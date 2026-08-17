# MCP Crunchyroll — BT7 Implementation Report

Candidate for external review. Base `52ef5a04` (BT6 formally closed). It records
the account read operations that were migrated, the one that was deferred on
live evidence, the provider contract that was corrected, and the proofs for all
of it. It authorizes nothing, closes nothing, and starts no BT8 work.

The two findings the first candidate raised are now **resolved**, by ruling:

| Finding | Ruling | Result |
|---|---|---|
| **F-1** `GET_CONTINUE_WATCHING` 404s with the site's HTML shell | **DEFER** | removed from production; the tool answers `OPERATION_NOT_MIGRATED` |
| **F-2** `GET_PLAYHEADS` legacy `content_ids[]` rejected with 400 | **CORRECT THE CONTRACT** | comma-joined `content_ids`; live `array[3]` |

## 1. Frozen Base

| Property | Value |
|---|---|
| Base | `52ef5a04ac5a8d637944750e5b29fa68de42ba8f` |
| Branch | `bt7-account-reads` (no rebase, amend, squash or merge) |
| Design | `BT7-DESIGN.md` (in the evidence packet) + `BT7-DESIGN-F1-F2-ERRATA.md` (in the repo) |
| Operations migrated | 5 |
| Operations deferred | 2 |
| `PRODUCTION_OPERATIONS` | **13** |
| Public tools | **21**, schemas unchanged |
| Full suite | 919 pass / 0 fail / 0 skipped |
| Zero-egress suite | 919 pass / 0 fail |
| Typecheck / build | exit 0 / exit 0 |
| Live smoke | **every expected outcome met** |
| Push | none — the interlock stays armed |

## 2. D-1 Resolution

D-1 was resolved as **D-1c: DEFER `GET_SUBSCRIPTION`**, from the Q-1 live probe.
The probe was not repeated in this round and the 403 it observed is not
reinterpreted here. F-1 later placed `GET_CONTINUE_WATCHING` in the same
category, for an independent reason and on its own evidence.

## 3. Scope Implemented

Migrated, all `scope: ACCOUNT`, `auth: BEARER`, `mutation: false`, `GET` only:

`GET_SIMILAR`, `GET_RECOMMENDATIONS`, `GET_WATCHLIST`, `GET_HISTORY`,
`GET_PLAYHEADS`.

Deferred: `GET_CONTINUE_WATCHING` (F-1), `GET_SUBSCRIPTION` (D-1c).

Untouched: the three BT8 mutations `ADD_TO_WATCHLIST`, `REMOVE_FROM_WATCHLIST`,
`UPDATE_PLAYHEAD`.

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

## 5. G-2 Implementation, and what F-2 did to it

G-2 shipped as designed: `repeatedQueryParams` maps a wire key to a declared,
array-valued caller param and emits one entry per element, in caller order. It
is implemented, invariant-checked at registry construction, and covered by
tests.

What F-2 falsified is not the mechanism but the **premise** that
`GET_PLAYHEADS` needed it. That operation now uses `joinedQueryParams`
(§3 of the errata, and section 5b below), and no production operation consumes
G-2 today.

**G-2 is retained deliberately.** It is general, closed, fully tested, and
unreachable by construction — a caller cannot declare a descriptor, and with no
descriptor declaring a repeated key there is no path to it at all. Deleting
tested machinery that nothing can reach buys no safety and costs a later stage
the work of rebuilding it.

### 5b. `joinedQueryParams` — the corrected encoding

```ts
export interface JoinedQueryParam {
  readonly callerParam: string;
  readonly separator: string;
}
```

```ts
for (const [key, spec] of Object.entries(descriptor.joinedQueryParams ?? {})) {
  const values = callerParams[spec.callerParam];
  if (values === undefined) continue;
  if (!Array.isArray(values)) {
    throw new TransportError("INVALID_ARGUMENTS", `expected a list: ${spec.callerParam}`);
  }
  query.set(key, values.map((entry) => String(entry)).join(spec.separator));
}
```

The descriptor owns the wire key **and** the separator. The URL builder knows
the rule and never an operation name — a test asserts that neither
`GET_PLAYHEADS` nor `content_ids` appears anywhere in that file, because the
moment one does, the registry has stopped being the single owner of the wire.

Registry invariants, all `INVALID_ARGUMENTS` at construction: the joined param
must be declared; the wire key may not also be scalar, fixed or repeated; the
separator must be a non-empty string. The list bounds are unchanged — 1 to 100
entries, each validated by the **existing** `contentId` predicate.

## 6. Identity Provenance

`accountId` is never a caller parameter. It is declared once, in the
`accountRead()` helper, as `authDerivedParams: { accountId: { source: "accountId" } }`,
and materialized only from the bound `AuthContext`. A caller that sends
`accountId` is refused with `CALLER_SUPPLIED_IDENTITY`; one that sends
`account_id`, `profileId` or `profile_id` is refused with `INVALID_ARGUMENTS` as
an undeclared parameter. Both are tested per operation.

## 7. Operation Descriptor Matrix

| Operation | Path template | Query | Locale | List encoding |
|---|---|---|---|---|
| `GET_SIMILAR` | `/content/v2/discover/{accountId}/similar_to/{series_id}` | `n` | yes | — |
| `GET_RECOMMENDATIONS` | `/content/v2/discover/{accountId}/recommendations` | `n` | yes | — |
| `GET_WATCHLIST` | `/content/v2/{accountId}/watchlist` | `n`, `order` | yes | — |
| `GET_HISTORY` | `/content/v2/{accountId}/watch-history` | `n` | yes | — |
| `GET_PLAYHEADS` | `/content/v2/{accountId}/playheads` | — | **no** | **joined** `content_ids`, separator `,` |

`withLocale: false` on `GET_PLAYHEADS` is not an oversight: the legacy client
sent no locale on that call, and the live endpoint accepts none.

All thirteen production operations are `GET`, `mutation: false`; eight are
`PUBLIC` and five are `ACCOUNT`; all thirteen are `auth: BEARER`.

## 8. Parameter Ownership

The registry is the only place that knows a method, a path, a query key, a
separator or a parameter predicate. The gateway owns defaults, and one remains:
`DEFAULT_WATCHLIST_ORDER = "desc"`, copied from the legacy call site rather than
chosen. `DEFAULT_CONTINUE_WATCHING_SIZE` left with F-1 — a default for an
unserved operation is dead policy.

## 9. Account Readiness

An account read requires an `AUTHENTICATED` binding. Without it the operation
fails `AUTH_NOT_READY` before any URL exists and before any channel is opened.
There is no anonymous degradation, no cached identity, no fallback.

## 10. Per-operation Cutover

Each of the five routes through `resolveCall` → registry descriptor → G-1 bind →
`buildRequestUrl` → closed CDP channel → account parser → the tool's published
shape. Exact URL rendering is asserted per operation against a literal string,
so a silent path drift fails a test rather than a live call.

## 11. Deferrals

**`GET_SUBSCRIPTION` (D-1c)** — no descriptor, no parser, no path move, no
fallback, no re-probe. Its path literal deliberately stays in `src/api.ts`,
owned by nothing else.

**`GET_CONTINUE_WATCHING` (F-1)** — no descriptor, no parser, no gateway case,
no default, and **no path anywhere in the tree**: it was not returned to
`src/api.ts`, because no owner at all is the correct state for a route the
provider does not serve. No replacement endpoint was sought or guessed.

Both tools remain published among the 21 and answer `OPERATION_NOT_MIGRATED`
with zero transport attempts. The refusal happens in the gateway, locally,
before any transport, browser or network; `resolveCall` refuses one layer down
with `UNKNOWN_OPERATION`. Both deferrals are asserted together, so neither can
drift into a shape of its own.

## 12. BT8 Isolation

`addToWatchlist`, `removeFromWatchlist` and `updatePlayhead` are untouched. All
three still answer `OPERATION_NOT_MIGRATED`, verified offline and again live.
`/watchlist` and `/playheads` therefore still appear in `src/api.ts` — as
**mutation** routes. Ownership is asserted per owning function and per exact
read template, not per path segment, precisely so this stays legible.

## 13. Parser/Domain Changes

`src/account-domain.ts` imports nothing: no fetch, no transport, no auth, no
token, no session, no cross-call state. It exposes `AccountShapeError` (carrying
a field path, never provider content), `parseSimilar`, `parseRecommendations`
(one shared discover parser), `parseWatchlist` and `parseHistory` (one shared
`{count, items}` shallow pass-through) and `parsePlayheads` (which returns the
data array itself, as that tool has always done).

`parseContinueWatching` was removed with F-1: its only consumer was the gateway
case for an endpoint the provider no longer routes. No published shape changed,
and no parser was relaxed at any point.

## 14. Caller Injection Results

Five operations × identity injection: `accountId` → `CALLER_SUPPLIED_IDENTITY`;
`account_id` / `profileId` / `profile_id` → `INVALID_ARGUMENTS`. No injected
value reaches a URL; refusal happens in `resolveCall`, before binding. For
`GET_PLAYHEADS` the same holds for the wire itself: `separator`,
`content_ids_separator`, `content_ids_key`, `joinedQueryParams` and
`content_ids[]` are all undeclared parameters and all refused.

## 15. Duplicate Ownership Results

Zero duplicate ownership. The four migrated read path templates exist only in
the registry; `continue_watching` exists nowhere. `src/api.ts` retains path
literals for exactly four functions — `addToWatchlist`, `removeFromWatchlist`,
`updatePlayhead` (all BT8) and `getSubscription` (deferred, under a different
prefix, `/subs/v1/...`). The six legacy read functions were deleted, not copied.

## 16. RED/Born-Green Evidence

**BT7 migration.** `test/bt7-account.test.ts` was written first and run against
unmigrated code: **52 tests, 16 pass, 36 fail** (`bt7-red.log`). The failures
were the intended ones — missing descriptors, missing list encoding, URLs built
before binding.

**F-1/F-2 ruling.** `test/bt7-f1-f2.test.ts` was likewise written before the
correction and run against the first candidate: **25 tests, 8 pass, 17 fail**
(`bt7-f1f2-red.log`). It is green at the candidate.

Two assertions in that RED file were themselves wrong and were corrected rather
than the source bent to fit: one expected `resolveCall` to answer
`OPERATION_NOT_MIGRATED` when the established contract at that layer is
`UNKNOWN_OPERATION` (the gateway speaks the former, as `GET_SUBSCRIPTION` has
since D-1c); the other read `calls[0].operation` where a `ResolvedCall` carries
`descriptor.id`.

**Retired stage assertions.** Eighteen assertions were retired in place after
the migration, and sixteen more after the ruling — each verified to be a
*stage* assertion (a statement about what was migrated *at that point*), never a
behaviour assertion, each retired at the site with the reason written there.

## 17. BT6 Regression

None. Every BT6 behaviour test — URL rendering, routing, refusals, encoding,
origin enforcement, the LIVE-COMPAT normalizer, ownership — passes unchanged
under both G-1's ordering and the new joined encoding. The live smoke
re-exercised `crunchyroll_search` (40 results) as a catalog control.

## 18. Full Suite

**919 pass, 0 fail, 0 skipped.**

## 19. Zero-Egress

**919 pass, 0 fail** under `bwrap --unshare-net` with `BT2_NET_ISOLATED=1`. TCP
and a real `fetch` both fail `ENETUNREACH`; DNS resolution alone is not accepted
as proof.

## 20. Typecheck / Build

`npm run typecheck` exit 0. `npm run build` → `Build complete: dist/index.js`.

## 21. Live Smoke

Real session, dedicated profile, read-only, no mutation attempted. IDs chained
from the smoke's own reads. Path **templates** only — no materialized URL was
ever rendered to the log.

| Step | Expected | Observed |
|---|---|---|
| login | `PROFILE_READY` | `PROFILE_READY`, 3 s |
| `crunchyroll_search` (catalog control) | success | **40** results, series `GT00377907` |
| `crunchyroll_get_similar` | success or valid empty | `count=0` — valid empty |
| `crunchyroll_get_recommendations` | success | **20** |
| `crunchyroll_get_watchlist` | success | **123** |
| `crunchyroll_get_history` | success | **25** |
| `crunchyroll_get_playheads` (3 ids) | HTTP success + parsed array, comma-joined | **`array[3]`**, 278 ms |
| `crunchyroll_continue_watching` | `OPERATION_NOT_MIGRATED`, 0 attempts | `OPERATION_NOT_MIGRATED`, 2 ms |
| `crunchyroll_get_subscription` | `OPERATION_NOT_MIGRATED`, 0 attempts | `OPERATION_NOT_MIGRATED`, 1 ms |
| `add_to_watchlist` / `remove_from_watchlist` / `update_playhead` | `OPERATION_NOT_MIGRATED`, 0 attempts | all refused, ≤1 ms |
| Node egress guard | 0 | **0 blocked attempts** |

Every expected outcome was met. `GET_PLAYHEADS` requested three ids and received
three playheads — the same request that answered HTTP 400 before the F-2
correction.

## 22. Parser Shape Audit

Field names only, no values.

| Entry | Fields observed live |
|---|---|
| recommendation | `["description","id","title","type"]` |
| watchlist item | `["date_added","id","is_favorite"]` |
| history item | `["date_played","fully_watched","id","panel","parent_id","parent_type","playhead"]` |
| playhead entry | `["content_id","fully_watched","last_modified","playhead"]` |
| similar | not observed — `count=0` for that series |

One drift worth recording: **live watchlist items carry no `panel`**, while
history items do. The published shape survives because `parseWatchlist` is a
shallow pass-through, exactly as the legacy tool was. No parser was relaxed and
no shape was invented.

## 23. Redaction / Secret Handling

No materialized ACCOUNT URL was written to any log, packet or report. No URL was
regex-masked; identity is omitted **structurally** — the drivers log an operation
id, a path template, a method, a status, a content type, a latency, a shape and
counts, and identity is never assembled into a log line at all. No `accountId`,
`account_id`, `profileId`, `profile_id`, `Authorization`, bearer, cookie, raw
body or email appears anywhere in this round's evidence. The one identifier class
that does appear is **public content ids**, which the mandate permits.

The diagnostic probes rewrote only the query string of a URL that production code
had built, so identity stayed inside that code; only `URL.search` was logged.

## 24. Candidate Commit Chain

```
52ef5a04  (base, BT6 formally closed)
  └─ 29950fd  BT7: migrate the account read operations
       └─ eaca267  BT7: record account migration verification
            └─ e895cad  BT7: apply the F-1/F-2 ruling to the account read contracts
                 └─ 36f48fc  BT7: record the F-1/F-2 design errata
                      └─ <this commit>  BT7: record the F-1/F-2 resolution evidence
```

Five commits, no merge, no rebase, no amend, no squash, no force. `29950fd` and
`eaca267` are untouched, so the first candidate and the findings that overturned
part of it both remain readable in the history. The candidate HEAD is the commit
carrying this report; its SHA is recorded in the packet and the final answer,
since a commit cannot contain its own hash. Working tree clean.

**Deviations from the suggested commit split, recorded rather than dressed up.**
The BT7 mandate suggested six commits and this round suggested three. The
migration landed as one commit plus an evidence commit, and the ruling as one
commit plus an errata commit plus this evidence commit. The RED sequences were
genuinely run first — both RED logs are in the packet — but the intermediate
states were never committed. Nothing was squashed to hide a sequence; it was
never split. F-1 and F-2 share one implementation commit because they are one
ruling touching one file in two places, and splitting them would have required
rewriting rather than recording.

## 25. Packet Provenance

The evidence packet contains the live driver and its SHA256, its stdout, stderr,
exit code, start and finish timestamps, a runtime snapshot, the candidate HEAD,
the raw regenerated logs for the full suite, the zero-egress run, typecheck and
build, both RED logs, the diagnostic probe sources and their logs, the
descriptor and operation inventories, the caller-injection matrix, the path
ownership proof, a `SHA256SUMS` over every file, and a complete `git bundle` of
the branch. All proof logs were regenerated **after** the candidate commit.

## 26. Acceptance Checklist

| Criterion | Result |
|---|---|
| Base `52ef5a04`, branch `bt7-account-reads`, no history rewritten | ✅ |
| F-1 resolved: `GET_CONTINUE_WATCHING` deferred, 0 transport attempts | ✅ |
| F-2 resolved: comma-joined `content_ids`, proven live | ✅ |
| `PRODUCTION_OPERATIONS` = 13 | ✅ |
| Public tools 21, schemas frozen | ✅ |
| `GET_SUBSCRIPTION` untouched, no re-probe | ✅ |
| BT8 mutations untouched, all refused | ✅ |
| Identity never from the caller; key and separator never from the caller | ✅ |
| G-1 bind before URL | ✅ |
| No operation special-cased inside the URL builder | ✅ |
| Move, not copy; single path ownership | ✅ |
| Focused / full / zero-egress / typecheck / build | ✅ 25+53 · 919 · 919 · 0 · 0 |
| BT6 regression | none |
| Live smoke, every expected outcome | ✅ |
| Redaction rule honoured | ✅ |
| No push | ✅ |

## 27. Risks / Observations

- **`GET_SIMILAR` has no live non-empty confirmation.** It answered `count=0`
  for the series the smoke chained. Its parser is exercised offline, but the
  live shape of a populated response has not been observed.
- **Where continue-watching went is unknown, deliberately.** No replacement
  endpoint was searched for. That is a question for a round with a mandate to
  answer it.
- **`repeatedQueryParams` has no production consumer.** Retained on purpose
  (§5); an auditor should read it as capability, not as an operation's contract.
- The error taxonomy was not extended at any point: 404 → `API_NOT_FOUND`,
  400 → `INVALID_RESPONSE`. Neither failure was ever converted into an empty
  result.
- `locale` remains fixed at `en-US`, as in the legacy client. BT7 invented no
  way for a caller to choose one.
- BT4-N2, N3, N4 remain open and non-blocking.

## 28. Final Disposition

**F-1 RESOLVED — `GET_CONTINUE_WATCHING` DEFERRED.**
**F-2 RESOLVED — `GET_PLAYHEADS` provider contract corrected to comma-joined `content_ids`.**

```
PRODUCTION_OPERATIONS: 13
Public tools:          21
GET_SUBSCRIPTION:      DEFERRED
BT8:                   NOT STARTED
```

**BT7 IMPLEMENTATION CANDIDATE — PASS.**

Every gate passes, including live. Five account read operations are migrated and
work against the real provider; two are deferred, each on its own evidence, each
answering an honest refusal rather than a promise the provider will not keep.

BT7 is **not** declared formally closed. Independent review is required. No push,
no merge, no `main` change, no BT8.
