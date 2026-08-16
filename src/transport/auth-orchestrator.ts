// BT4 — auth orchestration.
//
// Owns interactive-login and logout ORCHESTRATION only: the login gate, the
// exclusive logout gate, and the honest composite readiness report. It
// duplicates no BT3 state machine (the authority remains READY/UNAVAILABLE
// internally) and no BT2 lifecycle (the browser remains BT2's).
//
// No state here may imply authentication merely because a browser exists.
//
// Frozen design: CRUNCHYROLL-BT4-COMPLETION-ERRATA.md §6, §7, §10.

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
    | { readonly kind: "OBSERVED"; readonly material: ObservedAuthMaterial }
    | { readonly kind: "TIMED_OUT" }
    | { readonly kind: "CANCELLED" }
    | { readonly kind: "UNAVAILABLE" }
  >;
}

export interface AuthOrchestratorPorts {
  readonly diagnostics: AuthDiagnosticsPort;
  readonly browser: BrowserPresencePort;
  readonly producer: AuthProducerPort;
  readonly observer: AuthObserverPort;
}

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
}

export function createAuthOrchestrator(ports: AuthOrchestratorPorts): AuthOrchestrator {
  /** Exclusive by construction: entering LOGGING_OUT twice is unrepresentable. */
  let logoutFlight: Promise<LogoutOutcomeReport> | undefined;
  /** Single-flight: a second login joins rather than opening a second window. */
  let loginFlight: Promise<LoginOutcomeReport> | undefined;
  /** Set only by an explicit reauth signal, never by mere unavailability. */
  let reauthRequired = false;

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
   */
  const runLoginDecision = async (): Promise<boolean> => {
    try {
      await ports.browser.openLoginSurface();
    } catch {
      // No browser, no interactive login. Honest, safe, and no retry loop.
      return false;
    }

    const observed = await ports.observer.observeNextAuthMaterial();
    // Timeout, cancel or an unavailable channel all return the caller to an
    // explicit state; none of them is an error the model must interpret.
    if (observed.kind !== "OBSERVED") return false;

    // A logout that landed while the human was typing wins: the observation is
    // stale and must never reinstall the session.
    if (logoutFlight) return false;

    const installed = await ports.producer.establishFromObservedMaterial(observed.material);
    if (installed.kind === "ESTABLISHED") {
      reauthRequired = false;
      return true;
    }
    return false;
  };

  return {
    readiness,

    signalReauthRequired(): void {
      reauthRequired = true;
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

      // Idempotent: a second call joins the first and opens no second window.
      if (loginFlight) return loginFlight;

      const run = async (): Promise<LoginOutcomeReport> => {
        let accepted = false;
        try {
          accepted = await runLoginDecision();
        } finally {
          // Release the gate BEFORE reporting, so the answer is the exit state.
          loginFlight = undefined;
        }
        return Object.freeze({ accepted, readiness: readiness() });
      };

      loginFlight = run();
      return loginFlight;
    },

    async logout(): Promise<LogoutOutcomeReport> {
      // A concurrent logout joins the in-flight transaction and shares its
      // result rather than starting a second one.
      if (logoutFlight) return logoutFlight;

      const run = async (): Promise<LogoutOutcomeReport> => {
        let persistence: unknown;
        try {
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
}
