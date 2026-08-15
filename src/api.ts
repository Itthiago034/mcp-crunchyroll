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

// B6-core: redaction of upstream error bodies before they become Error
// messages that can cross the MCP boundary.
// B6-FIX-1 (blocker B6-C2): runtime registration of token literals into the
// active operation scope, plus redaction of upstream error bodies.
import { redactSecrets, registerSensitiveValue } from "./redact.js";

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
    // B6-FIX-1 (blocker B6-C2): register the token literal BEFORE it is
    // incorporated into the header. If any later error mentions the raw
    // token WITHOUT the `Authorization:` / `Bearer ` prefix, the runtime
    // literal redactor still removes it — we do not rely solely on the
    // static regexes. If no operation scope is active (no MCP call), this
    // is a safe no-op.
    registerSensitiveValue(token);
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
    // B6-core: upstream error bodies can carry sensitive literals (tokens,
    // credentials). Redact both static class patterns and registered values
    // before the body becomes an Error message.
    const safeBody = redactSecrets(errBody || response.statusText);
    throw new Error(`Crunchyroll API error ${response.status}: ${safeBody}`);
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

// ── Gate B4 — refresh state machine (Architecture B) ─────────────────────────
//
// Separate login/refresh structural contracts (no global refresh_token
// optionality), a strict classification precedence, an internal
// refresh-specific path with process-local single-flight, and a safe
// internal failure contract. The generic request() is NOT redesigned.
// Shared-failure safety is SECRET-FREE BEFORE REJECT (B6 AsyncLocalStorage
// registry is defense-in-depth for the origin operation only — §10 of
// GATE-B4-PLAN.md).

/** B4 safe internal failure kinds. */
export type RefreshFailureKind = "REAUTH_REQUIRED" | "TRANSIENT" | "SAFE_FAILURE" | "MALFORMED_RESPONSE";

/**
 * Safe internal failure representation for the refresh operation.
 *
 * Secret-free by construction: it carries only kind + optional HTTP status
 * and a fixed generic message. It never carries raw bodies, parsed provider
 * objects, tokens, Authorization values, passwords or form bodies.
 */
export class RefreshError extends Error {
  constructor(
    public readonly kind: RefreshFailureKind,
    message: string,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = "RefreshError";
  }
}

const FIXED_MESSAGES: Record<RefreshFailureKind, string> = {
  REAUTH_REQUIRED: "Authentication refresh rejected; reauthentication required",
  TRANSIENT: "Authentication refresh temporarily unavailable",
  SAFE_FAILURE: "Authentication refresh failed",
  MALFORMED_RESPONSE: "Authentication refresh returned an invalid response",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function finitePositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Structural validation of a provider login token response.
 * refresh_token is REQUIRED for login. Provider payload enters as unknown
 * and is validated structurally (no TS casts as runtime validation).
 */
export function validateLoginTokenResponse(value: unknown): TokenResponse {
  if (!isPlainObject(value)) throw new RefreshError("MALFORMED_RESPONSE", FIXED_MESSAGES.MALFORMED_RESPONSE);
  const required: Array<[string, (v: unknown) => boolean]> = [
    ["access_token", nonEmptyString],
    ["refresh_token", nonEmptyString],
    ["expires_in", finitePositiveNumber],
    ["token_type", nonEmptyString],
    ["account_id", nonEmptyString],
  ];
  for (const [field, check] of required) {
    if (!check(value[field])) throw new RefreshError("MALFORMED_RESPONSE", FIXED_MESSAGES.MALFORMED_RESPONSE);
  }
  const profile_id = value["profile_id"];
  if (profile_id !== undefined && !nonEmptyString(profile_id)) {
    throw new RefreshError("MALFORMED_RESPONSE", FIXED_MESSAGES.MALFORMED_RESPONSE);
  }
  return value as unknown as TokenResponse;
}

/**
 * Structural validation of a provider REFRESH token response.
 * refresh_token is OPTIONAL ONLY for refresh: an ABSENT property means
 * non-rotation (the caller reuses the old refresh_token). A PRESENT but
 * invalid value (null, number, array, object, empty/whitespace string)
 * is MALFORMED_RESPONSE with no save and no clear.
 */
export function validateRefreshTokenResponse(value: unknown): {
  valid: true;
  response: TokenResponse;
} | { valid: false; rotated: false } {
  if (!isPlainObject(value)) return { valid: false, rotated: false };
  if (!nonEmptyString(value["access_token"])) return { valid: false, rotated: false };
  if (!finitePositiveNumber(value["expires_in"])) return { valid: false, rotated: false };
  if (!nonEmptyString(value["token_type"])) return { valid: false, rotated: false };
  if (!nonEmptyString(value["account_id"])) return { valid: false, rotated: false };
  const profile_id = value["profile_id"];
  if (profile_id !== undefined && !nonEmptyString(profile_id)) return { valid: false, rotated: false };
  // refresh_token semantics (B4 plan §12):
  //   absent property → valid non-rotation
  //   present + non-empty string → rotated (valid)
  //   present + anything else (null/number/array/object/empty/whitespace) → malformed
  if (!("refresh_token" in value)) return { valid: true, response: value as unknown as TokenResponse };
  if (nonEmptyString(value["refresh_token"])) return { valid: true, response: value as unknown as TokenResponse };
  return { valid: false, rotated: false };
}

/**
 * Classify a parsed provider refresh response body per the approved
 * precedence (B4 plan §10): semantic invalid_grant (strict ===) BEFORE any
 * HTTP-status classification.
 *
 * Returns a RefreshError for every failure case, or null when the body is
 * not classified as an error (success path must then validate the
 * structure).
 */
export function classifyRefreshResponse(status: number, body: unknown): RefreshError | null {
  // Precedence B: semantic invalid_grant — JSON object AND strict equality.
  if (isPlainObject(body) && body["error"] === "invalid_grant") {
    return new RefreshError("REAUTH_REQUIRED", FIXED_MESSAGES.REAUTH_REQUIRED, status);
  }
  if (status >= 400) {
    // Precedence D: 429 or any 5xx → TRANSIENT.
    if (status === 429 || status >= 500) {
      return new RefreshError("TRANSIENT", FIXED_MESSAGES.TRANSIENT, status);
    }
    // Precedence C/E: everything else non-2xx → SAFE_FAILURE (401/403
    // ambiguous and 400 non-invalid_grant both PRESERVE auth).
    return new RefreshError("SAFE_FAILURE", FIXED_MESSAGES.SAFE_FAILURE, status);
  }
  return null;
}

/**
 * Process-local, ephemeral single-flight reference for the refresh
 * operation (B4 plan §14). Module-private; never exported; never used as
 * global token cache; never holding secret values — it holds a Promise of
 * validated TokenData while in flight and is cleared in finally for both
 * success and failure paths.
 */
let refreshInFlight: Promise<TokenData> | undefined;

/**
 * Internal refresh-specific token path (Architecture B). Generic
 * request() is NOT used here: refresh classification requires local
 * inspection of the parsed response body BEFORE constructing any outward
 * or shared error, which the generic error surface cannot provide.
 *
 * Security invariant: the shared in-flight failure is secret-free before
 * reject — the provider response is parsed, classified, and reduced to a
 * fixed-message RefreshError before anything propagates to concurrent
 * callers. Callers never depend on the origin operation's B6 registry.
 */
async function refreshOperation(oldTokens: TokenData): Promise<TokenData> {
  // B6: register the old refresh token BEFORE the request body uses it.
  registerSensitiveValue(oldTokens.refresh_token);

  const bodyParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: oldTokens.refresh_token,
    scope: "offline_access",
  });

  let status: number;
  let bodyText: string;
  try {
    const response = await fetch(`${AUTH_BASE}/auth/v1/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${BASIC_AUTH}`,
      },
      body: bodyParams.toString(),
    });
    status = response.status;
    bodyText = await response.text();
  } catch {
    // Precedence A: fetch/network throw before any response → TRANSIENT,
    // old persisted state preserved, no save, no clear, no retry.
    throw new RefreshError("TRANSIENT", FIXED_MESSAGES.TRANSIENT);
  }

  // Classification FIRST: the HTTP status determines the failure class even
  // when the body cannot be parsed (an empty or non-JSON 429/5xx response
  // must still be TRANSIENT — classification must not depend on JSON).
  // Semantic invalid_grant (strict ===) still beats everything else, but
  // only when the body is actually JSON.
  let parsed: unknown = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
  }

  // Precedence B: semantic invalid_grant — requires a JSON object body.
  let classified: RefreshError | null = null;
  if (parsed && isPlainObject(parsed) && parsed["error"] === "invalid_grant") {
    classified = new RefreshError("REAUTH_REQUIRED", FIXED_MESSAGES.REAUTH_REQUIRED, status);
  } else if (status >= 400) {
    // HTTP-status classification (independent of JSON parsability).
    classified = classifyRefreshResponse(status, parsed);
  }
  if (classified) {
    if (classified.kind === "REAUTH_REQUIRED") {
      // Semantic invalid_grant: do not save the response, do not return the
      // old access token, attempt local clear (best-effort, unchanged B2/B3
      // semantics), throw, no retry.
      try {
        await clearAuthData();
      } catch {
        // clearAuthData is best-effort by design — never surface as a new error.
      }
    }
    throw classified;
  }

  // HTTP 2xx: structural validation (no partial persistence). A non-JSON or
  // structurally invalid 2xx body is MALFORMED_RESPONSE.
  if (parsed === null) {
    throw new RefreshError("MALFORMED_RESPONSE", FIXED_MESSAGES.MALFORMED_RESPONSE);
  }
  const validation = validateRefreshTokenResponse(parsed);
  if (!validation.valid) {
    throw new RefreshError("MALFORMED_RESPONSE", FIXED_MESSAGES.MALFORMED_RESPONSE);
  }

  const resp = validation.response;
  // B6: register the newly received access token (and the new refresh token
  // when rotated) before persistence.
  const newRefresh = resp.refresh_token ?? oldTokens.refresh_token;
  registerSensitiveValue(resp.access_token, newRefresh);

  const newTokens: TokenData = {
    access_token: resp.access_token,
    refresh_token: newRefresh,
    expires_at: Date.now() + resp.expires_in * 1000,
    token_type: resp.token_type,
    account_id: resp.account_id,
  };
  if (resp.profile_id) newTokens.profile_id = resp.profile_id;

  await saveTokens(newTokens);
  return newTokens;
}

/**
 * Public refresh entry point with process-local single-flight: while one
 * refresh is in flight, concurrent callers await the SAME Promise and
 * share the same success or the same secret-free failure. The reference is
 * cleared in finally after both outcomes.
 */
export async function refreshRequest(oldTokens: TokenData): Promise<TokenData> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshOperation(oldTokens).finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

// ── Auth helpers (Gate B4) ───────────────────────────────────────────────────

/** Validate the raw login provider payload BEFORE registering secrets or persisting. */
export function validatedLoginPayload(value: unknown): TokenResponse {
  return validateLoginTokenResponse(value);
}

export async function login(email: string, password: string): Promise<{ success: boolean; message: string }> {
  try {
    const body = new URLSearchParams({
      grant_type: "password",
      username: email,
      password,
      scope: "offline_access",
    });

    // Gate B4: the raw provider payload enters as unknown and is
    // structurally validated BEFORE any registration or persistence.
    // A 2xx body missing/invalidating refresh_token is a malformed login
    // response: login fails with no token/session persistence.
    const raw: unknown = await request<unknown>(`${AUTH_BASE}/auth/v1/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${BASIC_AUTH}`,
      },
      body: body.toString(),
      noAuth: true,
    });
    const resp = validateLoginTokenResponse(raw);

    // B6-FIX-1 (blocker B6-C2): a valid TokenResponse makes both tokens
    // known to this operation. Register them IMMEDIATELY — before any
    // subsequent operation (persistence, diagnostics, session save) that
    // could produce an outward error mentioning them. The values themselves
    // are NOT altered or masked: persistence (B2/B3) must still receive the
    // real token; the registry exists only to redact OUTPUT.
    registerSensitiveValue(resp.access_token, resp.refresh_token);

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

async function getValidToken(): Promise<{ token: string; account_id: string }> {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Not logged in. Use crunchyroll_login first.");

  if (isTokenExpired(tokens)) {
    // Gate B4: the refresh goes through the state machine — classification,
    // rotation, non-rotation preservation, single-flight and secret-free
    // shared failure. Any failure surfaces as a RefreshError whose kind
    // determines the outcome for the caller (no automatic retry).
    return { token: (await refreshRequest(tokens)).access_token, account_id: tokens.account_id };
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
