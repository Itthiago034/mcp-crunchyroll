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

---

# Part II — BT4 Completion Macrophase

Appended, not rewritten: everything above is the record of the accepted
producer foundation and still stands. This part records the completion
macrophase authorized by `CRUNCHYROLL-BT4-COMPLETION-ERRATA.md`. It authorizes
nothing and starts no BT5 work.

## 9. Base, branch and artifacts

| Property | Value |
|---|---|
| Branch | `bt4-auth-producer` (unchanged, no rebase, no amend, no merge) |
| Foundation tip | `e39c951` |
| Completion tip | `7df208c` |
| Completion errata | `2ce6c61`, SHA-256 `38b1aa36754597c7914a1f520d2f99722eae27b3ef5e9cf65146f46f73ccfd91` |
| BT4 design (unchanged) | SHA-256 `dd85fc5b79e08fec57136f98b305de82f0af0410a0e66ae76fdca841b8d9ff96` |
| BT3 design (unchanged) | SHA-256 `48d34466ca08cf7bc840443efc3a1eb3b22900c010a181636a69ed52b40b1327` |
| Blocking questions | 0 |
| Merge commits | 0 |
| Push / merge to `main` | none |
| Node | v26.4.0 |

`c8c565f` (frozen BT3) remains an ancestor of every commit.

## 10. Commits

| Commit | Block |
|---|---|
| `2ce6c61` | completion errata (design checkpoint) |
| `86e8a64` | production authority composition, live `invalid_grant` sink, retirement of the three BT3 stage-closure assertions |
| `32e0845` | bounded browser auth observation (`browser-auth.ts`, closed response interception) |
| `4fc9c47` | observed-material install + auth orchestration (`auth-orchestrator.ts`) |
| `5d1f83e` | interactive login schema and the honest status contract (both breaking) |
| `7df208c` | stdio-close teardown seam |

Each is revertible on its own, in the order the errata §16 describes.

## 11. RED → GREEN, as observed

| Block | RED actually observed | GREEN | Suite verification |
|---|---|---|---|
| composition + sink (`86e8a64`) | earlier session's record, quoted in `test/auth-context.test.ts`: the three BT3 stage-closure assertions failed, and only those three (158/161) | 10 replacement assertions + 4 sink tests | verified in the earlier session |
| browser observation (`32e0845`) | earlier session's record: module resolution, then the observation behaviours | 31/31 | verified in the earlier session |
| observed material (`4fc9c47`) | see the honesty note below | 87/87 producer, 34/34 orchestrator, 168/168 BT3 | focused suites + typecheck |
| interactive login + status (`5d1f83e`) | 3 composition assertions failed; then the full suite surfaced 2 further RED in `test/redaction.test.ts` | 15/15 composition, 19/19 harness, 47/47 redaction | **full suite 726/726** |
| stdio close (`7df208c`) | 1 composition assertion failed — one teardown seam where two are required | 15/15 | **full 727/727, isolated 727/727** |

Per-commit full-suite counts for the two blocks completed in the earlier
session were not re-measured in this one, so they are not restated here as if
they had been. The branch tip is verified in full, twice, in §15.

**Honesty note (`4fc9c47`).** The previous session ended mid-block with
`establishFromObservedMaterial` already written but untested in the working
tree. Its nine tests were therefore **GREEN on arrival** — no defect was
invented to manufacture a RED. The block's genuine RED was the orchestration
gap found while writing them: 8 failures, 7 because `signalReauthRequired` did
not exist and 1 because the DEGRADED precedence contradicted the frozen table.

**Preserved RED history.** No earlier RED was rewritten, re-run into green by
editing its assertion, or deleted. The three BT3 stage-closure assertions were
retired in place with the reason recorded in the file itself, per errata §5.

## 12. Two design rulings made during implementation

**BT4-C1 — REAUTH_REQUIRED needs an explicit signal.** Errata §6 maps
"UNAVAILABLE, after a REAUTH signal" to `REAUTH_REQUIRED`, but no signal
existed: the state was unreachable. The orchestrator gained
`signalReauthRequired()`, called by the composition root from the same
`invalid_grant` sink that invalidates the authority. It records a *reason*,
never an availability — the authority remains the only source of truth, so a
stale signal can never contradict live material. A successful login and a
logout both clear it.

**BT4-C2 — a degraded browser outranks a ready authority in `auth_state`, but
does not revoke the credential.** The §6 table's DEGRADED row matches ANY
authority availability, while §10 defines `logged_in` as "authenticated work is
currently permitted". The first candidate implementation resolved the collision
by letting a ready authority hide a degraded browser. That is now split:
`auth_state` follows the frozen table (DEGRADED wins), and
`authenticated`/`logged_in`/`profile_ready` follow the authority, because the
installed material is unexpired and the content path still uses it — reporting
false there would be a fabricated logout. `LOGGING_OUT` still outranks both.
Four tests lock this, and the reasoning is in the source at the decision point.

## 13. Public contract — what actually changed

21 tools, all names unchanged, `MethodNotFound` unchanged. Two schemas moved:

| Tool | Before | After |
|---|---|---|
| `crunchyroll_login` | `{email, password}`, both required | `{type:"object", properties:{}, additionalProperties:false}` |
| `crunchyroll_status` | `logged_in`, `email`, `account_id`, `token_expires_at`, `profile` | `authenticated`, `logged_in`, `browser_running`, `browser_connected`, `auth_state`, `profile_ready`, `player_ready` |

`crunchyroll_logout`'s public output is unchanged — the structured
`LogoutResult` still passes through verbatim, and BT8's four-axis result is not
anticipated here.

Login fails closed on **both** surfaces: the schema admits no property, and the
handler refuses any supplied argument with `InvalidParams` rather than ignoring
it. The refusal names no key and echoes no value; the harness proves neither the
email nor the password appears anywhere in the response. B6 redaction was not
narrowed — the generic `SENSITIVE_ARG_KEYS` registration and every static
pattern remain, and the login handler now registers *every* string argument it
receives before refusing it.

`player_ready` is always `false`. BT4 owns no player and has no truthful source
for `true`; `profile` is omitted for the same reason (a handle would require an
account fetch BT4 does not own).

## 14. What the model can and cannot reach

- the model never receives or supplies an email, password, username, OTP,
  verification code, CAPTCHA answer, cookie, bearer or `Authorization` header;
- no caller input reaches the writer, the authority, a context, a CDP method
  string, a URL or an interception pattern — asserted mechanically;
- the login surface, the permitted auth origins and the observed token endpoint
  are hard-coded constants, never environment-configurable (asserted: no
  `process.env` in `browser-auth.ts`);
- the interception is response-stage only, on one fixed URL, with a 64 KiB body
  cap, and the browser's own response always proceeds untouched;
- the browser's cookie jar never leaves the browser;
- the tool-call boundary references neither the authority nor the browser
  session directly — it reaches them only through the orchestrator.

## 15. Preservation proofs

| Check | Result |
|---|---|
| Full suite | **727 tests, 727 pass, 0 fail, 0 skipped** |
| Network-isolated suite (`bwrap --unshare-net`, `BT2_NET_ISOLATED=1`) | **727/727**, identical; DNS `ENOTFOUND`, TCP `ENETUNREACH` verified from inside the namespace |
| Typecheck / build | exit 0 / exit 0 |
| BT3 suite (`auth-context`) | 168/168 |
| BT2 suites (session manager, cdp, profile, integration) | unchanged and green |
| Storage hardening (`src/auth.ts`) | untouched |
| Redaction (`src/redact.ts`) | untouched |
| `PRODUCTION_OPERATIONS` | `Object.freeze([])` |
| Content cutover | none — every content tool keeps its legacy `getValidToken()` path |
| BT3 reader (`asReader`/`bind`/`runCurrent`) | unused in production |
| Dependencies / engine floor | unchanged |
| Live Crunchyroll access, real credentials | none |

The BT3 report's one open item — the frozen harness test driving
`crunchyroll_login` with `audit-test@example.invalid`, which reached
`AUTH_BASE` — is now closed by construction: that credential path no longer
exists at the MCP boundary, and the replacement assertions are refusals that
touch no network.

## 16. Declared deviations from the frozen file map (§12)

Two test files were modified that the map does not list. Both are direct
consequences of changes the errata explicitly authorizes; neither widens scope.

| File | Why |
|---|---|
| `test/browser-session-manager.test.ts` | +12 lines covering `openResponseInterception`, the accessor errata §9 requires the manager to gain |
| `test/redaction.test.ts` | one B6 probe proved the success-path sanitize boundary *through* `status.email`; §10 removes that field, so the probe's vehicle no longer exists |

The redaction probe was not deleted. It keeps its isolated HOME and now proves
the stronger property — the sentinel is both on disk and supplied as an
argument, and neither reaches the client — while the temporal ordering it was
built to catch stays guarded by the unit timing proof in the same file
("boundary runs while the scope is still active"). The removed identity fields
are asserted absent, not merely redacted.

One test-quality defect was found and fixed in passing: assertions that scan
production source for URL literals ran against comment-stripped code, and the
stripper treats `//` inside a URL literal as a line comment. The new
fixed-origin assertion reads raw source instead.

## 17. Not done, deliberately

No BT5 work of any kind: `PRODUCTION_OPERATIONS` stays empty, no content or
account operation is migrated, no `TransportBackend` becomes caller-reachable,
no `OPERATION_NOT_MIGRATED`, no Node-fetch guard, no endpoint template moves
into the registry. No BT8 browser-session clear and no composite logout result.
No BT10 player. No new dependency, no storage format change, no `src/auth.ts`
or `src/redact.ts` change, no push, no merge, no `main` change.

## 18. Open items

**Blocking: 0.**

- **BT4-N1** (carried forward): the observed token endpoint is
  `https://www.crunchyroll.com/auth/v1/token`, from the evidence baseline. If a
  live smoke shows a different exact path, only the frozen constant changes.
- **BT4-N2** (new): the interception is armed *after* the managed page is
  created on the login surface. A mint that completes during that first page
  load — possible only when the browser profile already holds a live
  Crunchyroll session — is missed, and the attempt ends as an honest timeout
  rather than a false state. Closing the window would need a CDP capability the
  errata deliberately did not grant (no `Page.navigate`, no request-stage
  interception), so it is reported rather than worked around.
- **BT4-N3** (new): a login attempt that ends without installing material
  leaves the managed browser open on whatever page the human reached. BT4 owns
  no navigation, so a subsequent attempt reuses that page instead of returning
  it to the login surface. Harmless — the human can navigate — but it is a real
  edge of the "open the fixed login surface" promise.
- **Interactive smoke: PENDING.** The automated suite is complete, offline and
  network-isolated. The interactive login smoke requires a human to type
  credentials into the browser (errata §15) and has not been run. Formal
  candidate readiness is therefore **not** claimed for the live path.
