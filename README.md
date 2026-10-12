<p align="center">
  <img
    src="docs/assets/mcp-crunchyroll-banner.png"
    alt="MCP Crunchyroll"
    width="100%"
  >
</p>

# MCP Crunchyroll

An unofficial [Model Context Protocol](https://modelcontextprotocol.io/) server for Crunchyroll, written in TypeScript. It gives MCP clients a closed tool surface for catalog discovery, account reads, and account mutations through browser-mediated authentication and provider access.

[![CI](https://github.com/Itthiago034/mcp-crunchyroll/actions/workflows/ci.yml/badge.svg)](https://github.com/Itthiago034/mcp-crunchyroll/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-18%20%7C%2020%20%7C%2022-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6)
![License](https://img.shields.io/badge/license-MIT-blue)
![Unofficial](https://img.shields.io/badge/unofficial-community%20project-f47521)

## Release status

v0.1.0 exposes 22 public tools. Twenty are operational: three local authentication/status tools, sixteen production API operations and one playback tool. Two published tools remain deliberately deferred and fail closed.

| Surface | Count | Status |
|---|---:|---|
| Public MCP tools | 22 | Published |
| Authentication and status tools | 3 | Operational |
| Production API operations | 16 | Operational |
| Playback | 1 | Operational |
| Deferred tools | 2 | `OPERATION_NOT_MIGRATED` |

The production operations cover catalog reads, account reads, adding and removing watchlist items, and updating playheads. CI validates the project on Node.js 18, 20, and 22 with sandboxed Chrome for Testing.

## How it works

```text
MCP client
    |
    | stdio tool call
    v
MCP Crunchyroll
    |
    | closed operation descriptor + auth-derived account identity
    v
Managed browser / CDP
    |
    | provider request in the authenticated browser context
    v
Crunchyroll web services
```

Interactive credentials are entered only in the managed browser. Usernames, passwords, cookies, and bearer tokens are not tool arguments. Migrated provider operations use the browser-mediated transport; callers cannot choose an account ID or override the HTTP method, path, headers, query, or raw request body.

This project is not affiliated with or endorsed by Crunchyroll, LLC.

## Requirements

- Node.js 18 or newer
- npm
- A supported Chromium-family browser for interactive authentication, unless `CRUNCHYROLL_BROWSER_EXECUTABLE` points to one explicitly

## Install and build

```bash
git clone https://github.com/Itthiago034/mcp-crunchyroll.git
cd mcp-crunchyroll
npm ci
npm run typecheck
npm run build
```

The production bundle is written to `dist/index.js`.

## Run

Run the built stdio server:

```bash
npm start
```

For development directly from TypeScript:

```bash
npm run dev
```

A generic MCP client configuration for the built bundle looks like this:

```json
{
  "mcpServers": {
    "crunchyroll": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-crunchyroll/dist/index.js"]
    }
  }
}
```

The repository also includes `manifest.yaml` for compatible Hermes Agent installations.

### Hermes Agent

After building, register the bundle with Hermes:

```bash
hermes mcp add crunchyroll --command node --args /absolute/path/to/mcp-crunchyroll/dist/index.js
hermes mcp test crunchyroll
```

Hermes exposes the tools as `mcp__crunchyroll__crunchyroll_*` and starts stdio servers with a filtered environment that keeps `HOME`, `PATH` and `XDG_*` but drops `DISPLAY`, `WAYLAND_DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`. On Linux, when no display variable reaches the server, it recovers the user's own desktop session from sockets owned by the current user (`$XDG_RUNTIME_DIR/wayland-N`, `$XDG_RUNTIME_DIR/bus`, `/tmp/.X11-unix/XN`), so `crunchyroll_login` can open its window without extra `env` entries. It also restores the desktop identity (`KDE_SESSION_VERSION`, `DESKTOP_SESSION`, `XDG_CURRENT_DESKTOP`, ...) from `systemctl --user show-environment`: without it Chromium picks a different password store than the manual sign-in did (for example `basic` instead of KWallet 6), cannot decrypt the profile's cookies and is challenged again. Variables the client does pass are never replaced.

## Authentication

Call:

```text
crunchyroll_login({})
```

The login tool takes no arguments. It opens Crunchyroll in a dedicated managed browser, where the user completes sign-in and any human verification directly. The MCP server grants readiness only after observing and validating authentication material from that browser flow.

Useful local tools:

| Tool | Purpose | Status |
|---|---|---|
| `crunchyroll_login` | Start interactive browser sign-in | Operational |
| `crunchyroll_logout` | Invalidate the local authenticated context and clear managed artifacts | Operational |
| `crunchyroll_status` | Report auth and browser readiness | Operational |

The managed browser profile is stored under `~/.strider/crunchyroll/browser-profile`. Do not point the server at a personal browser profile.

The live validator (`npm run validate:live -- --login`) first opens the selected
browser directly for manual sign-in in the same dedicated profile, without CDP.
Complete verification and sign-in in Crunchyroll's own UI, decline browser-data
import, and close that window normally. The validator then opens the managed
browser and confirms MCP authentication before issuing its 12 reads. Close any
earlier windows of that dedicated profile before starting. You can also run
`npm run onboard:browser` separately to check the manual stage. Only an observed
and validated authentication response grants MCP readiness; this flow does not
guarantee that the provider will accept the session. See the
[recorded onboarding procedure](CRUNCHYROLL-BT4-N5-ONBOARDING-ERRATA.md).

### Session expiry

The bearer observed from the browser carries no refresh token and expires within minutes. `crunchyroll_status` reports an expired bearer as not authenticated, and `crunchyroll_login` then re-establishes it by reloading the signed-in managed page, which makes Crunchyroll mint a fresh bearer under observation. A content call that finds the session expired does this once on its own (waiting up to 45 s) and retries; the failure happens before anything is dispatched, so nothing is sent twice. A fresh server process still starts unauthenticated: call `crunchyroll_login` once, which takes seconds while the browser profile is signed in. Season and episode lists are compacted to the fields needed to choose and play (ids, numbers, titles, locales, availability and `versions` as `{audio_locale, guid, original}`); `crunchyroll_get_series` and `crunchyroll_get_episode` return the full record without image sets. `crunchyroll_get_episodes` accepts an optional `episode_number` to return a single episode, `crunchyroll_get_history` keeps resume data instead of the full panel, and `crunchyroll_get_watchlist` honours `n` and adds each item's `title` and `type` with one extra batched read. Login waits at most 240 s, below the 300 s tool timeout of clients such as Hermes.

## Tool surface

### Catalog and discovery

| Tool | Purpose |
|---|---|
| `crunchyroll_search` | Search titles |
| `crunchyroll_browse` | Browse by supported sort, category, season, and availability filters |
| `crunchyroll_get_categories` | List browse categories |
| `crunchyroll_get_simulcast_seasons` | List simulcast season tags |
| `crunchyroll_get_series` | Read series details |
| `crunchyroll_get_seasons` | Read seasons for a series |
| `crunchyroll_get_episodes` | Read episodes for a season |
| `crunchyroll_get_episode` | Read one episode |
| `crunchyroll_get_recommendations` | Read personalized recommendations |
| `crunchyroll_get_similar` | Read titles similar to a series |

### Account reads

| Tool | Purpose |
|---|---|
| `crunchyroll_get_watchlist` | Read the authenticated account's watchlist |
| `crunchyroll_get_history` | Read watch history |
| `crunchyroll_get_playheads` | Read playheads for selected content IDs |

### Account mutations

| Tool | Purpose | Provider success |
|---|---|---|
| `crunchyroll_add_to_watchlist` | Add a content ID to the authenticated account's watchlist | `204 No Content` |
| `crunchyroll_remove_from_watchlist` | Remove a content ID from the authenticated account's watchlist | `204 No Content` |
| `crunchyroll_update_playhead` | Submit a playhead for a content ID | `204 No Content` |

Mutation identity is derived from the authenticated browser context. The caller supplies only the functional inputs in each closed tool schema and cannot select `accountId`.

A provider response such as bad request, conflict, or operation-specific not found is reported deterministically. If a write may have been dispatched but its result cannot be known—for example, because the browser disconnects after possible dispatch—the operation returns `MUTATION_OUTCOME_UNKNOWN`. The server does not blindly retry mutations. Callers can reconcile playhead state with `crunchyroll_get_playheads` when appropriate.

### Playback

| Tool | Purpose |
|---|---|
| `crunchyroll_play` | Open an episode's watch page (`https://www.crunchyroll.com/watch/<episode_id>`) in a focused tab of the signed-in managed browser, reusing the playback tab if one is open |

`episode_id` must be a plain uppercase Crunchyroll id from `crunchyroll_get_episodes`; nothing else reaches the URL. Playback uses the browser's own signed-in session and makes no provider API request from the server.

### Deferred tools

These names remain visible for compatibility, but v0.1.0 intentionally refuses them with `OPERATION_NOT_MIGRATED`:

| Tool | v0.1.0 status |
|---|---|
| `crunchyroll_continue_watching` | Deferred / fail-closed |
| `crunchyroll_get_subscription` | Deferred / fail-closed |

They are not counted among the 19 operational tools.

## Security boundaries

- Interactive secrets are entered in the managed browser, not passed as MCP tool arguments.
- Provider access for migrated operations is mediated by the managed browser/CDP boundary.
- Authorization and content type are controlled internally.
- Account mutation identity is auth-derived.
- Unknown or forbidden caller arguments are rejected instead of silently discarded.
- Mutation outcomes that become uncertain after possible dispatch fail closed as `MUTATION_OUTCOME_UNKNOWN`.
- No automatic retry is performed for uncertain mutations.
- Browser transport uses `credentials: "omit"` and manual redirect handling.
- CI provisions pinned Chrome for Testing with its sandbox enabled; `--no-sandbox` is not used.

These controls describe the implemented boundaries; they are not a claim of absolute containment against every host or browser threat.

## Development and tests

```bash
npm ci
npm run typecheck
npm run build
npm test
```

The test command runs the unit suites and MCP stdio harness. GitHub Actions repeats install, typecheck, build, and tests independently on Node.js 18, 20, and 22, including the sandboxed browser lifecycle checks.

The [architecture, security, and network review](docs/architecture-review.md) records transport resource limits, regression evidence, dependency audit results, and measurements still needed against the real provider.

Run `npm run test:browser` for concurrent HTTP validation in real Chromium. The
[browser validation report](docs/browser-validation.md) includes measured load
results and the optional anonymous/live MCP commands; `npm run validate:live -- --login`
requires interactive sign-in in a visible managed browser.

## Known limitations

- `crunchyroll_continue_watching` is deferred and fails closed.
- `crunchyroll_get_subscription` is deferred and fails closed.
- Crunchyroll's internal web interfaces are not a stable public API and may change.
- The project does not provide playback, media downloading, or DRM bypass.
- Authentication can require user interaction in the managed browser.

## Credits and license

Based on the open-source `@striderlabs/mcp-crunchyroll` project by StrikerLabs. Distributed under the MIT License.

## Disclaimer

**Unofficial community project. Not affiliated with or endorsed by Crunchyroll, LLC.** “Crunchyroll” and related names and marks belong to their respective owners.
