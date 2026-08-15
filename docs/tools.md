# MCP Tools Reference

MCP Crunchyroll exposes **21 tools** across five categories. All tools are invoked over the MCP stdio transport by an MCP client (an LLM agent or any stdio-capable host). Tool names, order, and input schemas are enforced by the CI harness and verified byte-for-byte against the registered baseline (`test/fixtures/baseline-tools.json`).

## Authentication

| Tool | Description | Input | Status |
|------|-------------|-------|--------|
| `crunchyroll_login` | Log in with email + password | `email`, `password` | Live auth under compatibility investigation |
| `crunchyroll_logout` | Clear saved session locally | none | Structured result (B5, in progress) |
| `crunchyroll_status` | Check login status and account info | none | Validated |

- `crunchyroll_login` is the only tool that accepts a password; its argument is redacted at the MCP boundary (operation-scoped secret registry).
- `crunchyroll_logout` (candidate, in progress) is being extended to return a structured result with per-artifact states (`CLEARED`, `ALREADY_ABSENT`, `PARTIAL`, `FAILED`) — see the [Security Model](security.md).

## Discovery

| Tool | Description |
|------|-------------|
| `crunchyroll_search` | Search anime series and movies by query |
| `crunchyroll_browse` | Browse by popularity, genre, season, sub/dub |
| `crunchyroll_get_categories` | List all genres/categories |
| `crunchyroll_get_simulcast_seasons` | List simulcast season tags |
| `crunchyroll_get_recommendations` | Personalized recommendations |
| `crunchyroll_get_similar` | Anime similar to a given series |

Catalog tools operate on the Crunchyroll web interface endpoints and are read-only from the agent's perspective.

## Series & Episodes

| Tool | Description |
|------|-------------|
| `crunchyroll_get_series` | Get series info by ID |
| `crunchyroll_get_seasons` | Get seasons for a series |
| `crunchyroll_get_episodes` | Get episodes in a season |
| `crunchyroll_get_episode` | Get single episode details |

Content IDs returned by search, browse, or series tools can be used as inputs for the detail tools. Note: whether a content API ID maps directly to the route identifiers used in the Crunchyroll web player is still under validation.

## Account

| Tool | Description |
|------|-------------|
| `crunchyroll_get_watchlist` | View saved watchlist |
| `crunchyroll_add_to_watchlist` | Add a series/movie to the watchlist |
| `crunchyroll_remove_from_watchlist` | Remove from watchlist |
| `crunchyroll_get_history` | Recently watched episodes |
| `crunchyroll_continue_watching` | In-progress anime |
| `crunchyroll_get_subscription` | Subscription tier and renewal info |

Account tools require a locally saved session (login via `crunchyroll_login`). Account results are redacted at the MCP boundary when they contain known-sensitive fields.

## Playback State

| Tool | Description |
|------|-------------|
| `crunchyroll_get_playheads` | Progress positions for specific content IDs |
| `crunchyroll_update_playhead` | Update watch position (seconds) |

Playback state tracks where you left off. It does **not** control a browser or player; orchestration of the official player is a planned (experimental) integration, not part of the current runtime.

## Status Labels

- **Validated** — implemented and covered by the repository's CI harness (unit + MCP stdio tests).
- **In progress** — implementation exists on a development branch and is not yet consolidated.
- **Under compatibility investigation** — live Crunchyroll compatibility is being revalidated due to changes in the web SSO flow.
