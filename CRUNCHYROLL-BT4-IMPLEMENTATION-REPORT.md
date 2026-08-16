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
| Network-isolated suite (`bwrap --unshare-net`, `BT2_NET_ISOLATED=1`) | **727/727**, identical; every outbound connection fails `ENETUNREACH` from inside the namespace (see the correction below) |
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

**Correction to an earlier isolation claim.** Part I §7 and the BT3 report both
state that the isolated run shows "DNS `ENOTFOUND`". Probed explicitly this
time, that is not what the sandbox does: `--unshare-net` removes the network,
but name resolution still answers through the resolver socket the bind mount
keeps, so `www.crunchyroll.com` and `example.com` both resolve inside the
namespace. The `ENOTFOUND` seen earlier came from `auth.crunchyroll.com`, which
is NXDOMAIN globally — a property of that host, not of the sandbox.

The isolation guarantee is unaffected and is the one that matters: every
outbound connection attempt inside the namespace fails with `ENETUNREACH`,
including a real `fetch("https://www.crunchyroll.com/")`. A suite that passes
identically under that condition performs no live Crunchyroll access. The
evidence log records the probe verbatim.

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

## 16b. Live smoke — three runs, and what each one proves

Run on the operator's own machine, against the real site. The agent never
requested, read, typed or logged a credential, never opened or read the browser
profile's cookies or storage, and never touched BT2's control files by hand;
every value below is safe metadata the tools already publish.

Runs 1 and 2 attempted a fresh interactive login inside the managed browser and
were blocked upstream. Run 3, after the operator seeded the **same dedicated
profile** by hand, obtained the complete chain. Both outcomes are recorded; the
first is not retroactively excused by the second.

| | Attempt 1 | Attempt 2 |
|---|---|---|
| Duration to timeout | 301 s | 300 s |
| Browser | launched (Brave, `/usr/bin/brave`, dedicated 0700 profile) | **adopted the still-running browser from attempt 1, same PID** |
| Observed states | `LOGIN_REQUIRED` → `AUTHENTICATING` (`browser_running`/`browser_connected` true) → `LOGIN_REQUIRED` | identical |
| Login outcome | `accepted: false` | `accepted: false` |
| Material installed | none | none |
| Token store after the run | nothing written — only `browser-profile` exists under `~/.strider/crunchyroll/` | unchanged |

**What this verifies.** The whole path BT4 owns, up to the human step, works
against the real world: the composition root builds one authority and one
browser lazily, the managed browser launches on the fixed login surface, CDP
connects, the single-flight login gate holds for five minutes without reopening
a window, concurrent `status` calls stay read-only and truthful throughout, the
deadline expires into `LOGIN_REQUIRED` with `accepted: false`, no state is
fabricated, nothing crashes, and — because a browser-observed bearer is
deliberately never persisted — the hardened store is untouched. Attempt 2 also
exercised BT2 adoption in production: the second server process adopted the
orphaned browser instead of launching a second one.

**What blocked it.** The operator reports reaching the legitimate Crunchyroll
login page, then being held in a Cloudflare human-verification loop that never
completed, so no login was ever performed and no token was ever minted. The
observation channel therefore had nothing to observe. This is consistent with
the project's earlier finding that Crunchyroll's bot mitigation is per client
context, and with the launch profile being brand new and history-free; the
launcher itself carries no automation flags (`--enable-automation` is not
passed, `navigator.webdriver` is not set).

**What runs 1 and 2 left unverified.** Exactly one link: an observed mint being
validated and installed through the producer. Runs 1 and 2 produced no evidence
for or against BT4-N1 either, because no mint occurred at all. Run 3 closes
both, below.

### Run 3 — the human-seeded dedicated profile

The operator seeded **the same dedicated profile** by hand: plain Brave, the
same `/usr/bin/brave`, the same `--user-data-dir`, the benign BT2 flags, and
**no `--remote-debugging-port`, no MCP, no CDP**. They cleared the Cloudflare
challenge themselves, logged in themselves, declined any import prompt, and
closed the window normally. No credential was given to the agent; no cookie or
storage was copied, extracted or read; no personal browser profile was
involved; BT2's control files were left for BT2's own logic to invalidate.

Preconditions verified before the run: no process held the profile;
`SingletonLock` was gone (the signature of a graceful close); the stale
`DevToolsActivePort` and the dead-pid `.mcp-browser-owner.json` were left
untouched; `dist/index.js` hashed identical to the packet copy
(`3f7350878514ea9d3e24ceed7c04978f05e20d5ca5c2d8016dd287bcb0b14316`) with a
clean worktree, so the run used the unmodified production bundle.

| | Run 3 |
|---|---|
| Status before login | `LOGIN_REQUIRED`, `browser_running: false` |
| Time to outcome | **3 s** |
| Login outcome | **`accepted: true`** |
| Final state | **`auth_state: "PROFILE_READY"`, `authenticated: true`, `logged_in: true`, `profile_ready: true`, `player_ready: false`** |
| Browser | relaunched fresh (pid 1770414): BT2 rejected the dead-pid ownership record, cleared it and the stale endpoint, then wrote a new 0600 record |
| Token store after the run | **nothing written** — only `browser-profile` exists under `~/.strider/crunchyroll/` |

**E2 — the complete BT4 chain is proven live.** The authority was `UNAVAILABLE`
at the start of this very process (`LOGIN_REQUIRED` at step 1, and there is no
`tokens.json` for bootstrap to load), so the only reachable path to
`PROFILE_READY` is the one under test: managed browser on the fixed login
surface → response-stage interception of the fixed token endpoint → bounded
body → validated closed candidate → `establishFromObservedMaterial` → BT3
`ESTABLISH` compare-and-swap. Nothing else in the process can make the
authority ready.

Three consequences follow from that single transition:

- **BT4-N1 is CONFIRMED live.** `isTokenEndpoint()` requires an exact
  protocol/host/path match, so an install proves the mint happened at exactly
  `https://www.crunchyroll.com/auth/v1/token`. The frozen constant is right.
- `profile_ready: true` proves the observed payload carried a `profile_id` and
  that the authority's `hasProfileId` diagnostic reflects the installed record —
  the `ACCOUNT_READY`/`PROFILE_READY` distinction is real, not theoretical.
- The hardened store stayed empty, live: a browser-observed bearer is genuinely
  never persisted, exactly as designed.

**E1 — session continuity, recorded separately and NOT promoted.** The
dedicated profile did carry the human-seeded session across the manual →
managed handoff. This is *inferred* from the mint (a profile-scoped token was
minted seconds after load with no human logging in), not observed directly: the
agent did not read cookies or storage, and the visual confirmation of the
logged-in page belongs to the operator. E1 is browser-level continuity; E2
above is the authority-level proof. They are recorded as separate facts.

**What run 3 does NOT prove.** A human completing a *fresh* login inside the
managed browser — that is exactly what runs 1 and 2 failed to do, and run 3
bypassed the question rather than answering it, because the session already
existed. BT4-N5 therefore stays open. It also does not close BT4-N2: the
arm-after-load race did not materialise here (arming beat the mint by enough
margin, and the app mints repeatedly anyway), but one favourable observation
does not close a race.

### A/B diagnostic record

| | Configuration | Cloudflare + login |
|---|---|---|
| A | same dedicated profile, plain Brave, **no CDP**, human at the keyboard | **PASS** |
| B | same dedicated profile, managed browser with `--remote-debugging-port` + CDP attached, human at the keyboard | **FAIL** — challenge loop, twice, 301 s and 300 s |

Read this as a diagnostic lead, not a conclusion. The comparison is n=1 against
n=2, unblinded, and confounded: A ran on a profile already warmed by the two
earlier sessions, and A and B differ in more than CDP (window provenance,
timing, interaction pattern). It is **not** authorization to alter fingerprint,
suppress automation signals, bypass a bot-management control, or redesign the
browser layer. It is evidence to hand to whoever owns the browser strategy.

**BT4-N5 (open, material for the next stage).** Interactive login in a
freshly-created managed profile may be unable to complete at all when the site's
bot mitigation challenges it, while the same profile seeded by a human works.
That is an availability property of the chosen architecture, not a defect in
this code, and it belongs to whoever owns the browser strategy: it decides
whether the managed profile must be seeded by a human first, whether a
different Chromium build is required, or whether
the login surface should be opened in the operator's ordinary browser instead.

## 17. Not done, deliberately

No BT5 work of any kind: `PRODUCTION_OPERATIONS` stays empty, no content or
account operation is migrated, no `TransportBackend` becomes caller-reachable,
no `OPERATION_NOT_MIGRATED`, no Node-fetch guard, no endpoint template moves
into the registry. No BT8 browser-session clear and no composite logout result.
No BT10 player. No new dependency, no storage format change, no `src/auth.ts`
or `src/redact.ts` change, no push, no merge, no `main` change.

## 18. Open items

**Blocking: 0.**

- **BT4-N1 — CLOSED by live evidence.** The frozen token endpoint
  `https://www.crunchyroll.com/auth/v1/token` is correct: run 3 (§16b) observed
  and installed a real mint through an exact protocol/host/path match, so no
  other URL could have produced that transition.
- **BT4-N2** (open, one favourable observation): the interception is armed *after* the managed page is
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
- **BT4-N4** (pre-existing, observed): the B6 error boundary re-derives an
  `McpError` as `new McpError(err.code, redactSecrets(err.message))`, and the
  SDK constructor prepends `MCP error <code>: ` again, so every `McpError`
  message reaches the client double-prefixed. The new login refusal inherits
  this; `MethodNotFound` has always had it. Cosmetic only — the code, the class
  and the redaction are correct — and deliberately not repaired here, because
  the fix touches a security-hardened boundary for a presentation defect at the
  end of the macrophase.
- **BT4-N5** (open): see §16b — a freshly created managed profile could not
  clear the site's human-verification challenge, while the same profile seeded
  by a human could. Interactive first login is therefore an availability
  question for the browser strategy, not a defect in this code. The A/B record
  is a diagnostic lead only.
- **Live smoke: the observation chain is PROVEN; first-login is not.** Run 3
  (§16b) took the authority from `LOGIN_REQUIRED` to `PROFILE_READY` in 3 s
  through a real response-stage observation and
  `establishFromObservedMaterial`, with nothing persisted. What remains
  unproven live is a human completing a *fresh* login inside the managed
  browser (BT4-N5). Readiness for the seeded path is evidenced; readiness for
  cold first login is not claimed.

---

# Part III — BT4-R1 (external review blocker, FIX1)

Append-only. Parts I and II stand as written; this part records one defect
found by external review of the frozen candidate `8e33096`, and its repair.
It authorizes nothing, reopens no macrophase and starts no BT5 work.

## 19. The defect

A login attempt's observation could install material **after** a logout had
already completed.

`runLoginDecision` guarded the install with `if (logoutFlight) return false`.
That variable is the logout *gate*, and the gate is released the moment the
logout transaction finishes. So the window it protected was only the logout's
own duration:

```
login A pending on the observation
  → logout invalidates the authority, clears storage, finishes
  → logoutFlight = undefined            (gate released)
  → A's observation finally arrives
  → the guard sees no gate
  → ESTABLISH reinstalls the session the user just destroyed
```

The existing test `K` did not catch it: it resolved the observation while the
gate was still held and only completed the logout afterwards. It has been
renamed to say `during` so the claim matches what it proves.

The same staleness had a second face. `browser-auth.ts` produces
`connectionGeneration` on every OBSERVED outcome — errata §9 requires exactly
that so a stale observation "whose BT2 connection generation … no longer
matches" can be discarded — but `AuthObserverPort` dropped the field and
`runLoginDecision` never read it. A value was produced for a safety check that
was never performed.

## 20. The repair

Confined to the login/logout/observation boundary. `src/transport/auth-context.ts`
is untouched, no CDP method was added, no content tool moved, no public schema
changed.

- **Explicit attempt identity.** A monotonic `attemptSequence`; each login
  captures its own id and only the `currentAttempt` may install.
- **Synchronous cancellation.** `logout()` calls `cancelActiveLogin()` before
  anything is awaited: it bumps the attempt id, aborts the attempt's
  `AbortController`, and releases the login gate. Nothing can slip through,
  because there is no await between the decision and its effect.
- **Never restored.** The id only ever increases, so an attempt cancelled by a
  logout stays dead however late its material arrives — including long after
  the logout finished, which is the defect above.
- **Cancellation reaches the observer.** The signal is passed to
  `observeNextAuthMaterial({ signal })`; `browser-auth.ts` already honoured it
  and returns `CANCELLED`, closing its channel.
- **Generation is no longer produced and ignored.** `AuthObserverPort` carries
  `connectionGeneration`, and the install boundary requires it to equal the
  live generation. `BrowserSessionManager` gained one read-only accessor,
  `connectionGeneration(): number | undefined` (zero, its existing
  "no live connection" sentinel, maps to `undefined`). It grants no capability
  and exposes nothing about the session.
- **Checks sit after every await**, immediately before the only irreversible
  step: still the current attempt, not aborted, no logout in flight, and the
  observed generation still live.

A cancelled attempt that finishes late also no longer clears a gate a newer
attempt holds.

## 21. RED, exactly as observed

Seven failures on the frozen candidate before any source change:

| # | Test | RED |
|---|---|---|
| 1 | an observation from a login cancelled by a COMPLETED logout installs nothing | `AUTHENTICATING` where `LOGIN_REQUIRED` was expected — after a fully completed logout the dead attempt still held the gate, and the observation then installed |
| 2 | a logout aborts the pending observation synchronously | no signal was ever handed to the observer |
| 3 | a late observation from a superseded attempt installs nothing | the dead attempt installed |
| 4 | material observed on a stale BT2 connection generation is discarded | installed anyway — the field was never read |
| 5 | a reconnect racing the commit still discards the old generation | installed anyway |
| 6 | material cannot install while there is no live connection at all | installed anyway |
| 7 | a logout whose cleanup FAILED still blocks reinstallation | reinstalled after a failed clear — the worst case |

Two further tests in the family passed on arrival and are recorded as such: the
timed-out-then-newer-attempt case and the happy path. No defect was invented to
manufacture a RED, and no earlier RED was rewritten.

## 22. GREEN and verification at the FIX1 tip

| Check | Result |
|---|---|
| `test/auth-orchestrator.test.ts` | 44/44 (was 34; +10, of which 7 were RED) |
| `test/browser-session-manager.test.ts` | 65/65 (+2 for the generation accessor) |
| Focused BT2/BT3/BT4 suites together | 410/410 |
| Full suite | **739 tests, 739 pass, 0 fail, 0 skipped** |
| Zero-egress suite (`bwrap --unshare-net`, `BT2_NET_ISOLATED=1`) | **739/739** |
| Typecheck / build | exit 0 / exit 0 |
| Public contract | 21 tools, schemas byte-equivalent, fixture untouched by FIX1 |
| Secret sentinel sweep | producer 87/87, redaction 47/47, plus a new orchestrator sweep proving no cancellation path leaks material, identity, a generation or a signal |
| `src/transport/auth-context.ts` | 0 lines changed |
| New logging / env / fetch / CDP surface | none — asserted by scan over the changed source |

One test was written and then removed rather than shipped: a manager-level
assertion that an interception channel carries the generation the manager
reports. The shared BT2 fakes do not implement `Target.attachToTarget`, so it
would have required widening test infrastructure outside this boundary. The
linkage is structural (both read the same variable) and the channel's
generation is exercised in `test/browser-auth.test.ts`.

## 23. Live evidence

The run-3 E2 result in §16b stands as historical evidence and was **not**
repeated: FIX1 is proven offline, deterministically, with barriers rather than
sleeps. No browser was opened and no live login was performed for this fix.

## 24. Status

BT4-N2, BT4-N3, BT4-N4 and BT4-N5 are unchanged and still open. BT4-R1 is
repaired and awaiting external re-review. Nothing here is declared closed.

---

# Part IV — BT4-N5 design resolution (acceptance matrix)

Append-only. The full argument is in `CRUNCHYROLL-BT4-N5-ONBOARDING-ERRATA.md`;
this part records the decision and the matrix. No source, test, fixture or
package file changed for it.

**Decision: OPTION B — Supported Human Onboarding of the Dedicated Profile**,
as an operational contract. Public schemas: unchanged. Source: unchanged.

## 25. Acceptance matrix

| | Scenario | Result | Basis |
|---|---|---|---|
| **A** | fresh dedicated profile + managed **cold** login | **BLOCKED BY PROVIDER BOT MITIGATION** — two runs, 301 s and 300 s, `accepted:false`, nothing installed, nothing persisted | live runs 1 and 2 (§16b). Preserved as failures |
| **B** | fresh/dedicated profile + **human onboarding**, no CDP | **HUMAN LOGIN PASS** — challenge cleared and login completed by the operator in the same dedicated profile | live A/B, arm A (§16b) |
| **C** | human-onboarded dedicated profile → managed BT2/BT4 | **E1 session continuity** — the profile carried the session across the handoff; *inferred* from the mint, never from reading cookies or storage | run 3 (§16b) |
| **D** | managed BT4 observes a real mint in that profile | **E2 PASS** — `LOGIN_REQUIRED` → `PROFILE_READY` in 3 s via response-stage observation → `establishFromObservedMaterial` → BT3 CAS; store stayed empty | run 3 (§16b) |
| **E** | page looks authenticated, no material observed | **NOT READY** — readiness derives only from authority availability | `test/auth-orchestrator.test.ts`: "T: a running, connected browser with no auth is still LOGIN_REQUIRED"; "a timeout returns LOGIN_REQUIRED with no retry loop" |
| **F** | session expired or invalidated | **`LOGIN_REQUIRED` / `REAUTH_REQUIRED`**, never inferred from UI or cookie — `REAUTH_REQUIRED` only on an explicit `invalid_grant` signal | orchestrator REAUTH family; producer expiry rule (§5, Part I) |
| **G** | logout | authority invalidated per BT4-R1; a persistent profile does **not** re-authenticate the authority — only an explicit login observing a **new** mint can | BT4-R1 family, incl. "an observation from a login cancelled by a COMPLETED logout installs nothing" and "a logout whose cleanup FAILED still blocks reinstallation" |

Row A is not amended by rows B–D. The cold managed-window path remains
implemented and remains the default; it is no longer an acceptance requirement.

## 26. Verification for this part

Documentation only, so the contractual checks are the verification:

| Check | Result |
|---|---|
| Source / test / fixture / package files changed | **none** — `git diff --stat 59f5650..HEAD` touches only Markdown |
| Public schemas | unchanged; `test/fixtures/baseline-tools.json` untouched |
| `src/transport/auth-context.ts` | untouched |
| BT4-R1 FIX1 | intact, unmodified |
| `PRODUCTION_OPERATIONS` | still `Object.freeze([])` |
| Live E2 | **not repeated** — documentation does not require re-proving a runtime result |
| Browser opened for this part | none |

## 27. Status after Part IV

BT4-R1: closed (external review PASS). BT4-N2, BT4-N3, BT4-N4: open,
non-blocking. BT4-N6: **new**, open — `README.md` still documents the retired
credential contract and is outside the frozen file map, so it was not edited;
correcting it is submitted as a separate decision. BT4-N5: **design resolution
candidate**, submitted for external review.

BT4 is not declared closed.
