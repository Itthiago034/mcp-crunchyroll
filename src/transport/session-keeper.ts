// Session keeper — keeps the browser session warm in the background.
//
// The bearer observed in the browser expires within minutes and has no
// refresh token. Without this module it is renewed only when a tool call finds
// it expired, so that call pays for a page reload (seconds) and, if the reload
// fails, every caller for the next two minutes is told to log in again.
//
// The keeper renews it as soon as it runs out, through the SAME single-flight
// recovery content calls use, so a call that arrives meanwhile joins the
// renewal instead of starting its own. It reloads only the managed API tab,
// never the playback tab, and it never logs in for a human: a session that was
// never authorized, was logged out or was revoked stops the keeper and is
// reported as needing crunchyroll_login.
//
// It stays active while tools are being used and goes idle after a quiet
// period, so an unattended server does not reload Crunchyroll forever. The next
// tool call wakes it again.

import type { RecoveryOutcome, SessionFailureCode, SessionState } from "./session-recovery.js";

export type KeeperState =
  /** Renewing on schedule. */
  | "ACTIVE"
  /** A renewal failed; retrying with backoff. */
  | "RETRYING"
  /** No tool activity for a while; the next call wakes it. */
  | "IDLE"
  /** A human must log in (never authorized, logged out or revoked). */
  | "NEEDS_LOGIN"
  /** Turned off by configuration. */
  | "DISABLED";

export interface SessionKeeperPorts {
  classify(): SessionState;
  /** Epoch ms when the current bearer stops being usable, if there is one. */
  usableUntil(): number | undefined;
  /** The shared single-flight recovery content calls use. */
  ensureSession(): Promise<RecoveryOutcome>;
  now(): number;
  schedule(callback: () => void, ms: number): { cancel(): void };
}

export interface SessionKeeperTiming {
  /** Renew this long after the bearer's expiry instant (it must be expired to renew). */
  readonly renewAfterExpiryMs: number;
  /** Stop renewing after this long without tool activity. 0 disables the keeper. */
  readonly idleAfterMs: number;
  /** Waits between failed renewals; the last value repeats. */
  readonly retryBackoffMs: readonly number[];
}

export const DEFAULT_SESSION_KEEPER_TIMING: SessionKeeperTiming = Object.freeze({
  renewAfterExpiryMs: 250,
  idleAfterMs: 60 * 60_000,
  // The first value respects session-recovery's own 120 s cool-down.
  retryBackoffMs: Object.freeze([125_000, 300_000, 600_000]),
});

/** Failure codes after which only a human can help. */
const NEEDS_HUMAN: ReadonlySet<SessionFailureCode> = new Set([
  "LOGIN_REQUIRED",
  "REAUTH_REQUIRED",
  "LOGGED_OUT",
]);

export interface SessionKeeperStatus {
  readonly keep_warm: KeeperState;
  /** Seconds until the current bearer expires, or null without one. */
  readonly expires_in_s: number | null;
  /** Seconds until the next background renewal, or null when none is planned. */
  readonly next_renewal_in_s: number | null;
  readonly last_renewal: "OK" | "FAILED" | null;
  readonly last_failure?: SessionFailureCode;
}

export interface SessionKeeper {
  /** Record tool activity and (re)plan the next renewal. Cheap; call on every tool call. */
  touch(): void;
  /** Plan the first renewal at startup, warming a cold process right away when possible. */
  start(): void;
  stop(): void;
  status(): SessionKeeperStatus;
}

export function createSessionKeeper(
  ports: SessionKeeperPorts,
  timingOverrides: Partial<SessionKeeperTiming> = {},
): SessionKeeper {
  const timing: SessionKeeperTiming = { ...DEFAULT_SESSION_KEEPER_TIMING, ...timingOverrides };
  const disabled = timing.idleAfterMs <= 0;
  let lastActivity = ports.now();
  let timer: { cancel(): void } | undefined;
  let dueAt: number | undefined;
  let state: KeeperState = disabled ? "DISABLED" : "IDLE";
  let failures = 0;
  let lastRenewal: "OK" | "FAILED" | null = null;
  let lastFailure: SessionFailureCode | undefined;
  let running = false;
  let stopped = false;

  const clear = () => {
    timer?.cancel();
    timer = undefined;
    dueAt = undefined;
  };

  const at = (when: number) => {
    clear();
    const delay = Math.max(0, when - ports.now());
    dueAt = ports.now() + delay;
    timer = ports.schedule(() => {
      timer = undefined;
      dueAt = undefined;
      void renew();
    }, delay);
  };

  /** Decide what happens next from the current session, never from guesses. */
  const plan = () => {
    if (disabled || stopped || running) return;
    if (ports.now() - lastActivity >= timing.idleAfterMs) {
      clear();
      state = "IDLE";
      return;
    }
    const session = ports.classify();
    if (session === "LOGGED_OUT" || session === "REVOKED" || session === "LOGGING_OUT") {
      clear();
      state = session === "LOGGING_OUT" ? "IDLE" : "NEEDS_LOGIN";
      return;
    }
    if (state === "NEEDS_LOGIN" && session !== "USABLE") return; // wait for crunchyroll_login
    if (state === "RETRYING" && timer) return; // keep the backoff already planned
    if (session === "USABLE") {
      const until = ports.usableUntil();
      state = "ACTIVE";
      if (until !== undefined) at(until + timing.renewAfterExpiryMs);
      return;
    }
    // EXPIRED or NEVER_ESTABLISHED: renew now. Recovery itself refuses a
    // session no human ever authorized (LOGIN_REQUIRED).
    state = "ACTIVE";
    at(ports.now());
  };

  const renew = async () => {
    if (disabled || stopped || running) return;
    if (ports.now() - lastActivity >= timing.idleAfterMs) {
      state = "IDLE";
      return;
    }
    running = true;
    let outcome: RecoveryOutcome;
    try {
      outcome = await ports.ensureSession();
    } catch {
      outcome = { ok: false, code: "SILENT_REAUTH_FAILED", from: ports.classify() };
    } finally {
      running = false;
    }
    if (stopped) return;
    if (outcome.ok) {
      failures = 0;
      lastRenewal = "OK";
      lastFailure = undefined;
      state = "ACTIVE";
      plan();
      return;
    }
    lastRenewal = "FAILED";
    lastFailure = outcome.code;
    if (NEEDS_HUMAN.has(outcome.code)) {
      clear();
      state = "NEEDS_LOGIN";
      return;
    }
    if (outcome.code === "LOGGING_OUT") {
      clear();
      state = "IDLE";
      return;
    }
    const backoff = timing.retryBackoffMs[Math.min(failures, timing.retryBackoffMs.length - 1)];
    failures += 1;
    state = "RETRYING";
    at(ports.now() + backoff);
  };

  return {
    touch() {
      if (disabled || stopped) return;
      lastActivity = ports.now();
      // A login that just succeeded clears NEEDS_LOGIN; a retry keeps its backoff.
      if (state === "NEEDS_LOGIN" && ports.classify() === "USABLE") state = "ACTIVE";
      if (state === "IDLE") state = "ACTIVE";
      plan();
    },
    start() {
      if (disabled || stopped) return;
      lastActivity = ports.now();
      plan();
    },
    stop() {
      stopped = true;
      clear();
    },
    status() {
      const now = ports.now();
      const until = ports.usableUntil();
      return Object.freeze({
        keep_warm: state,
        expires_in_s: until === undefined ? null : Math.max(0, Math.round((until - now) / 1000)),
        next_renewal_in_s: dueAt === undefined ? null : Math.max(0, Math.round((dueAt - now) / 1000)),
        last_renewal: lastRenewal,
        ...(lastFailure ? { last_failure: lastFailure } : {}),
      });
    },
  };
}
