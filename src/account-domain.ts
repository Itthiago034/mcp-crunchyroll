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

// ── Watchlist and history ───────────────────────────────────────────────────
//
// Both answer a list of items whose exact fields the tools have always
// passed through. The projection is deliberately shallow: BT7 preserves the
// published shape rather than inventing a new one.

export function parseAccountItems(json: unknown, where: string): { count: number; items: readonly unknown[] } {
  const items = dataArray(json, where);
  return Object.freeze({ count: items.length, items: Object.freeze([...items]) });
}

export const parseWatchlist = (json: unknown) => parseAccountItems(json, "watchlist");

// History items embed the full episode panel (images, ratings, every locale's
// metadata): ~8 KB each, ~200 KB per page, which small local agents cannot
// hold. Keep what is needed to resume or continue a series.
const HISTORY_EPISODE_FIELDS = [
  "series_id", "series_title", "season_id", "season_title", "season_number", "episode",
  "episode_number", "duration_ms", "audio_locale",
] as const;

/** Same projection as catalog-domain's (this module imports nothing). */
function compactAudioVersions(raw: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const audioVersions: Record<string, string> = {};
  let originalAudio: string | undefined;
  for (const version of raw) {
    if (typeof version !== "object" || version === null) continue;
    const { audio_locale: locale, guid, original } = version as Record<string, unknown>;
    if (typeof locale !== "string" || typeof guid !== "string") continue;
    audioVersions[locale] = guid;
    if (original === true) originalAudio = locale;
  }
  return originalAudio === undefined
    ? { audio_versions: audioVersions }
    : { original_audio: originalAudio, audio_versions: audioVersions };
}

function compactHistoryItem(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const item = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["id", "date_played", "parent_id", "parent_type", "playhead", "fully_watched"]) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  const panel = item.panel;
  if (typeof panel === "object" && panel !== null && !Array.isArray(panel)) {
    const p = panel as Record<string, unknown>;
    if (p.title !== undefined) out.title = p.title;
    if (p.type !== undefined) out.type = p.type;
    const meta = p.episode_metadata;
    if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      const episode: Record<string, unknown> = {};
      for (const field of HISTORY_EPISODE_FIELDS) {
        if (m[field] !== undefined) episode[field] = m[field];
      }
      out.episode_metadata = { ...episode, ...compactAudioVersions(m.versions) };
    }
  }
  return out;
}

export function parseHistory(json: unknown): { count: number; items: readonly unknown[] } {
  const items = dataArray(json, "history").map(compactHistoryItem);
  return Object.freeze({ count: items.length, items: Object.freeze(items) });
}
// `parseContinueWatching` was removed with F-1: its only consumer was the
// gateway case for an endpoint the provider no longer routes.

// ── Playheads ───────────────────────────────────────────────────────────────

/**
 * `crunchyroll_get_playheads` has always returned the data array itself, not a
 * `{count, …}` envelope. Preserved exactly.
 */
export function parsePlayheads(json: unknown): readonly unknown[] {
  return Object.freeze([...dataArray(json, "playheads")]);
}
