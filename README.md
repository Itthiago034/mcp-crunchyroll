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

The manifest handles cloning, dependency installation, and the launch command. After installation, log in once through the `crunchyroll_login` tool (ask Hermes to do it — it will request your email and password, and tokens are saved locally).

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

Restart Hermes (or run `/reload-mcp`) and log in through `crunchyroll_login`.

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

Log in once with your Crunchyroll credentials via the `crunchyroll_login` tool:

```
crunchyroll_login(email: "you@example.com", password: "your-password")
```

Tokens are saved to `~/.strider/crunchyroll/` and automatically refreshed. You only need to log in again if tokens expire or after calling `crunchyroll_logout`.

## Tools

### Authentication

| Tool | Description |
|------|-------------|
| `crunchyroll_login` | Log in with email + password |
| `crunchyroll_logout` | Clear saved session |
| `crunchyroll_status` | Check login status and account info |

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
- Tokens are stored locally in `~/.strider/crunchyroll/` and auto-refreshed
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
