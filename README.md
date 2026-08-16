# Crunchyroll MCP Server

Crunchyroll anime streaming MCP connector for personal AI agents. Lets AI assistants manage your Crunchyroll account — search anime, track progress, manage watchlists, get recommendations, and more.

This version is packaged for use with [Hermes Agent](https://github.com/nousresearch/hermes-agent), including a catalog manifest (`manifest.yaml`) following the [hermes-agent optional-mcps](https://github.com/NousResearch/hermes-agent/tree/main/optional-mcps) format.

## Features

- **Search** anime series and movies
- **Browse** by genre, popularity, new additions, or simulcast season
- **Show details** — series info, seasons, episodes
- **Watchlist** management — add, remove, view
- **Watch history & progress** — track and update playhead positions
- **Continue watching** — pick up where you left off
- **Recommendations** — personalized and similar-to suggestions
- **Simulcast schedule** — current and past seasonal tags
- **Subscription** info — tier, renewal date, status

## Usage with Hermes Agent

### Option A — Catalog entry (recommended)

Place `manifest.yaml` into the `optional-mcps/crunchyroll/` directory of your hermes-agent checkout, then:

```bash
hermes mcp install crunchyroll
```

The manifest handles cloning, dependency installation, and the launch command. After installation, sign in once — see [Authentication](#authentication). You will type your credentials into Crunchyroll's own page in a browser; the agent never asks for them and never receives them.

### Option B — Manual stdio config

Add to your `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  crunchyroll:
    command: "npx"
    args: ["-y", "tsx", "${userHome}/path/to/mcp-crunchyroll/src/index.ts"]
```

Or build first and point at the compiled output:

```bash
npm install
npm run build
```

```yaml
mcp_servers:
  crunchyroll:
    command: "node"
    args: ["${userHome}/path/to/mcp-crunchyroll/dist/index.js"]
```

Restart Hermes (or run `/reload-mcp`) and sign in as described in [Authentication](#authentication).

## Usage with other MCP hosts

For Claude Desktop or any stdio-capable MCP client:

```bash
npm install -g @striderlabs/mcp-crunchyroll
```

```json
{
  "mcpServers": {
    "crunchyroll": {
      "command": "npx",
      "args": ["-y", "@striderlabs/mcp-crunchyroll"]
    }
  }
}
```

## Authentication

**This server never accepts your Crunchyroll email or password.** The login tool
takes no arguments at all:

```
crunchyroll_login({})
```

It opens a dedicated, managed browser on Crunchyroll's own login page. You type
your credentials there, in Crunchyroll's UI, exactly as you would normally. The
agent does not ask for them, does not see them, and cannot pass them on.

If the agent ever asks you for your Crunchyroll password, something is wrong —
no supported flow needs it.

### What "logged in" means here

Readiness is granted **only** when the server observes a real authentication
response from Crunchyroll and validates it. A browser page that merely *looks*
signed in grants nothing. `crunchyroll_status` reports what is actually true:

| Field | Meaning |
|---|---|
| `authenticated` / `logged_in` | authenticated work is permitted right now |
| `auth_state` | `LOGIN_REQUIRED`, `AUTHENTICATING`, `ACCOUNT_READY`, `PROFILE_READY`, `REAUTH_REQUIRED`, `LOGGING_OUT` or `DEGRADED` |
| `browser_running` / `browser_connected` | the managed browser's lifecycle |
| `profile_ready` | the session is scoped to a Crunchyroll profile |
| `player_ready` | always `false` for now — playback is a later stage |

Nothing you type is stored by this server: the credential goes to Crunchyroll,
and the bearer the server observes is held in memory only, never written to
disk. What persists is the browser's own session, inside the dedicated profile
at `~/.strider/crunchyroll/browser-profile` (created `0700`, used by nothing
else). That is why you usually do not need to sign in again after a restart.

Human verification (CAPTCHA or similar) is always solved by you, in the
browser. It is never automated, worked around, or answered on your behalf.

### Supported Human Onboarding (first use, or after the session expires)

Sometimes Crunchyroll's human verification will not complete inside the managed
window. When that happens the login attempt ends honestly at `LOGIN_REQUIRED` —
nothing is faked and nothing is bypassed. The supported fallback is to
establish the browser session yourself, **in the same dedicated profile**:

1. Make sure the managed browser is not running.
2. Open that profile directly, with no automation:

   ```bash
   /usr/bin/brave \
     --user-data-dir="$HOME/.strider/crunchyroll/browser-profile" \
     --no-first-run \
     --no-default-browser-check \
     --disable-background-networking \
     --disable-background-mode \
     https://www.crunchyroll.com/login
   ```

   Use the same browser binary the server uses (Chromium, Chrome or Brave —
   whichever it finds first, or `CRUNCHYROLL_BROWSER_EXECUTABLE` if you set
   it). Do **not** add a remote-debugging port: this window is not automated.
3. Solve the verification and sign in normally.
4. **Decline any offer to import or sync data from your normal browser.** This
   profile is deliberately separate; nothing is ever copied into it.
5. Close the window normally.

Then use `crunchyroll_login({})` as usual. The server reuses that same profile,
observes a real authentication response, and only then reports ready. Your
personal browser profile is never opened, read, or copied, and no cookie or
stored credential is ever extracted, injected, or exported.

### Signing out

`crunchyroll_logout` invalidates the server's authenticated session
immediately, and clears what it stored. It does **not** yet clear the browser's
own session inside the dedicated profile — a later stage owns that. Until then,
sign out of Crunchyroll in the browser too if that matters to you. Note that a
leftover browser session never re-authenticates the server on its own: only an
explicit `crunchyroll_login({})` that observes a fresh authentication response
can do that.

## Tools

### Authentication

| Tool | Description |
|------|-------------|
| `crunchyroll_login` | Start interactive sign-in in the managed browser — **takes no arguments** |
| `crunchyroll_logout` | Invalidate the current session and clear what the server stored |
| `crunchyroll_status` | Report readiness: `authenticated`, `auth_state`, browser lifecycle, `profile_ready` |

### Search & Browse

| Tool | Description |
|------|-------------|
| `crunchyroll_search` | Search anime series and movies |
| `crunchyroll_browse` | Browse by popularity, genre, season, sub/dub |
| `crunchyroll_get_categories` | List all genres/categories |
| `crunchyroll_get_simulcast_seasons` | List simulcast season tags |

### Show Details

| Tool | Description |
|------|-------------|
| `crunchyroll_get_series` | Get series info by ID |
| `crunchyroll_get_seasons` | Get seasons for a series |
| `crunchyroll_get_episodes` | Get episodes in a season |
| `crunchyroll_get_episode` | Get single episode details |

### Watchlist

| Tool | Description |
|------|-------------|
| `crunchyroll_get_watchlist` | View saved watchlist |
| `crunchyroll_add_to_watchlist` | Add series/movie to watchlist |
| `crunchyroll_remove_from_watchlist` | Remove from watchlist |

### Watch History & Progress

| Tool | Description |
|------|-------------|
| `crunchyroll_get_history` | Recently watched episodes |
| `crunchyroll_continue_watching` | In-progress anime |
| `crunchyroll_get_playheads` | Progress for specific content IDs |
| `crunchyroll_update_playhead` | Update watch position (seconds) |

### Recommendations

| Tool | Description |
|------|-------------|
| `crunchyroll_get_recommendations` | Personalized recommendations |
| `crunchyroll_get_similar` | Anime similar to a given series |

### Account

| Tool | Description |
|------|-------------|
| `crunchyroll_get_subscription` | Subscription tier and renewal info |

## Example Prompts

- *"What anime should I watch next based on my history?"*
- *"Add Attack on Titan to my watchlist"*
- *"What's airing this season? Sort by popularity"*
- *"Where did I leave off watching One Piece?"*
- *"Show me all the action anime added this week"*
- *"When does my Crunchyroll subscription renew?"*

## Notes

- Uses the Crunchyroll web API (same endpoints as the website)
- Sign-in is interactive and browser-based; this server never accepts an email
  or a password, and the bearer it observes is never written to disk
- The dedicated browser profile at `~/.strider/crunchyroll/browser-profile`
  (`0700`) holds the browser's own session and is used by nothing else
- Content IDs can be found in search results or Crunchyroll URLs
- API endpoints are subject to change by Crunchyroll

## Development

```bash
npm install
npm run dev      # run from TypeScript source via tsx
npm run build    # bundle to dist/index.js with esbuild
```

## Credits & License

Based on the open-source `@striderlabs/mcp-crunchyroll` package by StrikerLabs ([github.com/markswendsen-code/mcp-crunchyroll](https://github.com/markswendsen-code/mcp-crunchyroll)), distributed under the MIT License.
