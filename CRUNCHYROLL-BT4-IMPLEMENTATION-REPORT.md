# MCP Crunchyroll — BT4 Implementation Report

Candidate for external review. It records what was built, what was observed, and
the one thing that was deliberately left undone. It authorizes nothing.

## 1. Base and branch

| Property | Value |
|---|---|
| Frozen BT3 base | `c8c565fa2604adbc7672febf3253228bbd803166` |
| Branch | `bt4-auth-producer` (created from that exact commit) |
| Design commit | `16af8a5` |
| Design SHA-256 | `dd85fc5b79e08fec57136f98b305de82f0af0410a0e66ae76fdca841b8d9ff96` |
| Blocking design questions | 0 |
| Non-blocking design questions | 2 (BT4-D1, BT4-D2) |
| Merge commits | 0 |
| Production files added | 1 (`src/transport/auth-producer.ts`, 545 lines) |
| Test files added | 1 (`test/auth-producer.test.ts`, 1134 lines) |
| Existing source/test/package files changed | 0 |

## 2. Commits

| Commit | Task |
|---|---|
| `16af8a5` | design checkpoint |
| `99a31ac` | login → ESTABLISH |
| `23945d5` | refresh → REFRESH, invalid_grant ordering |
| `d8abf70` | logout, bootstrap, shutdown |
| `adb4237` | security closure and real-port adapter |

No amend, no squash, no rebase, no merge. All BT0–BT3 history is intact and
`c8c565f` remains an ancestor.

## 3. RED → GREEN

| Task | RED observed | GREEN | Full suite |
|---|---|---|---|
| 1 login | module resolution, then 20 behavioural assertions | 20/20 | 569 |
| 2 refresh | 18 behavioural failures (no refresh transition) | 38/38 | 587 |
| 3 logout/bootstrap/shutdown | 15 behavioural failures | 53/53 | 602 |
| 4 closure | module resolution for the adapter; **all 25 closure assertions GREEN on arrival** | 78/78 | 627 |

Task 4's honesty note: once the adapter existed, every capability and secrecy
assertion already passed. The design forbids those capabilities by construction,
so no defect was invented to manufacture a RED.

## 4. BT4-D1 — the one deferred item

BT3 Task 5 froze three closure assertions inside `test/auth-context.test.ts`:
no import path from `src/index.ts` may reach the authority, **no file under
`src/` may import `auth-context.js` at all — a type-only import trips the same
regex** — and `dist/index.js` may carry none of its markers. The BT4 mandate
requires simultaneously that BT3 tests stay unmodified and pass.

Instantiating an authority in the composition root, or importing the authority
module from any production file, breaks all three. This was verified against the
actual assertion source before designing, not assumed.

Resolution: the writer arrives by **dependency injection**, declared
structurally, and the producer imports nothing from BT3. Consequences:

- BT3's closure keeps passing untouched — 161/161 at every BT4 commit;
- BT4's own tests import the real `AuthContextAuthority` and drive it through
  the real `asWriter()` port (the BT3 assertions scan `src/` only), so every
  transition below is proven against the **real** authority, not a mock of the
  boundary under judgement;
- the remaining step — `createAuthContextAuthority()` in the composition root,
  `createDefaultAuthProducerPorts(authority.asWriter())`, and the
  `PROCESS_SHUTDOWN` hook with it — is deferred and needs an external decision
  on whether those three BT3 stage-closure assertions retire at BT4 or BT5.

This follows the mandate's own precedent for `PROCESS_SHUTDOWN` (§19):
document a composition obligation rather than force a refactor. Everything else
in BT4 is complete and independently verified.

**BT4-D2**: `refreshOperation` in `src/api.ts` already performs a best-effort
`clearAuthData()` before throwing `REAUTH_REQUIRED`, so in the current unwired
architecture that legacy clear precedes the producer's invalidation. The
producer's own ordering is correct and tested; making the *live* path
invalidation-first requires BT4-D1. No live path consumes the authority yet, so
this is not blocking.

## 5. Semantics as implemented

**Login → ESTABLISH.** Persistence first, authority second — the authority is
process-local and reconstructible from hardened storage while storage is
durable, so the only reachable partial state is persisted-but-not-yet-live,
which the next bootstrap or refresh repairs. Authority-first could leave a live
context with no durable backing, the worse half of a split brain. The legacy
`login()` returns no material, so the producer reads it back through hardened
`loadTokens()` rather than duplicating the password grant. Failure at each
boundary is a distinct closed outcome — `LOGIN_FAILED`, `MATERIAL_UNAVAILABLE`,
`AUTHORITY_REJECTED` — and nothing is ever retried.

**Refresh → REFRESH.** The expected revision is captured before the network
await. `refreshInFlight` is preserved untouched and is explicitly not the
authority, a generation, a lock or an AuthContext; BT4 adds no second
deduplication layer, so two concurrent refreshes share one request and BT3's CAS
makes exactly one of them a transition, with no double increment. A refresh that
loses to a logout is `STALE` and restores nothing.

**Identity continuity has exactly one rule, and it is BT3's.** The producer does
not compare identities itself, does not work around `AUTH_IDENTITY_CHANGED`, and
never auto-establishes the new identity. Account change and profile
add/remove/change all invalidate.

**invalid_grant.** `writer.invalidate("INVALID_GRANT")` runs first, then
producer-owned cleanup — proven by one ordered log across both layers
(`["invalidate:INVALID_GRANT", "clear"]`). A `PARTIAL`/`FAILED` clear never
resurrects the authority. `TRANSIENT`, `SAFE_FAILURE`, `MALFORMED_RESPONSE` and
anything unrecognised leave the exact current record installed and the
generation unmoved.

**Logout.** `["invalidate:LOGOUT", "clear"]`, in that order, and the structured
`LogoutResult` is returned verbatim — all four states plus every per-artifact
state and reason. BT4 owns no second outcome matrix. A terminal authority is
reported as `ALREADY_TERMINAL` and the cleanup still runs.

**Status.** Read-only by construction: it never touches the writer, not even
`currentRevision`. It performs no refresh, mutates no storage, adds no field, so
no epoch, generation, token or context can reach the public result.

**Bootstrap.** Implemented and tested, not wired. Nothing is trusted because a
file exists: load and validate outside the authority, capture the revision,
explicit `ESTABLISH` through the same CAS. Missing → unavailable; corrupt,
insecure or foreign-owned → unusable and never downgraded to "logged out";
expired → not installed. The storage port exposes no save at all, so BT4 cannot
change the on-disk format even by mistake, and no epoch or generation is ever
persisted.

**Expiry.** BT3's rule preserved: a usability condition, not an authority
transition. No timer, no watcher, no competing state machine.

## 6. Secrets

The password and email never leave the legacy login boundary — they are not
retained by the producer, never enter a candidate and never reach the authority.
The refresh token is passed to the legacy refresh path by reference and is never
copied into a candidate, the authority, diagnostics, an outcome or an error; the
commit candidate carries exactly `accessToken`, `tokenType`, `expiresAt`,
`accountId` and optionally `profileId`, and is frozen. Producer outcomes are
frozen closed discriminants with no message at all, so the legacy login string
(which contains the account id) is never propagated. A sweep across every
reachable outcome finds none of the ten sentinels.

Every crossing document — persisted material, refreshed payload, thrown error —
is snapshotted once per field before validation, so a hostile getter or Proxy
cannot answer validation with one value and the commit with another. Runtime
allowlists classify both the BT3 rejection kinds and the legacy refresh failure
kinds, because `instanceof` is unavailable without importing BT3 and TypeScript
unions do not exist at runtime. This is the closed BT3-R1 lesson applied one
layer out, and it is tested at both boundaries.

## 7. Preservation proofs

| Check | Result |
|---|---|
| Storage hardening | preserved — `src/auth.ts` untouched, no chmod/chown, no save port exposed |
| Redaction | preserved — `src/redact.ts` untouched; legacy registration paths unchanged |
| BT3 suite | 161/161 at every commit |
| Full suite | 627 tests, 627 pass, 0 fail, 0 skip |
| Network-isolated suite | 627/627 with DNS `ENOTFOUND` and TCP `ENETUNREACH` |
| Typecheck / build | exit 0 / exit 0 |
| Public tools | 21, schemas byte-equivalent, `MethodNotFound` unchanged |
| `PRODUCTION_OPERATIONS` | `Object.freeze([])` |
| Content cutover | none — `src/index.ts` untouched and does not reference the producer |
| BT3 reader | unused: no `AuthContextReader`, `asReader`, `bind` or `runCurrent` in the producer |
| Dependencies | unchanged, engine floor `>=18.0.0` |
| Live Crunchyroll / real credentials | none |

## 8. Not done, deliberately

No composition-root wiring (BT4-D1), no `PROCESS_SHUTDOWN` hook installation, no
BT5 content or account cutover, no operation registration, no dispatcher or
backend change, no public tool or schema change, no BT3 modification, no
cookie or browser auth, no CDP expansion, no new dependency, no storage format
change, no push, no merge, no `main` change.
