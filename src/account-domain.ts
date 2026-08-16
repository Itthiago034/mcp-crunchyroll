// BT7 — account domain: interpretation of account-scoped payloads.
//
// This module imports NOTHING. No fetch, no transport, no auth, no token, no
// secrets, no session, no side effects, no cross-call state. It receives the
// JSON the browser transport already bounded and turns it into the shapes the
// account tools have always published.
//
// It is separate from `catalog-domain.ts` because it is a separate domain —
// account state rather than catalog metadata — and because the gateway must not
// import the legacy client to reach either of them.

/**
 * A parse failure. It carries a FIELD PATH and never provider content: an
 * error is not a place to smuggle an account's data across the MCP boundary.
 */
export class AccountShapeError extends Error {
  constructor(public readonly path: string) {
    super("The response did not match the expected shape");
    this.name = "AccountShapeError";
  }
}

function dataArray(json: unknown, where: string): unknown[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new AccountShapeError(where);
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new AccountShapeError(`${where}.data`);
  return data;
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AccountShapeError(where);
  }
  return value as Record<string, unknown>;
}

// ── Recommendations and similar ─────────────────────────────────────────────
//
// Both endpoints answer the same discover shape, so they share one parser.
// That is a real shared responsibility, not visual symmetry: if one ever
// diverges, it gets its own parser rather than a flag.

export interface RecommendationEntry {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly description?: string;
}

function parseRecommendationList(json: unknown, where: string): RecommendationEntry[] {
  return dataArray(json, where).map((raw) => {
    const entry = requireObject(raw, `${where}.entry`);
    const { id, title, type, description } = entry as Record<string, unknown>;
    if (typeof id !== "string") throw new AccountShapeError(`${where}.entry.id`);
    return Object.freeze({
      id,
      title: typeof title === "string" ? title : "",
      type: typeof type === "string" ? type : "",
      ...(typeof description === "string" ? { description } : {}),
    });
  });
}

export function parseSimilar(json: unknown): { count: number; similar: readonly RecommendationEntry[] } {
  const similar = parseRecommendationList(json, "similar");
  return Object.freeze({ count: similar.length, similar: Object.freeze(similar) });
}

export function parseRecommendations(json: unknown): {
  count: number;
  recommendations: readonly RecommendationEntry[];
} {
  const recommendations = parseRecommendationList(json, "recommendations");
  return Object.freeze({
    count: recommendations.length,
    recommendations: Object.freeze(recommendations),
  });
}

// ── Watchlist, history, continue watching ───────────────────────────────────
//
// All three answer a list of items whose exact fields the tools have always
// passed through. The projection is deliberately shallow: BT7 preserves the
// published shape rather than inventing a new one.

export function parseAccountItems(json: unknown, where: string): { count: number; items: readonly unknown[] } {
  const items = dataArray(json, where);
  return Object.freeze({ count: items.length, items: Object.freeze([...items]) });
}

export const parseWatchlist = (json: unknown) => parseAccountItems(json, "watchlist");
export const parseHistory = (json: unknown) => parseAccountItems(json, "history");
export const parseContinueWatching = (json: unknown) => parseAccountItems(json, "continue_watching");

// ── Playheads ───────────────────────────────────────────────────────────────

/**
 * `crunchyroll_get_playheads` has always returned the data array itself, not a
 * `{count, …}` envelope. Preserved exactly.
 */
export function parsePlayheads(json: unknown): readonly unknown[] {
  return Object.freeze([...dataArray(json, "playheads")]);
}
