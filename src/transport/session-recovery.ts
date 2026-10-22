// Session recovery — single-flight establishment for content calls.
//
// Content tools need a usable bearer, and the bearer observed in the browser
// expires within minutes and carries no refresh token. This module decides,
// for ONE question shared by every concurrent caller, whether the session may
// be re-established without a human, and if so does it exactly once.
//
// What it will never do:
//   - log in for a human: a session that was never authorized, was logged out
//     or was revoked by the provider fails with a structured code instead;
//   - start a second attempt while one is in flight (single promise);
//   - retry a failed silent attempt in a tight loop (cool-down);
//   - keep a caller waiting past its own deadline or cancellation.
//
// Repeating a content request is NOT decided here; see `callWithSession`,
// which retries only with structural proof that nothing was dispatched.

/** The closed classification of the current session (see `classify`). */
export type SessionState =
  /** A bearer is installed and unexpired. */
  | "USABLE"
  /** Established in this process and simply ran out. */
  | "EXPIRED"
  /** Nothing was established in this process (cold start). */
  | "NEVER_ESTABLISHED"
  /** The user logged out explicitly. */
  | "LOGGED_OUT"
  /** The provider revoked the session (invalid_grant). */
  | "REVOKED"
  /** A logout transaction is running right now. */
  | "LOGGING_OUT";

export type SessionFailureCode =
  | "LOGIN_REQUIRED"
  | "REAUTH_REQUIRED"
  | "LOGGED_OUT"
  | "LOGGING_OUT"
  | "SILENT_REAUTH_FAILED"
  | "SILENT_REAUTH_COOLDOWN"
  | "TIMEOUT"
  | "CANCELLED";

export type RecoveryOutcome =
  | { readonly ok: true; readonly via: "REUSED" | "RE_ESTABLISHED"; readonly from: SessionState }
  | { readonly ok: false; readonly code: SessionFailureCode; readonly from: SessionState };

export interface SessionRecoveryPorts {
  /** The authority's own answer: installed AND unexpired. */
  usable(): boolean;
  /** Raw authority diagnostics — safe fields only. */
  diagnostics(): {
    readonly availability: "READY" | "UNAVAILABLE";
    readonly reason?: string;
    readonly cause?: string;
  };
  /** The orchestrator's composite state (LOGGING_OUT, REAUTH_REQUIRED, …). */
  authState(): string;
  /** Whether a human-authorized session was recorded for the dedicated profile. */
  eligibleForColdStart(): Promise<boolean>;
  /** One bounded silent attempt. Resolves true only when a session was installed. */
  establishSilently(observationDeadlineMs: number): Promise<boolean>;
  now(): number;
  schedule(callback: () => void, ms: number): { cancel(): void };
}

export interface SessionRecoveryTiming {
  /** Observation deadline of one silent attempt. */
  readonly silentObservationMs: number;
  /** How long a caller waits for the shared attempt before giving up itself. */
  readonly callerWaitMs: number;
  /** After a failed silent attempt, how long further callers fail fast. */
  readonly cooldownMs: number;
}

export const DEFAULT_SESSION_RECOVERY_TIMING: SessionRecoveryTiming = Object.freeze({
  silentObservationMs: 30_000,
  callerWaitMs: 40_000,
  cooldownMs: 120_000,
});

export interface SessionRecovery {
  classify(): SessionState;
  ensureSession(options?: { readonly signal?: AbortSignal }): Promise<RecoveryOutcome>;
  /** Introspection for tests and status: is a shared attempt in flight? */
  inFlight(): boolean;
}

export function createSessionRecovery(
  ports: SessionRecoveryPorts,
  timingOverrides: Partial<SessionRecoveryTiming> = {},
): SessionRecovery {
  const timing: SessionRecoveryTiming = { ...DEFAULT_SESSION_RECOVERY_TIMING, ...timingOverrides };
  let flight: Promise<RecoveryOutcome> | undefined;
  let blockedUntil = 0;

  const classify = (): SessionState => {
    if (ports.authState() === "LOGGING_OUT") return "LOGGING_OUT";
    if (ports.usable()) return "USABLE";
    const diagnostics = ports.diagnostics();
    if (ports.authState() === "REAUTH_REQUIRED" || diagnostics.cause === "INVALID_GRANT") return "REVOKED";
    // READY with no usable record: installed in this process, now expired.
    if (diagnostics.availability === "READY") return "EXPIRED";
    if (diagnostics.reason === "INVALIDATED" && diagnostics.cause === "LOGOUT") return "LOGGED_OUT";
    if (diagnostics.reason === "INVALIDATED" && diagnostics.cause === "AUTH_MATERIAL_LOST") return "EXPIRED";
    return "NEVER_ESTABLISHED";
  };

  const fail = (code: SessionFailureCode, from: SessionState): RecoveryOutcome =>
    Object.freeze({ ok: false as const, code, from });

  /** The one shared attempt. Everything that can wait is inside it. */
  const attempt = async (from: SessionState): Promise<RecoveryOutcome> => {
    if (from === "NEVER_ESTABLISHED" && !(await ports.eligibleForColdStart())) {
      return fail("LOGIN_REQUIRED", from);
    }
    let accepted = false;
    try {
      accepted = await ports.establishSilently(timing.silentObservationMs);
    } catch {
      accepted = false;
    }
    if (accepted && ports.usable()) {
      blockedUntil = 0;
      return Object.freeze({ ok: true as const, via: "RE_ESTABLISHED" as const, from });
    }
    // A logout that started during the attempt outranks the attempt's own failure.
    if (classify() === "LOGGING_OUT") return fail("LOGGING_OUT", from);
    if (classify() === "LOGGED_OUT") return fail("LOGGED_OUT", from);
    blockedUntil = ports.now() + timing.cooldownMs;
    return fail("SILENT_REAUTH_FAILED", from);
  };

  return {
    classify,
    inFlight: () => flight !== undefined,

    async ensureSession(options = {}) {
      const from = classify();
      switch (from) {
        case "USABLE":
          blockedUntil = 0;
          return Object.freeze({ ok: true as const, via: "REUSED" as const, from });
        case "LOGGING_OUT":
          return fail("LOGGING_OUT", from);
        case "LOGGED_OUT":
          return fail("LOGGED_OUT", from);
        case "REVOKED":
          return fail("REAUTH_REQUIRED", from);
        default:
          break;
      }
      if (options.signal?.aborted) return fail("CANCELLED", from);

      if (!flight) {
        if (ports.now() < blockedUntil) return fail("SILENT_REAUTH_COOLDOWN", from);
        flight = attempt(from).finally(() => { flight = undefined; });
      }

      // Each caller bounds its OWN wait; the shared attempt has its own deadline
      // and keeps running for the others.
      const shared = flight;
      let timer: { cancel(): void } | undefined;
      let onAbort: (() => void) | undefined;
      const bounded = new Promise<RecoveryOutcome>((resolve) => {
        timer = ports.schedule(() => resolve(fail("TIMEOUT", from)), timing.callerWaitMs);
        if (options.signal) {
          onAbort = () => resolve(fail("CANCELLED", from));
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      try {
        return await Promise.race([shared, bounded]);
      } finally {
        timer?.cancel();
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Raised when a content call cannot run because no usable session exists. */
export class SessionRequiredError extends Error {
  constructor(
    readonly code: SessionFailureCode,
    readonly sessionState: SessionState,
  ) {
    super(SESSION_MESSAGES[code]);
    this.name = "SessionRequiredError";
  }
}

const SESSION_MESSAGES: Record<SessionFailureCode, string> = {
  LOGIN_REQUIRED: "Not authenticated: log in before requesting content",
  REAUTH_REQUIRED: "Crunchyroll revoked the session: the user must log in again",
  LOGGED_OUT: "The user logged out: log in again before requesting content",
  LOGGING_OUT: "A logout is in progress: content is unavailable",
  SILENT_REAUTH_FAILED: "The saved browser session could not be re-established: log in again",
  SILENT_REAUTH_COOLDOWN: "The saved browser session could not be re-established recently: log in again",
  TIMEOUT: "Re-establishing the session took too long",
  CANCELLED: "The request was cancelled while re-establishing the session",
};

export const SESSION_HINTS: Record<SessionFailureCode, string> = {
  LOGIN_REQUIRED:
    "Call crunchyroll_login once (no arguments). The user signs in in the managed browser; never ask for credentials.",
  REAUTH_REQUIRED: "Call crunchyroll_login once; the user must sign in again in the managed browser.",
  LOGGED_OUT: "The user logged out. Call crunchyroll_login only if the user wants to sign in again.",
  LOGGING_OUT: "Wait for the logout to finish; do not retry automatically.",
  SILENT_REAUTH_FAILED: "Call crunchyroll_login once; the user may need to sign in in the managed browser.",
  SILENT_REAUTH_COOLDOWN: "Call crunchyroll_login once; do not retry the content call in a loop.",
  TIMEOUT: "Retry once later, or call crunchyroll_login.",
  CANCELLED: "The request was cancelled; nothing was sent.",
};

export interface DispatchProbe {
  /** Set by the transport the moment a provider channel is opened. */
  dispatched: boolean;
}

/**
 * Run one content call under a usable session.
 *
 * 1. Pre-flight: if the session is not usable, recover BEFORE dispatching
 *    anything, so a cold start never spends a request on a certain failure.
 * 2. If the call still fails with `isAuthNotReady`, it is repeated at most ONCE
 *    and only when `probe.dispatched` is still false — structural proof that no
 *    provider channel was ever opened for the first attempt.
 */
export async function callWithSession<T>(
  recovery: SessionRecovery,
  run: (probe: DispatchProbe) => Promise<T>,
  isAuthNotReady: (error: unknown) => boolean,
  options: { readonly signal?: AbortSignal } = {},
): Promise<T> {
  if (recovery.classify() !== "USABLE") {
    const outcome = await recovery.ensureSession(options);
    if (!outcome.ok) throw new SessionRequiredError(outcome.code, outcome.from);
  }
  const first: DispatchProbe = { dispatched: false };
  try {
    return await run(first);
  } catch (error) {
    if (first.dispatched || !isAuthNotReady(error)) throw error;
    const outcome = await recovery.ensureSession(options);
    if (!outcome.ok) throw new SessionRequiredError(outcome.code, outcome.from);
    const second: DispatchProbe = { dispatched: false };
    return await run(second);
  }
}
