import {
  TokenData,
  SessionInfo,
  saveTokens,
  saveSessionInfo,
  loadTokens,
  loadSessionInfo,
  clearAuthData,
  hasSavedTokens,
  isTokenExpired,
} from "./auth.js";

// Crunchyroll API base URLs
const AUTH_BASE = "https://auth.crunchyroll.com";
const API_BASE = "https://www.crunchyroll.com";

// Web client credentials (public, used by the CR web app)
const CLIENT_ID = "cr_web";
const CLIENT_SECRET = "";
const BASIC_AUTH = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

const DEFAULT_LOCALE = "en-US";
const DEFAULT_AUDIO_LOCALE = "ja-JP";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CrunchyrollImage {
  width: number;
  height: number;
  type: string;
  source: string;
}

export interface CrunchyrollSeries {
  id: string;
  title: string;
  slug_title: string;
  description: string;
  episode_count?: number;
  season_count?: number;
  media_count?: number;
  content_provider?: string;
  is_mature?: boolean;
  maturity_ratings?: string[];
  images?: { poster_tall?: CrunchyrollImage[][]; poster_wide?: CrunchyrollImage[][] };
  series_launch_year?: number;
}

export interface CrunchyrollMovie {
  id: string;
  title: string;
  slug_title: string;
  description: string;
  duration_ms?: number;
  is_mature?: boolean;
  maturity_ratings?: string[];
  images?: { poster_tall?: CrunchyrollImage[][]; poster_wide?: CrunchyrollImage[][] };
}

export interface CrunchyrollSeason {
  id: string;
  series_id: string;
  title: string;
  season_number?: number;
  episode_count?: number;
  is_complete?: boolean;
  audio_locale?: string;
  subtitle_locales?: string[];
}

export interface CrunchyrollEpisode {
  id: string;
  series_id: string;
  series_title?: string;
  season_id: string;
  season_title?: string;
  season_number?: number;
  episode: string;
  episode_number?: number;
  title: string;
  description: string;
  duration_ms?: number;
  premium_available_date?: string;
  free_available_date?: string;
  is_premium_only?: boolean;
  images?: { thumbnail?: CrunchyrollImage[][] };
}

export interface WatchlistItem {
  panel: {
    id: string;
    title: string;
    type: string;
    description?: string;
    series_launch_year?: number;
  };
  playhead?: { playhead: number; fully_watched: boolean };
  is_favorite?: boolean;
}

export interface HistoryItem {
  panel: { id: string; title: string; type: string };
  playhead: { playhead: number; fully_watched: boolean };
  date_played?: string;
}

export interface PlayheadData {
  content_id: string;
  playhead: number;
  fully_watched: boolean;
  last_modified?: string;
}

export interface Recommendation {
  id: string;
  title: string;
  type: string;
  description?: string;
}

export interface SimulcastSeason {
  id: string;
  localization: { title: string; description?: string };
}

// ── HTTP Client ───────────────────────────────────────────────────────────────

async function request<T>(
  url: string,
  options: RequestInit & { token?: string; noAuth?: boolean } = {}
): Promise<T> {
  const { token, noAuth, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (token && !noAuth) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  if (!response.ok) {
    let errBody = "";
    try {
      errBody = await response.text();
    } catch {
      // ignore
    }
    throw new Error(`Crunchyroll API error ${response.status}: ${errBody || response.statusText}`);
  }

  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  account_id: string;
  profile_id?: string;
}

export async function login(email: string, password: string): Promise<{ success: boolean; message: string }> {
  try {
    const body = new URLSearchParams({
      grant_type: "password",
      username: email,
      password,
      scope: "offline_access",
    });

    const resp = await request<TokenResponse>(`${AUTH_BASE}/auth/v1/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${BASIC_AUTH}`,
      },
      body: body.toString(),
      noAuth: true,
    });

    const tokens: TokenData = {
      access_token: resp.access_token,
      refresh_token: resp.refresh_token,
      expires_at: Date.now() + resp.expires_in * 1000,
      token_type: resp.token_type,
      account_id: resp.account_id,
      profile_id: resp.profile_id,
    };

    await saveTokens(tokens);
    await saveSessionInfo({ email, account_id: resp.account_id });

    return { success: true, message: `Logged in successfully. Account ID: ${resp.account_id}` };
  } catch (err) {
    return { success: false, message: `Login failed: ${(err as Error).message}` };
  }
}

export async function logout(): Promise<void> {
  await clearAuthData();
}

export async function getStatus(): Promise<{
  logged_in: boolean;
  email?: string;
  account_id?: string;
  token_expires_at?: string;
}> {
  const hasTokens = await hasSavedTokens();
  if (!hasTokens) return { logged_in: false };

  const tokens = await loadTokens();
  const session = await loadSessionInfo();

  if (!tokens) return { logged_in: false };

  return {
    logged_in: !isTokenExpired(tokens),
    email: session?.email,
    account_id: tokens.account_id,
    token_expires_at: new Date(tokens.expires_at).toISOString(),
  };
}

async function refreshTokens(tokens: TokenData): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    scope: "offline_access",
  });

  const resp = await request<TokenResponse>(`${AUTH_BASE}/auth/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${BASIC_AUTH}`,
    },
    body: body.toString(),
    noAuth: true,
  });

  const newTokens: TokenData = {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: Date.now() + resp.expires_in * 1000,
    token_type: resp.token_type,
    account_id: resp.account_id,
    profile_id: resp.profile_id,
  };

  await saveTokens(newTokens);
  return newTokens;
}

async function getValidToken(): Promise<{ token: string; account_id: string }> {
  let tokens = await loadTokens();
  if (!tokens) throw new Error("Not logged in. Use crunchyroll_login first.");

  if (isTokenExpired(tokens)) {
    tokens = await refreshTokens(tokens);
  }

  return { token: tokens.access_token, account_id: tokens.account_id };
}

// ── Search ────────────────────────────────────────────────────────────────────

interface SearchResult {
  items: Array<{
    type: string;
    count: number;
    items: Array<{ type: string; id: string; series_meta?: CrunchyrollSeries; movie_listing_meta?: CrunchyrollMovie }>;
  }>;
}

export async function searchAnime(
  query: string,
  options: { type?: "series" | "movie_listing" | ""; n?: number; locale?: string } = {}
): Promise<Array<{ type: string; id: string; title: string; description: string }>> {
  const { token } = await getValidToken();
  const params = new URLSearchParams({
    q: query,
    n: String(options.n ?? 20),
    locale: options.locale ?? DEFAULT_LOCALE,
    ...(options.type ? { type: options.type } : {}),
  });

  const data = await request<{ data: SearchResult["items"] }>(
    `${API_BASE}/content/v2/discover/search?${params}`,
    { token }
  );

  const results: Array<{ type: string; id: string; title: string; description: string }> = [];
  for (const group of data.data ?? []) {
    for (const item of group.items ?? []) {
      const meta = item.series_meta ?? item.movie_listing_meta;
      if (meta) {
        results.push({
          type: item.type,
          id: item.id,
          title: meta.title,
          description: meta.description?.slice(0, 300) ?? "",
        });
      }
    }
  }
  return results;
}

// ── Series / Movies ───────────────────────────────────────────────────────────

export async function getSeriesDetails(seriesId: string): Promise<CrunchyrollSeries> {
  const { token } = await getValidToken();
  const params = new URLSearchParams({ locale: DEFAULT_LOCALE });
  const data = await request<{ data: CrunchyrollSeries[] }>(
    `${API_BASE}/content/v2/cms/series/${seriesId}?${params}`,
    { token }
  );
  if (!data.data?.[0]) throw new Error(`Series ${seriesId} not found`);
  return data.data[0];
}

export async function getSeasons(seriesId: string): Promise<CrunchyrollSeason[]> {
  const { token } = await getValidToken();
  const params = new URLSearchParams({ locale: DEFAULT_LOCALE, series_id: seriesId });
  const data = await request<{ data: CrunchyrollSeason[] }>(
    `${API_BASE}/content/v2/cms/series/${seriesId}/seasons?${params}`,
    { token }
  );
  return data.data ?? [];
}

export async function getEpisodes(seasonId: string): Promise<CrunchyrollEpisode[]> {
  const { token } = await getValidToken();
  const params = new URLSearchParams({ locale: DEFAULT_LOCALE });
  const data = await request<{ data: CrunchyrollEpisode[] }>(
    `${API_BASE}/content/v2/cms/seasons/${seasonId}/episodes?${params}`,
    { token }
  );
  return data.data ?? [];
}

export async function getEpisodeDetails(episodeId: string): Promise<CrunchyrollEpisode> {
  const { token } = await getValidToken();
  const params = new URLSearchParams({ locale: DEFAULT_LOCALE });
  const data = await request<{ data: CrunchyrollEpisode[] }>(
    `${API_BASE}/content/v2/cms/episodes/${episodeId}?${params}`,
    { token }
  );
  if (!data.data?.[0]) throw new Error(`Episode ${episodeId} not found`);
  return data.data[0];
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export async function getWatchlist(options: { n?: number; order?: "desc" | "asc" } = {}): Promise<WatchlistItem[]> {
  const { token, account_id } = await getValidToken();
  const params = new URLSearchParams({
    n: String(options.n ?? 20),
    order: options.order ?? "desc",
    locale: DEFAULT_LOCALE,
  });
  const data = await request<{ data: WatchlistItem[] }>(
    `${API_BASE}/content/v2/${account_id}/watchlist?${params}`,
    { token }
  );
  return data.data ?? [];
}

export async function addToWatchlist(contentId: string): Promise<{ success: boolean; message: string }> {
  const { token, account_id } = await getValidToken();
  await request(`${API_BASE}/content/v2/${account_id}/watchlist/${contentId}`, {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
  return { success: true, message: `Added ${contentId} to watchlist` };
}

export async function removeFromWatchlist(contentId: string): Promise<{ success: boolean; message: string }> {
  const { token, account_id } = await getValidToken();
  await request(`${API_BASE}/content/v2/${account_id}/watchlist/${contentId}`, {
    method: "DELETE",
    token,
    headers: { "Content-Type": "application/json" },
  });
  return { success: true, message: `Removed ${contentId} from watchlist` };
}

// ── Watch History & Progress ──────────────────────────────────────────────────

export async function getWatchHistory(options: { n?: number; locale?: string } = {}): Promise<HistoryItem[]> {
  const { token, account_id } = await getValidToken();
  const params = new URLSearchParams({
    n: String(options.n ?? 20),
    locale: options.locale ?? DEFAULT_LOCALE,
  });
  const data = await request<{ data: HistoryItem[] }>(
    `${API_BASE}/content/v2/${account_id}/watch-history?${params}`,
    { token }
  );
  return data.data ?? [];
}

export async function getPlayheads(contentIds: string[]): Promise<PlayheadData[]> {
  const { token, account_id } = await getValidToken();
  const params = new URLSearchParams();
  contentIds.forEach((id) => params.append("content_ids[]", id));
  const data = await request<{ data: PlayheadData[] }>(
    `${API_BASE}/content/v2/${account_id}/playheads?${params}`,
    { token }
  );
  return data.data ?? [];
}

export async function updatePlayhead(
  contentId: string,
  playhead: number
): Promise<{ success: boolean; message: string }> {
  const { token, account_id } = await getValidToken();
  await request(`${API_BASE}/content/v2/${account_id}/playheads`, {
    method: "POST",
    token,
    body: JSON.stringify({ content_id: contentId, playhead }),
  });
  return { success: true, message: `Updated playhead for ${contentId} to ${playhead}s` };
}

export async function getContinueWatching(options: { n?: number } = {}): Promise<WatchlistItem[]> {
  const { token, account_id } = await getValidToken();
  const params = new URLSearchParams({
    n: String(options.n ?? 10),
    locale: DEFAULT_LOCALE,
  });
  const data = await request<{ data: WatchlistItem[] }>(
    `${API_BASE}/content/v2/${account_id}/continue_watching?${params}`,
    { token }
  );
  return data.data ?? [];
}

// ── Recommendations ───────────────────────────────────────────────────────────

export async function getRecommendations(options: { n?: number } = {}): Promise<Recommendation[]> {
  const { token, account_id } = await getValidToken();
  const params = new URLSearchParams({
    n: String(options.n ?? 20),
    locale: DEFAULT_LOCALE,
  });
  const data = await request<{ data: Recommendation[] }>(
    `${API_BASE}/content/v2/discover/${account_id}/recommendations?${params}`,
    { token }
  );
  return data.data ?? [];
}

export async function getSimilar(seriesId: string, options: { n?: number } = {}): Promise<Recommendation[]> {
  const { token, account_id } = await getValidToken();
  const params = new URLSearchParams({
    n: String(options.n ?? 20),
    locale: DEFAULT_LOCALE,
  });
  const data = await request<{ data: Recommendation[] }>(
    `${API_BASE}/content/v2/discover/${account_id}/similar_to/${seriesId}?${params}`,
    { token }
  );
  return data.data ?? [];
}

// ── Simulcast / Browse ────────────────────────────────────────────────────────

export async function getSimulcastSeasons(): Promise<SimulcastSeason[]> {
  const { token } = await getValidToken();
  const params = new URLSearchParams({ locale: DEFAULT_LOCALE });
  const data = await request<{ data: SimulcastSeason[] }>(
    `${API_BASE}/content/v2/discover/seasonal_tags?${params}`,
    { token }
  );
  return data.data ?? [];
}

interface BrowseOptions {
  sort_by?: "popularity" | "newly_added" | "updated" | "alphabetical";
  categories?: string;
  seasonal_tag?: string;
  is_subbed?: boolean;
  is_dubbed?: boolean;
  n?: number;
  start?: number;
  locale?: string;
}

export interface BrowseItem {
  id: string;
  title: string;
  type: string;
  description?: string;
  series_launch_year?: number;
}

export async function browse(options: BrowseOptions = {}): Promise<BrowseItem[]> {
  const { token } = await getValidToken();
  const params = new URLSearchParams({
    n: String(options.n ?? 20),
    start: String(options.start ?? 0),
    locale: options.locale ?? DEFAULT_LOCALE,
    ...(options.sort_by ? { sort_by: options.sort_by } : {}),
    ...(options.categories ? { categories: options.categories } : {}),
    ...(options.seasonal_tag ? { seasonal_tag: options.seasonal_tag } : {}),
    ...(options.is_subbed !== undefined ? { is_subbed: String(options.is_subbed) } : {}),
    ...(options.is_dubbed !== undefined ? { is_dubbed: String(options.is_dubbed) } : {}),
  });

  const data = await request<{ data: Array<{ type: string; id: string; series_meta?: CrunchyrollSeries; movie_listing_meta?: CrunchyrollMovie }> }>(
    `${API_BASE}/content/v2/discover/browse?${params}`,
    { token }
  );

  return (data.data ?? []).map((item) => {
    const meta = item.series_meta ?? item.movie_listing_meta;
    return {
      id: item.id,
      title: meta?.title ?? item.id,
      type: item.type,
      description: meta?.description?.slice(0, 300) ?? "",
      series_launch_year: (meta as CrunchyrollSeries)?.series_launch_year,
    };
  });
}

export async function getCategories(): Promise<Array<{ id: string; localization: { title: string } }>> {
  const { token } = await getValidToken();
  const params = new URLSearchParams({ locale: DEFAULT_LOCALE });
  const data = await request<{ data: Array<{ id: string; localization: { title: string } }> }>(
    `${API_BASE}/content/v2/discover/categories?${params}`,
    { token }
  );
  return data.data ?? [];
}

// ── Subscription ──────────────────────────────────────────────────────────────

export interface SubscriptionInfo {
  subscription_id?: string;
  next_renewal_date?: string;
  will_auto_renew?: boolean;
  tier?: string;
  effective_date?: string;
  expiration_date?: string;
  is_active?: boolean;
}

export async function getSubscription(): Promise<SubscriptionInfo> {
  const { token, account_id } = await getValidToken();
  try {
    const data = await request<{ total: number; data: SubscriptionInfo[] }>(
      `${API_BASE}/subs/v1/subscriptions/${account_id}/benefits`,
      { token }
    );
    return data.data?.[0] ?? {};
  } catch {
    // Try alternate endpoint
    const data = await request<SubscriptionInfo>(
      `${API_BASE}/subscriptions/v1/subscriptions/${account_id}`,
      { token }
    );
    return data;
  }
}
