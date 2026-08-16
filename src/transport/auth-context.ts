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
  readonly cause?: AuthInvalidationCause;
  readonly hasProfileId: boolean;
}

// ── The trusted producer's closed candidate (design §27) ────────────────────

/**
 * The ONLY shape a producer may submit. There is deliberately no refresh-token
 * and no cookie field: refresh material stays with the refresh producer and
 * hardened storage, and cookies are outside BT3 entirely (design §6, OQ-1).
 *
 * The authority copies these fields one by one — never by spread — so an extra
 * property on a producer's object cannot ride into the private record.
 */
export interface AuthMaterialCandidate {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresAt: number;
  readonly accountId: string;
  readonly profileId?: string;
}

/**
 * REFRESH demands exact account/profile continuity; ESTABLISH is the explicit
 * new-session path that may carry a different identity. A refresh that changed
 * identity is an anomaly, not a login (design §15, §27).
 */
export type AuthCommitMode = "ESTABLISH" | "REFRESH";

export type AuthInvalidationCause =
  | "LOGOUT"
  | "INVALID_GRANT"
  | "AUTH_MATERIAL_LOST"
  | "PROCESS_SHUTDOWN";

/**
 * Test-only view. Safe revision/identity metadata as permitted by design §9.2:
 * it deliberately has NO accessToken field, so no test can come to depend on
 * reading the secret out of the authority.
 */
export interface AuthAuthorityInspection {
  readonly availability: AuthAvailability;
  readonly generation: number;
  readonly epoch: string;
  readonly reason?: AuthUnavailableReason;
  readonly cause?: AuthInvalidationCause;
  readonly accountId?: string;
  readonly profileId?: string;
  readonly tokenType?: string;
  readonly expiresAt?: number;
  readonly signal?: AbortSignal;
}

function isUsableString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

  /** Closed diagnostic enum only — the last mutation cause (design §19). */
  private lastCause?: AuthInvalidationCause;

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
        cause: this.lastCause,
        hasProfileId: this.state.record.profileId !== undefined,
      });
    }
    return Object.freeze({
      availability: "UNAVAILABLE" as const,
      generation: this.state.revision.generation,
      reason: this.state.reason,
      cause: this.lastCause,
      hasProfileId: false,
    });
  }

  /**
   * TEST ONLY. Never called by production code and never placed on the writer
   * or reader port, so neither BT4 nor BT5 can reach it. It exposes revision
   * and identity metadata plus the invalidation signal — never the token.
   */
  inspectForTest(): AuthAuthorityInspection {
    if (this.state.kind === "READY") {
      const record = this.state.record;
      return Object.freeze({
        availability: "READY" as const,
        generation: record.revision.generation,
        epoch: record.revision.epoch,
        cause: this.lastCause,
        accountId: record.accountId,
        profileId: record.profileId,
        tokenType: record.tokenType,
        expiresAt: record.expiresAt,
        signal: record.abortController.signal,
      });
    }
    return Object.freeze({
      availability: "UNAVAILABLE" as const,
      generation: this.state.revision.generation,
      epoch: this.state.revision.epoch,
      reason: this.state.reason,
      cause: this.lastCause,
    });
  }

  /**
   * The acquisition linearization point (design §16.2): one synchronous read of
   * the current READY record. It never installs, never refreshes and never
   * increments — acquisition is not a transition (design §10).
   */
  acquire(): AuthContext {
    return this.currentUsableRecord().context;
  }

  /**
   * Install or replace the current material under an expected revision.
   *
   * BT3 TASK 2 SCOPE: the `expected` revision is part of the frozen writer
   * signature and is accepted here, but the compare-and-swap REJECTION is
   * Task 3 work (design §25) — that is the RED which proves a late producer
   * cannot overwrite a newer commit.
   */
  commitAuthenticatedMaterial(
    expected: AuthRevisionView,
    mode: AuthCommitMode,
    candidate: Readonly<AuthMaterialCandidate>
  ): AuthContext {
    void expected;

    // EXHAUSTED is terminal: an authority that ran out of generations can never
    // be reopened, only restarted into a different epoch (design §16.3).
    if (this.state.kind === "UNAVAILABLE" && this.state.reason === "EXHAUSTED") {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }

    // A trusted producer is not treated as infallible: every string and the
    // expiration are validated again here (design §27). A rejected candidate is
    // NOT a transition — no publication, no increment, no abort (design §10).
    this.validateCandidate(candidate);

    if (mode === "REFRESH") {
      if (this.state.kind !== "READY") {
        // Nothing to continue: a refresh cannot bootstrap an identity.
        throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
      }
      const current = this.state.record;
      if (current.accountId !== candidate.accountId || current.profileId !== candidate.profileId) {
        // Fail closed (design §15, §21.4): the candidate is never installed as
        // continuity. The old context is invalidated at the next generation
        // FIRST, and only then is the anomaly reported to the producer.
        const { exhausted } = this.publishUnavailable("INVALIDATED");
        throw new AuthContextError(exhausted ? "AUTH_CONTEXT_UNAVAILABLE" : "AUTH_IDENTITY_CHANGED");
      }
    }

    const currentGeneration = this.currentRevision().generation;
    if (currentGeneration >= MAX_AUTH_GENERATION) {
      // Overflow is not an error to be thrown before the state settles: the
      // terminal state is published, THEN the old controller is aborted, and
      // only then does the rejection escape (FIX1 §8).
      this.publishUnavailable("EXHAUSTED");
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }

    // ── The frozen mutation order (FIX1 §8) ───────────────────────────────
    // 1. capture the old controller;
    const oldController =
      this.state.kind === "READY" ? this.state.record.abortController : undefined;

    // 2. build the next immutable state COMPLETELY;
    const revision = freezeRevision(this.epoch, currentGeneration + 1);
    const context = this.issueContext();
    const record: ActiveAuthRecord = Object.freeze({
      revision,
      accountId: candidate.accountId,
      profileId: candidate.profileId,
      accessToken: candidate.accessToken,
      tokenType: candidate.tokenType,
      expiresAt: candidate.expiresAt,
      abortController: new AbortController(),
      context,
    });

    // 3. publish — this assignment is the state/generation linearization point;
    this.state = { kind: "READY", record };

    // 4. only now notify the previous generation. abort() may synchronously run
    //    listeners, and they must observe the ALREADY-published G+1 state.
    oldController?.abort();

    return context;
  }

  /**
   * Explicit invalidation by a trusted producer. Publishes UNAVAILABLE at the
   * next generation BEFORE notifying the old controller, and before any caller
   * may begin asynchronous storage work (design §15, §16.2).
   *
   * An invalidation while already unavailable still advances the generation: it
   * is an ordering barrier for concurrent mutation attempts (design §10).
   */
  invalidate(cause: AuthInvalidationCause): AuthRevisionView {
    if (this.state.kind === "UNAVAILABLE" && this.state.reason === "EXHAUSTED") {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
    this.lastCause = cause;
    const { exhausted, revision } = this.publishUnavailable("INVALIDATED");
    if (exhausted) {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
    return revision;
  }

  /**
   * The single place that publishes an UNAVAILABLE state, so publish-before-
   * abort holds for logout, identity anomaly and overflow alike.
   */
  private publishUnavailable(
    reason: AuthUnavailableReason
  ): { exhausted: boolean; revision: AuthRevisionView } {
    const oldController =
      this.state.kind === "READY" ? this.state.record.abortController : undefined;

    const currentGeneration = this.currentRevision().generation;
    const exhausted = currentGeneration >= MAX_AUTH_GENERATION;
    const revision = freezeRevision(
      this.epoch,
      exhausted ? MAX_AUTH_GENERATION : currentGeneration + 1
    );

    this.state = { kind: "UNAVAILABLE", revision, reason: exhausted ? "EXHAUSTED" : reason };
    oldController?.abort();

    return { exhausted, revision };
  }

  /**
   * The current record, or a fail-closed rejection. Expiry is checked here and
   * NOT treated as a transition: only a trusted producer mutates the authority
   * (design §10, §15).
   */
  private currentUsableRecord(): ActiveAuthRecord {
    if (this.state.kind !== "READY") {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
    const record = this.state.record;
    if (record.abortController.signal.aborted || !this.recordRemainsUsable(record)) {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
    return record;
  }

  private recordRemainsUsable(record: ActiveAuthRecord): boolean {
    return record.expiresAt > this.now();
  }

  /** Closed validation. Rejection carries the fixed unavailable message only. */
  private validateCandidate(candidate: Readonly<AuthMaterialCandidate>): void {
    const usable =
      candidate !== null &&
      typeof candidate === "object" &&
      isUsableString(candidate.accessToken) &&
      isUsableString(candidate.tokenType) &&
      isUsableString(candidate.accountId) &&
      (candidate.profileId === undefined || isUsableString(candidate.profileId)) &&
      typeof candidate.expiresAt === "number" &&
      Number.isFinite(candidate.expiresAt) &&
      candidate.expiresAt > this.now();

    if (!usable) {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
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
