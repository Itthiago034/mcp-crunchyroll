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
