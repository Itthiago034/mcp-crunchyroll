# MCP Crunchyroll — BT5 Implementation Report

Candidate for external review. Base `c229b317…` (BT4 formally closed). It
records what was built, what was observed, and what it deliberately did not do.
It authorizes nothing and starts no BT6 work.

## 1. Base and result

| Property | Value |
|---|---|
| Branch | `bt4-auth-producer` (unchanged; no rebase, amend or merge) |
| Base | `c229b317e8c83c9c7dfd9daf0295ecb21252cd84` |
| Design note | `CRUNCHYROLL-BT5-CUTOVER-PLAN.md` |
| External ruling | narrow `Runtime.callFunctionOn` channel, authorized |
| Public schemas | unchanged (21 tools, fixture byte-identical) |
| Full suite | 783 pass / 0 fail / 0 skipped |
| Zero-egress suite | 783 pass / 0 fail |
| Live smoke | PASS |
| Blocking questions | 0 |
| Declared deviations | 1 (§7) |

## 2. What now happens to a content tool

```
crunchyroll_get_categories
  → content gateway (the ONE decision site)
  → registry: GET_CATEGORIES present → dispatcher
  → browser API backend
      → BT3 bind(): the auth acquisition point
      → BT3 runCurrent(): ONE snapshot, bearer registered as a secret
      → closed execution channel on the managed Crunchyroll page
          → Runtime.enable / executionContextCreated / callFunctionOn
          → one CONSTANT function, structured arguments,
            credentials: "omit", redirect: "manual"
      → bounded body, status/content-type validated, JSON parsed
      → BT3 final generation commit check
  → domain parser → {count, categories} → MCP result

any other content tool
  → content gateway
  → registry: absent → OPERATION_NOT_MIGRATED, locally, no transport, no network
```

The Node path to Crunchyroll is gone from the reachable graph, and guarded at
runtime besides.

## 3. RED, exactly as observed

| # | RED | Cause |
|---|---|---|
| 1 | both BT5 suites failed to load | `browser-api-backend.ts` and `content-gateway.ts` did not exist |
| 2 | 11 failures across five existing files at cutover | stage-closure assertions encoding "no content operation exists yet" (below) |
| 3 | `the descriptor is the only place the categories path literal lives` | the literal was still in `src/api.ts` after entering the registry — a real dual source of truth, caught by the test rather than by review |
| 4 | `the composition root no longer imports any content function from api.ts` | the type-only `LogoutResult` import needed its own assertion |
| 5 | `no transport module imports the legacy api module` | too broad: the producer's legacy AUTH ports are BT4's accepted design |

The eleven stage-closure failures, all retired in place with their reason
recorded beside them:

| File | Assertion | Replaced by |
|---|---|---|
| `auth-context.test.ts` | 5. no module calls `bind()`/`runCurrent()` | the reader has exactly ONE consumer |
| `auth-context.test.ts` | 6. no module derives the reader | derived once, in the composition root |
| `auth-context.test.ts` | 7. registry empty, dispatcher unreachable | exactly one migrated operation, one route |
| `auth-context.test.ts` | 8. authority imported only by the root | imported by the root and the backend, nobody else |
| `auth-context.test.ts` | `PRODUCTION_OPERATIONS` remains empty | holds exactly `GET_CATEGORIES` |
| `auth-producer.test.ts` | W: content transport uncut | the producer gained no content role |
| `transport-registry.test.ts` | table empty in BT1 | exactly the migrated operations |
| `bt4-composition.test.ts` | root derives no reader | derives exactly one |
| `bt4-composition.test.ts` | no module uses the reader side | the backend, and nobody else |
| `browser-session-manager.test.ts` | manager surface | plus `openApiExecutionChannel` |
| `mcp-harness.test.ts` | unmigrated tool fails on missing tokens | refused with `OPERATION_NOT_MIGRATED` |

Three further failures were defects in assertions I had just written, not in the
code: two matched substrings (`browser` contains `browse`; `descriptor`
contains `script`) and one scanned comment-stripped source for a URL literal,
which the stripper eats at the literal's own `//`. All three now use word
boundaries or raw source. Recorded because a test that passes for the wrong
reason is worse than one that fails.

## 4. The authorized channel, as built

- Exactly three Runtime methods, asserted by scan: `Runtime.enable`,
  `Runtime.executionContextCreated`, `Runtime.callFunctionOn`. `Runtime.evaluate`
  is asserted absent.
- The function declaration is a source constant, `CRUNCHYROLL_FETCH_FUNCTION`,
  asserted to contain no interpolation, no concatenation of url/method/bearer,
  and no literal bearer. The manager is asserted to hand that constant itself to
  CDP.
- url, method, Authorization and the cap cross as structured CDP arguments.
- Context selection: the managed target's own flattened session, a default
  context, origin `https://www.crunchyroll.com`. No match → fail closed, no
  "recovery" on another target.
- Response: `awaitPromise`, `returnByValue`, explicit deadline, 512 KiB cap
  enforced in the page AND re-checked by byte length in Node, `exceptionDetails`
  → typed error carrying none of its text.

## 5. The Node egress guard

Installed unconditionally at composition. Host-scoped: `crunchyroll.com` and
true subdomains are refused before any socket, everything else passes through.
Not env-gated, not stack-scoped, not a substring match —
`crunchyroll.com.evil.invalid` and `notcrunchyroll.com` are correctly NOT
guarded. It counts attempts, emits one structural stderr line carrying no URL,
and restores the original `fetch` on uninstall only if it is still the one it
installed.

Consequence, intentional: the legacy Node auth refresh path is now inert in
production. Nothing calls `producer.refresh()` there, and browser-observed
material has no refresh token, so no live behaviour changes.

## 6. Verification

| Check | Result |
|---|---|
| Focused: BT5 cutover + channel/backend | 43/43 |
| Focused: BT3 auth, BT4 producer/orchestrator, BT4-R1, redaction, registry, dispatcher, manager, harness | all green |
| Full suite | **783 pass, 0 fail, 0 skipped** |
| Zero-egress (`bwrap --unshare-net`, `BT2_NET_ISOLATED=1`) | **783 pass, 0 fail** |
| Typecheck / build | exit 0 / exit 0 |
| Public contract | 21 tools, schemas byte-equivalent, fixture untouched |
| Source ↔ bundle | both exercised by the harness, identical behaviour |
| `PRODUCTION_OPERATIONS` | exactly `["GET_CATEGORIES"]`, frozen |
| Path literal | lives only in the registry descriptor |
| `src/transport/auth-context.ts` | 0 lines changed |

## 7. Declared deviation — the `scope` label

The ruling assigned `GET_CATEGORIES` `scope: PUBLIC` while stating that PUBLIC
does not mean anonymous and that a bearer is still required. In BT3's closed
vocabulary those cannot both hold: `bind()` answers a PUBLIC descriptor with no
context and no material, so a PUBLIC operation cannot carry a bearer at all.

Implemented as `scope: "ACCOUNT"` with **zero** auth-derived params, which is
BT3's shape for exactly what the ruling described: a live AuthContext is
required, no identity is resolved, `ACCOUNT_READY` suffices, `PROFILE_READY` is
not demanded. The alternative — keeping the PUBLIC label — would have meant
reading material outside BT3's reader and duplicating the §13A commit check,
which is strictly worse. Recorded in the registry comment, in the tests, and
here. Submitted for review.

## 8. Live smoke (Phase 6)

Operator's machine, real site, dedicated profile from BT4. Safe metadata only.

| Step | Result |
|---|---|
| status before | `LOGIN_REQUIRED`, browser not running |
| `crunchyroll_login {}` | `accepted: true`, `PROFILE_READY`, 5 s |
| `crunchyroll_get_categories` | **PASS — 15 categories, first id `action`, shape `{categories, count}`, 2142 ms** |
| `crunchyroll_search` | **`OPERATION_NOT_MIGRATED`, 23 ms** — no browser work, no network |
| status after | `PROFILE_READY` |
| Node Crunchyroll guard | **0 blocked attempts** — nothing even tried |
| Mutations | none attempted, by design |

The categories call is the whole BT5 pipeline against the real provider:
registry descriptor → AuthContext snapshot → managed page context →
`Runtime.callFunctionOn` → bounded response → generation commit check → domain
parse → MCP result. No bearer, cookie, identity or raw body appears anywhere in
the evidence.

## 9. Known limitations

- **One operation.** Search, series, seasons, episodes, watchlist, history,
  playheads, recommendations, subscription and the mutations all return
  `OPERATION_NOT_MIGRATED`. That is the cutover contract, not a defect, but it
  means the server is deliberately less capable than before BT5 until BT6/BT7.
- **The browser is now availability.** No browser, or no session, means content
  fails with a typed error. There is no fallback, by design.
- **No auto-start for content.** If the authority is ready but the browser is
  not running, `GET_CATEGORIES` fails with `BROWSER_UNAVAILABLE` rather than
  launching a browser as a side effect of a read. Reachable only via a
  bootstrap-from-storage session, which no current login path writes.
- **BT4-N2, N3, N4, N5** unchanged and still open.
- The managed browser from the smoke is left running, as BT2's adoption model
  expects.

## 10. Not done, deliberately

No second operation, no mutation, no account read, no player, no auto-login, no
auth-contract change, no onboarding change, no CDP beyond the three authorized
methods, no new dependency, no schema change, no push, no merge, no `main`
change, no BT6.

BT5 is **not** declared closed here.

---

# Part II — BT5-FIX1: bearer requirement separated from endpoint scope

Append-only. Part I stands as written, including its declared deviation, which
this part supersedes rather than erases.

## 11. Correction to Part I

Part I §9 listed "BT4-N2, N3, N4, N5" as open. That is wrong: **BT4-N5 and
BT4-N6 were both CLOSED at BT4's formal closure.** The correct state is:

| Item | State |
|---|---|
| BT4-R1 | CLOSED |
| BT4-N5 (Supported Human Onboarding) | **CLOSED** |
| BT4-N6 (operator documentation) | **CLOSED** |
| BT4-N2, BT4-N3, BT4-N4 | open, non-blocking |

## 12. What was wrong, and why it mattered

BT5 shipped `GET_CATEGORIES` as `scope: "ACCOUNT"` with zero auth-derived
params, because BT3's `bind()` keyed the wrapper on `scope` and only an ACCOUNT
descriptor could obtain a bearer. The endpoint addresses nobody's account, so
that label overloaded ACCOUNT — and it would have made the readiness rule
ambiguous exactly when it starts to matter: BT7's account operations must
require `PROFILE_READY`, and a stage cannot enforce that if ACCOUNT already
means "sometimes ACCOUNT_READY is enough".

The defect was one of vocabulary, not of behaviour: two independent questions
were being answered by one field.

## 13. The two dimensions

| | `auth: NONE` | `auth: BEARER` |
|---|---|---|
| **`scope: PUBLIC`** | truly unauthenticated: PUBLIC wrapper, no AuthContext, nothing to render | **`GET_CATEGORIES`.** AuthContext required, AuthorizedCall, `runCurrent`, empty identity, `ACCOUNT_READY` suffices |
| **`scope: ACCOUNT`** | **refused at registry construction** — an account-scoped path resolves identity from the record and cannot be served without material | account-scoped: AuthContext required, identity from the SAME snapshot, **`PROFILE_READY` required before these become caller-reachable (BT7 obligation)** |

`GET_CATEGORIES` final descriptor:

```
id                 GET_CATEGORIES
method             GET
pathTemplate       /content/v2/discover/categories?locale=en-US
callerParams       {}
authDerivedParams  {}
scope              PUBLIC
auth               BEARER
mutation           false
```

## 14. The change to `src/transport/auth-context.ts`

24 insertions, 1 deletion, and nothing else in that file:

- a runtime allowlist `AUTH_MATERIAL_REQUIREMENTS = ["NONE","BEARER"]`, in the
  same style as the existing `AUTH_COMMIT_MODES` — an unknown value fails
  closed rather than defaulting, because defaulting either way is a security
  answer given by accident;
- `bind()` decides on `descriptor.auth` instead of `descriptor.scope`. `NONE`
  still yields the PUBLIC wrapper with no context; `BEARER` yields an
  `AuthorizedCall` whose identity resolution loop is simply empty when the
  descriptor declares no auth-derived params.

Preserved, untouched: one authority, the current record as the only root of
material, the issuance `WeakSet`, `runCurrent` as the only guarded use that
releases a bearer, the pre-check, the `AbortSignal`, the post-check, redaction
registration at bind, and the absence of any other read path.

**No second bearer reader exists.** Asserted mechanically: `runCurrent` has
exactly one production consumer (`browser-api-backend.ts`), `asReader()` is
derived once (the composition root), no module calls `inspectForTest`, and
there is no `getCurrentBearer`-style accessor anywhere — `AuthContextReader`
still exposes exactly `bind` and `runCurrent`.

## 15. RED, exactly as observed

Eight failures before the fix:

| Test | RED |
|---|---|
| a PUBLIC descriptor that needs a bearer produces an AuthorizedCall | got `PUBLIC` |
| it releases the bearer only through runCurrent, with both checks | no context to run |
| without a usable context, PUBLIC + BEARER fails closed | bound happily with no material |
| an unknown auth requirement fails closed rather than defaulting | silently treated as public |
| ACCOUNT + NONE is rejected at construction | accepted |
| an unknown or missing auth requirement is rejected, never defaulted | accepted |
| the captured descriptor keeps the auth requirement immutably | field did not exist |
| `PRODUCTION_OPERATIONS` descriptor is PUBLIC + BEARER | was ACCOUNT |

**Born-green, recorded as such:** two of the new tests — the generation-change
discard and the wrapper-serialization sweep — passed before the fix, but for
the wrong reason (a PUBLIC wrapper has no context to leak and no `runCurrent`
to reach). They became meaningful only after `bind()` changed, which is why
they are kept.

## 16. Verification

| Check | Result |
|---|---|
| Focused: auth-context, registry, dispatcher, BT5 cutover, browser backend | 268/268 |
| Full suite | **794 pass, 0 fail, 0 skipped** |
| Zero-egress (`bwrap --unshare-net`) | **794 pass, 0 fail** |
| Typecheck / build | exit 0 / exit 0 |
| Public contract | 21 tools, schemas byte-equivalent, fixture untouched |
| `PRODUCTION_OPERATIONS` | exactly `GET_CATEGORIES`, now PUBLIC + BEARER |
| Second bearer reader | none (§14) |

**Flake observed and reported, not hidden.** Two full-suite runs each showed a
single failure in the REAL-browser BT2 integration suite — a different test
each time (`the profile and its ownership record survive across stop`, then
`cleanup runs even when the body fails`), 15 s and 0.3 s. The suite passes 8/8
in isolation and the third full run was 794/794 clean. It is contention in the
real-browser suite under parallel load, aggravated by an orphaned browser from
the earlier smoke; it is not caused by this change, which touches no lifecycle
code. Recorded as a known test-infrastructure weakness rather than explained
away.

## 17. Readiness obligation carried forward

BT3's reader knows nothing about the `ACCOUNT_READY`/`PROFILE_READY` enum, and
this FIX deliberately did not build that: it would be a BT4-wide refactor for
an operation that does not need it.

**Obligation recorded for BT7:** before any `scope: ACCOUNT` operation becomes
caller-reachable, the gateway must require `PROFILE_READY`. `ACCOUNT_READY` is
sufficient only for `PUBLIC + BEARER`. Nothing in this stage documents or
implements ACCOUNT as satisfiable at `ACCOUNT_READY`.

## 18. Status

BT5-FIX1 is a candidate for external review. BT5 is **not** declared closed.

---

# Part III — BT5-R2: the scope / auth-derived cross-field invariant

Append-only. Parts I and II stand as written.

## 19. Correction to an earlier handoff number

The BT5-FIX1 handoff message reported the FIX1 diff as "9 files, +407/−18".
The packet's own stat is authoritative: **10 files, +410/−21**. The discrepancy
was in the spoken summary, not in the artifacts; the history is unchanged and
this is the factual correction of record.

## 20. The finding

External review found that FIX1 separated the two dimensions but did not make
them agree. `createOperationRegistry()` rejected only `ACCOUNT + NONE`, so two
contradictory shapes remained representable:

| Shape | Why it is wrong |
|---|---|
| `PUBLIC` + any auth + **non-empty** `authDerivedParams` | `bind()` resolves whatever a descriptor declares, independently of scope. Such an operation would consume `accountId`/`profileId` from the current record while its label claimed to address nobody's account. |
| `ACCOUNT` + `BEARER` + **empty** `authDerivedParams` | the pre-FIX1 overload — ACCOUNT used only as a way to obtain a bearer — wearing the new label. It is exactly the ambiguity FIX1 existed to remove, and it would leave BT7's `PROFILE_READY` rule unenforceable. |

Neither was reachable in production: `PRODUCTION_OPERATIONS` holds one
descriptor and it is correct. The defect was that the policy was documented
rather than mechanical.

## 21. RED, exactly as observed

Three failures before the fix, and only three:

| Test | RED |
|---|---|
| PUBLIC + NONE may not declare an identity parameter | accepted |
| PUBLIC + BEARER may not declare an identity parameter either | accepted |
| ACCOUNT + BEARER with no identity parameter is refused | accepted |

**Born-green, recorded as such:** the three valid shapes, the production-table
invariant check, and the caller-supplied-identity refusal all passed before the
fix — the first three because they were already legal, the last because
`resolveCall`'s allow-list has rejected caller identity since BT1.

## 22. The fix

Confined to `createOperationRegistry()`, which owns descriptor policy. Two
closed checks, before capture, beside the existing ones:

- `scope === "PUBLIC"` with any auth-derived param → `INVALID_ARGUMENTS`;
- `scope === "ACCOUNT"` with none → `INVALID_ARGUMENTS`.

No second validation was added in the backend or anywhere else, and
`src/transport/auth-context.ts` is untouched: the registry proved sufficient in
the reachable production graph, so no RED justified touching BT3.

## 23. The complete matrix, mechanically proved

Exercised against the real registry (`scope-invariant-proof.txt`):

| Shape | Result |
|---|---|
| `PUBLIC + NONE + {}` | ACCEPTED |
| `PUBLIC + BEARER + {}` | ACCEPTED — this is `GET_CATEGORIES` |
| `ACCOUNT + BEARER + {accountId}` | ACCEPTED |
| `ACCOUNT + NONE + {accountId}` | REJECTED — account-scoped but declares no auth material |
| `PUBLIC + NONE + {accountId}` | REJECTED — public but resolves authenticated identity |
| `PUBLIC + BEARER + {accountId}` | REJECTED — public but resolves authenticated identity |
| `ACCOUNT + BEARER + {}` | REJECTED — account-scoped but resolves no identity |
| `PUBLIC + <unknown auth>` | REJECTED — no closed auth requirement |

A genuinely account-scoped endpoint with no identity parameter would require an
explicit future decision. The invariant is not weakened now for a hypothetical.

## 24. Unchanged by this FIX

`GET_CATEGORIES` is byte-identical: `PUBLIC` + `BEARER` + zero auth-derived
params + `mutation: false`. No browser, CDP, auth-lifecycle, transport-pipeline
or public-schema change; no new operation; no new CDP surface. The FIX1 live
evidence therefore still applies and was not repeated.

## 25. Authorized test cleanup

Four descriptor literals in `test/transport-registry.test.ts` carried a
duplicate `auth` key introduced by the FIX1 patch. Last-key-wins meant they
asserted what was intended, but the source did not say so plainly; each now has
exactly one. The stale comment in `test/browser-api-transport.test.ts`
describing `GET_CATEGORIES` as ACCOUNT-with-zero-identity now describes what it
is.

## 26. Verification

| Check | Result |
|---|---|
| Focused (10 suites incl. registry, auth-context, dispatcher, backend, cutover, harness) | 295/295 on the six named; all ten green |
| Full suite | **800 pass, 0 fail, 0 skipped** |
| Zero-egress (`bwrap --unshare-net`, `BT2_NET_ISOLATED=1`) | **800 pass, 0 fail**; TCP and a real `fetch` both `ENETUNREACH` |
| Typecheck / build | exit 0 / exit 0 |
| Public contract | 21 tools; fixture and package files unchanged since `c229b31` |
| `PRODUCTION_OPERATIONS` | exactly `GET_CATEGORIES` |
| Node Crunchyroll attempts | 0 |
| BT2 real-browser flake | did not recur in this stage's runs |

Raw logs for every row above are in the packet — including the zero-egress and
typecheck/build logs the FIX1 packet omitted.

## 27. Status

BT5-FIX2 is a candidate for external review. BT5 is **not** declared closed.
