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

import type { OperationRegistry } from "./operation-registry.js";
import { TransportError } from "./transport-error.js";
import type { CrunchyrollTransport, OperationId, CallerParams } from "./types.js";

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

/** One category, reduced to the two fields the public result has always had. */
export interface CategorySummary {
  readonly id: string;
  readonly localization: { readonly title: string };
}

export interface CategoriesResult {
  readonly count: number;
  readonly categories: readonly CategorySummary[];
}

/**
 * The domain parser, separated from transport.
 *
 * It accepts only the shape the public result is built from and refuses
 * anything else rather than passing a surprise through. No part of an
 * unrecognised payload is carried into the error.
 */
export function parseCategories(json: unknown): CategoriesResult {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new TransportError("SCHEMA_MISMATCH", "categories");
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new TransportError("SCHEMA_MISMATCH", "categories.data");
  }
  const categories = data.map((entry): CategorySummary => {
    if (typeof entry !== "object" || entry === null) {
      throw new TransportError("SCHEMA_MISMATCH", "categories.entry");
    }
    const id = (entry as { id?: unknown }).id;
    const localization = (entry as { localization?: unknown }).localization;
    const title = (localization as { title?: unknown } | undefined)?.title;
    if (typeof id !== "string" || typeof title !== "string") {
      throw new TransportError("SCHEMA_MISMATCH", "categories.entry");
    }
    return Object.freeze({ id, localization: Object.freeze({ title }) });
  });
  return Object.freeze({ count: categories.length, categories: Object.freeze(categories) });
}

export interface ContentGateway {
  /** Is this tool name one the cutover boundary owns? */
  isContentTool(name: string): boolean;
  /** Execute a content tool, or refuse it. Never returns a legacy result. */
  callTool(name: string, args: CallerParams): Promise<unknown>;
}

export function createContentGateway(
  transport: CrunchyrollTransport,
  registry: OperationRegistry
): ContentGateway {
  return {
    isContentTool(name: string): boolean {
      return CONTENT_TOOL_OPERATIONS.has(name);
    },

    async callTool(name: string, args: CallerParams): Promise<unknown> {
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
        case "GET_CATEGORIES": {
          // The tool takes no arguments; anything supplied is refused by the
          // registry's allow-list rather than quietly dropped here.
          const result = await transport.execute(operation, args);
          return parseCategories(result.json);
        }
        default:
          // A descriptor exists but this boundary has no parser for it: refuse
          // rather than improvise. Migrating an operation means adding both.
          throw new TransportError("OPERATION_NOT_MIGRATED", String(operation));
      }
    },
  };
}
