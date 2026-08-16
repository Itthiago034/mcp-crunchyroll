# MCP Crunchyroll — BT3 Design Gate 0

## 1. Executive summary

BT3 will add a process-local authentication authority whose only job is to
issue immutable, opaque `AuthContext` capabilities and to reject any capability
that is no longer the current authentication revision. It will not perform
login, refresh network calls, logout persistence, cookie extraction, browser
inspection, operation cutover, or public MCP wiring.

The authoritative model is:

`AuthRevision = { epoch, generation }`

The epoch is a fresh process-local 128-bit value from Node's `randomBytes(16)`.
The generation is a monotonically increasing safe integer local to that epoch.
The authority holds one private current auth record or is unavailable. An
`AuthContext` is a frozen, non-enumerable, non-rehydratable capability handle
registered by object identity inside that authority. It exposes no token,
cookie, account ID, profile ID, epoch, or generation field to ordinary callers.

For an account-scoped transport call, BT5 will later keep `ResolvedCall`
unchanged and ask the authority to produce an `AuthorizedCall` wrapper. The
wrapper binds the call, a current `AuthContext`, and separately resolved
auth-derived identity parameters. The backend must validate the capability at
the last pre-side-effect boundary, receive an invalidation `AbortSignal`, and
validate again before returning a result. A generation change aborts and makes
all old handles stale. The authority never substitutes current generation
material for an old handle.

This design has no blocking open questions. It creates no public method,
changes no tool, adds no CDP domain, requires no browser or network, and adds no
runtime dependency. The existing legacy auth path remains characterized but
unmodified until separately authorized cutover gates.

## 2. Frozen baseline

| Property | Frozen value |
|---|---|
| Repository | `/tmp/mcp-crunchyroll-bt0` |
| BT2 head | `ef05d3d4e1f577fcb28a908c3fdc33593c3f8b58` |
| BT2 parent baseline | `804611108af249f08668b12a5ff1c376a77f200d` |
| BT2 commits above parent | 13 |
| BT2 merge commits | 0 |
| Design branch | `bt3-auth-context-design` |
| BT2 preservation | `/mnt/ai-lab/mcp-crunchyroll-preservation/BT2-20260815-222717` |

The preservation manifest was verified from its own directory before the
design branch was created. The baseline worktree was clean. No source, test,
package, workflow, or build file is changed by this gate.

## 3. BT2 inherited constraints

BT2 remains lifecycle-only and auth-agnostic. Its visible/headless launch
policy, hardened profile, ProcessSingleton profile/PID binding, ownership
record, adopted-process observation, retained-CDP shutdown, sticky CDP close,
reconnect policy, managed target semantics, and no-adopted-PID-signal rules are
not reopened.

The closed lifecycle CDP set remains:

- `Browser.getVersion`
- `Browser.close`
- `Target.setDiscoverTargets`
- `Target.getTargets`
- `Target.createTarget`
- `Target.closeTarget`

BT3 adds no `Runtime.evaluate`, `Fetch.*`, `Network.*`, cookie API, generic CDP
surface, arbitrary navigation, or caller-controlled browser input. The public
MCP surface remains 21 tools with unchanged names, schemas, descriptions, and
behavior. `PRODUCTION_OPERATIONS` remains empty, and no handler reaches
`BrowserSessionManager` or the transport dispatcher.

## 4. Current repository auth architecture

The detailed evidence is in `CRUNCHYROLL-BT3-EXISTING-AUTH-MAP.md`. In summary:

- `src/auth.ts` owns validation and hardened persistence for `tokens.json` and
  `session.json`, plus the structured local clear operation.
- `src/api.ts` owns the legacy login, refresh, token acquisition, Authorization
  construction, and direct content API requests.
- `src/index.ts` owns the current 21-tool MCP boundary and invokes `src/api.ts`
  directly.
- `src/redact.ts` owns operation-scoped runtime literal registration and static
  secret patterns.
- BT1's registry owns caller-vs-auth-derived parameter policy but has no auth
  resolver. `ResolvedCall` contains only validated caller parameters.
- The dispatcher resolves synchronously and then awaits a backend. That await
  is the exact future interval in which an auth revision can become stale.
- BT2 browser lifecycle modules contain no token, cookie, account, profile,
  login, logout, or authentication generation state.

The legacy `refreshInFlight` promise is a refresh-request single-flight, not an
auth authority or generation. Current tests characterize successful refresh as
accepting a provider-supplied changed `account_id`; BT3 will not silently carry
that identity transition across the new boundary.

## 5. Existing auth data map

The persisted `TokenData` fields are `access_token`, `refresh_token`,
`expires_at`, `token_type`, `account_id`, and optional `profile_id`. The
persisted `SessionInfo` fields are optional `email`, `username`, `account_id`,
and generated `saved_at`. Unknown input fields are tolerated diagnostically by
name but are not persisted on a sanitized save.

Storage is `~/.strider/crunchyroll/tokens.json` and
`~/.strider/crunchyroll/session.json`. Directories require mode `0700`; files
require `0600`; effective UID ownership, regular-file type, and no-follow
checks are enforced. A genuine missing file is absence; insecure or corrupt
state is an error. Existing storage is a sufficient validated *candidate
source* for a future trusted producer. It is not itself an AuthContext and
does not provide process-local invalidation or an atomic token/session pair.

BT3 does not redesign this storage. In particular, it does not add an epoch or
generation to either JSON file. Auth revision state is deliberately
process-local.

## 6. Secret classification

| Datum | Class | BT3 rule |
|---|---|---|
| password | A — SECRET | forbidden from AuthContext and authority state |
| access token | A — SECRET | private current authority record only; exposed solely inside a future scoped execution callback |
| refresh token | A — SECRET | remains owned by secure storage/refresh producer; forbidden from AuthContext |
| Authorization value | A — SECRET | future backend use boundary only; never caller input or metadata |
| cookie or cookie jar | A — SECRET | no BT3 type or acquisition path; deferred to BT4 design |
| email / username | B — AUTH IDENTITY, NON-SECRET BUT SENSITIVE | presentation storage only; forbidden from transport context |
| account ID | B — AUTH IDENTITY, NON-SECRET BUT SENSITIVE | private authority record; resolvable only for a declared auth-derived parameter |
| profile ID | B — AUTH IDENTITY, NON-SECRET BUT SENSITIVE | optional private authority record; fail closed if an operation requires it and it is absent |
| expiration | C — AUTH METADATA | private authority record and acquisition check |
| `saved_at`, scope, token type | C — AUTH METADATA | producer/storage metadata; only token type needed in a validated material candidate |
| auth epoch / generation | C — AUTH METADATA | private revision identity; generation may be logged, full epoch may not |
| context availability/stale state | C — AUTH METADATA | fixed enum may be logged |
| declared non-auth caller parameter | D — PUBLIC/NON-SENSITIVE by default | remains in `callerParams`; existing schema controls it |

Account/profile identifiers are not credentials, but they enable correlation
and are therefore excluded from routine logs and public errors. Symbolic test
values are allowed.

## 7. BT3 scope

BT3 designs and will later implement only:

1. the opaque `AuthContext` capability;
2. a single process-local `AuthContextAuthority`;
3. process epoch and monotonically increasing generation;
4. atomic install, replacement, invalidation, acquisition, and currentness
   checks;
5. stale-handle invalidation and abort notification;
6. private ownership of the current access material and account/profile
   identity;
7. a closed internal producer port for later BT4;
8. an authenticated execution wrapper and guarded-use port for later BT5;
9. fixed, secret-free errors;
10. deterministic clocks/epoch/material seams where needed by unit tests.

The BT3 implementation remains uninstantiated by `src/index.ts` and unreachable
from MCP callers. It can be tested with symbolic data without a browser.

## 8. Explicit non-goals

BT3 does not implement or activate login, status migration, logout migration,
refresh HTTP, Crunchyroll navigation or requests, token/cookie extraction,
Fetch/Network interception, endpoint migration, production operation
registration, player, DRM, playback, media extraction, operation cutover,
`OPERATION_NOT_MIGRATED`, or BT4+. It does not change secure storage, BT2, the
public MCP contract, or existing legacy API behavior.

## 9. AuthContext authoritative design

### 9.1 Nature and representation

`AuthContext` is an immutable, opaque, process-local capability handle. It is a
snapshot in the sense that it is permanently bound to one authority revision;
it is not a value object because structural equality or copied fields cannot
recreate it. It is not a mutable session object and not a secret container.

Conceptual API:

```ts
declare const authContextBrand: unique symbol; // module-private

export interface AuthContext {
  readonly [authContextBrand]: true;
}

export interface AuthRevisionView {
  readonly epoch: string;
  readonly generation: number;
}
```

The authority creates a frozen, null-prototype handle with no enumerable
properties and records it in a private `WeakMap<AuthContext, ActiveAuthRecord>`.
The brand and constructor are not exported. Runtime acceptance additionally
requires WeakMap membership and identity with the authority's current handle;
TypeScript branding alone is not trusted.

The handle contains no raw access token, refresh token, cookie, Authorization
value, password, email, account ID, profile ID, expiration, epoch, or generation
as caller-readable fields. The private record associated with it contains:

```ts
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
```

This is one conceptual record, atomically replaced; its exact private syntax
may differ without changing the contract.

### 9.2 Explicit answers

- Immutable: **yes**. The handle and safe views are frozen; private records are
  never mutated after installation.
- Mutable: **no**. Mutation creates a new record, handle, and generation.
- Snapshot: **yes**, of one revision, but no public fields are copied out.
- Handle/capability: **yes**; object identity plus private authority membership
  is required.
- Raw secrets in AuthContext: **no**. The authority's private record owns the
  access token. Refresh tokens remain with the refresh producer/storage;
  cookies remain outside BT3.
- Outlive persisted state: a JavaScript handle may remain referenced after the
  persisted state changes, but it becomes stale immediately when the authority
  invalidates/replaces it and can no longer authorize work.
- Serialize: **no usable serialization**. Generic JSON may yield `{}`, but that
  output cannot be rehydrated, accepted, or used as a capability.
- Log: **no**. Code must log only fixed state/error metadata, never the object.
- Return to MCP callers: **no**.
- Test inspection: tests may use an explicitly test-only safe revision/identity
  inspector supplied by the authority seam; they never inspect raw secrets.
- Production diagnostics: availability, generation, and fixed reason only.
  Full epoch and account/profile identifiers are prohibited from routine logs.
- Caller construction: **no**, statically by private brand and dynamically by
  WeakMap/current-handle validation.
- Caller modification: **no**; frozen and opaque.
- Indefinite backend retention: **forbidden by contract**. A backend receives a
  handle only for one execution and must not store it; old retention is also
  mechanically harmless because currentness checks reject it.
- Coexisting generations: handles can remain in memory concurrently, but only
  the authority's current handle is usable. All older handles are stale.

## 10. authGeneration authoritative design

`authGeneration` is an integer in `[0, Number.MAX_SAFE_INTEGER]` scoped to one
auth epoch. It starts at `0` in an unavailable authority. It is process-local,
never persisted, never decremented, and never reset within an epoch.

A successful state transition increments exactly once and atomically publishes
the new state:

- first validated material installation (`0 → 1`);
- every successful access-material replacement, including rotated or
  non-rotated token refresh, even if identity is unchanged;
- explicit invalidation, including logout start and semantic invalid-grant;
- fail-closed invalidation caused by unexpected account/profile identity
  change or loss of required current secret material.

An explicit invalidation increments even when already unavailable. This makes
each accepted invalidation a new ordering barrier for concurrent mutation
attempts. Concurrent duplicate calls may therefore advance more than once;
generation counts authority transitions, not logins.

Generation does **not** increment for:

- candidate validation failure before a commit;
- transient refresh failure that leaves the exact current record installed;
- an operation acquisition/currentness check;
- CDP reconnect, target recreation, browser start/stop/restart/crash/adoption;
- storage reads, diagnostics, or public status checks;
- a failed compare-and-swap commit.

If an increment is required at `Number.MAX_SAFE_INTEGER`, the authority first
aborts and drops the current record, enters unavailable/exhausted state at the
same numeric value, and returns `AUTH_CONTEXT_UNAVAILABLE`. It never wraps,
reuses zero, or silently resets. Recovery requires process restart, which
creates a different epoch.

Equality of `{epoch, generation}` proves only that two revision views name the
same authority revision. It does not prove a handle was issued by the
authority, remains current, has usable/unexpired secret material, or belongs to
a particular account. Inequality proves the revisions are not interchangeable.
Every authorization decision therefore checks capability identity/current
record, not a caller-presented number.

## 11. Auth epoch and process restart

At construction, the authority obtains 16 cryptographically random bytes from
Node's built-in `node:crypto.randomBytes`, encoded as 32 lowercase hexadecimal
characters. Tests inject a deterministic epoch factory; production does not
accept an epoch from caller input or environment.

The authoritative revision is the pair `(epoch, generation)`. On MCP process
restart, a new epoch is generated and generation returns to zero. The old
process's handles cannot physically remain live, and even a serialized or
copied numeric generation cannot compare equal as a revision because the epoch
differs. The epoch is not persisted because it represents one process authority
lifetime, not durable credential history.

Randomness is necessary here only to prevent false cross-process equality for
revision metadata. It is not an authentication secret, does not replace
capability identity, and is never caller-controlled. No UUID package or new
dependency is needed.

## 12. Context ownership

Exactly one `AuthContextAuthority` instance, created later by the application
composition root, owns mutable transport-auth state. Its implementation belongs
in a new `src/transport/auth-context.ts` module.

- `src/auth.ts` remains owner of hardened persisted token/session documents,
  not of live operation contexts.
- `src/api.ts` remains the untouched legacy owner until later migration gates,
  not the new authority.
- The dispatcher consumes an authority port later; it does not own auth state.
- `BrowserSessionManager` remains process/CDP/target lifecycle-only and never
  stores tokens, cookies, account/profile identity, epoch, or auth generation.
- A future BT4 producer can submit only a closed, validated material candidate
  to a restricted writer port.
- A future BT5 backend can use only a context-bound guarded execution port; it
  cannot install or invalidate material.

This separation ensures that browser existence is not mistaken for
authentication and that transport code cannot mutate auth merely because it
executes requests.

## 13. Transport boundary

The complete later-stage flow is frozen as follows:

1. The MCP handler accepts only its unchanged published schema.
2. `resolveCall` uses the closed registry to validate caller parameters. It
   continues to reject caller-supplied auth-derived keys before auth lookup.
3. For a `PUBLIC` descriptor, the dispatcher creates a public execution wrapper
   with no AuthContext.
4. For an `ACCOUNT` descriptor, the dispatcher synchronously calls
   `authority.bind(resolvedCall)`. This is the auth-acquisition linearization
   point. It either returns an `AuthorizedCall` tied to the current capability
   or throws `AUTH_CONTEXT_UNAVAILABLE`.
5. `bind` resolves only the descriptor's declared `accountId`/`profileId`
   sources from the same private active record. It writes them to a separate
   frozen `authDerivedParams` map, never to `callerParams`.
6. Immediately before the backend's first external side effect, it calls the
   authority's guarded-use method. The authority validates current capability
   identity, non-aborted state, and usable expiration.
7. The authority registers the access-token literal with the *current MCP
   operation's* redaction scope before invoking the internal consumer. It gives
   the consumer a short-lived execution view and the record's `AbortSignal`.
8. If generation changes while the consumer is awaiting, invalidation aborts
   the signal. Regardless of underlying cancellation support, the authority
   performs a second currentness check after the consumer settles and before
   its result can be returned.
9. A stale result is discarded and reported as `AUTH_CONTEXT_STALE`; it is
   never reissued under the new context and never silently retried.

Conceptual internal types:

```ts
export type ExecutionCall =
  | { readonly kind: "PUBLIC"; readonly call: ResolvedCall }
  | AuthorizedCall;

export interface AuthorizedCall {
  readonly kind: "AUTHENTICATED";
  readonly call: ResolvedCall;
  readonly context: AuthContext;
  readonly authDerivedParams: Readonly<Record<string, string>>;
}

interface AuthExecutionView {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly signal: AbortSignal;
}
```

`AuthExecutionView` is internal to the guarded callback. A backend must not
return it, log it, retain it, or copy its token. JavaScript cannot prevent a
malicious internal module from copying a string; code ownership, a narrow API,
redaction registration, and tests enforce the intended boundary. The caller
never supplies Authorization, bearer, cookies, account/profile identity,
epoch, generation, or a context handle.

## 14. ResolvedCall relationship

Four options were evaluated:

| Option | Evaluation |
|---|---|
| A. Extend `ResolvedCall` with optional auth | Rejected: makes caller-only resolution carry mutable-stage concerns and permits invalid optional combinations. |
| B. Wrap `ResolvedCall` | Selected: preserves BT1 immutability and uses a discriminated authenticated form. |
| C. Separate execution context unrelated to the call | Rejected alone: weakens the mechanical tie between resolved policy and the auth-derived values used for it. |
| D. Bind auth only inside a backend | Rejected: each backend could resolve identity differently, and the dispatcher-to-backend race would remain unnamed. |

`ResolvedCall` therefore remains byte-for-byte and semantically unchanged in
BT3. `AuthorizedCall` is a separate immutable wrapper produced only by the
authority from an already-resolved account-scoped call. A public call has an
explicit `PUBLIC` wrapper rather than an optional context field.

BT3 itself defines and tests the wrapper/authority behavior but does not modify
the live dispatcher or `TransportBackend`; that wiring is BT5 cutover work.

## 15. Stale-context semantics

A context is **STALE** when it was issued by this authority but is not the
current handle, its record has been aborted, or its revision no longer equals
the authority's current revision. An unrecognized/forged handle is also rejected
as stale at the internal boundary so its origin is not disclosed. Staleness is
permanent.

Required examples:

- A call binds generation 4; refresh installs generation 5 before execution.
  The generation-4 pre-dispatch check throws `AUTH_CONTEXT_STALE`. No generation
  5 token or identity is substituted.
- Logout begins while an operation is executing. Logout synchronously
  invalidates first, advances generation, and aborts the old signal before it
  awaits filesystem deletion. The transport attempts cancellation; even if an
  underlying request cannot be unsent, its result fails the post-check and is
  discarded.
- CDP reconnect occurs while auth material is unchanged. No auth mutation is
  committed, so the context stays current.
- Browser process replacement occurs. BT2 alone does not mutate auth. If later
  BT4 determines that browser-derived auth trust was lost, BT4 must submit an
  explicit invalidation; that event, not the lifecycle event itself, advances
  the generation.
- Refresh fails transiently without replacing or invalidating current material.
  Generation remains stable. Acquisition still fails closed if the material is
  expired under the configured validity rule.
- A refresh response unexpectedly changes account or profile identity. The
  replacement is not installed as continuity. The current context is aborted,
  generation advances once into unavailable state, and
  `AUTH_IDENTITY_CHANGED` is returned to the trusted producer.

An operation already sent under generation G may be impossible to retract at
the remote peer. BT3 guarantees that it never changes to G+1 material, that
invalidation is signaled, and that a post-invalidation result is not returned
as valid. It does not falsely claim network-side rollback.

## 16. Concurrency and linearization points

JavaScript run-to-completion is sufficient for synchronous state publication,
but it is not sufficient across an `await`. The design uses immutable state,
synchronous compare-and-swap commits and an abort controller; it does not
require a general mutex.

### 16.1 State form

```ts
type AuthorityState =
  | {
      readonly kind: "UNAVAILABLE";
      readonly revision: AuthRevisionView;
      readonly reason: "INITIAL" | "INVALIDATED" | "LOAD_FAILED" | "EXHAUSTED";
    }
  | {
      readonly kind: "READY";
      readonly record: ActiveAuthRecord;
    };
```

There is no `INVALIDATING` state. Invalidation commits synchronously before
asynchronous cleanup, so observable state is already `UNAVAILABLE`. There is no
duplicate login state machine; BT4 owns future login orchestration.

### 16.2 Linearization points

- **Context acquisition/binding:** the synchronous read that compares the
  current `READY` record and installs that exact handle in an `AuthorizedCall`.
- **Generation increment/state mutation:** the single synchronous assignment
  that swaps the immutable authority state after calculating the next safe
  generation. The old controller is aborted immediately before publication in
  the same event-loop turn; no `await` occurs between abort and assignment.
- **Context invalidation:** abort plus state assignment at the start of
  `invalidate`, before any storage/network/browser await.
- **External execution:** the last synchronous currentness check immediately
  before invoking the guarded backend callback.
- **Result acceptance:** the synchronous currentness check after callback
  settlement and immediately before returning its result.

### 16.3 Async preparation and CAS

A producer captures an `AuthRevisionView`, performs any asynchronous validation
or refresh outside the authority, then calls
`commitAuthenticatedMaterial(expectedRevision, candidate)` synchronously. The
commit succeeds only if current revision equals `expectedRevision`; otherwise
it throws `AUTH_CONTEXT_STALE`. It never overwrites a logout, another refresh,
or a newer login.

BT3 performs no automatic storage bootstrap. A process starts unavailable at
generation 0. If a later BT4 gate authorizes bootstrap from existing hardened
storage, that producer must load and validate outside the authority, capture
revision 0, and perform an explicit `ESTABLISH` CAS commit. Concurrent bootstrap
attempts are resolved by the same CAS rule; no special storage single-flight or
implicit trust path exists in BT3.

### 16.4 Required races

- Simultaneous tool calls acquire the same canonical current handle. They are
  independent executions sharing one abort signal for that generation.
- Concurrent refresh attempts are a producer concern; the current legacy
  `refreshInFlight` already single-flights its flow. BT3 accepts only one CAS
  commit. A late completion is stale.
- Logout vs resolution: whichever synchronous linearization point occurs first
  wins. A pre-logout bind becomes stale before execution; a post-logout bind is
  unavailable.
- Logout vs execution: abort and the post-check prevent a result from being
  accepted after invalidation.
- Process shutdown invokes authority invalidation synchronously before other
  teardown awaits; no context survives as current.

## 17. Browser lifecycle interaction

Browser lifecycle generation and auth generation are distinct domains. The
BT2 connection generation is a private stale-WebSocket guard; it must never be
compared with or copied into `authGeneration`.

| Browser event | authGeneration by that event alone | Reason |
|---|---|---|
| CDP reconnect | unchanged | transport channel changed, auth material did not |
| managed target destroyed/recreated | unchanged | page lifecycle is not auth identity |
| browser restart after crash | unchanged | BT2 cannot infer auth continuity or loss |
| user closes browser | unchanged | browser loss does not mutate the authority |
| explicit manager stop | unchanged | lifecycle shutdown is not logout |
| adoption of validated owned browser | unchanged | process ownership validation is not auth validation |
| browser process replacement | unchanged | only a trusted auth producer may invalidate/install material |

If BT4 later owns browser-derived authentication, it must explicitly invalidate
the auth authority when it observes that the material is no longer trustworthy,
then explicitly install newly validated material. Those two producer events
advance auth generation. BT3 never subscribes directly to BT2 lifecycle and
never makes `BrowserSessionManager` an auth store.

## 18. Secret lifetime

- A validated access token is copied once from a trusted installation candidate
  into the private immutable current record. JavaScript strings are immutable,
  so this is a reference/value copy that cannot be zeroized reliably.
- A refresh token is never copied into AuthContext or its authority record. It
  remains in hardened storage and the trusted refresh producer.
- Cookies are not copied or typed by BT3. A future BT4 design must decide their
  acquisition and storage boundary before they can participate.
- The opaque context contains neither values nor references directly accessible
  to consumers. The private WeakMap association is the capability.
- Guarded execution exposes the access token only for the duration of one
  callback and registers it with the active redaction scope first. Consumers
  are forbidden to retain it.
- On replacement/invalidation the controller is aborted, the current record is
  dropped, and old handles become unusable. Records may remain reachable until
  in-flight callbacks and garbage collection release them.
- No zeroization, deterministic erasure, or garbage-collection deadline is
  claimed. Node/JavaScript cannot guarantee those properties for strings.

## 19. Logging and redaction

The existing `AsyncLocalStorage` redaction scope remains the outward boundary.
Before future guarded execution exposes an access token, the authority calls
`registerSensitiveValue(accessToken)`. Errors crossing MCP remain processed by
the existing sanitization path.

Never log or place in an Error detail:

- access or refresh token;
- cookie name/value or Authorization value;
- password;
- full AuthContext object or execution view;
- email, username, account ID, or profile ID;
- raw candidate objects, storage documents, provider payloads, or headers.

Safe structured diagnostic fields are error kind, availability state,
generation, mutation cause enum, and whether a profile ID was present. The full
epoch is not routinely logged or returned; tests may inspect an injected
symbolic epoch. A stale error uses only a fixed message. The authority must
construct shared failures secret-free before rejecting, rather than relying on
the originating operation's redaction scope.

## 20. Error model

BT3 adds one closed internal error class with three kinds. It is not an MCP
error surface; BT5 must translate it to an existing safe tool result without
changing schemas.

| Kind | Fixed message | Trigger | Retryability / later consumer |
|---|---|---|---|
| `AUTH_CONTEXT_UNAVAILABLE` | `Authentication context is unavailable` | no ready record, expired/unusable material, invalid persisted candidate, exhausted generation, or missing required profile identity | retry only after explicit trusted installation; BT4 can initiate reauth, BT5 rejects operation |
| `AUTH_CONTEXT_STALE` | `Authentication context is stale` | old, aborted, forged/unrecognized handle; CAS mismatch; pre/post execution mismatch | caller must resolve/bind a new operation; never silently retry a mutation |
| `AUTH_IDENTITY_CHANGED` | `Authentication identity changed unexpectedly` | a refresh-continuity candidate changes account ID or changes presence/value of profile ID | non-retryable as continuity; current context invalidated; BT4 must establish a new explicit session |

`AUTH_GENERATION_MISMATCH` is rejected as redundant: every mismatch is stale.
Storage corruption remains a `StorageError` at the storage boundary and maps to
unavailable without producing a context. Error objects carry no token, identity,
epoch, provider body, header, filesystem path, or raw cause across the authority
boundary.

## 21. Fail-closed rules

1. No usable validated material: acquisition throws
   `AUTH_CONTEXT_UNAVAILABLE`; no anonymous or caller-supplied fallback.
2. Stale/forged handle or revision mismatch: execution throws
   `AUTH_CONTEXT_STALE`; no substitution with current material.
3. Invalid/corrupt/insecure persisted state: no context is installed.
4. Unexpected account/profile change during refresh continuity: old context is
   invalidated, candidate is not installed, and `AUTH_IDENTITY_CHANGED` is
   returned.
5. Missing required profile ID for a descriptor: binding fails unavailable;
   caller input cannot supply it.
6. Secret missing or expired after binding: authority invalidates as required
   and refuses execution.
7. Ambiguous authority ownership or context from a different authority:
   rejected stale by WeakMap/current-object check.
8. Mutation generation overflow: abort, unavailable/exhausted, no wrap.
9. Cancellation cannot retract a sent request: its result is discarded after
   failed post-check.
10. No fallback to arbitrary cookie, stale bearer, legacy global, environment
    value, caller header, browser tab, or current-generation replacement.

## 22. Threat model

| ID | Asset | Attacker capability / failure mode | Mechanical mitigation | Required test |
|---|---|---|---|---|
| T1 — caller injects bearer | access credential and request authority | supplies `Authorization`, `bearer`, `token`, or another undeclared key | existing registry accepts only declared caller keys; authority is not caller-reachable; backend material comes only from guarded private record | every injection rejected before backend; backend call count zero |
| T2 — caller injects account/profile | authenticated resource boundary | supplies `accountId`, `profileId`, or generation | registry classifies auth-derived overlap as `CALLER_SUPPLIED_IDENTITY`; binder resolves only declared sources from current private record | injected identity/generation rejected; derived values equal synthetic authority record |
| T3 — stale request uses refreshed credentials | generation-consistent operation | call bound at G is silently supplied G+1 material | opaque handle maps to exact record; pre-check requires current object; no current-record substitution | bind G, install G+1, execute G → `AUTH_CONTEXT_STALE`; G+1 token never observed by callback |
| T4 — logout races pending operation | logout invalidation | operation resolves or awaits while logout clears disk | synchronous invalidate/abort before async clear; pre/post checks; stale result discarded | barriers place logout before dispatch and during callback; both reject/abort deterministically |
| T5 — old context survives account switch | account/profile confidentiality and authorization | retained handle is reused after explicit new login/account switch | every install creates new handle/generation and aborts old; WeakMap/current identity check | install account A then explicit account B; A handle permanently stale |
| T6 — browser restart preserves auth trust incorrectly | separation of browser and auth state | lifecycle code assumes browser existence means authenticated continuity | no lifecycle-to-auth implicit mapping; only trusted BT4 writer can invalidate/install; browser manager has no auth fields | all BT2 events leave generation unchanged; explicit producer invalidation changes it |
| T7 — logs leak token/cookie | credential secrecy | error, debug object, or success payload contains raw material | fixed errors, non-enumerable opaque handle, no cookie type, register token before callback, existing central sanitizer | sentinel absent from errors/results/log fixture under success, failure, and concurrency |
| T8 — backend retains context indefinitely | capability lifetime | backend stores handle/token and tries later use | execution-only port, no mutator port, old handle becomes stale and callback view is short-lived; retention prohibited and tested | fake retains handle, mutation occurs, later use rejects; fake cannot access writer methods |
| T9 — generation reset causes false equality | revision identity | numeric generation repeats after process restart | fresh 128-bit process epoch; equality uses pair and capability identity | two deterministic epochs both at generation 1 are unequal and mutually rejected |
| T10 — corrupted persisted auth becomes trusted | credential integrity | malformed/insecure token state is treated as ready | existing hardened validation produces no candidate; authority accepts only validated closed candidate; unavailable on load failure | malformed, missing, insecure, expired candidates produce no context |
| T11 — late refresh overwrites logout | invalidation ordering | async refresh begins at G, logout advances, refresh completes | commit CAS requires captured exact revision | resolve refresh candidate, invalidate, commit → stale and unavailable remains |
| T12 — result accepted after invalidation | response integrity | remote request resolves after logout/refresh | shared abort signal plus mandatory post-callback currentness check | deferred callback resolves after invalidation; result discarded as stale |
| T13 — context forgery/cross-authority use | authority ownership | internal or caller code creates lookalike or uses another authority's handle | private brand plus authority-local WeakMap/current object identity | frozen lookalike and context from authority B both rejected by authority A |
| T14 — refresh changes identity silently | account/profile authorization | provider response changes account/profile while called “refresh” | refresh-mode commit requires exact identity equality, invalidates on mismatch | account change, profile addition/removal/change all yield `AUTH_IDENTITY_CHANGED` and stale old handle |
| T15 — generation wrap | revision uniqueness | enough mutations exceed safe-integer precision | explicit max check, abort, exhausted-unavailable, no wrap | injected max generation cannot install/invalidate into reused value |

The attacker model includes an untrusted MCP caller and accidental races or
misuse by internal transport code. It does not claim protection against an
arbitrary-code-execution attacker in the Node process, which could inspect
memory or monkey-patch modules.

## 23. Invariant table

| ID | Authoritative invariant |
|---|---|
| BT3-I1 | MCP caller input can never construct, select, modify, serialize-and-rehydrate, or supply an accepted AuthContext. |
| BT3-I2 | MCP caller input can never set epoch, authGeneration, Authorization, bearer, cookie, account ID, or profile ID. |
| BT3-I3 | Exactly one process-local AuthContextAuthority owns the current transport-auth record. |
| BT3-I4 | Every accepted state mutation publishes one immutable record or unavailable state at one monotonically increasing generation within the same epoch. |
| BT3-I5 | Generation never wraps or resets within an epoch; process restart always creates a different epoch. |
| BT3-I6 | An operation bound to revision G is either executed with G's exact material or rejected; it is never executed with another revision's material. |
| BT3-I7 | Replacement/invalidation aborts and permanently stales every prior-generation handle before later asynchronous cleanup. |
| BT3-I8 | Backend results are accepted only after a post-execution currentness check for the same handle. |
| BT3-I9 | AuthContext exposes no raw secret or sensitive identity field and has no usable serialized representation. |
| BT3-I10 | Access material is exposed only inside guarded execution after registration with the current redaction scope; refresh tokens and cookies are never exposed by BT3. |
| BT3-I11 | Auth-derived parameters are resolved from the same private record as the bound context and remain separate from `callerParams`. |
| BT3-I12 | Unexpected account/profile change during refresh continuity invalidates the old context and cannot become current through that refresh commit. |
| BT3-I13 | Invalid, insecure, absent, corrupt, expired, or ambiguous material never produces a READY context. |
| BT3-I14 | Browser lifecycle and CDP connection generation never implicitly mutate or stand in for authGeneration. |
| BT3-I15 | `ResolvedCall`, BT1 registry policy, BT2 lifecycle policy, and `PRODUCTION_OPERATIONS` remain unchanged in BT3. |
| BT3-I16 | Public MCP remains exactly 21 tools with unchanged names, schemas, descriptions, and reachability. |
| BT3-I17 | No BT3 error, log, diagnostic, or result carries raw auth material or sensitive identity. |
| BT3-I18 | BT3 performs no login, logout persistence migration, live network access, browser launch, cookie/bearer extraction, or CDP capability expansion. |

## 24. Test strategy

The BT3 suite is deterministic, offline, browser-free, and uses only symbolic
secrets/identities. An injected epoch factory, clock, and deferred promises make
all races explicit. Required cases:

### Revision and authority lifecycle

- initial epoch is injected and generation is 0/unavailable;
- first install creates generation 1; repeated acquire remains generation 1;
- every replacement and invalidation increments exactly once;
- failed validation and failed CAS do not publish or increment;
- max-safe generation becomes exhausted/unavailable without wrap;
- two process epochs with equal numeric generation are unequal;
- stale, forged, cross-authority, and serialized lookalike handles reject.

### Material and identity

- valid symbolic material produces an opaque frozen handle;
- object keys and JSON output reveal no material or identity and cannot be
  rehydrated;
- absent/empty/expired/malformed fields produce unavailable;
- refresh with same identity increments and replaces token;
- account change, profile add/remove/change during refresh invalidates and
  returns `AUTH_IDENTITY_CHANGED`;
- explicit establish mode may install a different account only as a new
  session, never as refresh continuity;
- a descriptor requiring absent profile ID fails closed.

### Concurrency and stale execution

- simultaneous acquisitions return the same current handle;
- mutation between registry resolution and bind uses the newly current context,
  because no auth was captured yet;
- mutation after bind but before guarded use rejects stale;
- logout/invalidation during a deferred callback aborts its signal and discards
  the eventual result;
- a late async candidate cannot overwrite logout or a newer commit;
- multiple pending operations for one generation all receive abort and fail
  their post-check;
- transient producer failure leaves a still-usable exact record/generation
  unchanged.

### Boundaries and redaction

- `AuthorizedCall` preserves the original `ResolvedCall` object and places
  identity only in a frozen separate map;
- public calls carry no context; account calls require one;
- caller bearer/account/profile/generation injection remains rejected before
  fake backend invocation;
- callback token sentinel is registered/redacted on success and failure;
- fixed errors contain no token, identity, epoch, cause, or provider body;
- fake backend retention cannot make an old handle usable;
- source scan/type assertions show no refresh token, cookie, writer method, or
  BrowserSessionManager reference in the consumer port.

### Preservation

- existing `mcp-harness.test.ts` proves both source and bundle still publish 21
  baseline names and schemas;
- registry, dispatcher, auth storage, refresh, logout, redaction, and BT2
  lifecycle suites remain green;
- diff scope proves no `src/index.ts`, `src/api.ts`, `src/auth.ts`, BT2 CDP, or
  package change.

## 25. Future TDD implementation tasks

No task below is executed by this design gate.

### TASK 0 — frozen baseline and scope proof

- **FILES:** none.
- **PURPOSE:** verify frozen BT2 head, clean worktree, 21-tool harness,
  `PRODUCTION_OPERATIONS` empty, and baseline tests.
- **RED:** none; precondition gate.
- **EXPECTED FAILURE CLASS:** baseline divergence blocks all work.
- **IMPLEMENTATION:** none.
- **GREEN:** recorded baseline/typecheck/build/tests.
- **REGRESSION:** none beyond baseline.
- **COMMIT MESSAGE:** no commit.
- **DEPENDENCIES:** frozen BT2 only.

### TASK 1 — opaque revision, context, and error vocabulary

- **FILES:** add `src/transport/auth-context.ts`; add
  `test/auth-context.test.ts`.
- **PURPOSE:** define epoch/generation domain, opaque non-rehydratable context,
  closed errors, deterministic epoch seam.
- **RED:** tests import missing module and assert generation 0, opacity,
  cross-epoch inequality, fixed messages, and overflow behavior.
- **EXPECTED FAILURE CLASS:** module/type resolution RED, followed by behavioral
  assertions for missing capability checks.
- **IMPLEMENTATION:** minimal private brand/WeakMap scaffolding, epoch factory,
  error class, unavailable initial state.
- **GREEN:** focused context primitive tests.
- **REGRESSION:** typecheck, build, full test, diff check.
- **COMMIT MESSAGE:** `BT3: define opaque auth context revisions`.
- **DEPENDENCIES:** Task 0.

### TASK 2 — authority install, acquire, replace, and invalidate

- **FILES:** modify `src/transport/auth-context.ts` and
  `test/auth-context.test.ts`.
- **PURPOSE:** implement one immutable current record, closed material
  validation, generation mutation, explicit establish-vs-refresh identity
  semantics, and abort-on-invalidate.
- **RED:** initial unavailable, install/increment, stable acquire, refresh
  replacement, logout invalidation, identity-change, expiration, and max tests
  fail behaviorally.
- **EXPECTED FAILURE CLASS:** missing authority transitions and fail-closed
  validation.
- **IMPLEMENTATION:** synchronous atomic state replacement and private record;
  no network/storage/browser wiring.
- **GREEN:** lifecycle/identity table passes.
- **REGRESSION:** Task 1 plus full/typecheck/build/diff.
- **COMMIT MESSAGE:** `BT3: own auth context lifecycle and generation`.
- **DEPENDENCIES:** Task 1.

### TASK 3 — CAS mutation and guarded execution

- **FILES:** modify `src/transport/auth-context.ts` and
  `test/auth-context.test.ts`.
- **PURPOSE:** close await races with expected-revision CAS, pre/post checks,
  AbortSignal, and scoped secret exposure.
- **RED:** deferred refresh-vs-logout, mutation-before-dispatch,
  mutation-during-execution, concurrent pending operations, late completion,
  and stale-result tests fail behaviorally.
- **EXPECTED FAILURE CLASS:** stale operations incorrectly invoke/return or late
  candidate overwrites current state.
- **IMPLEMENTATION:** synchronous CAS commit and `runCurrent` guarded callback;
  register access token before callback.
- **GREEN:** deterministic barrier tests prove no cross-generation execution.
- **REGRESSION:** redaction concurrency, full/typecheck/build/diff.
- **COMMIT MESSAGE:** `BT3: reject stale auth work across async boundaries`.
- **DEPENDENCIES:** Task 2 and existing redaction API.

### TASK 4 — bind auth-derived values without changing ResolvedCall

- **FILES:** modify `src/transport/auth-context.ts` and
  `test/auth-context.test.ts` only.
- **PURPOSE:** add the discriminated public/authenticated execution wrappers and
  resolve declared `accountId`/`profileId` from the same current record.
- **RED:** account binding, missing profile, public wrapper, frozen-map,
  caller-injection, and bind-vs-mutation tests fail.
- **EXPECTED FAILURE CLASS:** missing wrapper/binder; no backend product change.
- **IMPLEMENTATION:** `bind(ResolvedCall)` with descriptor-scope checks and
  separate auth-derived map. Do not edit dispatcher/backend yet.
- **GREEN:** wrapper and existing registry tests pass.
- **REGRESSION:** BT1 transport suites plus full/typecheck/build/diff.
- **COMMIT MESSAGE:** `BT3: bind resolved calls to current auth identity`.
- **DEPENDENCIES:** Task 3 and frozen BT1 descriptors.

### TASK 5 — security and unreachability closure

- **FILES:** modify `test/auth-context.test.ts`; documentation-only update to
  the BT3 implementation report. No production change unless an observed
  security RED identifies an omission in Tasks 1–4.
- **PURPOSE:** prove redaction, retention resistance, absent refresh/cookie
  capability, no browser coupling, public unreachability, and dependency/file
  scope.
- **RED:** write source/boundary assertions before any correction; record the
  observed result honestly. If already GREEN, do not fabricate a defect.
- **EXPECTED FAILURE CLASS:** RED or GREEN observation-first security closure.
- **IMPLEMENTATION:** only a minimal fix for an observed BT3 omission; no public
  wiring.
- **GREEN:** focused suite, full suite, typecheck, build, 21-tool source/bundle
  harness, forbidden-file diff, and no-network inspection.
- **REGRESSION:** all existing auth/transport/BT2 tests.
- **COMMIT MESSAGE:** `BT3: verify auth context boundary remains internal`.
- **DEPENDENCIES:** Tasks 1–4.

## 26. Exact proposed file map

### New production file

- `src/transport/auth-context.ts` — private authority, opaque context,
  revision/error types, producer/consumer ports, authorized-call wrapper.

Keeping the closed error and small types in this one module avoids an
unnecessary production-file expansion. A split is not authorized without an
external design update.

### New test file

- `test/auth-context.test.ts` — all deterministic unit, concurrency, redaction,
  boundary, and unreachability tests.

### Existing files run but expected unchanged

- `test/transport-registry.test.ts`
- `test/transport-dispatcher.test.ts`
- `test/redaction.test.ts`
- `test/mcp-harness.test.ts`
- all existing auth/storage/refresh/logout and BT2 lifecycle tests.

### Must remain untouched by BT3 implementation

- `src/api.ts`, `src/auth.ts`, `src/index.ts`, `src/redact.ts`;
- `src/transport/types.ts`, `operation-registry.ts`, `dispatcher.ts`,
  `websocket.ts`, all BT2 browser/CDP/profile/lifecycle files;
- all existing test sources and fixtures;
- `package.json`, `package-lock.json`, `tsconfig.json`, `build.js`, and
  `.github/workflows/*`.

If implementation evidence shows one of these must change, BT3 stops for
external review rather than broadening scope.

## 27. BT3 → BT4 interface

BT4 will receive only a restricted writer port from the composition root; it
will not receive the authority object or execution consumer port.

```ts
interface AuthContextWriter {
  currentRevision(): AuthRevisionView;

  commitAuthenticatedMaterial(
    expected: AuthRevisionView,
    mode: "ESTABLISH" | "REFRESH",
    candidate: Readonly<{
      accessToken: string;
      tokenType: string;
      expiresAt: number;
      accountId: string;
      profileId?: string;
    }>
  ): AuthContext;

  invalidate(cause:
    | "LOGOUT"
    | "INVALID_GRANT"
    | "AUTH_MATERIAL_LOST"
    | "PROCESS_SHUTDOWN"
  ): AuthRevisionView;
}
```

The port validates every string/expiration again; a trusted producer is not
treated as infallible. BT4 cannot choose epoch/generation, obtain current access
material, create handles, resolve calls, or suppress invalidation. `REFRESH`
requires exact account/profile continuity. `ESTABLISH` permits an explicit new
authenticated identity and always produces a new generation. The writer is
internal and never placed in an MCP handler argument or result.

BT4 may later obtain bearer/cookie material through its separately reviewed
login/status design. BT3's current candidate accepts an access token only; it
does not pre-authorize cookie acquisition or add a cookie field.

## 28. BT3 → BT5 interface

BT5 receives a read/execution port without mutation methods:

```ts
interface AuthContextReader {
  bind(call: ResolvedCall): ExecutionCall;
  runCurrent<T>(
    call: AuthorizedCall,
    execute: (view: AuthExecutionView) => Promise<T>
  ): Promise<T>;
}
```

BT5 can acquire one auth-consistent wrapper, use only closed registry-derived
identity parameters, receive an abort signal at secret-use time, and detect
staleness before and after execution. It cannot set identity, generation, or
material and cannot silently retry a mutation after stale rejection. Public
operations bypass auth explicitly; account operations cannot proceed without
an `AuthorizedCall`.

Actual dispatcher/backend cutover, endpoint rendering, retry policy, and
operation registration remain BT5 work. BT3 provides the mechanical contract
but does not wire it.

## 29. Public MCP proof obligations

Every BT3 implementation commit and final gate must prove:

1. `src/index.ts`, `src/api.ts`, `src/auth.ts`, and public fixtures are unchanged
   from frozen BT2.
2. `PRODUCTION_OPERATIONS` is still `Object.freeze([])`.
3. No import path from public entry surfaces reaches `auth-context.ts`.
4. Source and built bundle each report exactly the 21 baseline tool names.
5. Each input schema remains structurally equal to
   `test/fixtures/baseline-tools.json`; descriptions also remain unchanged by
   source diff.
6. Unknown tools retain current `MethodNotFound` behavior.
7. No caller schema admits Authorization, bearer, cookie, account/profile
   identity, epoch, generation, context, browser input, or CDP method.
8. Existing login/status/logout behavior is neither migrated nor newly routed.

Any required public change blocks BT3 Design/Implementation and needs an
independent gate.

## 30. Dependency statement

BT3 requires no new runtime or development dependency. Node 18 built-ins cover
`randomBytes`, `AbortController`, `WeakMap`, object freezing, and promises.
Existing `AsyncLocalStorage` redaction is reused.

The frozen package has runtime dependencies only on
`@modelcontextprotocol/sdk` and `ws`; development dependencies are
`@types/node`, `@types/ws`, `esbuild`, `tsx`, and `typescript`. Its engine floor
is Node `>=18`. `tsconfig.json` uses strict NodeNext TypeScript over `src/`, and
`build.js` bundles the Node ESM entry with esbuild's Node 18 target and the
existing `createRequire` banner. BT3 changes none of those contracts or the
lockfile (lockfile version 3).

The BT2 matrix carried forward npm audit output of 9 existing advisories: 1
low, 4 moderate, and 4 high. They were not introduced by this design gate. No
`npm audit fix`, package update, lockfile edit, or remediation is authorized;
dependency remediation is a separate gate.

## 31. Open questions

There are **zero blocking open questions** for the BT3 abstraction.

### OQ-1 — future browser-cookie representation

- **OPEN QUESTION:** Will BT4 produce only access-token material, a
  browser-resident cookie capability, or both?
- **WHY IT MATTERS:** cookies must not be copied into the current BT3 access
  token record without a reviewed lifetime and use boundary.
- **OPTIONS:** extend the future writer under a BT4 gate; keep cookies entirely
  browser-resident behind a new opaque capability; or use access tokens only.
- **RECOMMENDED OPTION:** keep BT3 access-token-only and let BT4 propose a
  separate opaque browser-resident capability if real evidence requires it.
- **WHAT EVIDENCE IS MISSING:** the separately authorized BT4 login/status and
  credential-observation design.
- **BLOCKING:** NO. BT3 neither extracts nor needs cookies.

### OQ-2 — transport-specific cancellation strength

- **OPEN QUESTION:** Which future BT5 backend operations can actively cancel an
  in-flight request on `AbortSignal`?
- **WHY IT MATTERS:** cancellation reduces remote side effects after logout,
  although the post-check already prevents accepting a stale result.
- **OPTIONS:** native fetch signal, backend-specific cancellation adapter, or
  post-check-only where the underlying primitive cannot cancel.
- **RECOMMENDED OPTION:** require native cancellation where the backend supports
  it and always retain the mandatory post-check.
- **WHAT EVIDENCE IS MISSING:** BT5 endpoint/backend implementation choices.
- **BLOCKING:** NO. BT3's abort and result-rejection semantics are complete
  without falsely claiming remote rollback.

## 32. External-review checklist

### Architecture

- [ ] Frozen BT2 head, 13-commit chain, zero merges, and preservation evidence
  are referenced exactly.
- [ ] AuthContext is opaque, immutable, authority-issued, and contains no
  caller-visible secret or identity fields.
- [ ] Authority has exactly one immutable current record or is unavailable.
- [ ] Epoch plus monotonic safe-integer generation prevents cross-process false
  equality and in-process reuse.
- [ ] Overflow fails unavailable without wrap.
- [ ] `ResolvedCall` remains unchanged; `AuthorizedCall` is a separate wrapper.
- [ ] Caller parameters and auth-derived values remain mechanically separate.
- [ ] Pre-use check, AbortSignal, and post-use check close the documented await
  races without claiming remote rollback.
- [ ] Refresh identity mismatch invalidates rather than silently switching.
- [ ] Logout invalidates before asynchronous persistence work.
- [ ] Browser lifecycle never becomes auth authority or auth generation.

### Secrets and failures

- [ ] Access token exists only in private authority material and a scoped future
  execution view.
- [ ] Refresh tokens, cookies, passwords, Authorization values, and sensitive
  identity never enter AuthContext, logs, or fixed errors.
- [ ] Existing redaction scope registers access material before use.
- [ ] Invalid storage/material, stale context, identity change, missing profile,
  and ambiguous authority all fail closed.
- [ ] No zeroization or network rollback claim is made.

### Scope preservation

- [ ] No source/test/package/workflow/build file was changed in Design Gate 0.
- [ ] Future BT3 file map is one new production module and one new test file.
- [ ] No login, logout migration, live network, credential read, browser, CDP
  expansion, operation registration, public cutover, or BT4+ work is included.
- [ ] Public target remains 21 tools and `PRODUCTION_OPERATIONS` remains empty.
- [ ] No new dependency is proposed.

### Required self-review answers

1. **Can caller input construct AuthContext?** NO; private brand plus
   authority-local WeakMap/current identity.
2. **Can caller input set authGeneration?** NO; only synchronous authority
   transitions increment it.
3. **Can an old generation silently execute with new credentials?** NO; old
   handle is aborted/stale and no substitution occurs.
4. **Can BrowserSessionManager become auth authority?** NO; no auth state or
   port is added to it.
5. **Does CDP reconnect alone change authGeneration?** NO; channel continuity is
   not auth-material mutation.
6. **Does browser restart alone change authGeneration?** NO; BT2 cannot infer
   auth state. A separate trusted producer invalidation/install may do so.
7. **Does token refresh change authGeneration?** A successful material
   replacement always increments once; transient failure with unchanged usable
   material does not; invalid-grant/identity anomaly invalidates and increments.
8. **Does logout invalidate all outstanding contexts?** YES; synchronous abort
   and unavailable publication precede filesystem awaits, and post-checks reject
   late results.
9. **Can raw auth secrets enter logs?** NO by contract, fixed errors, scoped
   registration, and boundary tests.
10. **Does BT3 modify the 21-tool contract?** NO.
11. **Does BT3 perform login?** NO.
12. **Does BT3 require Crunchyroll network?** NO.
13. **Does BT3 require `Fetch.*` or `Network.*`?** NO.
14. **Is process-restart false generation equality prevented?** YES, by fresh
   epoch plus generation and non-rehydratable capability identity.
15. **Are BT4 and BT5 responsibilities separated?** YES; BT4 receives only a
   closed writer, BT5 only bind/guarded-execution read capabilities.

### Gate verdict

On approval, this document authorizes only a future BT3 TDD implementation of
the internal abstraction described above. It does not authorize integration,
cutover, BT4, or BT5.
