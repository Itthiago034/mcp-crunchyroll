// BT4 — auth orchestration.
//
// Owns interactive-login and logout ORCHESTRATION only: the login gate, the
// exclusive logout gate, and the honest composite readiness report. It
// duplicates no BT3 state machine (the authority remains READY/UNAVAILABLE
// internally) and no BT2 lifecycle (the browser remains BT2's).
//
// No state here may imply authentication merely because a browser exists.
//
// Frozen design: docs/dev/CRUNCHYROLL-BT4-COMPLETION-ERRATA.md §6, §7, §10.

import type { ObservedAuthMaterial } from "./browser-auth.js";

/** The closed public state set (errata §6). */
export type AuthOrchestrationState =
  | "LOGIN_REQUIRED"
  | "AUTHENTICATING"
  | "ACCOUNT_READY"
  | "PROFILE_READY"
  | "REAUTH_REQUIRED"
  | "LOGGING_OUT"
  | "DEGRADED";

/**
 * The public readiness report. `authenticated` and `logged_in` are the same
 * value by definition and answer one question: "is authenticated work
 * permitted right now?" — never "is the process alive" and never "does a
 * browser exist".
 */
export interface ReadinessReport {
  readonly authenticated: boolean;
  readonly logged_in: boolean;
  readonly browser_running: boolean;
  readonly browser_connected: boolean;
  readonly auth_state: AuthOrchestrationState;
  readonly profile_ready: boolean;
  readonly player_ready: boolean;
}

/** Safe authority diagnostics only — no epoch, no identity, no material. */
export interface AuthDiagnosticsPort {
  availability(): "READY" | "UNAVAILABLE";
  hasProfileId(): boolean;
}

export interface BrowserPresencePort {
  /** BT2 lifecycle state; `undefined` when no browser has ever been composed. */
  lifecycleState(): "STOPPED" | "BROWSER_STARTING" | "BROWSER_READY" | "DEGRADED" | undefined;
  /**
   * The CURRENT BT2 connection generation, or `undefined` when no connection is
   * live. Material observed on an older generation belongs to a connection that
   * no longer exists and must never become an ESTABLISH (BT4-R1).
   */
  connectionGeneration(): number | undefined;
  /** Start the browser if needed and put the managed page on the login surface. */
  openLoginSurface(): Promise<void>;
}

export interface AuthProducerPort {
  establishFromObservedMaterial(material: ObservedAuthMaterial): Promise<{ kind: string }>;
  logout(): Promise<{ persistence: unknown }>;
}

export interface AuthObserverPort {
  observeNextAuthMaterial(options?: {
    readonly deadlineMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<
    | {
        readonly kind: "OBSERVED";
        readonly material: ObservedAuthMaterial;
        /**
         * The BT2 connection the material was observed on. Carried, never
         * dropped: the observer produces it precisely so the install boundary
         * can refuse material from a connection that has since been replaced.
         */
        readonly connectionGeneration: number;
      }
    | { readonly kind: "TIMED_OUT" }
    | { readonly kind: "CANCELLED" }
    | { readonly kind: "UNAVAILABLE" }
  >;
}

/**
 * Records that a HUMAN-authorized session exists in the dedicated profile, so
 * a later process may re-establish it silently. It stores no secret: only the
 * fact. Cleared before logout and on revocation, so neither can be undone by a
 * silent attempt.
 */
export interface SessionEligibilityPort {
  record(): Promise<void>;
  clear(): Promise<void>;
  /** Explicit logout; falls back to `clear` when absent. */
  recordLogout?(): Promise<void>;
}

export interface AuthOrchestratorPorts {
  readonly diagnostics: AuthDiagnosticsPort;
  readonly browser: BrowserPresencePort;
  readonly producer: AuthProducerPort;
  readonly observer: AuthObserverPort;
  readonly eligibility?: SessionEligibilityPort;
}

/** Why a silent re-establishment did not install a session. */
export type SilentEstablishOutcome =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "LOGGING_OUT" | "REAUTH_REQUIRED" | "NOT_ESTABLISHED" };

/** What the login tool reports. Safe readiness only — never a credential. */
export interface LoginOutcomeReport {
  readonly accepted: boolean;
  readonly readiness: ReadinessReport;
}

export interface LogoutOutcomeReport {
  readonly persistence: unknown;
  readonly readiness: ReadinessReport;
}

export interface AuthOrchestrator {
  readiness(): ReadinessReport;
  login(): Promise<LoginOutcomeReport>;
  logout(): Promise<LogoutOutcomeReport>;
  /**
   * The provider has told us the session must be re-established (a semantic
   * `invalid_grant`). It records a REASON, never an availability: the authority
   * remains the only source of truth for whether material is installed.
   */
  signalReauthRequired(): void;
  /**
   * Re-establish a previously authorized browser session WITHOUT waiting for a
   * human: the same closed observation as `login()`, bounded by a short
   * deadline. It never runs during logout or after a revocation, joins any
   * login already in flight, and never opens a second window. Deciding WHETHER
   * a silent attempt is appropriate belongs to the caller (session recovery).
   */
  establishSilently(options: { readonly observationDeadlineMs: number }): Promise<SilentEstablishOutcome>;
}

export function createAuthOrchestrator(ports: AuthOrchestratorPorts): AuthOrchestrator {
  /** Exclusive by construction: entering LOGGING_OUT twice is unrepresentable. */
  let logoutFlight: Promise<LogoutOutcomeReport> | undefined;
  /** Single-flight: a second login joins rather than opening a second window. */
  let loginFlight: Promise<LoginOutcomeReport> | undefined;
  /** Whether the flight above is a bounded silent attempt rather than an interactive one. */
  let loginFlightSilent = false;
  /** Set only by an explicit reauth signal, never by mere unavailability. */
  let reauthRequired = false;

  // ── BT4-R1: explicit login-attempt identity ───────────────────────────────
  //
  // The logout gate alone cannot decide whether an observation may install: it
  // is released when the logout finishes, so material belonging to a login the
  // logout cancelled could arrive afterwards and reinstall the authority. A
  // monotonic attempt id survives that, because it is never restored.
  let attemptSequence = 0;
  /** The ONLY attempt allowed to install. Bumped to cancel, never lowered. */
  let currentAttempt = 0;
  /** Cancellation for the in-flight attempt's observation. */
  let loginAbort: AbortController | undefined;

  /**
   * Cancel any in-flight login attempt, synchronously.
   *
   * Synchronous matters: the caller must be unable to await anything between
   * deciding to cancel and the cancellation taking effect, or an observation
   * could slip through that gap. After this returns, no attempt started before
   * it can ever install — whatever it later observes, and whenever it arrives.
   */
  const cancelActiveLogin = (): void => {
    currentAttempt = ++attemptSequence;
    loginAbort?.abort();
    loginAbort = undefined;
    // The dead attempt must stop claiming the gate: it can no longer succeed,
    // so it must neither report AUTHENTICATING nor absorb a later login.
    loginFlight = undefined;
    loginFlightSilent = false;
  };

  const browserFlags = (): { running: boolean; connected: boolean; degraded: boolean } => {
    const state = ports.browser.lifecycleState();
    return {
      running: state === "BROWSER_STARTING" || state === "BROWSER_READY" || state === "DEGRADED",
      connected: state === "BROWSER_READY",
      degraded: state === "DEGRADED",
    };
  };

  /**
   * Is authenticated work permitted right now (errata §10)? The authority is
   * the only source of truth, and the logout gate is the only override: during
   * it the authority is already invalidated, so reporting true would claim a
   * usable session at the exact moment it is being refused.
   *
   * A degraded browser deliberately does NOT revoke this: the installed
   * material is unexpired and the content path still uses it, so answering
   * false would be a fabricated logout.
   */
  const authenticatedWorkPermitted = (): boolean =>
    !logoutFlight && ports.diagnostics.availability() === "READY";

  const currentState = (): AuthOrchestrationState => {
    // Precedence is the frozen table in errata §6, read top to bottom.
    //
    // The logout gate outranks everything, because during it no authenticated
    // work is permitted regardless of what else is true. A degraded browser
    // comes next and matches ANY authority availability: the composite state
    // answers "is this transport healthy", so hiding a degraded browser behind
    // a still-valid credential would be the same dishonesty as the reverse.
    if (logoutFlight) return "LOGGING_OUT";
    if (browserFlags().degraded) return "DEGRADED";

    if (ports.diagnostics.availability() === "READY") {
      return ports.diagnostics.hasProfileId() ? "PROFILE_READY" : "ACCOUNT_READY";
    }
    // An attempt in flight is more informative than the reason it started.
    if (loginFlight) return "AUTHENTICATING";
    // Only an explicit signal — never mere unavailability — means REAUTH.
    if (reauthRequired) return "REAUTH_REQUIRED";
    return "LOGIN_REQUIRED";
  };

  const readiness = (): ReadinessReport => {
    const state = currentState();
    const flags = browserFlags();
    const authenticated = authenticatedWorkPermitted();
    return Object.freeze({
      authenticated,
      logged_in: authenticated,
      browser_running: flags.running,
      browser_connected: flags.connected,
      auth_state: state,
      profile_ready: authenticated && ports.diagnostics.hasProfileId(),
      // BT10 owns the player. BT4 has no truthful source for `true`, and
      // fabricating one would be worse than reporting the honest false.
      player_ready: false,
    });
  };

  /**
   * The login decision. Readiness is deliberately NOT computed here: the login
   * gate is still held at this point, so reporting from inside would answer
   * AUTHENTICATING for an attempt that has already finished. The caller
   * releases the gate first and then reports the exit state.
   *
   * Every `await` below is a place where the world may have moved on, so the
   * attempt revalidates itself after each one and immediately before the only
   * irreversible step (BT4-R1).
   */
  const runLoginDecision = async (
    attempt: number,
    signal: AbortSignal,
    observationDeadlineMs?: number,
  ): Promise<boolean> => {
    /** Is this attempt still the one allowed to act? */
    const current = (): boolean => attempt === currentAttempt && !signal.aborted && !logoutFlight;

    try {
      await ports.browser.openLoginSurface();
    } catch {
      // No browser, no interactive login. Honest, safe, and no retry loop.
      return false;
    }
    if (!current()) return false;

    const observed = await ports.observer.observeNextAuthMaterial(
      observationDeadlineMs === undefined ? { signal } : { signal, deadlineMs: observationDeadlineMs },
    );
    // Timeout, cancel or an unavailable channel all return the caller to an
    // explicit state; none of them is an error the model must interpret.
    if (observed.kind !== "OBSERVED") return false;

    // The staleness gate. A logout — in flight OR already finished — a newer
    // attempt, or an explicit cancellation all make this material dead, and it
    // must be dropped rather than installed.
    if (!current()) return false;

    // The connection the material was observed on must still be the live one.
    // A reconnect mints a new generation, so material from before it belongs
    // to a session that no longer exists; no live connection at all is the
    // same refusal.
    const liveGeneration = ports.browser.connectionGeneration();
    if (liveGeneration === undefined || liveGeneration !== observed.connectionGeneration) {
      return false;
    }

    const installed = await ports.producer.establishFromObservedMaterial(observed.material);
    if (installed.kind === "ESTABLISHED") {
      reauthRequired = false;
      // Best effort and secret-free. A failure only costs a future silent
      // attempt; it can never make the installed session less valid.
      if (current()) await ports.eligibility?.record().catch(() => undefined);
      return true;
    }
    return false;
  };

  /** Start one attempt and hold the gate for it. The caller has checked the gate is free. */
  const startAttempt = (silent: boolean, observationDeadlineMs?: number): Promise<LoginOutcomeReport> => {
    const attempt = ++attemptSequence;
    currentAttempt = attempt;
    const abort = new AbortController();
    loginAbort = abort;

    const run = async (): Promise<LoginOutcomeReport> => {
      let accepted = false;
      try {
        accepted = await runLoginDecision(attempt, abort.signal, observationDeadlineMs);
      } finally {
        // Release the gate BEFORE reporting, so the answer is the exit state
        // — but only if it is still ours. A cancelled attempt that finishes
        // late must not clear the gate a newer attempt now holds.
        if (currentAttempt === attempt) {
          loginFlight = undefined;
          loginFlightSilent = false;
          loginAbort = undefined;
        }
      }
      return Object.freeze({ accepted, readiness: readiness() });
    };

    loginFlightSilent = silent;
    loginFlight = run();
    return loginFlight;
  };

  const orchestrator: AuthOrchestrator = {
    readiness,

    signalReauthRequired(): void {
      reauthRequired = true;
      void ports.eligibility?.clear().catch(() => undefined);
    },

    async login(): Promise<LoginOutcomeReport> {
      // Login can never race a logout transaction: it is refused immediately
      // with the honest state rather than queued.
      if (logoutFlight) return Object.freeze({ accepted: false, readiness: readiness() });

      if (authenticatedWorkPermitted()) {
        // Already authenticated: do not reopen a login page. This asks the
        // authority, not the composite state, so a degraded browser cannot
        // trick us into a second window for a session that is still live.
        return Object.freeze({ accepted: true, readiness: readiness() });
      }

      // A bounded silent attempt is already on the page the human would use.
      // Join it; if it ends without a session, the interactive wait starts
      // here instead of the human receiving the silent attempt's short timeout.
      if (loginFlight && loginFlightSilent) {
        const silent = await loginFlight;
        if (silent.accepted || logoutFlight) return silent;
        return orchestrator.login();
      }

      // Idempotent: a second call joins the first and opens no second window.
      if (loginFlight) return loginFlight;

      return startAttempt(false);
    },

    async establishSilently(options): Promise<SilentEstablishOutcome> {
      if (logoutFlight) return Object.freeze({ accepted: false as const, reason: "LOGGING_OUT" as const });
      if (authenticatedWorkPermitted()) return Object.freeze({ accepted: true as const });
      // A revocation is the provider's decision; only a human login undoes it.
      if (reauthRequired) return Object.freeze({ accepted: false as const, reason: "REAUTH_REQUIRED" as const });
      const flight = loginFlight ?? startAttempt(true, Math.max(1, options.observationDeadlineMs));
      const outcome = await flight;
      return outcome.accepted
        ? Object.freeze({ accepted: true as const })
        : Object.freeze({ accepted: false as const, reason: logoutFlight ? "LOGGING_OUT" as const : "NOT_ESTABLISHED" as const });
    },

    async logout(): Promise<LogoutOutcomeReport> {
      // A concurrent logout joins the in-flight transaction and shares its
      // result rather than starting a second one.
      if (logoutFlight) return logoutFlight;

      // BT4-R1: kill any login attempt BEFORE anything can be awaited. The
      // logout gate protects only the window it is held for; this is what
      // protects everything after it.
      cancelActiveLogin();

      const run = async (): Promise<LogoutOutcomeReport> => {
        let persistence: unknown;
        try {
          // Eligibility goes first: a logout interrupted at any later point must
          // still leave nothing a silent attempt could re-establish.
          const eligibility = ports.eligibility;
          await (eligibility?.recordLogout ? eligibility.recordLogout() : eligibility?.clear())?.catch(() => undefined);
          // The authority is invalidated inside the producer BEFORE any
          // filesystem work; a failed or partial clear can never restore it.
          persistence = (await ports.producer.logout()).persistence;
        } finally {
          // Release the gate BEFORE computing the exit readiness, so the
          // reported state is the exit state and not the transient one. A
          // concurrent caller during the await still joined this transaction.
          logoutFlight = undefined;
        }
        // Exit is never a previous ready state: the authority is gone, so the
        // derived state is LOGIN_REQUIRED.
        reauthRequired = false;
        return Object.freeze({ persistence, readiness: readiness() });
      };

      logoutFlight = run();
      return logoutFlight;
    },
  };
  return orchestrator;
}
