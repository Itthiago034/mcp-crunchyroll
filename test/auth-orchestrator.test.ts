// BT4 completion — auth orchestration, readiness and races.
//
// Deterministic and offline: every race is an explicit barrier (deferred
// promises), never a sleep. No browser, no CDP, no network, no credentials.
//
// Frozen design: docs/dev/CRUNCHYROLL-BT4-COMPLETION-ERRATA.md §6, §7, §10.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createAuthOrchestrator,
  type AuthOrchestratorPorts,
  type ReadinessReport,
} from "../src/transport/auth-orchestrator.js";
import type { ObservedAuthMaterial } from "../src/transport/browser-auth.js";

const ACCOUNT_SENTINEL = "SENSITIVE-ACCOUNT-SENTINEL-orch";
const PROFILE_SENTINEL = "SENSITIVE-PROFILE-SENTINEL-orch";
const ACCESS_SENTINEL = "SYNTHETIC-ACCESS-TOKEN-orch";

const MATERIAL: ObservedAuthMaterial = Object.freeze({
  accessToken: ACCESS_SENTINEL,
  tokenType: "Bearer",
  expiresAt: 9_999_999_999_999,
  accountId: ACCOUNT_SENTINEL,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The live BT2 connection generation the fake browser reports by default. */
const GENERATION = 7;

/** An OBSERVED outcome always carries the generation it was observed on. */
function observedOn(generation: number, material: ObservedAuthMaterial = MATERIAL) {
  return { kind: "OBSERVED" as const, material, connectionGeneration: generation };
}

interface Harness {
  ports: AuthOrchestratorPorts;
  orchestrator: ReturnType<typeof createAuthOrchestrator>;
  events: string[];
  setAvailability(value: "READY" | "UNAVAILABLE"): void;
  setProfile(has: boolean): void;
  setBrowser(state: "STOPPED" | "BROWSER_STARTING" | "BROWSER_READY" | "DEGRADED" | undefined): void;
  setConnectionGeneration(value: number | undefined): void;
  setObservation(handler: () => Promise<unknown>): void;
  setLoginSurface(handler: () => Promise<void>): void;
  setLogout(handler: () => Promise<{ persistence: unknown }>): void;
  loginSurfaceOpens: number;
  installs: ObservedAuthMaterial[];
  /** Every signal the orchestrator handed to the observer, in order. */
  observerSignals: (AbortSignal | undefined)[];
  /** Resolves when the observer has actually been entered — a barrier, not a sleep. */
  observing: Promise<void>;
}

function harness(): Harness {
  let availability: "READY" | "UNAVAILABLE" = "UNAVAILABLE";
  let hasProfile = false;
  let browserState: Harness extends never ? never : ReturnType<AuthOrchestratorPorts["browser"]["lifecycleState"]> =
    "STOPPED";
  let connectionGeneration: number | undefined = GENERATION;
  const events: string[] = [];
  const installs: ObservedAuthMaterial[] = [];
  const observerSignals: (AbortSignal | undefined)[] = [];
  let observingResolve!: () => void;
  const observing = new Promise<void>((resolve) => {
    observingResolve = resolve;
  });
  const state = { loginSurfaceOpens: 0 };

  let observation: () => Promise<unknown> = async () => ({ kind: "TIMED_OUT" });
  let loginSurface: () => Promise<void> = async () => void 0;
  let logoutHandler: () => Promise<{ persistence: unknown }> = async () => ({
    persistence: { state: "CLEARED" },
  });

  const ports: AuthOrchestratorPorts = {
    diagnostics: {
      availability: () => availability,
      hasProfileId: () => hasProfile,
    },
    browser: {
      lifecycleState: () => browserState,
      connectionGeneration: () => connectionGeneration,
      openLoginSurface: async () => {
        state.loginSurfaceOpens += 1;
        events.push("openLoginSurface");
        await loginSurface();
      },
    },
    producer: {
      establishFromObservedMaterial: async (material) => {
        installs.push(material);
        events.push("install");
        availability = "READY";
        return { kind: "ESTABLISHED" };
      },
      logout: async () => {
        events.push("logout");
        availability = "UNAVAILABLE";
        hasProfile = false;
        return logoutHandler();
      },
    },
    observer: {
      observeNextAuthMaterial: async (options) => {
        events.push("observe");
        observerSignals.push(options?.signal);
        observingResolve();
        return observation() as never;
      },
    },
  };

  const orchestrator = createAuthOrchestrator(ports);
  return {
    ports,
    orchestrator,
    events,
    installs,
    observerSignals,
    observing,
    get loginSurfaceOpens() {
      return state.loginSurfaceOpens;
    },
    setAvailability: (value) => {
      availability = value;
    },
    setProfile: (has) => {
      hasProfile = has;
    },
    setBrowser: (value) => {
      browserState = value;
    },
    setConnectionGeneration: (value) => {
      connectionGeneration = value;
    },
    setObservation: (handler) => {
      observation = handler;
    },
    setLoginSurface: (handler) => {
      loginSurface = handler;
    },
    setLogout: (handler) => {
      logoutHandler = handler;
    },
  };
}

function assertShape(readiness: ReadinessReport): void {
  assert.deepEqual(Object.keys(readiness).sort(), [
    "auth_state",
    "authenticated",
    "browser_connected",
    "browser_running",
    "logged_in",
    "player_ready",
    "profile_ready",
  ]);
}

describe("BT4 readiness — browser liveness is never authentication", () => {
  test("T: a running, connected browser with no auth is still LOGIN_REQUIRED", () => {
    const h = harness();
    h.setBrowser("BROWSER_READY");
    const readiness = h.orchestrator.readiness();
    assertShape(readiness);
    assert.equal(readiness.authenticated, false);
    assert.equal(readiness.logged_in, false);
    assert.equal(readiness.browser_running, true);
    assert.equal(readiness.browser_connected, true);
    assert.equal(readiness.auth_state, "LOGIN_REQUIRED");
    assert.equal(readiness.profile_ready, false);
  });

  test("authenticated and logged_in are always the same value", () => {
    const h = harness();
    for (const availability of ["READY", "UNAVAILABLE"] as const) {
      h.setAvailability(availability);
      const readiness = h.orchestrator.readiness();
      assert.equal(readiness.authenticated, readiness.logged_in);
    }
  });

  test("an account-scoped session without a profile is ACCOUNT_READY", () => {
    const h = harness();
    h.setAvailability("READY");
    const readiness = h.orchestrator.readiness();
    assert.equal(readiness.auth_state, "ACCOUNT_READY");
    assert.equal(readiness.authenticated, true);
    assert.equal(readiness.profile_ready, false);
  });

  test("a profile-scoped session is PROFILE_READY", () => {
    const h = harness();
    h.setAvailability("READY");
    h.setProfile(true);
    const readiness = h.orchestrator.readiness();
    assert.equal(readiness.auth_state, "PROFILE_READY");
    assert.equal(readiness.profile_ready, true);
  });

  test("U: a disconnected browser degrades honestly rather than claiming auth", () => {
    const h = harness();
    h.setBrowser("DEGRADED");
    const readiness = h.orchestrator.readiness();
    assert.equal(readiness.auth_state, "DEGRADED");
    assert.equal(readiness.authenticated, false);
    assert.equal(readiness.browser_connected, false);
    assert.equal(readiness.browser_running, true);
  });

  test("player_ready is always false — BT4 owns no player", () => {
    const h = harness();
    h.setAvailability("READY");
    h.setProfile(true);
    assert.equal(h.orchestrator.readiness().player_ready, false);
  });

  test("the report carries no token, identity, epoch or generation", () => {
    const h = harness();
    h.setAvailability("READY");
    const rendered = JSON.stringify(h.orchestrator.readiness());
    for (const sentinel of [ACCESS_SENTINEL, ACCOUNT_SENTINEL, PROFILE_SENTINEL, "epoch", "generation"]) {
      assert.equal(rendered.includes(sentinel), false, `leaked ${sentinel}`);
    }
  });
});

describe("BT4 login — interactive, idempotent, never racing a logout", () => {
  test("H: a login enters AUTHENTICATING exactly once and installs the material", async () => {
    const h = harness();
    h.setObservation(async () => observedOn(GENERATION));

    const outcome = await h.orchestrator.login();

    assert.equal(outcome.accepted, true);
    assert.equal(outcome.readiness.auth_state, "ACCOUNT_READY");
    assert.deepEqual(h.events, ["openLoginSurface", "observe", "install"]);
    assert.deepEqual(h.installs, [MATERIAL]);
  });

  test("H: while the human is typing, the state is AUTHENTICATING", async () => {
    const h = harness();
    const gate = deferred<unknown>();
    h.setObservation(() => gate.promise);

    const pending = h.orchestrator.login();
    await Promise.resolve();
    assert.equal(h.orchestrator.readiness().auth_state, "AUTHENTICATING");
    assert.equal(h.orchestrator.readiness().authenticated, false);

    gate.resolve(observedOn(GENERATION));
    await pending;
  });

  test("I: a duplicate login joins the first and opens no second window", async () => {
    const h = harness();
    const gate = deferred<unknown>();
    h.setObservation(() => gate.promise);

    const first = h.orchestrator.login();
    await Promise.resolve();
    const second = h.orchestrator.login();

    gate.resolve(observedOn(GENERATION));
    const [a, b] = await Promise.all([first, second]);

    assert.equal(h.loginSurfaceOpens, 1, "exactly one login window");
    assert.equal(h.installs.length, 1, "exactly one install");
    assert.deepEqual(a, b, "the second call shares the first result");
  });

  test("an already-authenticated login does not reopen a login page", async () => {
    const h = harness();
    h.setAvailability("READY");
    const outcome = await h.orchestrator.login();
    assert.equal(outcome.accepted, true);
    assert.equal(h.loginSurfaceOpens, 0);
    assert.deepEqual(h.events, []);
  });

  test("a timeout returns LOGIN_REQUIRED with no retry loop", async () => {
    const h = harness();
    h.setObservation(async () => ({ kind: "TIMED_OUT" }));
    const outcome = await h.orchestrator.login();
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.readiness.auth_state, "LOGIN_REQUIRED");
    assert.equal(h.events.filter((e) => e === "observe").length, 1);
  });

  test("a browser that cannot open the login surface fails safely", async () => {
    const h = harness();
    h.setLoginSurface(async () => {
      throw new Error("BROWSER_UNAVAILABLE");
    });
    const outcome = await h.orchestrator.login();
    assert.equal(outcome.accepted, false);
    assert.equal(h.events.includes("observe"), false, "no observation without a surface");
  });

  test("a browser crash while AUTHENTICATING becomes a safe degraded state", async () => {
    const h = harness();
    h.setObservation(async () => {
      h.setBrowser("DEGRADED");
      return { kind: "UNAVAILABLE" };
    });
    const outcome = await h.orchestrator.login();
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.readiness.auth_state, "DEGRADED");
    assert.equal(h.installs.length, 0);
  });
});

describe("BT4 LOGGING_OUT — exclusive, honest, never resurrecting", () => {
  test("Q: status reports LOGGING_OUT with every boolean false", async () => {
    const h = harness();
    h.setAvailability("READY");
    h.setProfile(true);
    const gate = deferred<{ persistence: unknown }>();
    h.setLogout(() => gate.promise);

    const pending = h.orchestrator.logout();
    await Promise.resolve();

    const readiness = h.orchestrator.readiness();
    assert.equal(readiness.auth_state, "LOGGING_OUT");
    assert.equal(readiness.authenticated, false);
    assert.equal(readiness.logged_in, false);
    assert.equal(readiness.profile_ready, false);

    gate.resolve({ persistence: { state: "CLEARED" } });
    await pending;
  });

  test("R: an interactive login is refused while LOGGING_OUT", async () => {
    const h = harness();
    h.setAvailability("READY");
    const gate = deferred<{ persistence: unknown }>();
    h.setLogout(() => gate.promise);

    const loggingOut = h.orchestrator.logout();
    await Promise.resolve();

    const login = await h.orchestrator.login();
    assert.equal(login.accepted, false);
    assert.equal(login.readiness.auth_state, "LOGGING_OUT");
    assert.equal(h.loginSurfaceOpens, 0, "no login window may open during a logout");

    gate.resolve({ persistence: { state: "CLEARED" } });
    await loggingOut;
  });

  test("a concurrent logout joins the in-flight transaction", async () => {
    const h = harness();
    h.setAvailability("READY");
    const gate = deferred<{ persistence: unknown }>();
    h.setLogout(() => gate.promise);

    const first = h.orchestrator.logout();
    await Promise.resolve();
    const second = h.orchestrator.logout();

    gate.resolve({ persistence: { state: "CLEARED" } });
    const [a, b] = await Promise.all([first, second]);

    assert.equal(h.events.filter((e) => e === "logout").length, 1, "one transaction only");
    assert.deepEqual(a, b);
  });

  test("K: an observation arriving during a logout cannot reinstall the session", async () => {
    const h = harness();
    const observation = deferred<unknown>();
    const logoutGate = deferred<{ persistence: unknown }>();
    h.setObservation(() => observation.promise);
    h.setLogout(() => logoutGate.promise);

    // The human is mid-login (AUTHENTICATING) when the logout is requested.
    const login = h.orchestrator.login();
    await Promise.resolve();
    const loggingOut = h.orchestrator.logout();
    await Promise.resolve();

    // The human finished typing after the logout began.
    observation.resolve(observedOn(GENERATION));
    const loginOutcome = await login;

    assert.equal(loginOutcome.accepted, false, "a stale observation installs nothing");
    assert.equal(h.installs.length, 0);

    logoutGate.resolve({ persistence: { state: "CLEARED" } });
    await loggingOut;
    assert.equal(h.orchestrator.readiness().authenticated, false);
  });

  test("O: a failed clear never restores a ready state", async () => {
    const h = harness();
    h.setAvailability("READY");
    h.setProfile(true);
    h.setLogout(async () => ({
      persistence: { state: "FAILED", tokens: { state: "FAILED" }, session: { state: "FAILED" } },
    }));

    const outcome = await h.orchestrator.logout();

    assert.deepEqual(outcome.persistence, {
      state: "FAILED",
      tokens: { state: "FAILED" },
      session: { state: "FAILED" },
    });
    assert.equal(outcome.readiness.auth_state, "LOGIN_REQUIRED");
    assert.equal(outcome.readiness.authenticated, false);
  });

  test("the exit state is LOGIN_REQUIRED, never a previous ready state", async () => {
    const h = harness();
    h.setAvailability("READY");
    h.setProfile(true);
    const outcome = await h.orchestrator.logout();
    assert.equal(outcome.readiness.auth_state, "LOGIN_REQUIRED");
    assert.equal(h.orchestrator.readiness().auth_state, "LOGIN_REQUIRED");
  });

  test("the structured persistence result is passed through verbatim", async () => {
    const h = harness();
    const persistence = {
      state: "PARTIAL",
      tokens: { state: "REMOVED" },
      session: { state: "FAILED", reason: "INSECURE_OWNER" },
    };
    h.setLogout(async () => ({ persistence }));
    const outcome = await h.orchestrator.logout();
    assert.deepEqual(outcome.persistence, persistence);
  });
});

// ── BT4-R1 (external review blocker) ────────────────────────────────────────
//
// A login attempt owns an explicit local identity. An observation may only
// install if it still belongs to the CURRENT attempt and to the CURRENT BT2
// connection — checked after every await, never before one.
//
// The sibling test above ("K") only covers an observation landing WHILE the
// logout gate is held. The gate is released when the logout finishes, so it
// could not catch an observation that lands afterwards. That is this family.

describe("BT4-R1 — a stale observation can never install", () => {
  test("an observation from a login cancelled by a COMPLETED logout installs nothing", async () => {
    const h = harness();
    const observation = deferred<unknown>();
    h.setObservation(() => observation.promise);

    // A. login A is in flight, the human is still typing.
    const loginA = h.orchestrator.login();
    await Promise.resolve();
    assert.equal(h.orchestrator.readiness().auth_state, "AUTHENTICATING");

    // B. a logout begins AND completes, end to end.
    await h.orchestrator.logout();

    // C. the logout is fully over: the gate is released and the state is honest.
    assert.equal(h.orchestrator.readiness().auth_state, "LOGIN_REQUIRED");
    assert.equal(h.orchestrator.readiness().authenticated, false);

    // D. only now does the observation from attempt A arrive.
    observation.resolve(observedOn(GENERATION));
    const outcome = await loginA;

    // E/F/G.
    assert.equal(outcome.accepted, false, "a cancelled attempt must not be accepted");
    assert.equal(h.installs.length, 0, "nothing may be installed");
    assert.equal(h.ports.diagnostics.availability(), "UNAVAILABLE");
    assert.equal(h.orchestrator.readiness().auth_state, "LOGIN_REQUIRED");
    assert.equal(h.orchestrator.readiness().authenticated, false);
  });

  test("a logout aborts the pending observation synchronously", async () => {
    const h = harness();
    const observation = deferred<unknown>();
    h.setObservation(() => observation.promise);

    const loginA = h.orchestrator.login();
    await h.observing;
    const signal = h.observerSignals[0];
    assert.ok(signal, "the orchestrator must hand the observer a signal");
    assert.equal(signal.aborted, false, "not aborted while the attempt is live");

    // No await between the call and the assertion: cancellation must be
    // synchronous, so no observation can slip through the gap.
    const loggingOut = h.orchestrator.logout();
    assert.equal(signal.aborted, true, "the pending attempt is cancelled at once");

    observation.resolve({ kind: "CANCELLED" });
    await Promise.all([loginA, loggingOut]);
    assert.equal(h.installs.length, 0);
  });

  test("a late observation from a superseded attempt installs nothing", async () => {
    const h = harness();
    const first = deferred<unknown>();
    h.setObservation(() => first.promise);

    const loginA = h.orchestrator.login();
    await Promise.resolve();

    // A logout cancels attempt A and releases the login gate.
    await h.orchestrator.logout();

    // A newer attempt B starts and is waiting on its own observation.
    const second = deferred<unknown>();
    h.setObservation(() => second.promise);
    const loginB = h.orchestrator.login();
    await Promise.resolve();

    // A's material finally arrives — it belongs to a dead attempt.
    first.resolve(observedOn(GENERATION));
    const outcomeA = await loginA;
    assert.equal(outcomeA.accepted, false);
    assert.equal(h.installs.length, 0, "the dead attempt installed something");

    // B is untouched by A's arrival and still installs exactly once.
    second.resolve(observedOn(GENERATION, MATERIAL));
    const outcomeB = await loginB;
    assert.equal(outcomeB.accepted, true);
    assert.deepEqual(h.installs, [MATERIAL], "exactly one install, from B");
  });

  test("an attempt that timed out cannot install; only the newer attempt does", async () => {
    const h = harness();
    h.setObservation(async () => ({ kind: "TIMED_OUT" }));

    const outcomeA = await h.orchestrator.login();
    assert.equal(outcomeA.accepted, false);
    assert.equal(h.installs.length, 0);

    h.setObservation(async () => observedOn(GENERATION));
    const outcomeB = await h.orchestrator.login();

    assert.equal(outcomeB.accepted, true);
    assert.deepEqual(h.installs, [MATERIAL], "exactly one install, from the live attempt");
  });

  test("material observed on a stale BT2 connection generation is discarded", async () => {
    const h = harness();
    // Observed on generation 7; the browser has since reconnected as 8.
    h.setObservation(async () => {
      h.setConnectionGeneration(GENERATION + 1);
      return observedOn(GENERATION);
    });

    const outcome = await h.orchestrator.login();

    assert.equal(outcome.accepted, false, "old-generation material must not ESTABLISH");
    assert.equal(h.installs.length, 0);
    assert.equal(h.ports.diagnostics.availability(), "UNAVAILABLE");
  });

  test("a reconnect racing the commit still discards the old generation", async () => {
    const h = harness();
    const observation = deferred<unknown>();
    h.setObservation(() => observation.promise);

    const login = h.orchestrator.login();
    await Promise.resolve();

    // The connection dies and comes back as a new generation while the
    // observation is still travelling.
    h.setConnectionGeneration(GENERATION + 1);
    observation.resolve(observedOn(GENERATION));

    const outcome = await login;
    assert.equal(outcome.accepted, false);
    assert.equal(h.installs.length, 0);
  });

  test("material cannot install while there is no live connection at all", async () => {
    const h = harness();
    h.setObservation(async () => {
      h.setConnectionGeneration(undefined);
      return observedOn(GENERATION);
    });

    const outcome = await h.orchestrator.login();

    assert.equal(outcome.accepted, false, "no live connection, no install");
    assert.equal(h.installs.length, 0);
  });

  test("a logout whose cleanup FAILED still blocks reinstallation", async () => {
    const h = harness();
    const observation = deferred<unknown>();
    h.setObservation(() => observation.promise);
    h.setLogout(async () => ({
      persistence: { state: "FAILED", tokens: { state: "FAILED" }, session: { state: "FAILED" } },
    }));

    const loginA = h.orchestrator.login();
    await Promise.resolve();

    const logoutOutcome = await h.orchestrator.logout();
    assert.equal((logoutOutcome.persistence as { state: string }).state, "FAILED");

    observation.resolve(observedOn(GENERATION));
    const outcome = await loginA;

    // A partial or failed clear is exactly when resurrection would be worst.
    assert.equal(outcome.accepted, false);
    assert.equal(h.installs.length, 0);
    assert.equal(h.orchestrator.readiness().authenticated, false);
    assert.equal(h.orchestrator.readiness().auth_state, "LOGIN_REQUIRED");
  });

  test("the happy path is untouched: exactly one install, on the live generation", async () => {
    const h = harness();
    h.setObservation(async () => observedOn(GENERATION));

    const outcome = await h.orchestrator.login();

    assert.equal(outcome.accepted, true);
    assert.deepEqual(h.installs, [MATERIAL]);
    assert.equal(h.orchestrator.readiness().auth_state, "ACCOUNT_READY");
    assert.deepEqual(h.events, ["openLoginSurface", "observe", "install"]);
  });

  test("no cancellation path leaks material, identity or a signal into the report", async () => {
    const h = harness();
    const observation = deferred<unknown>();
    h.setObservation(() => observation.promise);
    const loginA = h.orchestrator.login();
    await Promise.resolve();
    await h.orchestrator.logout();
    observation.resolve(observedOn(GENERATION));

    const rendered = JSON.stringify(await loginA);
    for (const sentinel of [ACCESS_SENTINEL, ACCOUNT_SENTINEL, PROFILE_SENTINEL, "generation", "signal", "attempt"]) {
      assert.equal(rendered.includes(sentinel), false, `leaked ${sentinel}`);
    }
  });
});

describe("BT4 REAUTH_REQUIRED — an explicit signal, never mere unavailability", () => {
  test("an unavailable authority alone is LOGIN_REQUIRED, not REAUTH_REQUIRED", () => {
    const h = harness();
    assert.equal(h.orchestrator.readiness().auth_state, "LOGIN_REQUIRED");
  });

  test("after the signal, an unavailable authority reports REAUTH_REQUIRED", () => {
    const h = harness();
    h.orchestrator.signalReauthRequired();
    const readiness = h.orchestrator.readiness();
    assert.equal(readiness.auth_state, "REAUTH_REQUIRED");
    assert.equal(readiness.authenticated, false);
    assert.equal(readiness.logged_in, false);
    assert.equal(readiness.profile_ready, false);
  });

  test("the signal is idempotent and mutates nothing else", () => {
    const h = harness();
    h.orchestrator.signalReauthRequired();
    h.orchestrator.signalReauthRequired();
    assert.equal(h.orchestrator.readiness().auth_state, "REAUTH_REQUIRED");
    assert.deepEqual(h.events, [], "signalling performs no work of its own");
    assert.equal(h.loginSurfaceOpens, 0, "a signal never opens a window");
  });

  test("a signal never contradicts a live authority", () => {
    const h = harness();
    h.setAvailability("READY");
    h.orchestrator.signalReauthRequired();
    // The authority is the only source of truth for availability. A stale
    // signal must not report REAUTH while material is still installed.
    assert.equal(h.orchestrator.readiness().auth_state, "ACCOUNT_READY");
    assert.equal(h.orchestrator.readiness().authenticated, true);
  });

  test("a successful login clears the signal", async () => {
    const h = harness();
    h.orchestrator.signalReauthRequired();
    h.setObservation(async () => observedOn(GENERATION));

    await h.orchestrator.login();
    h.setAvailability("UNAVAILABLE");

    assert.equal(h.orchestrator.readiness().auth_state, "LOGIN_REQUIRED");
  });

  test("a logout clears the signal — its exit is LOGIN_REQUIRED", async () => {
    const h = harness();
    h.setAvailability("READY");
    h.orchestrator.signalReauthRequired();

    const outcome = await h.orchestrator.logout();

    assert.equal(outcome.readiness.auth_state, "LOGIN_REQUIRED");
    assert.equal(h.orchestrator.readiness().auth_state, "LOGIN_REQUIRED");
  });

  test("a login in flight outranks the signal", async () => {
    const h = harness();
    h.orchestrator.signalReauthRequired();
    const gate = deferred<unknown>();
    h.setObservation(() => gate.promise);

    const pending = h.orchestrator.login();
    await Promise.resolve();
    assert.equal(h.orchestrator.readiness().auth_state, "AUTHENTICATING");

    gate.resolve({ kind: "TIMED_OUT" });
    const outcome = await pending;
    // A failed attempt does not erase the reason reauthentication was needed.
    assert.equal(outcome.readiness.auth_state, "REAUTH_REQUIRED");
  });

  test("the logout gate still outranks the signal", async () => {
    const h = harness();
    h.orchestrator.signalReauthRequired();
    const gate = deferred<{ persistence: unknown }>();
    h.setLogout(() => gate.promise);

    const pending = h.orchestrator.logout();
    await Promise.resolve();
    assert.equal(h.orchestrator.readiness().auth_state, "LOGGING_OUT");

    gate.resolve({ persistence: { state: "CLEARED" } });
    await pending;
  });
});

describe("BT4 readiness — a degraded browser is reported, not hidden", () => {
  test("the browser lifecycle outranks a ready authority in auth_state", () => {
    const h = harness();
    h.setAvailability("READY");
    h.setProfile(true);
    h.setBrowser("DEGRADED");

    const readiness = h.orchestrator.readiness();

    // Errata §6: the DEGRADED row matches ANY authority availability. The
    // composite state answers "is this transport healthy", and hiding a
    // degraded browser behind a still-valid credential would be the same
    // dishonesty as the reverse.
    assert.equal(readiness.auth_state, "DEGRADED");
  });

  test("a degraded browser does not revoke a credential that is still current", () => {
    const h = harness();
    h.setAvailability("READY");
    h.setProfile(true);
    h.setBrowser("DEGRADED");

    const readiness = h.orchestrator.readiness();

    // §10 defines logged_in as "authenticated work is currently permitted".
    // The material is installed and unexpired: it IS permitted. Reporting
    // false here would be a fabricated logout.
    assert.equal(readiness.authenticated, true);
    assert.equal(readiness.logged_in, true);
    assert.equal(readiness.profile_ready, true);
    assert.equal(readiness.browser_connected, false);
  });

  test("a login is still refused as already-authenticated while degraded", async () => {
    const h = harness();
    h.setAvailability("READY");
    h.setBrowser("DEGRADED");

    const outcome = await h.orchestrator.login();

    assert.equal(outcome.accepted, true);
    assert.equal(h.loginSurfaceOpens, 0, "no second login window for a live session");
  });

  test("LOGGING_OUT still outranks a degraded browser", async () => {
    const h = harness();
    h.setAvailability("READY");
    h.setBrowser("DEGRADED");
    const gate = deferred<{ persistence: unknown }>();
    h.setLogout(() => gate.promise);

    const pending = h.orchestrator.logout();
    await Promise.resolve();
    const readiness = h.orchestrator.readiness();
    assert.equal(readiness.auth_state, "LOGGING_OUT");
    assert.equal(readiness.authenticated, false);

    gate.resolve({ persistence: { state: "CLEARED" } });
    await pending;
  });
});

describe("BT4 readiness — S: reporting mutates nothing", () => {
  test("repeated readiness reads touch no port that could transition", () => {
    const h = harness();
    h.setAvailability("READY");
    for (let i = 0; i < 5; i += 1) h.orchestrator.readiness();
    assert.deepEqual(h.events, [], "no observation, no install, no logout, no window");
    assert.equal(h.loginSurfaceOpens, 0);
  });
});
