// BT6 — catalog domain: payload interpretation, and nothing else.
//
// This module imports NOTHING. No fetch, no transport, no legacy client. It
// turns a bounded TransportResult payload into the domain shapes the MCP tools
// have always published, and it is the single home of the LIVE-COMPAT-01
// normalizer that BT0 introduced.
//
// The browser transport stops at TransportResult; interpretation lives here.

// ── Shapes the provider sends (structural, not exhaustive) ──────────────────

export interface DiscoverItemLike {
  type?: unknown;
  id?: unknown;
  title?: unknown;
  description?: unknown;
  series_meta?: unknown;
  movie_listing_meta?: unknown;
  series_metadata?: unknown;
  movie_listing_metadata?: unknown;
}

/** Shape-independent view of the fields both call sites consume. */
export interface NormalizedDiscoverItem {
  /**
   * Whether this item carries metadata in one of the four shapes we
   * understand. Deliberately independent of the title entirely: the title is
   * DATA carried by a recognized item, never the discriminator that makes an
   * item recognized. So an empty-string title must not make an item disappear,
   * and an item-level title alone must not make an unknown shape appear.
   */
  recognized: boolean;
  title?: string;
  description?: string;
  series_launch_year?: number;
}

/**
 * LIVE-COMPAT-01 (BT0). The live API answers `series_metadata` /
 * `movie_listing_metadata`; older fixtures carry `series_meta` /
 * `movie_listing_meta`. Both are understood, here and only here.
 *
 * MOVED from `src/api.ts` at BT6 — not copied. The legacy account paths import
 * it back from this module, so there is exactly one normalizer.
 */
export function normalizeDiscoverItem(item: DiscoverItemLike): NormalizedDiscoverItem {
  const legacy = (item.series_meta ?? item.movie_listing_meta) as
    | { title?: string; description?: string; series_launch_year?: number }
    | undefined;
  const live = (item.series_metadata ?? item.movie_listing_metadata) as
    | { title?: string; description?: string; series_launch_year?: number }
    | undefined;
  const extras = legacy ?? live;
  return {
    recognized: legacy !== undefined || live !== undefined,
    title: legacy?.title ?? (typeof item.title === "string" ? item.title : undefined),
    description:
      legacy?.description ?? (typeof item.description === "string" ? item.description : undefined),
    series_launch_year: extras?.series_launch_year,
  };
}

// ── Parse failures ──────────────────────────────────────────────────────────

/**
 * A payload that does not match what the caller will be shown. It carries a
 * FIELD PATH, never provider content: an error is not a place to smuggle a
 * response body across the MCP boundary.
 */
export class CatalogShapeError extends Error {
  constructor(public readonly path: string) {
    super("The response did not match the expected shape");
    this.name = "CatalogShapeError";
  }
}

function dataArray(json: unknown, where: string): unknown[] {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new CatalogShapeError(where);
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new CatalogShapeError(`${where}.data`);
  return data;
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogShapeError(where);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new CatalogShapeError(where);
  return value;
}

// ── Parsers, one per migrated operation ─────────────────────────────────────
//
// Each reproduces EXACTLY the public shape its tool has always returned.

export interface SearchHit {
  readonly type: string;
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export function parseSearch(json: unknown): { count: number; results: SearchHit[] } {
  const groups = dataArray(json, "search");
  const results: SearchHit[] = [];
  for (const group of groups) {
    const items = (requireObject(group, "search.group").items ?? []) as unknown;
    if (!Array.isArray(items)) throw new CatalogShapeError("search.group.items");
    for (const raw of items) {
      const item = requireObject(raw, "search.item");
      const meta = normalizeDiscoverItem(item as DiscoverItemLike);
      // Unrecognized shapes are skipped, exactly as before: an item we cannot
      // describe is not surfaced as an empty row.
      if (!meta.recognized) continue;
      results.push({
        type: requireString(item.type, "search.item.type"),
        id: requireString(item.id, "search.item.id"),
        title: meta.title ?? "",
        description: meta.description?.slice(0, 300) ?? "",
      });
    }
  }
  return { count: results.length, results };
}

export interface BrowseEntry {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly description: string;
  readonly series_launch_year?: number;
}

export function parseBrowse(json: unknown): { count: number; items: BrowseEntry[] } {
  const items = dataArray(json, "browse").map((raw): BrowseEntry => {
    const item = requireObject(raw, "browse.item");
    const meta = normalizeDiscoverItem(item as DiscoverItemLike);
    const id = requireString(item.id, "browse.item.id");
    return {
      id,
      title: meta.title ?? id,
      type: requireString(item.type, "browse.item.type"),
      description: meta.description?.slice(0, 300) ?? "",
      series_launch_year: meta.series_launch_year,
    };
  });
  return { count: items.length, items };
}

/** Image URL sets: the bulk of a detail record, and of no use to an agent. */
function withoutImages(record: Record<string, unknown>): Record<string, unknown> {
  const { images: _images, images_localized: _localized, ...rest } = record;
  return rest;
}

/** The series object, passed through as the tool has always published it, minus images. */
export function parseSeries(json: unknown): Record<string, unknown> {
  const [first] = dataArray(json, "series");
  if (first === undefined) throw new CatalogShapeError("series.data[0]");
  return withoutImages(requireObject(first, "series.data[0]"));
}

// Season and episode LISTS are what an agent reads to pick something to play.
// Hermes spills any MCP result over 50 000 characters to a file.
// The provider records carry images, ratings and localized copies that make a
// 13-episode season ~110 KB, which small local models cannot hold. Lists keep
// only the fields needed to choose and play; get_series/get_episode still
// return the full record.
const SEASON_LIST_FIELDS = [
  "id", "title", "series_id", "season_number", "season_display_number", "number_of_episodes",
  "is_complete", "is_simulcast", "is_subbed", "is_dubbed", "audio_locale", "audio_locales",
  "subtitle_locales", "description",
] as const;

// Episodes share their season's subtitle list and ids, so a list entry keeps
// only what tells episodes apart.
const EPISODE_LIST_FIELDS = [
  "id", "title", "season_number", "episode", "episode_number", "duration_ms", "audio_locale",
  "is_premium_only", "availability_status", "next_episode_id", "next_episode_title",
] as const;

/**
 * Versions reduced to the choice that matters: audio locale → id to play, plus
 * which audio is the original. A season with fifteen dubs is ~2 KB of version
 * records per episode; as a map it is a few hundred bytes.
 */
export function compactAudioVersions(raw: unknown): Record<string, unknown> | undefined {
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

function compactRecord(raw: unknown, fields: readonly string[]): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return { ...out, ...compactAudioVersions(source.versions) };
}

export function parseSeasons(json: unknown): { count: number; seasons: unknown[] } {
  const seasons = dataArray(json, "seasons").map((raw) => compactRecord(raw, SEASON_LIST_FIELDS));
  return { count: seasons.length, seasons };
}

export function parseEpisodes(json: unknown): { count: number; episodes: unknown[] } {
  const episodes = dataArray(json, "episodes").map((raw) => compactRecord(raw, EPISODE_LIST_FIELDS));
  return { count: episodes.length, episodes };
}

export function parseEpisode(json: unknown): Record<string, unknown> {
  const [first] = dataArray(json, "episode");
  if (first === undefined) throw new CatalogShapeError("episode.data[0]");
  return withoutImages(requireObject(first, "episode.data[0]"));
}

export function parseSimulcastSeasons(json: unknown): { count: number; seasons: unknown[] } {
  const seasons = dataArray(json, "seasonal_tags");
  return { count: seasons.length, seasons };
}

export interface CategorySummary {
  readonly id: string;
  readonly localization: { readonly title: string };
}

export function parseCategories(json: unknown): {
  count: number;
  categories: CategorySummary[];
} {
  const categories = dataArray(json, "categories").map((raw): CategorySummary => {
    const entry = requireObject(raw, "categories.entry");
    const localization = requireObject(entry.localization, "categories.entry.localization");
    return {
      id: requireString(entry.id, "categories.entry.id"),
      localization: { title: requireString(localization.title, "categories.entry.localization.title") },
    };
  });
  return { count: categories.length, categories };
}
