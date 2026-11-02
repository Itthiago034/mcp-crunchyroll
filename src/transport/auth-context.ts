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
import { registerSensitiveValue } from "../redact.js";
// Type-only: BT3 wraps ResolvedCall, it never rebuilds or extends it, and it
// adds no runtime dependency on the registry or the dispatcher.
import type { ResolvedCall } from "./types.js";

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

// ── Runtime closure of the two enums (external review BT3-R1) ───────────────
//
// A TypeScript union does not exist at runtime. An internal JavaScript caller —
// or a compiled consumer that lost its types — can pass anything, and an
// unknown mode must never fall through implicitly as ESTABLISH.

const AUTH_COMMIT_MODES: readonly string[] = Object.freeze(["ESTABLISH", "REFRESH"]);

/**
 * BT5-FIX1. A descriptor states its auth requirement separately from its
 * scope, and this is the runtime allowlist for that field: an unknown value
 * must fail closed rather than default to either answer. Defaulting to NONE
 * would serve an authenticated endpoint with no bearer; defaulting to BEARER
 * would demand material a genuinely public endpoint does not need.
 */
const AUTH_MATERIAL_REQUIREMENTS: readonly string[] = Object.freeze(["NONE", "BEARER"]);

const AUTH_INVALIDATION_CAUSES: readonly string[] = Object.freeze([
  "LOGOUT",
  "INVALID_GRANT",
  "AUTH_MATERIAL_LOST",
  "PROCESS_SHUTDOWN",
]);

function isAuthCommitMode(value: unknown): value is AuthCommitMode {
  return typeof value === "string" && AUTH_COMMIT_MODES.includes(value);
}

function isAuthInvalidationCause(value: unknown): value is AuthInvalidationCause {
  return typeof value === "string" && AUTH_INVALIDATION_CAUSES.includes(value);
}

/**
 * The five authorized fields, read out of the producer's object exactly once
 * each. Their types are `unknown` on purpose: a getter may answer with anything
 * at all, and only the validated result of THIS object is ever used afterwards.
 */
interface RawMaterialSnapshot {
  readonly accessToken: unknown;
  readonly tokenType: unknown;
  readonly expiresAt: unknown;
  readonly accountId: unknown;
  readonly profileId: unknown;
}

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

/**
 * The short-lived view handed to ONE guarded callback. A consumer must not
 * return it, log it, retain it or copy its token. JavaScript cannot prevent a
 * determined internal module from copying a string; what enforces the boundary
 * is code ownership, this narrow API, redaction registration and tests.
 *
 * There is no refresh token and no cookie here, and there never will be in BT3.
 */
export interface AuthExecutionView {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly signal: AbortSignal;
}

// ── Execution wrappers (design §13, §14) ────────────────────────────────────

/**
 * BT5-FIX1: which wrapper a call gets is decided by `descriptor.auth`, not by
 * `descriptor.scope` — a PUBLIC endpoint may still require a bearer.
 *
 * `ResolvedCall` is NOT extended with an optional auth field. An optional field
 * would let invalid combinations exist (an account call with no context, a
 * public call carrying one) and would drag mutable-stage concerns into BT1's
 * caller-only resolution. The discriminated wrapper makes both illegal states
 * unrepresentable, and a public call carries an explicit PUBLIC marker rather
 * than an absent context (design §14, option B).
 */
export interface PublicCall {
  readonly kind: "PUBLIC";
  readonly call: ResolvedCall;
}

export interface AuthorizedCall {
  readonly kind: "AUTHENTICATED";
  readonly call: ResolvedCall;
  readonly context: AuthContext;
  readonly authDerivedParams: Readonly<Record<string, string>>;
}

export type ExecutionCall = PublicCall | AuthorizedCall;

// ── The two stage-scoped ports (design §27, §28) ────────────────────────────

/**
 * BT4's port. It cannot choose an epoch or generation, read current material,
 * create handles, resolve calls or suppress an invalidation.
 */
export interface AuthContextWriter {
  currentRevision(): AuthRevisionView;
  commitAuthenticatedMaterial(
    expected: AuthRevisionView,
    mode: AuthCommitMode,
    candidate: Readonly<AuthMaterialCandidate>
  ): AuthContext;
  invalidate(cause: AuthInvalidationCause): AuthRevisionView;
}

/**
 * BT5's port. No mutation method exists on it at all, so a backend cannot
 * install or invalidate material merely because it executes requests.
 */
export interface AuthContextReader {
  bind(call: ResolvedCall): ExecutionCall;
  runCurrent<T>(call: AuthorizedCall, execute: (view: AuthExecutionView) => Promise<T>): Promise<T>;
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

  /**
   * Whether the READY record can still serve requests. An observed browser
   * bearer carries no refresh token and expires within minutes; READY alone
   * would keep reporting a session nothing can use. Loggable: a boolean only.
   */
  hasUsableRecord(): boolean {
    if (this.state.kind !== "READY") return false;
    const record = this.state.record;
    return !record.abortController.signal.aborted && this.recordRemainsUsable(record);
  }

  /**
   * When the usable record stops being usable (epoch ms), or undefined when
   * there is none. A time only: it identifies nobody and carries no material.
   * The session keeper uses it to renew right as the bearer runs out.
   */
  usableUntil(): number | undefined {
    if (!this.hasUsableRecord() || this.state.kind !== "READY") return undefined;
    return this.state.record.expiresAt;
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
   * The producer captures a revision, performs its asynchronous validation or
   * refresh OUTSIDE the authority, and then commits synchronously. The commit
   * succeeds only if the authority is still at exactly that revision, so a late
   * completion can never overwrite a logout, another refresh or a newer login
   * (design §16.3).
   */
  commitAuthenticatedMaterial(
    expected: AuthRevisionView,
    mode: AuthCommitMode,
    candidate: Readonly<AuthMaterialCandidate>
  ): AuthContext {
    // ── A. EXHAUSTED is terminal ──────────────────────────────────────────
    // An authority that ran out of generations can never be reopened, only
    // restarted into a different epoch (design §16.3). Checked BEFORE the CAS,
    // so an expected revision that numerically equals the published maximum
    // still gets UNAVAILABLE rather than a misleading staleness verdict.
    this.assertNotExhausted();

    // The expected revision is a producer-supplied object too, so its two
    // fields are read exactly once here. A getter cannot answer differently
    // across the two compare-and-swap checks below.
    const expectedRevision = freezeRevision(
      (expected as { epoch: string }).epoch,
      (expected as { generation: number }).generation
    );

    // ── B. the compare-and-swap gate ──────────────────────────────────────
    // A mismatch performs NO state mutation, no generation increment and no
    // controller abort (FIX1 §8), and is checked before the candidate is
    // touched at all, so a doomed candidate is never even read.
    this.assertCurrentRevisionIs(expectedRevision);

    // ── C. runtime mode allowlist (BT3-R1) ────────────────────────────────
    // Before any candidate access: an unknown mode must not reach the producer
    // object, and must never fall through implicitly as ESTABLISH.
    if (!isAuthCommitMode(mode)) {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }

    // ── D. snapshot: each authorized field read AT MOST ONCE ──────────────
    // Every read is a call into producer-controlled code — a getter or a Proxy
    // trap — which may synchronously reenter this authority. Reading a field
    // twice would let it answer validation with one value and construction with
    // another. No spread, no Object.assign, no enumeration: exactly these five
    // closed fields, so an unknown property cannot ride in either.
    const snapshot: RawMaterialSnapshot = Object.freeze({
      accessToken: candidate.accessToken,
      tokenType: candidate.tokenType,
      expiresAt: candidate.expiresAt,
      accountId: candidate.accountId,
      profileId: candidate.profileId,
    });

    // ── E. validate ONLY the snapshot ─────────────────────────────────────
    // A trusted producer is not treated as infallible: every string and the
    // expiration are validated again (design §27). A rejected candidate is NOT
    // a transition — no publication, no increment, no abort (design §10).
    const material = this.validateSnapshot(snapshot);

    // ── F. the final compare-and-swap, after all untrusted reads ──────────
    // Reading the candidate may have logged the user out, committed a newer
    // generation or exhausted the authority. This is the last boundary: from
    // here to publication, no producer-controlled code runs at all.
    this.assertNotExhausted();
    this.assertCurrentRevisionIs(expectedRevision);

    // ── G. commit decision and publication, from local values only ────────
    if (mode === "REFRESH") {
      if (this.state.kind !== "READY") {
        // Nothing to continue: a refresh cannot bootstrap an identity.
        throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
      }
      const current = this.state.record;
      if (current.accountId !== material.accountId || current.profileId !== material.profileId) {
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
      accountId: material.accountId,
      profileId: material.profileId,
      accessToken: material.accessToken,
      tokenType: material.tokenType,
      expiresAt: material.expiresAt,
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
    // Runtime allowlist first (BT3-R1): an unrecognised cause must not widen
    // the diagnostic enum, and must not invalidate anything on its way out.
    if (!isAuthInvalidationCause(cause)) {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
    this.assertNotExhausted();
    this.lastCause = cause;
    const { exhausted, revision } = this.publishUnavailable("INVALIDATED");
    if (exhausted) {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
    return revision;
  }

  /**
   * Guarded execution: the only path on which the access token is ever exposed,
   * and then only for the duration of one callback.
   *
   * Three checks close the await race (design §13.6–13.9):
   *
   * 1. a synchronous pre-check immediately before the first external side
   *    effect — capability identity, non-aborted state AND usable expiration;
   * 2. the generation's AbortSignal, handed to the consumer so it can attempt
   *    cancellation;
   * 3. a synchronous post-check after the callback settles.
   *
   * The post-check is deliberately a CURRENTNESS check only, not a usability
   * check: §13.8 defines it against a generation change while the consumer was
   * awaiting. Discarding an authorized result merely because the token expired
   * a millisecond after the request succeeded would protect nothing and would
   * throw away work the authority itself had already sanctioned.
   *
   * No claim is made that aborting retracts a request already sent. What is
   * guaranteed is that its result is never accepted afterwards, and that it is
   * never replayed or reissued under a newer generation.
   */
  async runCurrent<T>(
    call: AuthorizedCall,
    execute: (view: AuthExecutionView) => Promise<T>
  ): Promise<T> {
    // The wrapper is never trusted for provenance: only the handle it carries
    // is checked, so a hand-built wrapper around a forged, stale or foreign
    // handle is rejected exactly like the handle itself.
    const record = this.assertUsableCurrentContext(call.context);

    // Registered BEFORE the callback so that a backend rendering the token into
    // a failure string is covered from its very first instruction (design §19).
    registerSensitiveValue(record.accessToken);

    const view: AuthExecutionView = Object.freeze({
      accessToken: record.accessToken,
      tokenType: record.tokenType,
      signal: record.abortController.signal,
    });

    const result = await execute(view);

    // Post-check. A stale result is discarded, never returned and never retried.
    this.assertStillCurrent(call.context);

    return result;
  }

  /**
   * The auth-acquisition linearization point for one call (design §13.4).
   *
   * A PUBLIC descriptor gets an explicit public wrapper and no context. An
   * ACCOUNT descriptor gets the current handle plus ONLY the identity its own
   * descriptor declared, resolved from the SAME private record the handle names
   * — never from caller input, never from a different generation.
   */
  bind(call: ResolvedCall): ExecutionCall {
    // BT5-FIX1: the question here is whether MATERIAL is required, which is not
    // the same question as whose data the endpoint addresses. A PUBLIC endpoint
    // that still needs a bearer (every Crunchyroll read) binds to an authorized
    // call and goes through runCurrent exactly like an account-scoped one; only
    // its identity resolution is empty.
    const requirement = call.descriptor.auth;
    if (!AUTH_MATERIAL_REQUIREMENTS.includes(requirement as string)) {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
    if (requirement === "NONE") {
      // A truly unauthenticated operation. It carries no context, and BT3
      // hands it nothing it could accidentally render.
      return Object.freeze({ kind: "PUBLIC" as const, call });
    }

    const record = this.currentUsableRecord();

    const resolvedIdentity: Record<string, string> = {};
    for (const [name, spec] of Object.entries(call.descriptor.authDerivedParams)) {
      const value = spec.source === "accountId" ? record.accountId : record.profileId;
      if (!isUsableString(value)) {
        // A descriptor that needs a profile id the authority does not have
        // fails closed. Caller input cannot supply it: the registry already
        // rejects an auth-derived key as CALLER_SUPPLIED_IDENTITY (design §21.5).
        throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
      }
      resolvedIdentity[name] = value;
    }
    const authDerivedParams = Object.freeze(resolvedIdentity);

    // D0-H1 (FIX1 §11). The design obliges the eventual renderer to register
    // these values before they can surface in request material. Registering
    // them HERE discharges that obligation mechanically at the earliest
    // possible point — bind strictly precedes any rendering — instead of
    // relying on a future stage to remember. Outside an operation scope this
    // is a documented no-op and retains nothing.
    registerSensitiveValue(...Object.values(authDerivedParams));

    // `context` and `authDerivedParams` are defined as read-only,
    // non-enumerable own properties BEFORE freezing: nominal internal access
    // works, while Object.keys, spread and JSON.stringify emit neither the
    // handle nor the sensitive identity (design §13.5).
    const wrapper = { kind: "AUTHENTICATED" as const, call };
    Object.defineProperty(wrapper, "context", {
      value: record.context,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(wrapper, "authDerivedParams", {
      value: authDerivedParams,
      enumerable: false,
      writable: false,
      configurable: false,
    });

    return Object.freeze(wrapper) as unknown as AuthorizedCall;
  }

  /** The restricted producer port handed to BT4 (design §27). */
  asWriter(): AuthContextWriter {
    return Object.freeze({
      currentRevision: (): AuthRevisionView => this.currentRevision(),
      commitAuthenticatedMaterial: (
        expected: AuthRevisionView,
        mode: AuthCommitMode,
        candidate: Readonly<AuthMaterialCandidate>
      ): AuthContext => this.commitAuthenticatedMaterial(expected, mode, candidate),
      invalidate: (cause: AuthInvalidationCause): AuthRevisionView => this.invalidate(cause),
    });
  }

  /** The restricted execution port handed to BT5 (design §28). */
  asReader(): AuthContextReader {
    return Object.freeze({
      bind: (call: ResolvedCall): ExecutionCall => this.bind(call),
      runCurrent: <T>(
        call: AuthorizedCall,
        execute: (view: AuthExecutionView) => Promise<T>
      ): Promise<T> => this.runCurrent(call, execute),
    });
  }

  /**
   * The complete runtime acceptance conjunction (FIX1 §5). Issuance membership
   * rejects a forged or cross-authority object; current-record identity rejects
   * a previously issued but stale handle. There is deliberately no lookup from
   * a handle to a historical record, so nothing stale can be resolved at all.
   */
  private assertStillCurrent(context: AuthContext): ActiveAuthRecord {
    if (
      !this.issuedContexts.has(context) ||
      this.state.kind !== "READY" ||
      this.state.record.context !== context ||
      this.state.record.abortController.signal.aborted
    ) {
      // A forged handle is reported exactly like a stale one, so the rejection
      // does not disclose whether the object was ever issued here (design §15).
      throw new AuthContextError("AUTH_CONTEXT_STALE");
    }
    return this.state.record;
  }

  /** Pre-use acceptance: currentness plus usable material (design §13.6). */
  private assertUsableCurrentContext(context: AuthContext): ActiveAuthRecord {
    const record = this.assertStillCurrent(context);
    if (!this.recordRemainsUsable(record)) {
      // Unusable material is not staleness: the handle is still the current
      // one, there is simply nothing valid to authorize with.
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
    return record;
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

  /** EXHAUSTED is terminal in every direction (design §16.3). */
  private assertNotExhausted(): void {
    if (this.state.kind === "UNAVAILABLE" && this.state.reason === "EXHAUSTED") {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }
  }

  /** The single compare-and-swap rule, applied identically at B and at F. */
  private assertCurrentRevisionIs(expected: AuthRevisionView): void {
    if (!revisionsEqual(expected, this.currentRevision())) {
      throw new AuthContextError("AUTH_CONTEXT_STALE");
    }
  }

  /**
   * Closed validation of the local snapshot — never of the producer's object,
   * which is not read again after the snapshot is taken. Rejection carries the
   * fixed unavailable message only.
   *
   * Guards are sequential rather than one boolean chain so that each field is
   * narrowed exactly once, and so the returned material is a frozen object of
   * validated primitives rather than a re-reference to anything producer-owned.
   */
  private validateSnapshot(snapshot: RawMaterialSnapshot): Readonly<AuthMaterialCandidate> {
    const { accessToken, tokenType, expiresAt, accountId, profileId } = snapshot;

    if (!isUsableString(accessToken)) throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    if (!isUsableString(tokenType)) throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    if (!isUsableString(accountId)) throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");

    let profile: string | undefined;
    if (profileId !== undefined) {
      if (!isUsableString(profileId)) throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
      profile = profileId;
    }

    if (
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now()
    ) {
      throw new AuthContextError("AUTH_CONTEXT_UNAVAILABLE");
    }

    return Object.freeze({
      accessToken,
      tokenType,
      expiresAt,
      accountId,
      profileId: profile,
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
