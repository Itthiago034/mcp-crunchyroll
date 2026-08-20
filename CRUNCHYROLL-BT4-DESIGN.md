# MCP Crunchyroll — BT4 Design (Auth Producer)

Internal design checkpoint for the BT4 macrophase. It freezes what BT4 will
implement before any production code is written. It authorizes no BT5 work, no
public MCP change, and no BT3 contract change.

## 1. Frozen starting point

| Property | Value |
|---|---|
| Worktree | `/tmp/mcp-crunchyroll-bt0` |
| Base BT3 head | `c8c565fa2604adbc7672febf3253228bbd803166` |
| BT4 branch | `bt4-auth-producer` |
| Authoritative designs | BT3 Design Gate 0, its FIX1 errata, the auth map, the BT3 implementation report |

BT3 is closed. `src/transport/auth-context.ts` and `test/auth-context.test.ts`
are not modified by BT4.

## 2. Observed source behaviour (evidence, not assumption)

Read from the frozen tree before designing.

### `src/auth.ts` — hardened persistence

- `TokenData` = `access_token`, `refresh_token`, `expires_at` (ms), `token_type`,
  `account_id`, optional `profile_id`, plus non-persisted `unknown_fields`
  diagnostics.
- `SessionInfo` = optional `email`, `username`, `account_id`, generated
  `saved_at`.
- `saveTokens` validates *before* serializing and writes the sanitized document
  only; `loadTokens` refuses symlinks/insecure modes/foreign owners, treats a
  genuinely missing file as `null`, and raises `StorageError("CORRUPT_SESSION")`
  on malformed JSON.
- `hasSavedTokens()` returns `false` only for genuine absence; an insecure store
  throws rather than silently reporting "logged out".
- `clearAuthData(): LogoutResult` is non-throwing by contract and returns
  `state ∈ {CLEARED, ALREADY_ABSENT, PARTIAL, FAILED}` plus per-artifact
  `{state, reason}` where `reason ∈ {INSECURE_DIR, INSECURE_OWNER,
  FILESYSTEM_ERROR}`. An insecure target is classified `FAILED` and is never
  unlinked through.
- `isTokenExpired(tokens)` is `Date.now() >= expires_at - 60_000` (a one-minute
  buffer).

### `src/api.ts` — legacy network auth

- `login(email, password)` posts the password grant, structurally validates the
  payload, registers both tokens with the redaction scope, then `saveTokens`
  and `saveSessionInfo`. It returns **only** `{success, message}` — the token
  material is not returned to the caller. Every throw is swallowed into
  `{success:false, message}`.
- `refreshRequest(oldTokens)` is a process-local single-flight wrapper around
  `refreshOperation`, cleared in `finally` on both outcomes.
- `refreshOperation` classifies with a fixed precedence: semantic
  `invalid_grant` (strict `===`, JSON object body) beats HTTP status; `429`/`5xx`
  → `TRANSIENT`; other non-2xx → `SAFE_FAILURE`; network throw → `TRANSIENT`;
  2xx with a bad shape → `MALFORMED_RESPONSE`. On `REAUTH_REQUIRED` it performs
  a best-effort `clearAuthData()` **and then throws**. On success it saves the
  new tokens and returns them.
- `getStatus()` reads `hasSavedTokens` / `loadTokens` / `loadSessionInfo` and
  returns `{logged_in, email?, account_id?, token_expires_at?}`. It performs no
  refresh and no write.
- `getValidToken()` loads tokens, refreshes when expired, and is called by every
  content function.

### `src/index.ts` — MCP boundary and composition root

- 21 tools. `crunchyroll_login` serializes `login()`'s result verbatim;
  `crunchyroll_logout` formats `LogoutResult` through `formatLogoutResult`;
  `crunchyroll_status` serializes `getStatus()` verbatim.
- Every call runs inside `withRedactionScope`; results and errors converge on
  `sanitizeToolResult` / `safeErrorWithCleanStack`.
- `main()` creates a `StdioServerTransport` and connects. **There is no
  shutdown hook, no signal handler and no dependency-injection seam.**

## 3. BT4-B1 — the composition-wiring collision (material finding)

BT3 Task 5 froze three closure assertions inside `test/auth-context.test.ts`:

1. *"no import path from the MCP entry point reaches the authority"* — a
   transitive import walk from `src/index.ts`;
2. *"no other production module imports the authority"* — no file under `src/`
   may contain `from "…auth-context.js"`, **including a type-only import**;
3. *"the published bundle carries no trace of the authority"* — `dist/index.js`
   must contain none of its markers.

Wiring an `AuthContextAuthority` into the composition root, or importing the
authority module from any production file, breaks all three. The BT4 mandate
simultaneously requires that BT3 tests remain unmodified **and** pass.

**Resolution frozen here.** BT4 delivers the complete trusted producer with the
writer supplied by **dependency injection**, and does **not** instantiate an
authority in the composition root. Consequences:

- the producer declares its writer port **structurally** and imports nothing
  from `auth-context.ts`, so all three closure assertions keep passing
  untouched;
- BT4's own tests import the real `AuthContextAuthority` (the assertions scan
  `src/` only), so every producer transition is proven against the **real** BT3
  authority through the **real** `asWriter()` port — this is verified
  integration, not a mock of the boundary;
- the single remaining step — `createAuthContextAuthority()` in the composition
  root and passing `asWriter()` to the producer — is recorded as **deferred
  obligation BT4-D1**, requiring the external reviewer to authorize retiring or
  re-scoping the three BT3 stage-closure assertions.

This follows the precedent the BT4 mandate itself sets for `PROCESS_SHUTDOWN`
(§19): when the frozen architecture cannot safely accommodate a step, document
it as a composition obligation rather than forcing a refactor. It is recorded as
a **non-blocking** design question because every other BT4 deliverable is
complete and independently verifiable without it.

## 4. Ownership

```
src/auth.ts        hardened persistence (unchanged)
src/api.ts         legacy network auth + single-flight refresh (unchanged)
src/index.ts       21-tool MCP boundary (unchanged)
src/transport/auth-producer.ts   BT4 — orchestration only
src/transport/auth-context.ts    BT3 — live authority (closed)
```

The producer owns **ordering and translation**. It owns no secret storage, no
live authority state, no network client and no MCP surface. It never sees an
`AuthContext`: its writer port types the commit result as `unknown`, so BT4
mechanically cannot consume a handle.

## 5. Ports (all injected; no import of `auth-context.ts`)

```ts
interface AuthRevisionSnapshot { readonly epoch: string; readonly generation: number }

interface AuthWriterPort {
  currentRevision(): AuthRevisionSnapshot;
  commitAuthenticatedMaterial(
    expected: AuthRevisionSnapshot,
    mode: "ESTABLISH" | "REFRESH",
    candidate: Readonly<{ accessToken: string; tokenType: string; expiresAt: number;
                          accountId: string; profileId?: string }>
  ): unknown;                       // deliberately NOT AuthContext
  invalidate(cause: "LOGOUT" | "INVALID_GRANT" | "AUTH_MATERIAL_LOST"
                    | "PROCESS_SHUTDOWN"): AuthRevisionSnapshot;
}

interface AuthStoragePort {         // bound to src/auth.ts
  loadTokens(): Promise<TokenLike | null>;
  clearAuthData(): Promise<LogoutResult>;
  isTokenExpired(tokens: TokenLike): boolean;
}

interface LegacyAuthPort {          // bound to src/api.ts
  login(email: string, password: string): Promise<{ success: boolean; message: string }>;
  refreshRequest(tokens: TokenLike): Promise<TokenLike>;
  getStatus(): Promise<StatusShape>;
}
```

`createDefaultAuthProducerPorts()` binds the storage and legacy ports to the
real `src/auth.ts` / `src/api.ts` functions. It is a compile-time proof that the
ports are satisfiable by the real implementations, and it makes the future
wiring a one-liner. It is not reachable from `src/index.ts`.

No `AuthContextReader`, `bind`, `runCurrent`, epoch/generation control, context
issuance or BT2 browser authority is available to BT4.

## 6. Login → ESTABLISH

`login()` returns no material, so the producer must not re-implement the network
grant (that would create a second competing auth implementation). Frozen order:

1. delegate to the legacy `login(email, password)` — password and email never
   leave that boundary and never enter the producer's state, a candidate or the
   authority;
2. `success === false` → **no authority transition at all**;
3. on success, read the material back through hardened `loadTokens()`;
4. snapshot the five authorized fields **once** into local primitives and
   validate them (BT3-R1 lesson: never validate one read and commit another);
5. `expected = writer.currentRevision()`;
6. `commitAuthenticatedMaterial(expected, "ESTABLISH", candidate)`.

**Persistence precedes authority, deliberately.** The authority is process-local
and reconstructible from hardened storage; storage is durable. Authority-first
would allow a crash to leave a live context with no durable backing — the worse
half of a split brain. The chosen order can only produce
*persisted-but-not-yet-live*, which the next bootstrap or refresh repairs.

Failure semantics, each explicit and tested:

| Failure point | Persistence | Authority | Outcome |
|---|---|---|---|
| legacy login fails | untouched | unchanged | `LOGIN_FAILED` |
| read-back absent | tokens saved | unchanged | `MATERIAL_UNAVAILABLE` |
| read-back throws `StorageError` | tokens saved | unchanged | `MATERIAL_UNAVAILABLE` |
| read-back invalid/expired | tokens saved | unchanged | `MATERIAL_UNAVAILABLE` |
| commit rejected | tokens saved | unchanged by this call | `AUTHORITY_REJECTED` + closed reason |

No silent retry, ever.

## 7. Refresh → REFRESH

The existing single-flight is preserved and not refactored. `refreshInFlight` is
a *request* deduplicator: it is not the authority, not a generation, not a lock
and not an `AuthContext`.

1. `expected = writer.currentRevision()` **before** awaiting anything;
2. `loadTokens()`; absent → `NO_MATERIAL`, no transition;
3. `await refreshRequest(oldTokens)` — outside the authority, single-flight
   intact; the refresh token stays owned by that path and by storage;
4. snapshot-and-validate the returned material once;
5. `commitAuthenticatedMaterial(expected, "REFRESH", candidate)`.

Outcomes: `REFRESHED`; `STALE` when BT3's CAS rejects a late completion that
lost to a logout or a newer commit — the stale commit installs nothing and the
producer never retries; `IDENTITY_CHANGED` when BT3 refuses continuity.

**Identity continuity has exactly one rule, and it is BT3's.** The producer does
not compare identities itself and does not work around
`AUTH_IDENTITY_CHANGED`. Observed consequence, documented rather than papered
over: `refreshOperation` persists the new tokens before returning, so after an
identity anomaly the store describes a new identity while the authority is
UNAVAILABLE. Recovery requires an explicit new `ESTABLISH`; the producer never
auto-establishes.

Failure classes that leave material intact and perform **no** authority
transition: `TRANSIENT`, `SAFE_FAILURE`, `MALFORMED_RESPONSE`.

## 8. invalid_grant

On `REAUTH_REQUIRED` the producer performs, in this order:

1. `writer.invalidate("INVALID_GRANT")` — synchronous, first;
2. `await clearAuthData()` — producer-owned, idempotent.

Live invalidation therefore always precedes producer-owned asynchronous
persistence work, and a `PARTIAL`/`FAILED` clear can never resurrect authority
state. Observed carry-forward: legacy `refreshOperation` already performs its
own best-effort clear before throwing, so the producer's clear typically reports
`ALREADY_ABSENT`. That legacy clear is inside `src/api.ts`, which BT4 does not
modify; once BT4-D1 is authorized, the producer's refresh becomes the entry
point and the legacy clear becomes redundant rather than ordering-relevant.

## 9. Logout

1. `writer.invalidate("LOGOUT")` — synchronous, before any filesystem work;
2. `await clearAuthData()`;
3. return the structured `LogoutResult` **unchanged**.

`CLEARED` / `ALREADY_ABSENT` / `PARTIAL` / `FAILED` and every per-artifact state
and reason are preserved verbatim — BT4 adds no second outcome matrix and never
collapses them into a generic auth error. Authority invalidation and persistence
cleanup remain separate layers, and a failed clear never restores the authority.
If the authority is already terminal (EXHAUSTED) the invalidation is recorded as
`ALREADY_TERMINAL` and the clear still proceeds.

## 10. Status — read-only

`status()` delegates to the legacy `getStatus()` and **never touches the writer
at all**: not `currentRevision`, not `commit`, not `invalidate`. It performs no
refresh, installs no context, mutates no storage and changes no identity. The
returned shape is byte-compatible with today's public output; BT4 adds no field,
so no epoch, generation, token, refresh token, Authorization value or new
identity can appear. Diagnostics are deliberately *not* consulted: not calling
the authority is a stronger read-only proof than calling it carefully.

## 11. Startup bootstrap

Implemented and tested; not wired (BT4-D1). Continuity across restart is today
provided by hardened storage plus legacy `getValidToken()`, so bootstrap is not
required by the current composition — it is required by BT5, and is specified
now so BT5 inherits it rather than inventing it.

1. `loadTokens()` outside the authority; absent → `NO_MATERIAL`, stay
   unavailable;
2. `StorageError` (corrupt/insecure) → `STORAGE_UNUSABLE`, stay unavailable, the
   structured storage failure is preserved and never downgraded to "logged out";
3. expired under `isTokenExpired` → `EXPIRED`, stay unavailable, no commit;
4. otherwise snapshot-validate, capture revision, `ESTABLISH` via CAS.

No epoch or generation is ever persisted, and neither `tokens.json` nor
`session.json` changes format.

## 12. Expiry

BT3's rule is preserved unchanged: expiry is a usability condition, not an
authority transition. BT4 adds **no timer**, no expiry watcher and no competing
expiration state machine. An expired candidate is refused at commit; an expired
current record is unusable to BT3; the producer refreshes only through its
existing acquisition flow.

## 13. Token type, refresh token, cookies, browser

- `tokenType` is validated provider metadata carried on the candidate. BT4
  performs **no** header or Authorization rendering — that is BT5's.
- The refresh token never enters the candidate, the authority, the execution
  view, diagnostics, logs, errors or any public result. It stays with the
  refresh path and hardened storage.
- **No cookie and no browser auth.** The authorized producer scope is the
  existing password-grant and refresh-token flows, which are pure HTTP and need
  no browser trust model. No `Network.*`, `Fetch.*`, `Runtime.evaluate`, generic
  CDP, cookie jar or navigation is added. BT3's OQ-1 stays deferred.

## 14. Process shutdown

`main()` exposes no deterministic shutdown hook. Per the mandate, BT4 does not
invent a lifecycle refactor: `invalidateForShutdown()` is implemented and tested
so the future hook is a one-liner, and its wiring is recorded together with
BT4-D1 as a composition obligation.

## 15. Errors and hostile objects

BT4 adds no `AuthContextError` kind. It classifies BT3 rejections structurally —
`name === "AuthContextError"` plus a **runtime allowlist** of the three closed
kinds — because `instanceof` is unavailable without importing the module and
TypeScript unions do not exist at runtime.

Every object crossing a producer boundary (storage documents, refreshed
material, thrown errors) is **snapshotted once** into local primitives before
validation, so no getter or Proxy trap can answer validation with one value and
the commit with another. This is the closed BT3-R1 lesson applied one layer out.

Producer outcomes are closed discriminated unions carrying no message, no
provider body, no token, no password, no account or profile identifier and no
filesystem path.

## 16. Concurrency

- Two concurrent refreshes share one in-flight request (unchanged) and produce
  one commit; the second observes the same settled result.
- A refresh that loses to a logout is rejected by BT3's CAS; nothing is
  restored.
- Login and refresh both capture their expected revision before awaiting, so a
  transition landing during the await is detected rather than overwritten.
- The producer holds no mutable auth state of its own beyond an optional
  injected clock, so there is no second state machine to race.

## 17. File map (frozen)

New:

- `src/transport/auth-producer.ts`
- `test/auth-producer.test.ts`
- `CRUNCHYROLL-BT4-DESIGN.md`
- `CRUNCHYROLL-BT4-IMPLEMENTATION-REPORT.md`

Unchanged: `src/api.ts`, `src/auth.ts`, `src/index.ts`, `src/redact.ts`, every
BT1/BT2/BT3 transport source, every existing test and fixture, `package.json`,
`package-lock.json`, `tsconfig.json`, `build.js`, `.github/`.

Any file outside this map = STOP for review.

## 18. Test matrix

Deterministic, offline, browser-free, synthetic sentinels only; the real
`AuthContextAuthority` drives every authority assertion.

A login→ESTABLISH once · B login failure→no transition · C persistence/read-back
failure ordering · D bootstrap established · E bootstrap missing→unavailable ·
F bootstrap corrupt/insecure→unavailable · G refresh→REFRESH once · H refresh
CAS loses to logout · I single-flight preserved · J refresh account change ·
K profile add/remove/change · L invalid_grant invalidates before clear ·
M transient failure preserves material · N logout invalidates before cleanup ·
O partial/failed clear does not restore authority · P status read-only and
generation-stable · Q secrets absent from outcomes and errors · R refresh token
never in candidate · S password never in authority · T no browser/CDP/cookie
capability · U 21-tool contract unchanged · V BT3 reader unused by BT4 ·
W content transport uncut · X network-isolated regression · plus hostile
getter/Proxy candidates at the producer boundary.

## 19. Public MCP preservation

Exactly 21 tools, unchanged schemas, unchanged descriptions, unchanged
`MethodNotFound`. `PRODUCTION_OPERATIONS` stays `Object.freeze([])`. No public
`AuthContext`, generation, epoch, Authorization, bearer, cookie, CDP, browser
control or new account/profile input. Because `src/index.ts` is untouched, this
is preserved by construction and re-proved by the existing harness.

## 20. BT4 → BT5 boundary

BT5 receives the reader side (`bind`, `runCurrent`) and owns endpoint rendering,
retry policy, operation registration and the dispatcher/backend cutover. BT4
performs none of it: no content or account request is migrated, the operation
registry stays empty, and content tools keep their legacy `getValidToken()` path
in full. There is no half-cutover.

## 21. Non-goals

No BT5 content cutover, no public tool or schema change, no BT3 modification, no
browser/cookie auth, no CDP expansion, no new dependency, no storage-hardening
change, no `tokens.json`/`session.json` format change, no live Crunchyroll, no
real credentials, no push, no merge, no `main` change.

## 22. Open questions

**Blocking: 0.**

Non-blocking:

- **BT4-D1 — composition-root wiring.** Instantiating the authority and passing
  `asWriter()` to the producer (and the `PROCESS_SHUTDOWN` hook with it) is
  implemented-but-unwired because it collides with three frozen BT3 stage-closure
  assertions that BT4 may neither modify nor fail. Needs an external decision on
  whether those assertions retire at BT4 or BT5. Not blocking: every BT4
  transition is implemented and proven against the real authority today.
- **BT4-D2 — legacy in-`api.ts` clear on invalid_grant.** `refreshOperation`
  clears storage before throwing, so in the unwired architecture that clear
  precedes the producer's invalidation. The producer's own ordering is correct
  and tested; making the *live* path invalidation-first requires BT4-D1. Not
  blocking: no live path consumes the authority yet.

## 23. Gate verdict

Blocking open questions: 0. No public MCP schema change, no new tool, no BT5
cutover, no BT3 contract change, no browser/CDP expansion, no cookie capability,
no new dependency, no weakening of storage hardening. Login, refresh and logout
are all expressible through `AuthContextWriter`. Identity continuity has one
unambiguous rule. No real credential or live-network test is required.

Implementation is authorized to proceed under this frozen design.
