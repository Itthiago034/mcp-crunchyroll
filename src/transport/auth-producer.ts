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

import type { LogoutResult, TokenData } from "../auth.js";

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

export interface AuthProducer {
  establishFromLogin(email: string, password: string): Promise<LoginOutcome>;
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

    return this.commit(expected, "ESTABLISH", material.candidate);
  }

  /** Commit and translate. No retry, ever — a rejection is a result. */
  private commit(
    expected: AuthRevisionSnapshot,
    mode: "ESTABLISH" | "REFRESH",
    candidate: ValidatedCandidate
  ): LoginOutcome {
    try {
      this.ports.writer.commitAuthenticatedMaterial(expected, mode, candidate);
    } catch (error) {
      return Object.freeze({
        kind: "AUTHORITY_REJECTED" as const,
        reason: classifyAuthorityRejection(error),
      });
    }
    return Object.freeze({ kind: "ESTABLISHED" as const });
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

/** Compile-time proof that auth.ts's TokenData satisfies the consumed shape. */
export type TokenDataSatisfiesTokenLike = TokenData extends TokenLike ? true : never;
