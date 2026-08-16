// BT4 — the trusted auth producer.
//
// Orchestration ONLY. It owns ordering and translation between the existing
// hardened auth lifecycle and the closed BT3 authority; it owns no secret
// storage, no live authority state, no network client and no MCP surface.
//
// It deliberately imports NOTHING from `auth-context.ts`. The writer arrives by
// injection, declared structurally below, which is exactly what BT3 §27
// specifies ("BT4 will receive only a restricted writer port from the
// composition root; it will not receive the authority object") and what keeps
// BT3's frozen unreachability closure intact. See CRUNCHYROLL-BT4-DESIGN.md §3.
//
// Frozen design: CRUNCHYROLL-BT4-DESIGN.md.

import { clearAuthData, isTokenExpired, loadTokens } from "../auth.js";
import type { LogoutResult, TokenData } from "../auth.js";
import { getStatus, login, refreshRequest } from "../api.js";

// ── The injected ports (design §5) ──────────────────────────────────────────

export interface AuthRevisionSnapshot {
  readonly epoch: string;
  readonly generation: number;
}

/**
 * The BT3 writer, structurally. The commit result is typed `unknown` on
 * purpose: BT4 must never consume an AuthContext, and a port that cannot name
 * the type cannot accidentally start using it.
 */
export interface AuthWriterPort {
  currentRevision(): AuthRevisionSnapshot;
  commitAuthenticatedMaterial(
    expected: AuthRevisionSnapshot,
    mode: "ESTABLISH" | "REFRESH",
    candidate: Readonly<{
      accessToken: string;
      tokenType: string;
      expiresAt: number;
      accountId: string;
      profileId?: string;
    }>
  ): unknown;
  invalidate(
    cause: "LOGOUT" | "INVALID_GRANT" | "AUTH_MATERIAL_LOST" | "PROCESS_SHUTDOWN"
  ): AuthRevisionSnapshot;
}

/** The persisted-material shape BT4 consumes. Satisfied by auth.ts TokenData. */
export interface TokenLike {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly token_type: string;
  readonly account_id: string;
  readonly profile_id?: string;
}

export interface AuthStoragePort {
  loadTokens(): Promise<TokenLike | null>;
  clearAuthData(): Promise<LogoutResult>;
  isTokenExpired(tokens: TokenLike): boolean;
}

export interface AuthStatusShape {
  logged_in?: boolean;
  email?: string;
  account_id?: string;
  token_expires_at?: string;
}

export interface LegacyAuthPort {
  login(email: string, password: string): Promise<{ success: boolean; message: string }>;
  refreshRequest(tokens: TokenLike): Promise<TokenLike>;
  getStatus(): Promise<AuthStatusShape>;
}

export interface AuthProducerPorts {
  readonly writer: AuthWriterPort;
  readonly storage: AuthStoragePort;
  readonly legacy: LegacyAuthPort;
}

// ── Closed outcomes (design §15) ────────────────────────────────────────────
//
// No message, no provider body, no token, no password, no account or profile
// identifier, no filesystem path. A closed kind is the whole result.

export type AuthorityRejection = "STALE" | "UNAVAILABLE" | "IDENTITY_CHANGED";

export type LoginOutcome =
  | { readonly kind: "ESTABLISHED" }
  | { readonly kind: "LOGIN_FAILED" }
  | { readonly kind: "MATERIAL_UNAVAILABLE" }
  | { readonly kind: "AUTHORITY_REJECTED"; readonly reason: AuthorityRejection };

/**
 * Refresh outcomes. `TRANSIENT`, `FAILED` and `NO_MATERIAL` are explicitly NOT
 * authority transitions: the current material stays exactly as it was.
 */
export type RefreshOutcome =
  | { readonly kind: "REFRESHED" }
  | { readonly kind: "NO_MATERIAL" }
  | { readonly kind: "STALE" }
  | { readonly kind: "IDENTITY_CHANGED" }
  | { readonly kind: "UNAVAILABLE" }
  | { readonly kind: "REAUTH_REQUIRED" }
  | { readonly kind: "TRANSIENT" }
  | { readonly kind: "FAILED" };

export type AuthorityInvalidation = "INVALIDATED" | "ALREADY_TERMINAL";

/**
 * Logout keeps the two layers separate on purpose: live authority invalidation
 * and hardened persistence cleanup are different failure domains, and the
 * structured `LogoutResult` is passed through verbatim rather than collapsed
 * into a generic auth error.
 */
export interface LogoutOutcome {
  readonly authority: AuthorityInvalidation;
  readonly persistence: LogoutResult;
}

export interface ShutdownOutcome {
  readonly authority: AuthorityInvalidation;
}

export type BootstrapOutcome =
  | { readonly kind: "ESTABLISHED" }
  | { readonly kind: "NO_MATERIAL" }
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "STORAGE_UNUSABLE" }
  | { readonly kind: "AUTHORITY_REJECTED"; readonly reason: AuthorityRejection };

export interface AuthProducer {
  establishFromLogin(email: string, password: string): Promise<LoginOutcome>;
  refresh(): Promise<RefreshOutcome>;
  logout(): Promise<LogoutOutcome>;
  bootstrapFromStorage(): Promise<BootstrapOutcome>;
  invalidateForShutdown(): ShutdownOutcome;
  status(): Promise<AuthStatusShape>;
}

// ── Validated material ──────────────────────────────────────────────────────

interface ValidatedCandidate {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresAt: number;
  readonly accountId: string;
  readonly profileId?: string;
}

type MaterialRead =
  | { readonly kind: "OK"; readonly candidate: ValidatedCandidate }
  | { readonly kind: "ABSENT" }
  | { readonly kind: "INVALID" }
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "UNUSABLE" };

const AUTH_CONTEXT_ERROR_KINDS: readonly string[] = Object.freeze([
  "AUTH_CONTEXT_UNAVAILABLE",
  "AUTH_CONTEXT_STALE",
  "AUTH_IDENTITY_CHANGED",
]);

function isUsableString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Classify a BT3 rejection structurally.
 *
 * `instanceof` is unavailable without importing the authority module, and a
 * TypeScript union does not exist at runtime, so the discriminant is read once
 * and checked against a runtime allowlist. Anything unrecognised fails closed
 * as UNAVAILABLE — BT4 never treats an unknown failure as success.
 */
const REFRESH_FAILURE_KINDS: readonly string[] = Object.freeze([
  "REAUTH_REQUIRED",
  "TRANSIENT",
  "SAFE_FAILURE",
  "MALFORMED_RESPONSE",
]);

/**
 * Classify a legacy `RefreshError` structurally, by the same runtime-allowlist
 * rule used for authority rejections. Anything unrecognised is treated as the
 * conservative class: no authority transition, current material preserved.
 */
function classifyRefreshFailure(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (name === "RefreshError" && typeof kind === "string" && REFRESH_FAILURE_KINDS.includes(kind)) {
    return kind;
  }
  return "SAFE_FAILURE";
}

function classifyAuthorityRejection(error: unknown): AuthorityRejection {
  const name = (error as { name?: unknown } | null)?.name;
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (name === "AuthContextError" && typeof kind === "string" && AUTH_CONTEXT_ERROR_KINDS.includes(kind)) {
    if (kind === "AUTH_CONTEXT_STALE") return "STALE";
    if (kind === "AUTH_IDENTITY_CHANGED") return "IDENTITY_CHANGED";
    return "UNAVAILABLE";
  }
  return "UNAVAILABLE";
}

class AuthProducerImpl implements AuthProducer {
  constructor(private readonly ports: AuthProducerPorts) {}

  /**
   * Login → ESTABLISH (design §6).
   *
   * Persistence precedes authority deliberately: the authority is process-local
   * and reconstructible from hardened storage, while storage is durable.
   * Authority-first would let a crash leave a live context with no durable
   * backing; this order can only produce persisted-but-not-yet-live, which the
   * next bootstrap or refresh repairs.
   *
   * The password and email never leave the legacy login boundary. They are not
   * retained here, never enter a candidate, and never reach the authority.
   */
  async establishFromLogin(email: string, password: string): Promise<LoginOutcome> {
    const result = await this.ports.legacy.login(email, password);

    // Read the discriminant once, and require the real boolean: a truthy
    // non-boolean must not be mistaken for a successful authentication.
    const succeeded = (result as { success?: unknown } | null)?.success;
    if (succeeded !== true) {
      return Object.freeze({ kind: "LOGIN_FAILED" as const });
    }

    // Capture the expected revision BEFORE any untrusted read. A stored
    // document may be a hostile object whose getters reenter the authority; if
    // the revision were captured afterwards it would already contain that
    // transition and the commit would silently overwrite it. This is the
    // closed BT3-R1 lesson applied one layer out.
    const expected = this.ports.writer.currentRevision();

    const material = await this.readValidatedMaterial();
    if (material.kind !== "OK") {
      return Object.freeze({ kind: "MATERIAL_UNAVAILABLE" as const });
    }

    const rejection = this.commit(expected, "ESTABLISH", material.candidate);
    return rejection === null
      ? Object.freeze({ kind: "ESTABLISHED" as const })
      : Object.freeze({ kind: "AUTHORITY_REJECTED" as const, reason: rejection });
  }

  /**
   * Refresh → REFRESH (design §7).
   *
   * The existing process-local single-flight in `src/api.ts` is preserved and
   * not refactored: it deduplicates a *request*, and is not the authority, not
   * a generation, not a lock and not an AuthContext. BT4 adds no second
   * deduplication layer — two concurrent refreshes share one request, and BT3's
   * compare-and-swap ensures only one of them becomes a transition.
   */
  async refresh(): Promise<RefreshOutcome> {
    // Captured before the network await, so a logout or a newer commit landing
    // while the request is in flight is detected rather than overwritten.
    const expected = this.ports.writer.currentRevision();

    let stored: TokenLike | null;
    try {
      stored = await this.ports.storage.loadTokens();
    } catch {
      return Object.freeze({ kind: "NO_MATERIAL" as const });
    }
    if (stored === null || stored === undefined) {
      return Object.freeze({ kind: "NO_MATERIAL" as const });
    }

    let refreshed: TokenLike;
    try {
      // The stored document is passed through by reference: the refresh token
      // it carries stays owned by the legacy path and hardened storage, and is
      // never copied out into a candidate here.
      refreshed = await this.ports.legacy.refreshRequest(stored);
    } catch (error) {
      return this.handleRefreshFailure(error);
    }

    const material = this.validateMaterial(refreshed);
    if (material.kind !== "OK") {
      // A malformed or unusable payload leaves the current record installed.
      return Object.freeze({ kind: "FAILED" as const });
    }

    const rejection = this.commit(expected, "REFRESH", material.candidate);
    if (rejection === null) return Object.freeze({ kind: "REFRESHED" as const });
    if (rejection === "STALE") return Object.freeze({ kind: "STALE" as const });
    if (rejection === "IDENTITY_CHANGED") {
      // BT3 owns the single identity-continuity rule and has already
      // invalidated. BT4 does not compare identities itself, does not work
      // around the refusal, and never auto-establishes the new identity.
      return Object.freeze({ kind: "IDENTITY_CHANGED" as const });
    }
    return Object.freeze({ kind: "UNAVAILABLE" as const });
  }

  /**
   * Translate a legacy refresh failure.
   *
   * `REAUTH_REQUIRED` (semantic invalid_grant) is the only class that touches
   * the authority, and it invalidates FIRST — before any producer-owned
   * asynchronous persistence work — so a slow or failing clear can never leave
   * an old context usable. A PARTIAL or FAILED clear never resurrects it.
   */
  private async handleRefreshFailure(error: unknown): Promise<RefreshOutcome> {
    const kind = classifyRefreshFailure(error);

    if (kind !== "REAUTH_REQUIRED") {
      // TRANSIENT / SAFE_FAILURE / MALFORMED_RESPONSE and anything
      // unrecognised: the exact current record stays installed and usable, and
      // the generation does not move.
      return Object.freeze({
        kind: (kind === "TRANSIENT" ? "TRANSIENT" : "FAILED") as "TRANSIENT" | "FAILED",
      });
    }

    try {
      this.ports.writer.invalidate("INVALID_GRANT");
    } catch {
      // An already-terminal authority is still unavailable, which is the
      // outcome this path wants; the cleanup below must still run.
    }
    await this.ports.storage.clearAuthData();
    return Object.freeze({ kind: "REAUTH_REQUIRED" as const });
  }

  /**
   * Logout (design §9). The live authority is invalidated synchronously, before
   * any filesystem work, so a slow, partial or failing clear can never leave an
   * old context usable — and can never restore one either.
   *
   * The structured `LogoutResult` is returned verbatim: BT4 owns no second
   * outcome matrix and never collapses CLEARED / ALREADY_ABSENT / PARTIAL /
   * FAILED or a per-artifact reason into a generic auth error.
   */
  async logout(): Promise<LogoutOutcome> {
    const authority = this.invalidateNow("LOGOUT");
    const persistence = await this.ports.storage.clearAuthData();
    return Object.freeze({ authority, persistence });
  }

  /**
   * Startup bootstrap (design §11). Nothing is trusted merely because a file
   * exists: the material is loaded and validated OUTSIDE the authority, the
   * revision is captured, and installation is an explicit ESTABLISH through the
   * same compare-and-swap every other producer transition uses.
   */
  async bootstrapFromStorage(): Promise<BootstrapOutcome> {
    const expected = this.ports.writer.currentRevision();
    const material = await this.readValidatedMaterial();

    switch (material.kind) {
      case "ABSENT":
        return Object.freeze({ kind: "NO_MATERIAL" as const });
      case "EXPIRED":
        return Object.freeze({ kind: "EXPIRED" as const });
      case "INVALID":
      case "UNUSABLE":
        // A corrupt, insecure or foreign-owned store stays unusable. It is
        // never silently downgraded into "logged out", which would let a
        // planted or broken file hide the real state.
        return Object.freeze({ kind: "STORAGE_UNUSABLE" as const });
      default:
        break;
    }

    const rejection = this.commit(expected, "ESTABLISH", material.candidate);
    return rejection === null
      ? Object.freeze({ kind: "ESTABLISHED" as const })
      : Object.freeze({ kind: "AUTHORITY_REJECTED" as const, reason: rejection });
  }

  /**
   * Process shutdown (design §14). Invalidates the live authority and does NOT
   * touch persistence: shutting down is not logging out, and destroying stored
   * credentials on exit would be a data-loss bug, not a security measure.
   */
  invalidateForShutdown(): ShutdownOutcome {
    return Object.freeze({ authority: this.invalidateNow("PROCESS_SHUTDOWN") });
  }

  /**
   * Status (design §10). Deliberately never touches the writer — not even
   * `currentRevision`. Not calling the authority at all is a stronger
   * read-only proof than calling it carefully, and it guarantees that no
   * epoch, generation or context can reach the public result.
   */
  async status(): Promise<AuthStatusShape> {
    return this.ports.legacy.getStatus();
  }

  /** Invalidate now, reporting a terminal authority instead of throwing. */
  private invalidateNow(
    cause: "LOGOUT" | "INVALID_GRANT" | "AUTH_MATERIAL_LOST" | "PROCESS_SHUTDOWN"
  ): AuthorityInvalidation {
    try {
      this.ports.writer.invalidate(cause);
      return "INVALIDATED";
    } catch {
      // An exhausted authority is already permanently unavailable, which is
      // exactly the state these callers want; the caller's own cleanup still
      // has to run.
      return "ALREADY_TERMINAL";
    }
  }

  /** Commit and translate. No retry, ever — a rejection is a result. */
  private commit(
    expected: AuthRevisionSnapshot,
    mode: "ESTABLISH" | "REFRESH",
    candidate: ValidatedCandidate
  ): AuthorityRejection | null {
    try {
      this.ports.writer.commitAuthenticatedMaterial(expected, mode, candidate);
    } catch (error) {
      return classifyAuthorityRejection(error);
    }
    return null;
  }

  /**
   * Read the persisted material and reduce it to validated local primitives.
   *
   * Each authorized field is read AT MOST ONCE. The stored document crosses a
   * trust boundary and may carry getters or Proxy traps, so validating one read
   * and committing another would be exactly the vulnerability BT3-R1 closed.
   * The refresh token is never among the fields read into a candidate.
   */
  private async readValidatedMaterial(): Promise<MaterialRead> {
    let stored: TokenLike | null;
    try {
      stored = await this.ports.storage.loadTokens();
    } catch {
      // A structured storage failure (corrupt, insecure, foreign owner) is
      // never downgraded to "logged out": it stays unusable and installs
      // nothing.
      return { kind: "UNUSABLE" };
    }
    if (stored === null || stored === undefined) return { kind: "ABSENT" };
    return this.validateMaterial(stored);
  }

  /**
   * Reduce one crossing document to validated local primitives.
   *
   * Each authorized field is read AT MOST ONCE. Persisted documents and
   * provider-derived material both cross a trust boundary and may carry getters
   * or Proxy traps, so validating one read and committing another would be
   * exactly the vulnerability BT3-R1 closed. The refresh token is never among
   * the fields read into a candidate.
   */
  private validateMaterial(stored: TokenLike): MaterialRead {
    const accessToken: unknown = stored.access_token;
    const tokenType: unknown = stored.token_type;
    const expiresAt: unknown = stored.expires_at;
    const accountId: unknown = stored.account_id;
    const profileId: unknown = stored.profile_id;

    if (!isUsableString(accessToken)) return { kind: "INVALID" };
    if (!isUsableString(tokenType)) return { kind: "INVALID" };
    if (!isUsableString(accountId)) return { kind: "INVALID" };

    let profile: string | undefined;
    if (profileId !== undefined) {
      if (!isUsableString(profileId)) return { kind: "INVALID" };
      profile = profileId;
    }

    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
      return { kind: "INVALID" };
    }

    // Expiry is evaluated on the validated snapshot, never by re-reading the
    // stored object. It is a usability condition, not an authority transition:
    // BT4 adds no timer and no competing expiration state machine.
    if (this.ports.storage.isTokenExpired({ ...EMPTY_TOKEN, expires_at: expiresAt })) {
      return { kind: "EXPIRED" };
    }

    const candidate: ValidatedCandidate = Object.freeze(
      profile === undefined
        ? { accessToken, tokenType, expiresAt, accountId }
        : { accessToken, tokenType, expiresAt, accountId, profileId: profile }
    );
    return { kind: "OK", candidate };
  }
}

/**
 * A neutral carrier for the expiry predicate. The existing `isTokenExpired`
 * reads only `expires_at`; passing a synthesized object rather than the stored
 * one keeps the hostile document from being re-entered a second time.
 */
const EMPTY_TOKEN: TokenLike = Object.freeze({
  access_token: "",
  refresh_token: "",
  expires_at: 0,
  token_type: "",
  account_id: "",
});

export function createAuthProducer(ports: AuthProducerPorts): AuthProducer {
  return new AuthProducerImpl(ports);
}

/**
 * Bind the storage and legacy ports to the real project functions.
 *
 * This is the concrete adapter, not a placeholder: it is a compile-time proof
 * that `src/auth.ts` and `src/api.ts` genuinely satisfy the consumed contracts,
 * and it reduces the deferred composition wiring (BT4-D1) to instantiating one
 * authority and calling this with its `asWriter()` port.
 *
 * The network-facing auth logic is ADAPTED, never duplicated: login, the
 * single-flight refresh and status remain owned by `src/api.ts`, and hardened
 * persistence remains owned by `src/auth.ts`. There is no second competing
 * implementation of either.
 */
export function createDefaultAuthProducerPorts(writer: AuthWriterPort): AuthProducerPorts {
  return Object.freeze({
    writer,
    storage: Object.freeze({
      loadTokens,
      clearAuthData,
      isTokenExpired,
    }),
    legacy: Object.freeze({
      login,
      refreshRequest,
      getStatus,
    }),
  });
}

/** Compile-time proof that auth.ts's TokenData satisfies the consumed shape. */
export type TokenDataSatisfiesTokenLike = TokenData extends TokenLike ? true : never;
