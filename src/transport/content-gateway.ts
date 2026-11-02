// BT5 — the cutover boundary.
//
// THE single place that decides what happens to a content tool call. Every
// content tool maps to an operation id here; an id present in the production
// table goes to the browser transport, and everything else is refused with
// OPERATION_NOT_MIGRATED. No handler decides for itself, nothing falls through
// undecided, and there is no second path to try.
//
// This module holds no origin, no path, no method and no credential: those
// belong to the registry descriptor and the transport.

import {
  parseBrowse,
  parseCategories,
  parseEpisode,
  parseEpisodes,
  parseSearch,
  parseSeasons,
  parseSeries,
  parseSimulcastSeasons,
  CatalogShapeError,
} from "../catalog-domain.js";
import {
  AccountShapeError,
  parseHistory,
  parsePlayheads,
  parseRecommendations,
  parseSimilar,
  parseWatchlist,
} from "../account-domain.js";
import { resolveCall, type OperationRegistry } from "./operation-registry.js";
import { TransportError } from "./transport-error.js";
import type { CrunchyrollTransport, OperationId, CallerParams } from "./types.js";

/**
 * Domain defaults (BT6). The page size and offset a tool uses when the caller
 * does not say — a domain decision, deliberately not transport policy, kept
 * exactly as the legacy client had them.
 */
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_BROWSE_START = 0;
/** The watchlist has always been newest-first unless the caller says otherwise. */
const DEFAULT_WATCHLIST_ORDER = "desc";
const GET_OBJECTS = "GET_OBJECTS" as unknown as OperationId;

/** Only defined values are forwarded: an absent option must stay absent. */
function withDefined(params: Record<string, unknown>): CallerParams {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return Object.freeze(out);
}

/**
 * Every content tool, mapped to the operation that will serve it.
 *
 * The map is exhaustive on purpose: a tool missing from it would be invisible
 * to the cutover, and "invisible" is how a legacy path survives a migration.
 * Presence here means the boundary KNOWS the tool; only presence in the
 * registry means the operation is actually migrated.
 */
export const CONTENT_TOOL_OPERATIONS: ReadonlyMap<string, OperationId> = new Map(
  (
    [
      ["crunchyroll_get_categories", "GET_CATEGORIES"],
      ["crunchyroll_search", "SEARCH"],
      ["crunchyroll_get_series", "GET_SERIES"],
      ["crunchyroll_get_seasons", "GET_SEASONS"],
      ["crunchyroll_get_episodes", "GET_EPISODES"],
      ["crunchyroll_get_episode", "GET_EPISODE"],
      ["crunchyroll_get_simulcast_seasons", "GET_SIMULCAST_SEASONS"],
      ["crunchyroll_browse", "BROWSE"],
      ["crunchyroll_get_watchlist", "GET_WATCHLIST"],
      ["crunchyroll_add_to_watchlist", "ADD_TO_WATCHLIST"],
      ["crunchyroll_set_favorite", "SET_FAVORITE"],
      ["crunchyroll_remove_from_watchlist", "REMOVE_FROM_WATCHLIST"],
      ["crunchyroll_get_history", "GET_HISTORY"],
      ["crunchyroll_continue_watching", "GET_CONTINUE_WATCHING"],
      ["crunchyroll_get_playheads", "GET_PLAYHEADS"],
      ["crunchyroll_update_playhead", "UPDATE_PLAYHEAD"],
      ["crunchyroll_get_recommendations", "GET_RECOMMENDATIONS"],
      ["crunchyroll_get_similar", "GET_SIMILAR"],
      ["crunchyroll_get_subscription", "GET_SUBSCRIPTION"],
    ] as const
  ).map(([tool, operation]) => [tool, operation as unknown as OperationId])
);

export interface ContentGateway {
  /** Is this tool name one the cutover boundary owns? */
  isContentTool(name: string): boolean;
  /** Execute a content tool, or refuse it. Never returns a legacy result. */
  callTool(name: string, args: CallerParams): Promise<unknown>;
  /** Internal: the routing half, without the domain-error translation. */
  execute(name: string, args: CallerParams): Promise<unknown>;
}

export function createContentGateway(
  transport: CrunchyrollTransport,
  registry: OperationRegistry
): ContentGateway {
  /**
   * Add `title` and `type` to items that carry only an `id`, with ONE extra
   * read. Best effort: if that read fails the items are returned as they were,
   * because the watchlist itself was read successfully.
   */
  const withTitles = async (items: readonly unknown[]): Promise<unknown[]> => {
    const ids = items
      .map((item) => (item as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id));
    if (ids.length === 0 || !registry.has(GET_OBJECTS)) return [...items];
    let names: Map<string, { title?: unknown; type?: unknown }>;
    try {
      const json = (await transport.execute(GET_OBJECTS, { object_ids: ids.join(",") })).json as {
        data?: unknown;
      };
      const objects = Array.isArray(json?.data) ? json.data : [];
      names = new Map(
        objects
          .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
          .map((o) => [String(o.id), { title: o.title, type: o.type }])
      );
    } catch {
      return [...items];
    }
    return items.map((item) => {
      const named = names.get(String((item as { id?: unknown }).id));
      if (!named || typeof item !== "object" || item === null) return item;
      return {
        ...(item as Record<string, unknown>),
        ...(typeof named.title === "string" ? { title: named.title } : {}),
        ...(typeof named.type === "string" ? { type: named.type } : {}),
      };
    });
  };

  return {
    isContentTool(name: string): boolean {
      return CONTENT_TOOL_OPERATIONS.has(name);
    },

    async callTool(name: string, args: CallerParams): Promise<unknown> {
      try {
        return await this.execute(name, args);
      } catch (error) {
        // A domain shape failure carries a field PATH and no provider content;
        // it becomes the transport's closed vocabulary here.
        if (error instanceof CatalogShapeError || error instanceof AccountShapeError) {
          throw new TransportError("SCHEMA_MISMATCH", error.path);
        }
        throw error;
      }
    },

    async execute(name: string, args: CallerParams): Promise<unknown> {
      const operation = CONTENT_TOOL_OPERATIONS.get(name);
      if (operation === undefined) {
        // Not a content tool at all — the caller asked the wrong boundary.
        throw new TransportError("UNKNOWN_OPERATION", "not a content tool");
      }
      if (!registry.has(operation)) {
        // The cutover refusal. It happens HERE, locally, before any transport,
        // any browser and certainly any network.
        throw new TransportError("OPERATION_NOT_MIGRATED", String(operation));
      }

      switch (operation as unknown as string) {
        case "GET_CATEGORIES":
          return parseCategories((await transport.execute(operation, args)).json);

        case "SEARCH": {
          const result = await transport.execute(
            operation,
            withDefined({
              q: args.query,
              n: args.n ?? DEFAULT_PAGE_SIZE,
              // Only series and movies are ever surfaced (parseSearch); asking
              // for nothing else keeps big franchises under the response cap
              // and drops the top-results bucket that duplicated them.
              type: args.type === undefined || args.type === "" ? "series,movie_listing" : args.type,
            })
          );
          return parseSearch(result.json);
        }

        case "GET_SERIES":
          return parseSeries(
            (await transport.execute(operation, withDefined({ series_id: args.series_id }))).json
          );

        case "GET_SEASONS":
          return parseSeasons(
            (await transport.execute(operation, withDefined({ series_id: args.series_id }))).json
          );

        case "GET_EPISODES": {
          const wanted = args.episode_number;
          if (
            wanted !== undefined &&
            (typeof wanted !== "number" || !Number.isInteger(wanted) || wanted < 0 || wanted > 100_000)
          ) {
            throw new TransportError("INVALID_ARGUMENTS", "episode_number");
          }
          const list = parseEpisodes(
            (await transport.execute(operation, withDefined({ season_id: args.season_id }))).json
          );
          if (wanted === undefined) return list;
          // A local filter over the season the provider returned: long seasons
          // (One Piece arcs run past 200 episodes) do not fit a client's
          // context, and an agent playing one episode needs only that one.
          const episodes = list.episodes.filter(
            (episode) => (episode as { episode_number?: unknown }).episode_number === wanted
          );
          return { count: episodes.length, season_episode_count: list.count, episodes };
        }

        case "GET_EPISODE":
          return parseEpisode(
            (await transport.execute(operation, withDefined({ episode_id: args.episode_id }))).json
          );

        case "GET_SIMULCAST_SEASONS":
          return parseSimulcastSeasons((await transport.execute(operation, {})).json);

        case "BROWSE": {
          const result = await transport.execute(
            operation,
            withDefined({
              n: args.n ?? DEFAULT_PAGE_SIZE,
              start: args.start ?? DEFAULT_BROWSE_START,
              sort_by: args.sort_by,
              categories: args.categories,
              seasonal_tag: args.seasonal_tag,
              is_subbed: args.is_subbed,
              is_dubbed: args.is_dubbed,
            })
          );
          return parseBrowse(result.json);
        }

        // ── BT7: account reads. The caller supplies functional arguments
        // only; the account identity is a path parameter the registry declares
        // and BT3's bind() resolves, and it never appears here.
        case "GET_SIMILAR": {
          const result = await transport.execute(
            operation,
            withDefined({ series_id: args.series_id, n: args.n ?? DEFAULT_PAGE_SIZE })
          );
          return parseSimilar(result.json);
        }

        case "GET_RECOMMENDATIONS":
          return parseRecommendations(
            (await transport.execute(operation, withDefined({ n: args.n ?? DEFAULT_PAGE_SIZE }))).json
          );

        case "GET_WATCHLIST": {
          const n = args.n ?? DEFAULT_PAGE_SIZE;
          const result = await transport.execute(
            operation,
            withDefined({
              n,
              order: args.order ?? DEFAULT_WATCHLIST_ORDER,
            })
          );
          const watchlist = parseWatchlist(result.json);
          // The provider ignores `n` and answers bare ids (126 of them for a
          // real account). Honour `n` here and name what the ids are, so a
          // client does not have to look up every series one by one.
          const limit = typeof n === "number" && n > 0 ? Math.min(n, 50) : DEFAULT_PAGE_SIZE;
          const items = watchlist.items.slice(0, limit);
          return { count: items.length, items: await withTitles(items) };
        }

        case "GET_HISTORY":
          return parseHistory(
            (await transport.execute(operation, withDefined({ n: args.n ?? DEFAULT_PAGE_SIZE }))).json
          );

        case "GET_PLAYHEADS":
          return parsePlayheads(
            (await transport.execute(operation, withDefined({ content_ids: args.content_ids }))).json
          );

        case "SET_FAVORITE": {
          // Validate the complete input BEFORE the initial read. Never drop
          // unknown arguments or coerce a string into a boolean.
          resolveCall(registry, operation, args);
          const target = "GET_WATCHLIST_ENTRY" as OperationId;
          const result = await transport.execute(target, { content_id: args.content_id });
          const items = parseWatchlist(result.json).items;
          // A filtered response must identify the exact target. Refuse an
          // ignored filter or malformed response, rather than infer absence
          // from a truncated general watchlist page.
          if (items.length > 1 || items.some(item =>
            typeof item !== "object" || item === null ||
            (item as { id?: unknown }).id !== args.content_id
          )) throw new AccountShapeError("watchlist.target");
          const present = items.length === 1;
          const noop = !present && args.favorite === false;
          if (!noop) {
            if (!present) await transport.execute("ADD_TO_WATCHLIST" as OperationId, { content_id: args.content_id });
            // Set the requested boolean even if it matches the current value:
            // this is idempotent state assignment, never a toggle or a replay.
            await transport.execute(operation, args);
          }
          return {
            tool: "crunchyroll_set_favorite",
            operation: "SET_FAVORITE",
            mutation: true,
            mutation_class: "ACCOUNT",
            content_id: args.content_id,
            favorite: args.favorite,
            outcome: noop ? "NOOP" : "APPLIED",
            outcome_certainty: "CERTAIN",
            retry_performed: false,
            verify_with: "crunchyroll_get_watchlist",
          };
        }

        case "ADD_TO_WATCHLIST": {
          await transport.execute(operation, args);
          return {
            tool: "crunchyroll_add_to_watchlist",
            operation: "ADD_TO_WATCHLIST",
            mutation: true,
            mutation_class: "ACCOUNT",
            content_id: args.content_id,
            outcome: "APPLIED",
            outcome_certainty: "CERTAIN",
            retry_performed: false,
            verify_with: "crunchyroll_get_watchlist",
          };
        }

        case "REMOVE_FROM_WATCHLIST": {
          await transport.execute(operation, args);
          return {
            tool: "crunchyroll_remove_from_watchlist",
            operation: "REMOVE_FROM_WATCHLIST",
            mutation: true,
            mutation_class: "ACCOUNT",
            content_id: args.content_id,
            outcome: "APPLIED",
            outcome_certainty: "CERTAIN",
            retry_performed: false,
            verify_with: "crunchyroll_get_watchlist",
          };
        }

        case "UPDATE_PLAYHEAD": {
          await transport.execute(operation, args);
          return {
            tool: "crunchyroll_update_playhead",
            operation: "UPDATE_PLAYHEAD",
            mutation: true,
            mutation_class: "PROGRESS",
            content_id: args.content_id,
            playhead: args.playhead,
            outcome: "APPLIED",
            outcome_certainty: "CERTAIN",
            retry_performed: false,
            verify_with: "crunchyroll_get_playheads",
          };
        }

        default:
          // A descriptor exists but this boundary has no parser for it: refuse
          // rather than improvise. Migrating an operation means adding both.
          throw new TransportError("OPERATION_NOT_MIGRATED", String(operation));
      }
    },
  };
}
