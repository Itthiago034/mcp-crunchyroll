import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  callWithSession,
  createSessionRecovery,
  SessionRequiredError,
  type SessionRecoveryPorts,
} from "../src/transport/session-recovery.js";
import { TransportError } from "../src/transport/transport-error.js";

interface AuthWorld {
  usable: boolean;
  availability: "READY" | "UNAVAILABLE";
  reason?: string;
  cause?: string;
  authState: string;
  eligible: boolean;
}

function harness(world: Partial<AuthWorld> = {}, options: { silentSucceeds?: boolean; silentDelay?: number } = {}) {
  const state: AuthWorld = {
    usable: false,
    availability: "UNAVAILABLE",
    reason: "INITIAL",
    authState: "LOGIN_REQUIRED",
    eligible: true,
    ...world,
  };
  let time = 0;
  const timers: Array<{ at: number; fn: () => void; dead: boolean }> = [];
  let attempts = 0;
  let eligibilityReads = 0;
  let release: (() => void) | undefined;
  const ports: SessionRecoveryPorts = {
    usable: () => state.usable,
    diagnostics: () => ({ availability: state.availability, reason: state.reason, cause: state.cause }),
    authState: () => state.authState,
    eligibleForColdStart: async () => {
      eligibilityReads += 1;
      return state.eligible;
    },
    establishSilently: async (deadline) => {
      attempts += 1;
      assert.equal(deadline, 30_000, "the silent attempt carries its own short deadline");
      if (options.silentDelay) await new Promise<void>((resolve) => { release = resolve; });
      if (options.silentSucceeds ?? true) {
        state.usable = true;
        state.availability = "READY";
        state.authState = "PROFILE_READY";
        return true;
      }
      return false;
    },
    now: () => time,
    schedule: (fn, ms) => {
      const timer = { at: time + ms, fn, dead: false };
      timers.push(timer);
      return { cancel: () => { timer.dead = true; } };
    },
  };
  const recovery = createSessionRecovery(ports);
  return {
    recovery,
    state,
    get attempts() { return attempts; },
    get eligibilityReads() { return eligibilityReads; },
    release: () => release?.(),
    advance(ms: number) {
      time += ms;
      for (const timer of timers) if (!timer.dead && timer.at <= time) { timer.dead = true; timer.fn(); }
    },
  };
}

describe("session recovery — classification", () => {
  test("each state is distinguished", () => {
    const cases: Array<[Partial<AuthWorld>, string]> = [
      [{ usable: true, availability: "READY", authState: "PROFILE_READY" }, "USABLE"],
      [{ availability: "READY", authState: "PROFILE_READY" }, "EXPIRED"],
      [{ reason: "INITIAL" }, "NEVER_ESTABLISHED"],
      [{ reason: "INVALIDATED", cause: "LOGOUT" }, "LOGGED_OUT"],
      [{ reason: "INVALIDATED", cause: "INVALID_GRANT" }, "REVOKED"],
      [{ authState: "REAUTH_REQUIRED" }, "REVOKED"],
      [{ authState: "LOGGING_OUT", usable: true, availability: "READY" }, "LOGGING_OUT"],
    ];
    for (const [world, expected] of cases) assert.equal(harness(world).recovery.classify(), expected, expected);
  });
});

describe("session recovery — who may be re-established silently", () => {
  test("a valid session is reused without any attempt", async () => {
    const h = harness({ usable: true, availability: "READY", authState: "PROFILE_READY" });
    assert.deepEqual(await h.recovery.ensureSession(), { ok: true, via: "REUSED", from: "USABLE" });
    assert.equal(h.attempts, 0);
  });

  test("cold start with a recorded human authorization re-establishes once", async () => {
    const h = harness();
    const outcome = await h.recovery.ensureSession();
    assert.deepEqual(outcome, { ok: true, via: "RE_ESTABLISHED", from: "NEVER_ESTABLISHED" });
    assert.equal(h.attempts, 1);
  });

  test("cold start WITHOUT a recorded authorization is LOGIN_REQUIRED and never attempts", async () => {
    const h = harness({ eligible: false });
    assert.deepEqual(await h.recovery.ensureSession(), { ok: false, code: "LOGIN_REQUIRED", from: "NEVER_ESTABLISHED" });
    assert.equal(h.attempts, 0);
  });

  test("an expired session is re-established without consulting the cold-start marker", async () => {
    const h = harness({ availability: "READY", authState: "PROFILE_READY", eligible: false });
    assert.equal((await h.recovery.ensureSession()).ok, true);
    assert.equal(h.eligibilityReads, 0);
  });

  test("explicit logout, revocation and an in-flight logout are never silently undone", async () => {
    const cases: Array<[Partial<AuthWorld>, string]> = [
      [{ reason: "INVALIDATED", cause: "LOGOUT" }, "LOGGED_OUT"],
      [{ reason: "INVALIDATED", cause: "INVALID_GRANT" }, "REAUTH_REQUIRED"],
      [{ authState: "LOGGING_OUT" }, "LOGGING_OUT"],
    ];
    for (const [world, code] of cases) {
      const h = harness(world);
      const outcome = await h.recovery.ensureSession();
      assert.equal(outcome.ok, false);
      assert.equal((outcome as { code: string }).code, code);
      assert.equal(h.attempts, 0, `${code}: no attempt`);
    }
  });
});

describe("session recovery — single flight, cool-down and recovery", () => {
  test("twenty concurrent callers share ONE attempt and all see the same outcome", async () => {
    const h = harness({}, { silentDelay: 1 });
    const callers = Array.from({ length: 20 }, () => h.recovery.ensureSession());
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.recovery.inFlight(), true);
    h.release();
    const outcomes = await Promise.all(callers);
    assert.equal(h.attempts, 1);
    assert.equal(h.eligibilityReads, 1, "even the eligibility read is shared");
    assert.ok(outcomes.every((o) => o.ok));
    assert.equal(h.recovery.inFlight(), false, "state is cleaned up");
  });

  test("a failed attempt starts a cool-down: callers fail fast instead of storming", async () => {
    const h = harness({}, { silentSucceeds: false });
    assert.equal((await h.recovery.ensureSession() as { code: string }).code, "SILENT_REAUTH_FAILED");
    const storm = await Promise.all(Array.from({ length: 10 }, () => h.recovery.ensureSession()));
    assert.ok(storm.every((o) => !o.ok && o.code === "SILENT_REAUTH_COOLDOWN"));
    assert.equal(h.attempts, 1);
  });

  test("after the cool-down one new attempt may run, and success clears it", async () => {
    const h = harness({}, { silentSucceeds: false });
    await h.recovery.ensureSession();
    h.advance(120_001);
    await h.recovery.ensureSession();
    assert.equal(h.attempts, 2);
  });

  test("a human login clears the cool-down", async () => {
    const h = harness({}, { silentSucceeds: false });
    await h.recovery.ensureSession();
    Object.assign(h.state, { usable: true, availability: "READY", authState: "PROFILE_READY" });
    assert.equal((await h.recovery.ensureSession()).ok, true);
    Object.assign(h.state, { usable: false });
    await h.recovery.ensureSession();
    assert.equal(h.attempts, 2, "expired again later: allowed to try, not blocked by the old failure");
  });

  test("a caller's own timeout or cancellation never blocks the others", async () => {
    const h = harness({}, { silentDelay: 1 });
    const abort = new AbortController();
    const cancelled = h.recovery.ensureSession({ signal: abort.signal });
    abort.abort();
    assert.deepEqual(await cancelled, { ok: false, code: "CANCELLED", from: "NEVER_ESTABLISHED" });
    const timedOut = h.recovery.ensureSession();
    h.advance(40_000);
    assert.equal((await timedOut as { code: string }).code, "TIMEOUT");
    // The shared attempt outlived both callers and is still joinable.
    assert.equal(h.recovery.inFlight(), true);
    const patient = h.recovery.ensureSession();
    h.release();
    assert.equal((await patient).ok, true);
    assert.equal(h.attempts, 1);
  });

  test("a logout that lands during the attempt outranks the attempt", async () => {
    const h = harness({}, { silentDelay: 1, silentSucceeds: false });
    const pending = h.recovery.ensureSession();
    await Promise.resolve();
    await Promise.resolve();
    h.state.authState = "LOGGING_OUT";
    h.release();
    assert.equal((await pending as { code: string }).code, "LOGGING_OUT");
  });
});

describe("callWithSession — no duplicated side effects", () => {
  const authNotReady = (error: unknown) => error instanceof TransportError && error.kind === "AUTH_NOT_READY";

  test("cold start: recovery runs BEFORE the first dispatch, so the call runs once", async () => {
    const h = harness();
    let runs = 0;
    const value = await callWithSession(h.recovery, async () => { runs += 1; return "ok"; }, authNotReady);
    assert.equal(value, "ok");
    assert.equal(runs, 1);
    assert.equal(h.attempts, 1);
  });

  test("a refused recovery throws a structured SessionRequiredError and never runs the call", async () => {
    const h = harness({ reason: "INVALIDATED", cause: "LOGOUT" });
    let runs = 0;
    await assert.rejects(
      callWithSession(h.recovery, async () => { runs += 1; }, authNotReady),
      (e: unknown) => e instanceof SessionRequiredError && e.code === "LOGGED_OUT" && e.sessionState === "LOGGED_OUT",
    );
    assert.equal(runs, 0);
  });

  test("AUTH_NOT_READY before dispatch is retried exactly once", async () => {
    const h = harness({ usable: true, availability: "READY", authState: "PROFILE_READY" });
    let runs = 0;
    const value = await callWithSession(h.recovery, async () => {
      runs += 1;
      if (runs === 1) {
        // The bearer expired between the pre-flight and bind: nothing was opened.
        Object.assign(h.state, { usable: false });
        throw new TransportError("AUTH_NOT_READY");
      }
      return "second";
    }, authNotReady);
    assert.equal(value, "second");
    assert.equal(runs, 2);
  });

  test("AUTH_NOT_READY after a channel was opened is NEVER retried (mutation safety)", async () => {
    const h = harness({ usable: true, availability: "READY", authState: "PROFILE_READY" });
    let mutations = 0;
    await assert.rejects(
      callWithSession(h.recovery, async (probe) => {
        mutations += 1;
        probe.dispatched = true;
        throw new TransportError("AUTH_NOT_READY");
      }, authNotReady),
      (e: unknown) => e instanceof TransportError && e.kind === "AUTH_NOT_READY",
    );
    assert.equal(mutations, 1);
    assert.equal(h.attempts, 0);
  });

  test("other errors are never retried and never trigger recovery", async () => {
    const h = harness({ usable: true, availability: "READY", authState: "PROFILE_READY" });
    let runs = 0;
    for (const kind of ["MUTATION_OUTCOME_UNKNOWN", "API_UNAUTHORIZED", "AUTH_GENERATION_CHANGED", "BROWSER_UNAVAILABLE"] as const) {
      await assert.rejects(callWithSession(h.recovery, async () => { runs += 1; throw new TransportError(kind); }, authNotReady));
    }
    assert.equal(runs, 4);
    assert.equal(h.attempts, 0);
  });

  test("a second AUTH_NOT_READY after the retry is surfaced, not looped", async () => {
    const h = harness({ usable: true, availability: "READY", authState: "PROFILE_READY" });
    let runs = 0;
    await assert.rejects(callWithSession(h.recovery, async () => {
      runs += 1;
      throw new TransportError("AUTH_NOT_READY");
    }, authNotReady));
    assert.equal(runs, 2);
  });

  test("ten concurrent cold-start content calls cause one silent attempt and ten dispatches", async () => {
    const h = harness({}, { silentDelay: 1 });
    let runs = 0;
    const calls = Array.from({ length: 10 }, () =>
      callWithSession(h.recovery, async () => { runs += 1; return runs; }, authNotReady));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(runs, 0, "nothing is dispatched while the session is being established");
    h.release();
    await Promise.all(calls);
    assert.equal(h.attempts, 1);
    assert.equal(runs, 10);
  });
});
