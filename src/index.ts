import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import {
  login,
  logout,
  getStatus,
  searchAnime,
  getSeriesDetails,
  getSeasons,
  getEpisodes,
  getEpisodeDetails,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getWatchHistory,
  getPlayheads,
  updatePlayhead,
  getContinueWatching,
  getRecommendations,
  getSimilar,
  getSimulcastSeasons,
  browse,
  getCategories,
  getSubscription,
} from "./api.js";

// B6-core: operation-scoped secret redaction (internal, not an MCP surface).
import { withRedactionScope, safeErrorWithCleanStack, redactSecrets } from "./redact.js";

// ── Server Setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "crunchyroll", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ── Tool Definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Auth
    {
      name: "crunchyroll_login",
      description: "Log in to Crunchyroll with email and password. Tokens are saved locally for future requests.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "Crunchyroll account email" },
          password: { type: "string", description: "Crunchyroll account password" },
        },
        required: ["email", "password"],
      },
    },
    {
      name: "crunchyroll_logout",
      description: "Log out and clear saved Crunchyroll session tokens.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "crunchyroll_status",
      description: "Check current Crunchyroll login status and account info.",
      inputSchema: { type: "object", properties: {} },
    },

    // Search
    {
      name: "crunchyroll_search",
      description: "Search for anime series and movies on Crunchyroll.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (anime title, character, genre)" },
          type: {
            type: "string",
            enum: ["series", "movie_listing", ""],
            description: "Filter by content type. Leave empty for all.",
          },
          n: { type: "number", description: "Number of results (default 20, max 100)" },
        },
        required: ["query"],
      },
    },

    // Series / Shows
    {
      name: "crunchyroll_get_series",
      description: "Get detailed information about an anime series by its ID.",
      inputSchema: {
        type: "object",
        properties: {
          series_id: { type: "string", description: "Crunchyroll series ID (e.g. GY8VEQ95Y)" },
        },
        required: ["series_id"],
      },
    },
    {
      name: "crunchyroll_get_seasons",
      description: "Get all seasons of an anime series.",
      inputSchema: {
        type: "object",
        properties: {
          series_id: { type: "string", description: "Crunchyroll series ID" },
        },
        required: ["series_id"],
      },
    },
    {
      name: "crunchyroll_get_episodes",
      description: "Get all episodes in a specific season.",
      inputSchema: {
        type: "object",
        properties: {
          season_id: { type: "string", description: "Crunchyroll season ID" },
        },
        required: ["season_id"],
      },
    },
    {
      name: "crunchyroll_get_episode",
      description: "Get detailed information about a specific episode.",
      inputSchema: {
        type: "object",
        properties: {
          episode_id: { type: "string", description: "Crunchyroll episode ID" },
        },
        required: ["episode_id"],
      },
    },

    // Watchlist
    {
      name: "crunchyroll_get_watchlist",
      description: "Get the user's anime watchlist (series saved to watch later).",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of items (default 20)" },
          order: { type: "string", enum: ["desc", "asc"], description: "Sort order by date added" },
        },
      },
    },
    {
      name: "crunchyroll_add_to_watchlist",
      description: "Add an anime series or movie to the watchlist.",
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Series or movie ID to add" },
        },
        required: ["content_id"],
      },
    },
    {
      name: "crunchyroll_remove_from_watchlist",
      description: "Remove an anime series or movie from the watchlist.",
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Series or movie ID to remove" },
        },
        required: ["content_id"],
      },
    },

    // History & Progress
    {
      name: "crunchyroll_get_history",
      description: "Get recently watched episodes and their progress.",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of history items (default 20)" },
        },
      },
    },
    {
      name: "crunchyroll_continue_watching",
      description: "Get list of in-progress anime to continue watching.",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of items (default 10)" },
        },
      },
    },
    {
      name: "crunchyroll_get_playheads",
      description: "Get watch progress (playhead position) for specific content IDs.",
      inputSchema: {
        type: "object",
        properties: {
          content_ids: {
            type: "array",
            items: { type: "string" },
            description: "List of episode/movie content IDs to check progress for",
          },
        },
        required: ["content_ids"],
      },
    },
    {
      name: "crunchyroll_update_playhead",
      description: "Update watch progress for an episode or movie.",
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Episode or movie ID" },
          playhead: { type: "number", description: "Position in seconds" },
        },
        required: ["content_id", "playhead"],
      },
    },

    // Recommendations
    {
      name: "crunchyroll_get_recommendations",
      description: "Get personalized anime recommendations based on watch history.",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of recommendations (default 20)" },
        },
      },
    },
    {
      name: "crunchyroll_get_similar",
      description: "Get anime similar to a given series.",
      inputSchema: {
        type: "object",
        properties: {
          series_id: { type: "string", description: "Series ID to find similar content for" },
          n: { type: "number", description: "Number of results (default 20)" },
        },
        required: ["series_id"],
      },
    },

    // Simulcast
    {
      name: "crunchyroll_get_simulcast_seasons",
      description: "Get available simulcast seasons/tags (e.g. 'Winter 2025', 'Fall 2024').",
      inputSchema: { type: "object", properties: {} },
    },

    // Browse
    {
      name: "crunchyroll_browse",
      description:
        "Browse anime by popularity, new additions, genre/category, or simulcast season. Use crunchyroll_get_categories to get valid category names and crunchyroll_get_simulcast_seasons for season tags.",
      inputSchema: {
        type: "object",
        properties: {
          sort_by: {
            type: "string",
            enum: ["popularity", "newly_added", "updated", "alphabetical"],
            description: "Sort order",
          },
          categories: {
            type: "string",
            description: "Comma-separated category slugs (e.g. 'action,fantasy')",
          },
          seasonal_tag: {
            type: "string",
            description: "Simulcast season tag ID (from crunchyroll_get_simulcast_seasons)",
          },
          is_subbed: { type: "boolean", description: "Filter for subbed content" },
          is_dubbed: { type: "boolean", description: "Filter for dubbed content" },
          n: { type: "number", description: "Number of results (default 20)" },
          start: { type: "number", description: "Offset for pagination (default 0)" },
        },
      },
    },
    {
      name: "crunchyroll_get_categories",
      description: "Get all available anime genres/categories for browsing.",
      inputSchema: { type: "object", properties: {} },
    },

    // Subscription
    {
      name: "crunchyroll_get_subscription",
      description: "Get current Crunchyroll subscription details and renewal info.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// ── Tool Handlers ─────────────────────────────────────────────────────────────

// B6-core: every tool call runs inside an operation-scoped redaction scope.
// The registry is cleared unconditionally in `finally` (success, thrown
// error, rejected promise, early return), so registered sensitive material
// can never leak across operations — including concurrent ones, since the
// scope is carried by AsyncLocalStorage per async chain.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return withRedactionScope(async (scope) => {
    const { name, arguments: args = {} } = request.params;

    // B6-core: register the raw credentials received by the login handler.
    // They must not survive in any error path that crosses the MCP boundary.
    // Empty/whitespace values are rejected by registerSecret by design.
    if (name === "crunchyroll_login") {
      scope.registerSecret(String(args.password ?? ""), String(args.email ?? ""));
    }

    try {
      switch (name) {
        // ── Auth ──────────────────────────────────────────────────────────────
        case "crunchyroll_login": {
          const result = await login(args.email as string, args.password as string);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "crunchyroll_logout": {
        await logout();
        return {
          content: [{ type: "text", text: "Logged out successfully. Session tokens cleared." }],
        };
      }

      case "crunchyroll_status": {
        const status = await getStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      }

      // ── Search ────────────────────────────────────────────────────────────
      case "crunchyroll_search": {
        const results = await searchAnime(args.query as string, {
          type: args.type as "series" | "movie_listing" | "" | undefined,
          n: args.n as number | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: results.length, results }, null, 2),
            },
          ],
        };
      }

      // ── Series ────────────────────────────────────────────────────────────
      case "crunchyroll_get_series": {
        const series = await getSeriesDetails(args.series_id as string);
        return {
          content: [{ type: "text", text: JSON.stringify(series, null, 2) }],
        };
      }

      case "crunchyroll_get_seasons": {
        const seasons = await getSeasons(args.series_id as string);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: seasons.length, seasons }, null, 2),
            },
          ],
        };
      }

      case "crunchyroll_get_episodes": {
        const episodes = await getEpisodes(args.season_id as string);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: episodes.length, episodes }, null, 2),
            },
          ],
        };
      }

      case "crunchyroll_get_episode": {
        const episode = await getEpisodeDetails(args.episode_id as string);
        return {
          content: [{ type: "text", text: JSON.stringify(episode, null, 2) }],
        };
      }

      // ── Watchlist ─────────────────────────────────────────────────────────
      case "crunchyroll_get_watchlist": {
        const items = await getWatchlist({
          n: args.n as number | undefined,
          order: args.order as "desc" | "asc" | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: items.length, items }, null, 2),
            },
          ],
        };
      }

      case "crunchyroll_add_to_watchlist": {
        const result = await addToWatchlist(args.content_id as string);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "crunchyroll_remove_from_watchlist": {
        const result = await removeFromWatchlist(args.content_id as string);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // ── History & Progress ────────────────────────────────────────────────
      case "crunchyroll_get_history": {
        const items = await getWatchHistory({ n: args.n as number | undefined });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: items.length, items }, null, 2),
            },
          ],
        };
      }

      case "crunchyroll_continue_watching": {
        const items = await getContinueWatching({ n: args.n as number | undefined });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: items.length, items }, null, 2),
            },
          ],
        };
      }

      case "crunchyroll_get_playheads": {
        const data = await getPlayheads(args.content_ids as string[]);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "crunchyroll_update_playhead": {
        const result = await updatePlayhead(args.content_id as string, args.playhead as number);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // ── Recommendations ───────────────────────────────────────────────────
      case "crunchyroll_get_recommendations": {
        const recs = await getRecommendations({ n: args.n as number | undefined });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: recs.length, recommendations: recs }, null, 2),
            },
          ],
        };
      }

      case "crunchyroll_get_similar": {
        const recs = await getSimilar(args.series_id as string, { n: args.n as number | undefined });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: recs.length, similar: recs }, null, 2),
            },
          ],
        };
      }

      // ── Simulcast ─────────────────────────────────────────────────────────
      case "crunchyroll_get_simulcast_seasons": {
        const seasons = await getSimulcastSeasons();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: seasons.length, seasons }, null, 2),
            },
          ],
        };
      }

      // ── Browse ────────────────────────────────────────────────────────────
      case "crunchyroll_browse": {
        const items = await browse({
          sort_by: args.sort_by as "popularity" | "newly_added" | "updated" | "alphabetical" | undefined,
          categories: args.categories as string | undefined,
          seasonal_tag: args.seasonal_tag as string | undefined,
          is_subbed: args.is_subbed as boolean | undefined,
          is_dubbed: args.is_dubbed as boolean | undefined,
          n: args.n as number | undefined,
          start: args.start as number | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: items.length, items }, null, 2),
            },
          ],
        };
      }

      case "crunchyroll_get_categories": {
        const cats = await getCategories();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: cats.length, categories: cats }, null, 2),
            },
          ],
        };
      }

      // ── Subscription ──────────────────────────────────────────────────────
      case "crunchyroll_get_subscription": {
        const sub = await getSubscription();
        return {
          content: [{ type: "text", text: JSON.stringify(sub, null, 2) }],
        };
      }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      // B6-core: sanitize the error (preserving class, never mutating the
      // original) and redact registered secrets + static class patterns
      // from the message and stack before it reaches the model.
      if (err instanceof McpError) {
        // Re-derive the McpError message through the redactor: the SDK may
        // echo err.message into the wire payload.
        throw new McpError(err.code, redactSecrets(err.message));
      }
      const safe = safeErrorWithCleanStack(err);
      const message = safe.message;
      const isAuthError = message.includes("Not logged in") || message.includes("401");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: message,
                ...(isAuthError ? { hint: "Use crunchyroll_login to authenticate first." } : {}),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Crunchyroll MCP server running on stdio");
}

main().catch((err) => {
  // B6-core: redact the fatal error before logging to stderr. No registered
  // secrets exist at bootstrap time, but static class patterns (Bearer /
  // Authorization headers, key-value bodies) still apply.
  const safe = err instanceof Error ? redactSecrets(err.message) : redactSecrets(String(err));
  console.error(`Fatal error: ${safe || "(empty)"}`);
  process.exit(1);
});
