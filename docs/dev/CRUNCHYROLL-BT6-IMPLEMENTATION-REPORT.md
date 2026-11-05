# MCP Crunchyroll — BT6 Implementation Report

Candidate for external review. Base `8da746e` (BT5 formally closed). It records
what was migrated, what deliberately was not, and what the live run showed. It
authorizes nothing and starts no BT7 work.

## 1. Result

| Property | Value |
|---|---|
| Branch | `bt4-auth-producer` (no rebase, amend or merge) |
| Base | `8da746e05bde7a1cdba13e2e63b51146d68dd8e5` |
| Plan | `CRUNCHYROLL-BT6-CATALOG-PLAN.md` |
| Operations migrated | 7 (plus BT5's `GET_CATEGORIES`) |
| Public schemas | unchanged; 21 tools |
| Full suite | 852 pass / 0 fail / 0 skipped |
| Zero-egress suite | 852 pass / 0 fail |
| Live catalog smoke | PASS, every operation |
| Parser drift | **NO DRIFT OBSERVED** |
| Blocking questions | 0 |

## 2. Migrated, and not

**Migrated (all `PUBLIC` + `BEARER`, no identity, `mutation: false`):**
`SEARCH`, `GET_SERIES`, `GET_SEASONS`, `GET_EPISODES`, `GET_EPISODE`,
`GET_SIMULCAST_SEASONS`, `BROWSE`.

**Not migrated, and why:** `GET_SIMILAR` and `GET_RECOMMENDATIONS` interpolate
`account_id` (from `getValidToken()`) into their paths, so they resolve
identity and are `scope: ACCOUNT` under the BT5-FIX2 invariant — BT7. Watchlist,
history, continue-watching, playheads and subscription are account reads (BT7);
the three watchlist/playhead writes are mutations (BT8). Every one of them
still answers `OPERATION_NOT_MIGRATED`, locally, with zero transport calls.

The mandate asked for `GET_SIMILAR` to be decided from the code rather than
from documentation. It was: the path literal is
`/content/v2/discover/${account_id}/similar_to/${seriesId}`. No ambiguity
remained, so there was nothing to stop for.

## 3. Descriptors gained two closed fields

BT5's single descriptor had a fixed path and no caller params. Catalog reads
need path segments and query strings, so the descriptor now carries:

- `fixedQuery` — constants of this build (`locale=en-US`), which a caller can
  neither add to nor override;
- `queryParams` — wire key → declared caller param.

Explicit rather than inferred: `GET_SEASONS` legitimately sends `series_id` in
**both** the path and the query, and any rule clever enough to guess would have
silently dropped or duplicated it. The registry now also refuses a query string
inside a path template, an undeclared placeholder, a mapping to an undeclared
param, and a key that is both fixed and caller-filled.

Path values are validated as ids (`^[A-Za-z0-9_-]{1,64}$`) before being encoded.
The legacy client interpolated them raw, so this is the one place BT6 is
stricter than what it replaced rather than merely equivalent.

## 4. The move was a move

Every migrated path literal left `src/api.ts` in the same commit its descriptor
entered the registry — proved by a test that fails if any literal lives in two
places. The four types that existed only to serve those functions
(`DiscoverItem`, `SearchResult`, `BrowseOptions`, `BrowseItem`) went with them.

The LIVE-COMPAT-01 normalizer **moved** to `src/catalog-domain.ts`, a module
that imports nothing. There is still exactly one normalizer; the LIVE-COMPAT-01
regressions now drive it directly with the same fixtures and the same
assertions, which is also what the production path does — the transport hands
the parser exactly that JSON.

The browser backend still ends at `TransportResult`. It parses nothing.

## 5. RED, exactly as observed

| # | RED | Cause |
|---|---|---|
| 1 | `test/bt6-catalog.test.ts` failed to load | `buildRequestUrl` did not exist |
| 2 | routing, ownership and normalizer-location assertions | the migration had not happened |
| 3 | 6 stage assertions across 4 files | they encoded "only `GET_CATEGORIES` is migrated", or used a now-migrated tool as the unmigrated representative |
| 4 | `no transport module imports a CONTENT function from the legacy api module` | **my own** BT5 assertion scanned for bare identifiers, and the registry now legitimately owns a path containing `browse`. Rewritten to check imports, which is what it always meant |
| 5 | `Cannot convert undefined or null to object` across four suites | synthetic descriptors predate the two new fields |

Born-green, recorded as such: the caller-supplied-identity refusals and the
undeclared-key refusals passed on arrival — `resolveCall`'s allow-list has done
that since BT1, and BT6 only had to prove it still holds for seven new
descriptors.

For RED 5 the fix was to normalize absent maps to empty at registry
construction rather than patch dozens of literals: an operation with no query
genuinely has none, and the frozen copy still keeps registry policy immune to
later mutation.

## 6. Verification

| Check | Result |
|---|---|
| Focused (12 suites) | all green — registry 42, dispatcher 15, BT6 46, BT5 cutover 26, backend 17, auth-context 174, LIVE-COMPAT 6, redaction 47, harness 27, producer 87, orchestrator 44, session manager 65 |
| Full suite | **852 pass, 0 fail, 0 skipped** |
| Zero-egress (`bwrap --unshare-net`, `BT2_NET_ISOLATED=1`) | **852 pass, 0 fail**; TCP and a real `fetch` both `ENETUNREACH` |
| Typecheck / build | exit 0 / exit 0 |
| Public contract | 21 tools; fixture and package files unchanged since `c229b31` |
| Duplicate path literals | 0 — each lives only in the registry |
| Node Crunchyroll attempts | 0 |
| Account/mutation boundary | all 10 representatives `OPERATION_NOT_MIGRATED`, zero transport calls |

## 7. Live catalog smoke — PASS

Real session, dedicated profile, IDs chained from the smoke itself. Safe
metadata only: no bearer, cookie, account or profile id, no raw body.

| Step | Result |
|---|---|
| login | `PROFILE_READY`, 5 s |
| `crunchyroll_search { query: "BLACK TORCH" }` | **40 results**, first `GT00377907` "BLACK TORCH", 1088 ms |
| `crunchyroll_get_series` | real series object, 1488 ms |
| `crunchyroll_get_seasons` | **1** season, `GS00377908ENUS`, 533 ms |
| `crunchyroll_get_episodes` | **7** episodes, first `GE00377909ENUS`, 522 ms |
| `crunchyroll_get_episode` | real episode object, 356 ms |
| `crunchyroll_get_simulcast_seasons` | **71** tags, first `summer-2026`, 236 ms |
| `crunchyroll_browse { sort_by: popularity, n: 5 }` | **5** items, first "Frieren: Beyond Journey's End", `series_launch_year` 2023, 299 ms |
| `crunchyroll_get_similar` | `OPERATION_NOT_MIGRATED`, 6 ms |
| `crunchyroll_get_watchlist` | `OPERATION_NOT_MIGRATED`, 1 ms |
| Node Crunchyroll guard | **0 blocked attempts** |

No mutation was attempted, and no `/watch` route was constructed — BT9 owns
that question and BT6 did not touch it.

`series_launch_year: 2023` on the browse item is incidental live proof that the
LIVE-COMPAT-01 normalizer consumed the live `series_metadata` shape.

### An environment condition worth recording

The first smoke attempt failed in 218 ms with `LOGIN_REQUIRED`. The cause was
not BT6: an earlier smoke's managed browser had **self-restarted** (Brave's own
`--restart`), which changed its pid and command line, so BT2 rejected adoption
and cleared the ownership record — leaving an unowned process still holding the
dedicated profile, and Chromium refuses a second instance on one `user-data-dir`.
The fail-closed behaviour was correct and honest. The orphan was verified as
BT2-launched (our `--remote-debugging-port=0` and our `--user-data-dir`, not the
personal profile), terminated with `SIGTERM` only, and the smoke then passed.

## 8. Parser shape audit — the open design question, answered

`series`, `seasons`, `episodes` and `episode` return **flat objects**: every
field sits directly on the object and none carries a `_meta` or `_metadata`
wrapper in either spelling.

**NO DRIFT OBSERVED.** The drift LIVE-COMPAT-01 addresses is specific to the
discover payloads (search groups, browse items), where the normalizer already
handles both spellings and did so in this very run. No parser was changed and
no fixture was added as a result of the audit, because there was nothing to
reproduce. Field names are recorded in `live-parser-shape-audit.txt`.

## 9. Known limitations

- **Account reads and mutations are still refused.** Eight of the eighteen
  content tools work; ten do not, until BT7/BT8.
- The browser remains availability: no browser or no session means a typed
  failure, with no fallback.
- `locale` is fixed at `en-US`, as the legacy client had it. A caller still
  cannot choose one, and BT6 did not invent a way.
- BT4-N2, N3, N4 remain open and non-blocking.
- The real-browser BT2 integration suite remains occasionally flaky under
  parallel load (recorded at BT5-FIX1); it did not recur here.

## 10. Not done, deliberately

No account read, no mutation, no player, no BT9 route builder, no episode-id ↔
watch-route-id work, no login/logout/status change, no CDP addition, no
`Runtime.evaluate`, no new dependency, no schema change, no push, no merge, no
`main` change, no BT7.

BT6 is **not** declared closed here.
