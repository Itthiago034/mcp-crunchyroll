# MCP Crunchyroll — BT6 Catalog Migration Plan (frozen)

Base `8da746e` (BT5 formally closed). Source C §28 assigns BT6 the remaining
catalog reads, paths **moved** out of `api.ts` into the registry, no duplicate
path literals.

## 1. Inventory, decided from the real code

Every row below was read out of `src/api.ts` at this base, not assumed.

| Tool | Operation | Method | Path today | Query today | BT6 |
|---|---|---|---|---|---|
| `crunchyroll_search` | `SEARCH` | GET | `/content/v2/discover/search` | `q`, `n`, `locale`, `type?` | **yes** |
| `crunchyroll_get_series` | `GET_SERIES` | GET | `/content/v2/cms/series/{id}` | `locale` | **yes** |
| `crunchyroll_get_seasons` | `GET_SEASONS` | GET | `/content/v2/cms/series/{id}/seasons` | `locale`, `series_id` | **yes** |
| `crunchyroll_get_episodes` | `GET_EPISODES` | GET | `/content/v2/cms/seasons/{id}/episodes` | `locale` | **yes** |
| `crunchyroll_get_episode` | `GET_EPISODE` | GET | `/content/v2/cms/episodes/{id}` | `locale` | **yes** |
| `crunchyroll_get_simulcast_seasons` | `GET_SIMULCAST_SEASONS` | GET | `/content/v2/discover/seasonal_tags` | `locale` | **yes** |
| `crunchyroll_browse` | `BROWSE` | GET | `/content/v2/discover/browse` | `n`, `start`, `locale`, `sort_by?`, `categories?`, `seasonal_tag?`, `is_subbed?`, `is_dubbed?` | **yes** |
| `crunchyroll_get_similar` | `GET_SIMILAR` | GET | `/content/v2/discover/{account_id}/similar_to/{seriesId}` | `n`, `locale` | **NO — BT7** |
| `crunchyroll_get_recommendations` | `GET_RECOMMENDATIONS` | GET | `/content/v2/discover/{account_id}/recommendations` | `n`, `locale` | **NO — BT7** |

**GET_SIMILAR is decided, not deferred for lack of evidence.** Its path
interpolates `account_id` taken from `getValidToken()`. That is an
identity-derived path parameter, so under the BT5-FIX2 invariant it is
`scope: ACCOUNT` with `authDerivedParams: { accountId }` — BT7, and it stays
`OPERATION_NOT_MIGRATED` here. `GET_RECOMMENDATIONS` is the same shape.

All seven migrated operations are `scope: PUBLIC`, `auth: BEARER`,
`authDerivedParams: {}`, `mutation: false`.

## 2. Descriptors need two closed additions

BT5's single descriptor had a fixed path and no caller params. The catalog
reads need path segments and query strings, so the descriptor gains exactly
two closed maps — no template DSL, no caller-controlled fragment:

- `fixedQuery: Record<string, string>` — constants of this build (`locale`);
- `queryParams: Record<wireKey, declaredCallerParamName>` — which declared
  caller param fills which query key.

Path placeholders `{name}` are resolved from declared caller params (or
auth-derived params, unchanged). The registry validates that every placeholder
and every query mapping names a declared param, and that fixed and mapped query
keys do not collide. `GET_SEASONS` legitimately sends `series_id` in both the
path and the query; that is expressed explicitly, not by a rule.

Every caller param keeps a closed validator: IDs match `^[A-Za-z0-9_-]+$`
(the legacy code interpolated them raw), enums stay enums, integers stay
bounded. The URL is built from the descriptor alone and re-validated against
the frozen origin, exactly as at BT5.

## 3. Domain parsing moves to a transport-free module

`src/catalog-domain.ts` (new) holds the payload interpretation: the
LIVE-COMPAT-01 normalizer **moved** there — one normalizer, not a copy —
plus one parser per operation producing today's exact public shapes.

It imports nothing: no fetch, no `api.ts`, no transport. `api.ts` imports the
normalizer back from it, so the legacy account paths keep using the same code.
The gateway imports the parsers, which keeps the BT5 assertion that the gateway
never reaches `api.ts` true.

The browser backend still ends at `TransportResult`. It parses nothing.

## 4. Ownership move, per operation

For each migrated operation the path and query literals LEAVE `src/api.ts` in
the same commit the descriptor enters the registry. What stays in the domain
layer: operation choice, domain defaults (`n=20`, `start=0`), normalization,
parsing, domain types and domain error meaning.

## 5. Public contract

21 tool names, input schemas byte-identical, `MethodNotFound` unchanged, and
each migrated tool keeps its exact current output shape — `{count, results}`,
`{count, seasons}`, `{count, episodes}`, `{count, items}`, the series object,
the episode object.

## 6. Live smoke

Chained on IDs obtained during the smoke itself: search → series → seasons →
episodes → episode, plus simulcast seasons and browse. Read-only, no mutation,
no `/watch` route construction (BT9 owns that). Safe metadata only.

A parser shape audit runs alongside it to answer one open design question:
do `series`, `seasons`, `episodes` and `episode` show the same
`_meta` vs `_metadata` drift BT0 fixed for discover payloads? The answer is
recorded as observed — `NO DRIFT OBSERVED` or a reproduced drift with a
sanitized fixture and its own RED — and nothing is "fixed" preventively.

## 7. Out of scope

No account reads, no mutations, no player, no BT9 route builder, no
episode-id ↔ watch-route-id work, no login/logout/status change, no CDP
addition, no schema change, no BT7.
