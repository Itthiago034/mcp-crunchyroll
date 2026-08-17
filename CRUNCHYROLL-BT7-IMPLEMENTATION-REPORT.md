# MCP Crunchyroll — BT7 Implementation Report

Candidate for external review. Base `52ef5a04` (BT6 formally closed). It records
the six account read operations that were migrated, the two that do not work
against the live provider and why, and the evidence for both. It authorizes
nothing, closes nothing, and starts no BT8 work.

Two live findings (**F-1**, **F-2**) are open and carry a proposed resolution
that was deliberately **not** applied. They need a ruling, in the same way D-1
did.

## 1. Frozen Base

| Property | Value |
|---|---|
| Base | `52ef5a04ac5a8d637944750e5b29fa68de42ba8f` |
| Branch | `bt7-account-reads` (created from the base; no rebase, amend or merge) |
| Design | `BT7-DESIGN.md` (design round, PASS) — carried in the evidence packet, not the repo |
| Operations migrated | 6 |
| `PRODUCTION_OPERATIONS` | **14** |
| Public tools | **21**, schemas unchanged |
| Full suite | 897 pass / 0 fail / 0 skipped |
| Zero-egress suite | 897 pass / 0 fail |
| Typecheck / build | exit 0 / exit 0 |
| Live smoke | 5 of 7 steps green; **2 open findings** |
| Push | none — the interlock stays armed |

## 2. D-1 Resolution

D-1 was resolved as **D-1c: DEFER `GET_SUBSCRIPTION`**, from the Q-1 live probe.
BT7 therefore migrates six operations, not seven. The probe was **not** repeated
in this round, and the 403 it observed is not reinterpreted here.

## 3. Scope Implemented

Migrated, all `scope: ACCOUNT`, `auth: BEARER`, `mutation: false`, `GET` only:

`GET_SIMILAR`, `GET_RECOMMENDATIONS`, `GET_WATCHLIST`, `GET_HISTORY`,
`GET_CONTINUE_WATCHING`, `GET_PLAYHEADS`.

Not touched: `GET_SUBSCRIPTION` (deferred), and the three BT8 mutations
`ADD_TO_WATCHLIST`, `REMOVE_FROM_WATCHLIST`, `UPDATE_PLAYHEAD`.

## 4. G-1 Implementation

Before BT7, an account URL could in principle be assembled and only then
authorised. G-1 inverts that order in `browser-api-backend.ts`: the reader binds
first, the execution must be `AUTHENTICATED`, and only the identity that binding
produced reaches URL construction.

```ts
let execution;
try { execution = ports.reader.bind(call); } catch (error) { throw asTransportError(error); }
if (execution.kind !== "AUTHENTICATED") throw new TransportError("AUTH_NOT_READY", "no-bearer");
const url = buildRequestUrl(call, execution.authDerivedParams);
if (!url.startsWith(`${CRUNCHYROLL_API_ORIGIN}/`)) throw new TransportError("INVALID_ARGUMENTS", "path");
```

Consequences proved by test rather than asserted: no CDP channel is opened when
authority is absent; a generation change between bind and run discards the
result; the origin check still runs on the materialized URL.

## 5. G-2 Implementation

`OperationDescriptor` gained `repeatedQueryParams: Readonly<Record<string,string>>`,
mapping a **wire key** to a **caller parameter**. `buildRequestUrl` appends one
query entry per list element, in caller order:

```ts
for (const [key, param] of Object.entries(descriptor.repeatedQueryParams ?? {})) {
  const values = callerParams[param];
  if (values === undefined) continue;
  if (!Array.isArray(values)) throw new TransportError("INVALID_ARGUMENTS", `expected a list: ${param}`);
  for (const entry of values) query.append(key, String(entry));
}
```

The list is bounded by `contentIdList(MAX_CONTENT_IDS)` — 1 to 100 entries, each
validated by the **existing** `contentId` predicate, not a new one. The registry
refuses at construction: a repeated param that is undeclared, that is also a
scalar query param, or that collides with a fixed param, is `INVALID_ARGUMENTS`.

**F-2 concerns the wire key this mechanism is configured with, not the mechanism.**
See §27.

## 6. Identity Provenance

`accountId` is never a caller parameter. It is declared once, in the
`accountRead()` helper, as `authDerivedParams: { accountId: { source: "accountId" } }`,
and materialized only from the bound `AuthContext`. A caller that sends
`accountId` is refused with `CALLER_SUPPLIED_IDENTITY`; a caller that sends
`account_id`, `profileId` or `profile_id` is refused with `INVALID_ARGUMENTS` as
an undeclared parameter. Both are tested per operation, six times each.

## 7. Operation Descriptor Matrix

| Operation | Path template | Query | Locale | Repeated |
|---|---|---|---|---|
| `GET_SIMILAR` | `/content/v2/discover/{accountId}/similar_to/{series_id}` | `n` | yes | — |
| `GET_RECOMMENDATIONS` | `/content/v2/discover/{accountId}/recommendations` | `n` | yes | — |
| `GET_WATCHLIST` | `/content/v2/{accountId}/watchlist` | `n`, `order` | yes | — |
| `GET_HISTORY` | `/content/v2/{accountId}/watch-history` | `n` | yes | — |
| `GET_CONTINUE_WATCHING` | `/content/v2/{accountId}/continue_watching` | `n` | yes | — |
| `GET_PLAYHEADS` | `/content/v2/{accountId}/playheads` | — | **no** | `content_ids[]` ← `content_ids` |

`withLocale: false` on `GET_PLAYHEADS` is not an oversight: the legacy client
sent no locale on that call, and BT7 reproduced it verbatim.

All fourteen production operations are `GET`, `mutation: false`; eight are
`PUBLIC` and six are `ACCOUNT`; all fourteen are `auth: BEARER`.

## 8. Parameter Ownership

The registry is the only place that knows a method, a path, a query key or a
parameter predicate. The gateway owns defaults, and only two exist:
`DEFAULT_CONTINUE_WATCHING_SIZE = 10` and `DEFAULT_WATCHLIST_ORDER = "desc"`,
both copied from the legacy call sites rather than chosen.

## 9. Account Readiness

An account read requires an `AUTHENTICATED` binding. Without it the operation
fails `AUTH_NOT_READY` before any URL exists and before any channel is opened.
There is no anonymous degradation, no cached identity, and no fallback.

## 10. Per-operation Cutover

Each of the six routes through `resolveCall` → registry descriptor → G-1 bind →
`buildRequestUrl` → closed CDP channel → account parser → the tool's published
shape. Exact URL rendering is asserted per operation against a literal string,
so a silent path drift fails a test rather than a live call.

## 11. `GET_SUBSCRIPTION` Deferral

No descriptor, no parser, no path move, no fallback, no re-probe. The tool
remains registered and answers `OPERATION_NOT_MIGRATED` with zero transport
calls. Its path literal deliberately stays in `src/api.ts`, owned by nothing
else.

## 12. BT8 Isolation

`addToWatchlist`, `removeFromWatchlist` and `updatePlayhead` are untouched. All
three still answer `OPERATION_NOT_MIGRATED`, verified in the offline suite and
again live. `/watchlist` and `/playheads` therefore still appear in `src/api.ts`
— as **mutation** routes. Ownership is asserted per owning function and per read
template, not per path segment, precisely so this remains legible.

## 13. Parser/Domain Changes

New file `src/account-domain.ts`. It imports nothing: no fetch, no transport, no
auth, no token, no session, no cross-call state. It exposes `AccountShapeError`
(carrying a field path, never provider content), `parseSimilar`,
`parseRecommendations` (one shared discover parser), `parseWatchlist`,
`parseHistory`, `parseContinueWatching` (one shared `{count, items}` shallow
pass-through) and `parsePlayheads` (which returns the data array itself, as that
tool has always done). No published shape changed.

## 14. Caller Injection Results

Six operations × identity injection: `accountId` → `CALLER_SUPPLIED_IDENTITY`;
`account_id` / `profileId` / `profile_id` → `INVALID_ARGUMENTS`. No injected
value ever reaches a URL. Refusal happens in `resolveCall`, before binding.

## 15. Duplicate Ownership Results

Zero duplicate ownership. The six read path templates exist only in the
registry. `src/api.ts` retains path literals for exactly four functions —
`addToWatchlist`, `removeFromWatchlist`, `updatePlayhead`, `getSubscription` —
and the six read functions were deleted, not copied.

## 16. RED/Born-Green Evidence

`test/bt7-account.test.ts` was written first and run against unmigrated code:
**52 tests, 16 pass, 36 fail** (`bt7-red.log`). The failures were the intended
ones — missing descriptors, missing `repeatedQueryParams`, URLs built before
binding. After migration the same file is **53 pass / 0 fail** (one test was
added during implementation, for registry incoherence).

Eighteen assertions in four earlier suites failed after the migration. Each was
verified to be a **stage assertion** — a statement that these operations were
*not yet* migrated — never a behaviour assertion. They were retired in place,
with the reason written at the site, and their representatives moved to
`GET_SUBSCRIPTION` and the BT8 mutations.

## 17. BT6 Regression

None. Every BT6 behaviour test — URL rendering, routing, refusals, encoding,
origin enforcement, the LIVE-COMPAT normalizer, ownership — still passes
unchanged, including under G-1's new bind-before-URL ordering. The live smoke
re-exercised `crunchyroll_search` (40 results) as a catalog control.

## 18. Full Suite

**897 pass, 0 fail, 0 skipped.**

## 19. Zero-Egress

**897 pass, 0 fail** under `bwrap --unshare-net` with `BT2_NET_ISOLATED=1`. TCP
and a real `fetch` both fail `ENETUNREACH`; DNS resolution alone is not accepted
as proof.

## 20. Typecheck / Build

`npm run typecheck` exit 0. `npm run build` → `Build complete: dist/index.js`.

## 21. Live Smoke

Real session, dedicated profile, read-only, no mutation attempted. IDs chained
from the smoke's own reads. Path **templates** only — no materialized URL was
ever rendered to the log.

| Step | Result |
|---|---|
| login | `PROFILE_READY`, 2 s |
| `crunchyroll_search` (catalog control) | **40** results, series `GT00377907`, 1641 ms |
| `crunchyroll_get_similar` | `count=0`, 810 ms — **valid empty result** |
| `crunchyroll_get_recommendations` | **20**, 418 ms |
| `crunchyroll_get_watchlist` | **123**, 298 ms |
| `crunchyroll_get_history` | **25**, 339 ms |
| `crunchyroll_continue_watching` | **`API_NOT_FOUND`** — "Upstream has no such resource", 333 ms → **F-1** |
| `crunchyroll_get_playheads` (3 ids) | **`INVALID_RESPONSE`** — "The response could not be validated", 254 ms → **F-2** |
| `crunchyroll_get_subscription` | `OPERATION_NOT_MIGRATED`, 1 ms |
| `add_to_watchlist` / `remove_from_watchlist` / `update_playhead` | `OPERATION_NOT_MIGRATED`, ≤1 ms each |
| Node egress guard | **0 blocked attempts** |

Four of the six migrated operations answer real account data. `GET_SIMILAR`
returning `count=0` is a valid empty result for that series and is **not**
counted as a failure. The remaining two are F-1 and F-2.

### F-1 — `GET_CONTINUE_WATCHING`: the endpoint is not routed

Not an empty result. HTTP **404** with `content-type: text/html` and a
**274907-byte** document beginning `<!DOCTYPE html>` — the website's SPA 404
page, not an API answer. Probed three ways in one session:

| Query sent | Status | Type | HTML shell | Bytes |
|---|---|---|---|---|
| `n=10&locale=en-US` (legacy wire, verbatim) | 404 | `text/html` | yes | 274907 |
| *(no query at all)* | 404 | `text/html` | yes | 274907 |
| `n=10` | 404 | `text/html` | yes | 274907 |

The response is byte-identical regardless of the query, so this is **routing,
not validation**. Validation failures on this host answer JSON `400` — proved in
the same session by F-2, on a sibling path under the same `/content/v2/{accountId}/`
prefix. `GET_HISTORY` returned **200** on the same channel, same identity,
seconds apart. The path is a faithful copy of the legacy one:

```
src/api.ts @52ef5a04:737   `${API_BASE}/content/v2/${account_id}/continue_watching?${params}`
```

**Conclusion:** the legacy endpoint no longer exists. This is a provider-contract
defect that predates BT7 in the source; BT7's live smoke is the first time it
could be observed, because the Node egress guard prevented the legacy client
from reaching it at all. Finding a replacement endpoint would be a guess and a
redesign, both out of mandate. **No code was changed.**

### F-2 — `GET_PLAYHEADS`: the legacy wire key is rejected

Not an id problem, not a shape problem, and it never reaches the parser. HTTP
**400** with the provider naming the fault itself:

```
code    = "content.get_playheads_v2.format_validation_error"
context = [ { field: "content_ids", code: "content.get_playheads_v2.missing_required_field" } ]
```

The v2 endpoint expects a parameter named `content_ids`. The legacy wire sends
`content_ids[]`, so the server sees `content_ids` as **missing**. BT7 reproduced
that wire verbatim:

```
src/api.ts @52ef5a04:709   contentIds.forEach((id) => params.append("content_ids[]", id));
```

Four wires were probed read-only in one session, with content ids the account has
actually watched, so a non-empty answer could discriminate them:

| Wire | Status | Result |
|---|---|---|
| `content_ids=<one id>` | 200 | `data=array[1]` |
| `content_ids=<id>,<id>` (comma-joined) | 200 | **`data=array[2]`** |
| `content_ids=<id>&content_ids=<id>` (repeated key) | 200 | `data=array[1]` — **second id dropped** |
| `content_ids[]=<id>&content_ids[]=<id>` (legacy, current BT7) | 400 | `missing_required_field` |

Entry shape on success: `["content_id","fully_watched","last_modified","playhead"]`
— which `parsePlayheads` accepts unchanged.

The five hypotheses put to this finding resolve as:

1. **repeated-query wire incorrect** — **CONFIRMED as the cause**, with the
   qualification that BT7 is byte-identical to the legacy wire. The defect is
   in the wire BT7 faithfully copied.
2. ids not valid for playheads — **excluded**: the very same ids return 200 under
   the bare parameter name.
3. valid HTTP response with a shape the parser rejects — **excluded**: a 400
   never reaches the parser; and the 200 shape parses.
4. invalid HTTP/transport response — **excluded**: `GET_HISTORY` returned 200 on
   the same channel, identity and session.
5. other — none observed.

**Proposed resolution, deliberately NOT applied:** change the registry's wire key
from `"content_ids[]"` to `"content_ids"` **and** render the list comma-joined
rather than repeated. The first half is a one-string registry change inside G-2;
the second half replaces G-2's mechanism for this operation, and G-2 was mandated
as a repeated-query mechanism. That is a design change, so it is escalated rather
than taken. **No code was changed.**

## 22. Parser Shape Audit

Field names only, no values.

| Entry | Fields observed live |
|---|---|
| recommendation | `["description","id","title","type"]` |
| watchlist item | `["date_added","id","is_favorite"]` |
| history item | `["date_played","fully_watched","id","panel","parent_id","parent_type","playhead"]` |
| playhead entry (from the F-2 probe) | `["content_id","fully_watched","last_modified","playhead"]` |
| similar / continue item | not observed — `count=0` and F-1 respectively |

One drift worth recording: **live watchlist items carry no `panel`**, while
history items do. The published shape survives because `parseWatchlist` is a
shallow pass-through, exactly as the legacy tool was. No parser was relaxed and
no shape was invented.

## 23. Redaction / Secret Handling

No materialized ACCOUNT URL was written to any log, packet or report. No URL was
regex-masked; identity is omitted **structurally** — the drivers log an operation
id, a path template, a method, a status, a content type, a latency, a shape and
counts, and identity is simply never assembled into a log line. No `accountId`,
`account_id`, `profileId`, `profile_id`, `Authorization`, bearer, cookie, raw
body or email appears anywhere in this round's evidence. The one identifier class
that does appear is **public content ids**, which the mandate permits.

The diagnostic probes rewrote only the query string of a URL that production code
had built, so the identity stayed inside that code; only `URL.search` was logged.

## 24. Candidate Commit Chain

```
52ef5a04  (base, BT6 formally closed)
  └─ 29950fd  BT7: migrate the account read operations
       └─ <this commit>  BT7: record account migration verification
```

**Deviation from §40, recorded rather than dressed up.** The mandate *suggested*
a six-commit split (BT7.1 gates, BT7.2–BT7.4 operations, BT7.6 cleanup). The work
landed as one migration commit plus this evidence commit. The RED sequence was
genuinely run first — the suite was written against unmigrated code and produced
36 failures, preserved as `bt7-red.log` — but the intermediate states were never
committed, so the RED/GREEN sequence lives in the packet's logs rather than in
the history. Nothing was squashed to hide it; it was never split.

Two commits, no merge, no rebase, no amend, no force. The candidate HEAD is the
commit carrying this report; its SHA is recorded in the packet and in the final
answer, since a commit cannot contain its own hash. Working tree clean.

## 25. Packet Provenance

The evidence packet contains the live driver and its SHA256, its stdout, stderr,
exit code, start and finish timestamps, a runtime snapshot (node, npm, platform),
the candidate HEAD, the raw regenerated logs for the full suite, the zero-egress
run, typecheck and build, the RED log, the diagnostic probe sources and their
logs, a `SHA256SUMS` over every file, and a complete `git bundle` of the branch.
All proof logs were regenerated **after** the candidate commit.

## 26. Acceptance Checklist

| Criterion | Result |
|---|---|
| Base `52ef5a04`, branch `bt7-account-reads` | ✅ |
| Exactly six operations migrated | ✅ |
| `PRODUCTION_OPERATIONS` = 14 | ✅ |
| Public tools 21, schemas frozen | ✅ |
| `GET_SUBSCRIPTION` untouched, no re-probe | ✅ |
| BT8 mutations untouched, all refused | ✅ |
| Identity never from the caller | ✅ |
| G-1 bind before URL | ✅ |
| G-2 bounded 1–100 list, existing `contentId` predicate | ✅ |
| Move, not copy | ✅ |
| Focused / full / zero-egress / typecheck / build | ✅ 53 · 897 · 897 · 0 · 0 |
| BT6 regression | none |
| Redaction rule honoured | ✅ |
| No push | ✅ |
| Live smoke, all six operations functional | ❌ **F-1, F-2 open** |

## 27. Risks / Observations

- **F-1 and F-2 are open and need a ruling.** Two of the six migrated operations
  do not work against the live provider. They are not declared working anywhere
  in this report. Neither is caused by BT7's wiring, and neither can be repaired
  inside this mandate: F-1 would require discovering a replacement endpoint
  (a guess), F-2 would require changing G-2's mandated mechanism for one
  operation (a design change). The options for each look like D-1's: **defer the
  operation** as `GET_SUBSCRIPTION` was, or **keep it migrated** answering an
  honest typed error until a later round fixes the contract.
- The error taxonomy behaved correctly and was not extended: 404 → `API_NOT_FOUND`,
  400 → `INVALID_RESPONSE`. Neither failure was silently converted into an empty
  result.
- `GET_SIMILAR` was observed only as `count=0`. Its parser is exercised by tests
  but has no live non-empty confirmation.
- `locale` remains fixed at `en-US`, as in the legacy client. BT7 invented no way
  for a caller to choose one.
- BT4-N2, N3, N4 remain open and non-blocking.

## 28. Final Disposition

**BT7 IMPLEMENTATION CANDIDATE — PASS, WITH TWO OPEN LIVE FINDINGS.**

Every criterion the mandate placed on the *implementation* is met, and no stop
condition fired. What the live smoke surfaced is not a defect in this migration
but two stale provider contracts that the migration made observable for the first
time. They are reported, not worked around.

BT7 is **not** declared formally closed. Independent review is required, and
F-1 and F-2 need a ruling before closure. No push, no merge, no `main` change,
no BT8.
