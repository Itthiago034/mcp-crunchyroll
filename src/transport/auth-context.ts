// BT3 — the process-local authentication authority.
//
// Owns the opaque AuthContext capability, the (epoch, generation) revision
// domain and the closed auth error vocabulary. It performs NO login, refresh,
// logout persistence, network call, browser work or cookie handling, and it is
// NOT wired into any MCP tool: BT3 remains caller-unreachable, exactly like
// BT1's registry and BT2's lifecycle before their own cutover gates.
//
// Frozen design: CRUNCHYROLL-BT3-DESIGN-GATE0.md, corrected by
// CRUNCHYROLL-BT3-DESIGN-GATE0-FIX1-ERRATA.md.

import { randomBytes } from "node:crypto";

// ── Closed error vocabulary (design §20) ────────────────────────────────────

/**
 * Three kinds, no more. `AUTH_GENERATION_MISMATCH` is deliberately absent:
 * every mismatch is staleness, and a second name for it would invite callers
 * to treat one of them as retryable.
 */
export type AuthContextErrorKind =
  | "AUTH_CONTEXT_UNAVAILABLE"
  | "AUTH_CONTEXT_STALE"
  | "AUTH_IDENTITY_CHANGED";

const FIXED_MESSAGES: Record<AuthContextErrorKind, string> = {
  AUTH_CONTEXT_UNAVAILABLE: "Authentication context is unavailable",
  AUTH_CONTEXT_STALE: "Authentication context is stale",
  AUTH_IDENTITY_CHANGED: "Authentication identity changed unexpectedly",
};

/**
 * Follows the project convention (TransportError.kind, StorageError.state): a
 * readonly discriminant plus a fixed, secret-free message.
 *
 * Unlike TransportError there is no `detail` field. A detail string is a
 * channel, and everything this class could describe — a token, an account or
 * profile id, an epoch, a provider body, a filesystem path, an underlying cause
 * — is exactly what must never cross the authority boundary (design §20).
 */
export class AuthContextError extends Error {
  constructor(public readonly kind: AuthContextErrorKind) {
    super(FIXED_MESSAGES[kind]);
    this.name = "AuthContextError";
  }
}

// ── The opaque capability (design §9.1) ─────────────────────────────────────

declare const authContextBrand: unique symbol;

/**
 * An immutable, opaque, process-local capability handle. It is permanently
 * bound to ONE authority revision.
 *
 * The brand is module-private and ambient, so no code outside this file can
 * name it, construct a value of this type, or rehydrate one from JSON. The
 * brand is a compile-time guard only — it is erased at runtime and is never
 * trusted on its own. Runtime acceptance is issuance membership plus current
 * record identity (see `isAcceptable`).
 */
export interface AuthContext {
  readonly [authContextBrand]: true;
}

// ── Revision domain (design §10, §11) ───────────────────────────────────────

export interface AuthRevisionView {
  readonly epoch: string;
  readonly generation: number;
}

/** Generation is a safe integer scoped to one epoch; it never wraps. */
export const MAX_AUTH_GENERATION = Number.MAX_SAFE_INTEGER;

/**
 * Two revision views name the same authority revision only when BOTH the epoch
 * and the generation match.
 *
 * Equality proves nothing else: not that a handle was issued here, not that it
 * is still current, not that its material is usable, not that it belongs to a
 * given account. Every authorization decision therefore checks capability
 * identity, never a caller-presented number (design §10).
 */
export function revisionsEqual(a: AuthRevisionView, b: AuthRevisionView): boolean {
  return a.epoch === b.epoch && a.generation === b.generation;
}

/**
 * The single increment rule. At the maximum, the authority is exhausted rather
 * than wrapped or reset: recovery requires a process restart, which mints a
 * different epoch. Callers must publish the terminal EXHAUSTED state before
 * letting this rejection escape (design §10, FIX1 §8).
 */
export function nextGeneration(current: number): number {
  if (current >= MAX_AUTH_GENERATION) {
    throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
  }
  return current + 1;
}

/** Fresh 128-bit process epoch, 32 lowercase hex characters (design §11). */
function createProcessEpoch(): string {
  return randomBytes(16).toString("hex");
}

// ── Authority state (design §16.1) ──────────────────────────────────────────

export type AuthUnavailableReason = "INITIAL" | "INVALIDATED" | "LOAD_FAILED" | "EXHAUSTED";
export type AuthAvailability = "READY" | "UNAVAILABLE";

/**
 * The private secret-bearing record. The current `AuthorityState` is the SOLE
 * authority-owned root for it: there is no handle-to-record lookup table, so
 * capability bookkeeping cannot keep a historical record reachable (FIX1 §5).
 */
interface ActiveAuthRecord {
  readonly revision: AuthRevisionView;
  readonly accountId: string;
  readonly profileId?: string;
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresAt: number;
  readonly abortController: AbortController;
  readonly context: AuthContext;
}

/**
 * There is deliberately no INVALIDATING state: invalidation commits
 * synchronously before any asynchronous cleanup, so the observable state is
 * already UNAVAILABLE by the time anyone can look (design §16.1).
 */
type AuthorityState =
  | { readonly kind: "UNAVAILABLE"; readonly revision: AuthRevisionView; readonly reason: AuthUnavailableReason }
  | { readonly kind: "READY"; readonly record: ActiveAuthRecord };

/** Safe structured diagnostics: no epoch, no identity, no material (design §19). */
export interface AuthDiagnostics {
  readonly availability: AuthAvailability;
  readonly generation: number;
  readonly reason?: AuthUnavailableReason;
  readonly hasProfileId: boolean;
}

// ── Deterministic seams (design §7.10, §11, §24) ────────────────────────────

/**
 * Test seams only. Production constructs the authority with no arguments: the
 * epoch is minted from `randomBytes`, never accepted from caller input or the
 * environment, and the generation always starts at 0.
 */
export interface AuthAuthoritySeams {
  readonly epochFactory?: () => string;
  readonly now?: () => number;
  /** Deterministic starting generation, for overflow tests only. */
  readonly initialGeneration?: number;
}

export class AuthContextAuthority {
  /**
   * Issuance-only bookkeeping (FIX1 §5). It records ONLY that this authority
   * created an object — no token, identity, revision, controller, execution
   * view or record is associated with the key. A WeakMap keyed by AuthContext
   * is forbidden by the frozen design precisely because its value would keep a
   * historical secret-bearing record reachable from a retained stale handle.
   */
  private readonly issuedContexts = new WeakSet<AuthContext>();

  private state: AuthorityState;

  private readonly epoch: string;
  private readonly now: () => number;

  constructor(seams: AuthAuthoritySeams = {}) {
    this.epoch = seams.epochFactory ? seams.epochFactory() : createProcessEpoch();
    this.now = seams.now ?? Date.now;

    const startGeneration = seams.initialGeneration ?? 0;
    if (!Number.isInteger(startGeneration) || startGeneration < 0 || startGeneration > MAX_AUTH_GENERATION) {
      throw new RangeError("initialGeneration must be a safe non-negative integer");
    }

    // A process always starts unavailable: BT3 performs no storage bootstrap.
    // Establishing material is an explicit, trusted producer action (design §16.3).
    this.state = {
      kind: "UNAVAILABLE",
      revision: freezeRevision(this.epoch, startGeneration),
      reason: "INITIAL",
    };
  }

  /** The current revision. Internal: the epoch is not routinely logged. */
  currentRevision(): AuthRevisionView {
    return this.state.kind === "READY" ? this.state.record.revision : this.state.revision;
  }

  /** Loggable state only — never the epoch, identity or material (design §19). */
  diagnostics(): AuthDiagnostics {
    if (this.state.kind === "READY") {
      return Object.freeze({
        availability: "READY" as const,
        generation: this.state.record.revision.generation,
        hasProfileId: this.state.record.profileId !== undefined,
      });
    }
    return Object.freeze({
      availability: "UNAVAILABLE" as const,
      generation: this.state.revision.generation,
      reason: this.state.reason,
      hasProfileId: false,
    });
  }

  /**
   * Create the opaque handle and record ONLY its issuance.
   *
   * A frozen null-prototype object: it has no own properties, no inherited
   * `toString`/`valueOf`/`constructor`, and no usable serialization. Generic
   * JSON yields `{}`, which cannot be rehydrated into an accepted capability.
   */
  private issueContext(): AuthContext {
    const context = Object.freeze(Object.create(null)) as AuthContext;
    this.issuedContexts.add(context);
    return context;
  }
}

function freezeRevision(epoch: string, generation: number): AuthRevisionView {
  return Object.freeze({ epoch, generation });
}

/**
 * The single construction point. The application composition root will later
 * create exactly one instance; BT3 creates none, because nothing production
 * reaches this module yet.
 */
export function createAuthContextAuthority(seams: AuthAuthoritySeams = {}): AuthContextAuthority {
  return new AuthContextAuthority(seams);
}
