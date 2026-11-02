import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSessionKeeper } from "../src/transport/session-keeper.js";
import type { RecoveryOutcome, SessionState } from "../src/transport/session-recovery.js";

/** A fake clock plus a scripted session: expiry, renew results, state. */
function harness(options: {
  state?: SessionState;
  expiresIn?: number;
  renew?: Array<RecoveryOutcome["ok"] extends never ? never : RecoveryOutcome>;
  idleAfterMs?: number;
} = {}) {
  let now = 1_000_000;
  let state: SessionState = options.state ?? "USABLE";
  let until: number | undefined = state === "USABLE" ? now + (options.expiresIn ?? 300_000) : undefined;
  const results = [...(options.renew ?? [])];
  const timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
  let renewCalls = 0;

  const keeper = createSessionKeeper(
    {
      classify: () => (state === "USABLE" && until !== undefined && until <= now ? "EXPIRED" : state),
      usableUntil: () => (state === "USABLE" && until !== undefined && until > now ? until : undefined),
      ensureSession: async () => {
        renewCalls += 1;
        const next = results.shift() ?? { ok: true as const, via: "RE_ESTABLISHED" as const, from: "EXPIRED" as const };
        if (next.ok) {
          state = "USABLE";
          until = now + 300_000;
        }
        return next;
      },
      now: () => now,
      schedule: (cb, ms) => {
        const t = { at: now + ms, cb, live: true };
        timers.push(t);
        return { cancel: () => { t.live = false; } };
      },
    },
    { idleAfterMs: options.idleAfterMs ?? 3_600_000 },
  );

  /** Advance the clock, firing due timers in order. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      now = Math.max(now, due.at);
      due.cb();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = end;
  };

  return {
    keeper,
    advance,
    get renewCalls() { return renewCalls; },
    setState(next: SessionState) { state = next; },
  };
}

const fail = (code: string): RecoveryOutcome =>
  ({ ok: false, code, from: "EXPIRED" }) as RecoveryOutcome;

describe("session keeper", () => {
  test("renews right after the bearer expires, then keeps renewing on each expiry", async () => {
    const h = harness({ expiresIn: 300_000 });
    h.keeper.touch();
    assert.equal(h.keeper.status().keep_warm, "ACTIVE");
    assert.equal(h.keeper.status().next_renewal_in_s, 300);
    await h.advance(299_000);
    assert.equal(h.renewCalls, 0, "never renews a still-usable bearer");
    await h.advance(2_000);
    assert.equal(h.renewCalls, 1);
    await h.advance(301_000);
    assert.equal(h.renewCalls, 2);
    assert.equal(h.keeper.status().last_renewal, "OK");
  });

  test("goes idle after the quiet window and the next tool call wakes it", async () => {
    const h = harness({ expiresIn: 300_000, idleAfterMs: 600_000 });
    h.keeper.touch();
    await h.advance(1_200_000);
    const calls = h.renewCalls;
    assert.equal(h.keeper.status().keep_warm, "IDLE");
    await h.advance(1_200_000);
    assert.equal(h.renewCalls, calls, "an idle keeper reloads nothing");
    h.keeper.touch();
    assert.equal(h.keeper.status().keep_warm, "ACTIVE");
    await h.advance(1);
    assert.equal(h.renewCalls, calls + 1, "an expired session is renewed at once on wake");
  });

  test("a failed renewal backs off instead of looping, then recovers", async () => {
    const h = harness({ expiresIn: 1_000, renew: [fail("SILENT_REAUTH_FAILED")] });
    h.keeper.touch();
    await h.advance(2_000);
    assert.equal(h.renewCalls, 1);
    assert.equal(h.keeper.status().keep_warm, "RETRYING");
    assert.equal(h.keeper.status().last_failure, "SILENT_REAUTH_FAILED");
    h.keeper.touch(); // activity during backoff must not cause an extra attempt
    await h.advance(100_000);
    assert.equal(h.renewCalls, 1);
    await h.advance(30_000);
    assert.equal(h.renewCalls, 2);
    assert.equal(h.keeper.status().keep_warm, "ACTIVE");
  });

  test("a session only a human can restore stops the keeper as NEEDS_LOGIN", async () => {
    const h = harness({ expiresIn: 1_000, renew: [fail("REAUTH_REQUIRED")] });
    h.keeper.touch();
    await h.advance(2_000);
    assert.equal(h.keeper.status().keep_warm, "NEEDS_LOGIN");
    await h.advance(3_600_000);
    assert.equal(h.renewCalls, 1, "never retries what needs a human");
  });

  test("a logged-out session is never renewed", async () => {
    const h = harness({ state: "LOGGED_OUT" });
    h.keeper.touch();
    await h.advance(600_000);
    assert.equal(h.renewCalls, 0);
    assert.equal(h.keeper.status().keep_warm, "NEEDS_LOGIN");
  });

  test("idleAfterMs 0 disables the keeper entirely", async () => {
    const h = harness({ expiresIn: 1_000, idleAfterMs: 0 });
    h.keeper.touch();
    await h.advance(600_000);
    assert.equal(h.renewCalls, 0);
    assert.equal(h.keeper.status().keep_warm, "DISABLED");
  });
});
