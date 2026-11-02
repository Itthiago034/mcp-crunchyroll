import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { setLegacyAuthTransitionSink } from "./api.js";

// BT4: the auth authority and its trusted producer. Composed here and nowhere
// else — see the composition-root section below.
import { createAuthContextAuthority } from "./transport/auth-context.js";
import { createAuthProducer, createDefaultAuthProducerPorts } from "./transport/auth-producer.js";
import { createAuthOrchestrator } from "./transport/auth-orchestrator.js";
import { TransportError, type TransportErrorKind } from "./transport/transport-error.js";
import { createBrowserAuthObserver, CRUNCHYROLL_LOGIN_URL } from "./transport/browser-auth.js";
import {
  createBrowserSessionManager,
  createRealBrowserSessionSeams,
  type BrowserSessionManager,
} from "./transport/browser-session-manager.js";
import { browserProfileDir, resolveBrowserExecutable } from "./transport/browser-profile.js";
import { DEFAULT_BROWSER_SESSION_CONFIG } from "./transport/browser-lifecycle-types.js";

// BT5: the cutover. Content tools reach the browser transport through the
// gateway, or they are refused — there is no other route from here.
import { createOperationRegistry, PRODUCTION_OPERATIONS } from "./transport/operation-registry.js";
import { createTransportDispatcher } from "./transport/dispatcher.js";
import { createBrowserApiBackend } from "./transport/browser-api-backend.js";
import { createContentGateway } from "./transport/content-gateway.js";
import { installNodeCrunchyrollGuard } from "./transport/node-egress-guard.js";

// Player control and session recovery (Crunchyroll MCP 2.0).
import { AsyncLocalStorage } from "node:async_hooks";
import { createPlayerController, PLAYER_ACTIONS, type PlayerAction } from "./transport/player-controller.js";
import {
  callWithSession,
  createSessionRecovery,
  SESSION_HINTS,
  SessionRequiredError,
  type DispatchProbe,
} from "./transport/session-recovery.js";
import { createSessionEligibilityStore } from "./transport/session-eligibility.js";

// B6-core: operation-scoped secret redaction (internal, not an MCP surface).
import { withRedactionScope, safeErrorWithCleanStack, redactSecrets, sanitizeToolResult } from "./redact.js";
// Gate B5: structured logout domain types from the storage layer.
import type { LogoutResult } from "./api.js";

// ── Gate B5: logout presentation at the MCP boundary ─────────────────────────
//
// The domain (clearAuthData) computes the LogoutResult — state, per-artifact
// artifact states and reasons. This function is the ONLY place that turns
// that result into a human message; messages never contain paths, raw
// errors, stacks, or secret literals, and the CLEARED success message
// wording is preserved verbatim from the pre-B5 contract.
function formatLogoutResult(
  result: LogoutResult
): { success: boolean; state: string; tokens: { state: string; reason?: string }; session: { state: string; reason?: string }; message: string } {
  const { state } = result;
  let message: string;
  if (state === "CLEARED") {
    message = "Logged out successfully. Session tokens cleared.";
  } else if (state === "ALREADY_ABSENT") {
    message = "No session tokens found to clear.";
  } else if (state === "PARTIAL") {
    message = "Logged out partially. Some stored credentials could not be removed — check the per-artifact details for reasons.";
  } else {
    message = "Logout failed. No stored credentials were removed — check the per-artifact details for reasons.";
  }
  return {
    success: state === "CLEARED" || state === "ALREADY_ABSENT",
    state,
    tokens: result.tokens,
    session: result.session,
    message,
  };
}

// B6-FIX-1 (blocker B6-C2): closed list of tool argument fields whose values
// are known-sensitive. Never register every argument — query/title/series_id
// etc. are deliberately NOT secrets.
const SENSITIVE_ARG_KEYS = new Set(["password", "access_token", "refresh_token"]);

// ── Server Setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "crunchyroll", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ── BT4 composition root ─────────────────────────────────────────────────────
//
// This file is the ONLY place that constructs an auth authority, and it
// constructs EXACTLY ONE per MCP process — never one per request or per tool.
// The authority object itself never leaves this section: only the narrow
// writer port crosses into the producer, so no other module can install
// material, invalidate, mint a context or reach the reader side.
//
// BT5 derives the BT3 reader HERE, exactly once, and hands the port to the
// transport backend — the only module that calls `bind()`/`runCurrent()`. The
// authority object itself still never leaves this section.

const authAuthority = createAuthContextAuthority();
const authProducer = createAuthProducer(createDefaultAuthProducerPorts(authAuthority.asWriter()));

/**
 * The managed browser, built on first use.
 *
 * Construction resolves a real executable and can fail on a machine with no
 * supported browser installed. That must not stop the server from starting and
 * reporting an honest LOGIN_REQUIRED, so nothing is built until an interactive
 * login actually asks for it.
 */
let browserSession: BrowserSessionManager | undefined;

const CRUNCHYROLL_WATCH_URL_PREFIX = "https://www.crunchyroll.com/watch/";
const CONTENT_ID_PATTERN = /^[A-Z0-9]{1,32}$/;
/**
 * The only origins whose page contexts the player channel may talk to: the
 * watch page and the player frame it embeds. Build constants, never arguments.
 */
const CRUNCHYROLL_PLAYER_FRAME_ORIGINS = Object.freeze([
  "https://www.crunchyroll.com",
  "https://static.crunchyroll.com",
]);

function managedBrowser(): BrowserSessionManager {
  if (!browserSession) {
    browserSession = createBrowserSessionManager(
      {
        ...DEFAULT_BROWSER_SESSION_CONFIG,
        // The managed page opens directly on the FIXED login surface. It is a
        // constant of this build: never a tool argument, never an environment
        // variable, never assembled from a caller-supplied fragment.
        initialPageUrl: CRUNCHYROLL_LOGIN_URL,
        // Playback opens `<this><episode id>`; the id is validated, the prefix
        // is a constant of this build.
        watchPageBaseUrl: CRUNCHYROLL_WATCH_URL_PREFIX,
        playerFrameOrigins: CRUNCHYROLL_PLAYER_FRAME_ORIGINS,
        profileDir: browserProfileDir(),
        executablePath: resolveBrowserExecutable(),
      },
      createRealBrowserSessionSeams(DEFAULT_BROWSER_SESSION_CONFIG.cdpCommandTimeoutMs)
    );
  }
  return browserSession;
}

/**
 * Auth orchestration: the login gate, the exclusive logout gate and the honest
 * composite readiness report.
 *
 * The authority itself does not travel here either — the orchestrator receives
 * a closure over the two SAFE diagnostics (availability and whether the record
 * carries a profile id) and can neither read material nor commit one.
 */
/** Secret-free record that the human authorized the dedicated profile. */
const sessionEligibility = createSessionEligibilityStore();

const authOrchestrator = createAuthOrchestrator({
  eligibility: sessionEligibility,
  diagnostics: {
    // An expired browser bearer is not a usable session: report it as
    // unavailable so status is honest and login re-establishes instead of
    // answering "already authenticated".
    availability: () => (authAuthority.hasUsableRecord() ? "READY" : "UNAVAILABLE"),
    hasProfileId: () => authAuthority.diagnostics().hasProfileId,
  },
  browser: {
    lifecycleState: () => browserSession?.state(),
    // BT4-R1: read-only connection identity, so material observed on a
    // connection that has since been replaced can never be installed.
    connectionGeneration: () => browserSession?.connectionGeneration(),
    openLoginSurface: async () => {
      const session = managedBrowser();
      await session.start();
      await session.ensureManagedPage();
    },
  },
  producer: authProducer,
  observer: createBrowserAuthObserver({
    // The pattern is chosen by the observer module that owns the constant; the
    // manager only opens the closed channel it is handed.
    openInterception: (urlPattern) => managedBrowser().openResponseInterception(urlPattern),
    now: () => Date.now(),
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      // An observation deadline must never hold the process open by itself.
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
    // A signed-in page that is already open mints only on its own schedule;
    // navigating it again makes the provider mint now, under observation.
    afterArmed: () => managedBrowser().reloadManagedPage(),
  }),
});

/**
 * Session recovery for content calls (single-flight).
 *
 * The observed bearer expires within minutes and carries no refresh token, and
 * a cold process has none at all. Recovery classifies the session first and
 * re-establishes it silently ONLY when that is a reuse of a session the human
 * already authorized: expired in this process, or recorded as eligible by an
 * earlier process. Never-authorized, logged-out and revoked sessions get a
 * structured error instead — opening a login page for them stays an explicit
 * crunchyroll_login decision.
 */
const sessionRecovery = createSessionRecovery({
  usable: () => authAuthority.hasUsableRecord(),
  diagnostics: () => {
    const { availability, reason, cause } = authAuthority.diagnostics();
    return { availability, reason, cause };
  },
  authState: () => authOrchestrator.readiness().auth_state,
  eligibleForColdStart: () => sessionEligibility.isEligible(),
  loggedOutPersisted: () => sessionEligibility.loggedOutPersisted(),
  establishSilently: async (observationDeadlineMs) =>
    (await authOrchestrator.establishSilently({ observationDeadlineMs })).accepted,
  now: () => Date.now(),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
});

/**
 * Carries the per-call dispatch probe to the transport's channel opener. A
 * provider channel is opened inside the authorized execution, immediately
 * before the request, so "no channel opened" proves "nothing dispatched".
 */
const dispatchScope = new AsyncLocalStorage<DispatchProbe>();

async function callContentTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return callWithSession(
    sessionRecovery,
    (probe) => dispatchScope.run(probe, () => contentGateway.callTool(name, args)),
    (error) => error instanceof TransportError && error.kind === "AUTH_NOT_READY",
    { signal },
  );
}

// ── BT5 cutover ──────────────────────────────────────────────────────────────
//
// The Node egress assertion is installed unconditionally, at composition, for
// the life of the process: after the cutover Crunchyroll is reachable only from
// the managed browser, and any Node-originated attempt fails closed before a
// socket exists. It is scoped by destination host, so a loopback fixture or any
// unrelated destination is untouched.
installNodeCrunchyrollGuard();

/**
 * The content boundary: registry → dispatcher → browser transport.
 *
 * BT3's reader is the only auth surface that crosses. It snapshots the record
 * once per operation, registers the bearer as a secret, and performs the final
 * generation commit check itself — so a response obtained under a session that
 * has since changed is discarded rather than returned.
 */
const contentGateway = (() => {
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const backend = createBrowserApiBackend({
    openChannel: () => {
      const probe = dispatchScope.getStore();
      if (probe) probe.dispatched = true;
      return managedBrowser().openApiExecutionChannel();
    },
    reader: authAuthority.asReader(),
  });
  return createContentGateway(createTransportDispatcher(registry, backend), registry);
})();

// BT4-D2: the legacy refresh path notifies us on a semantic invalid_grant so
// the LIVE authority is invalidated BEFORE `clearAuthData()` runs. The sink is
// synchronous, holds no state, and never re-enters the legacy module.
setLegacyAuthTransitionSink({
  onInvalidGrant: () => {
    authProducer.invalidateForInvalidGrant();
    // The provider said this session must be re-established. That is a REASON,
    // recorded separately from availability, so status can distinguish "never
    // logged in" from "log in again".
    authOrchestrator.signalReauthRequired();
  },
});

/**
 * Native player control. Every browser action goes through the session
 * manager's closed playback channel; there is no evaluate, no CDP pass-through
 * and no terminal fallback anywhere on this path.
 */
const playerController = createPlayerController({
  openChannel: async () => {
    const session = managedBrowser();
    // Reattach to the owned browser a previous process left running, but never
    // spawn one: pausing must not open a window. Only from STOPPED: a starting
    // or reconnecting manager is left to finish on its own, and the channel
    // below refuses until it is ready.
    if (session.state() === "STOPPED") await session.start({ adoptOnly: true });
    return session.openPlaybackControlChannel();
  },
  permission: () => {
    if (authOrchestrator.readiness().auth_state === "LOGGING_OUT") return "LOGGING_OUT";
    if (sessionRecovery.classify() === "LOGGED_OUT") return "LOGGED_OUT";
    return "OK";
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** How long crunchyroll_play waits for a freshly opened player before acting. */
const PLAY_READY_WAIT_MS = 20_000;
/** After a confirmed play, how long to watch current_time advance. Returns early once it moves. */
const PLAY_PROGRESS_WAIT_MS = 2_500;

// ── Result shaping ────────────────────────────────────────────────────────────

/**
 * One result shape for every tool. The text is COMPACT JSON (no indentation:
 * fewer tokens for the model to read on every call) and the same value travels
 * as `structuredContent`, so a client can use the object without parsing a
 * JSON string out of the text.
 */
function jsonResult(value: unknown, isError = false) {
  const structured =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

const LOGIN_HINT =
  "Call crunchyroll_login once (no arguments; it takes seconds while the browser is signed in), then retry this call. Do not ask the user for credentials.";

/** Structural details that are safe and useful to show. Everything else is dropped. */
const PUBLIC_ERROR_DETAILS: ReadonlySet<string> = new Set([
  "empty-response",
  "html-response",
  "json-response",
  "other-response",
  "watchlist-item-absent",
  "over-cap",
  "deadline",
]);

const TRANSPORT_ERROR_GUIDANCE: Partial<Record<TransportErrorKind, { retryable: boolean; hint: string }>> = {
  AUTH_NOT_READY: { retryable: true, hint: LOGIN_HINT },
  AUTH_GENERATION_CHANGED: {
    retryable: true,
    hint: "The session changed while this call was running. Retry the same call once.",
  },
  API_UNAUTHORIZED: { retryable: true, hint: LOGIN_HINT },
  API_FORBIDDEN: {
    retryable: false,
    hint: "Crunchyroll refused THIS operation (detail html-response usually means a temporary edge or bot challenge; json-response means the profile, region or subscription does not allow it). If other tools still work, the session is fine: do not log in again or loop. Try once more later, or continue without this data.",
  },
  API_NOT_FOUND: {
    retryable: false,
    hint: "No such item. Check the id: series, season, episode and movie ids are different; get them from crunchyroll_search, crunchyroll_get_seasons or crunchyroll_get_episodes.",
  },
  API_RATE_LIMITED: {
    retryable: true,
    hint: "Crunchyroll is rate limiting. Wait a few seconds before the next call and avoid parallel calls.",
  },
  API_SERVER_ERROR: { retryable: true, hint: "Crunchyroll had a server error. Retry once after a short wait." },
  API_BAD_REQUEST: { retryable: false, hint: "Crunchyroll rejected the arguments. Check ids and values; do not retry unchanged." },
  API_CONFLICT: {
    retryable: false,
    hint: "The account is already in the requested state, or conflicts with it. Read it back before retrying.",
  },
  MUTATION_OUTCOME_UNKNOWN: {
    retryable: false,
    hint: "The change may or may not have been applied. Read the state back (see the tool's verify_with) before retrying, so the change is not applied twice.",
  },
  BROWSER_UNAVAILABLE: {
    retryable: true,
    hint: "The managed browser is not ready. Call crunchyroll_status, then retry once.",
  },
  TRANSPORT_FAILURE: { retryable: true, hint: "The request failed before an answer arrived. Retry once." },
  INVALID_RESPONSE: { retryable: true, hint: "Crunchyroll answered with something unexpected. Retry once; if it repeats, skip this data." },
  SCHEMA_MISMATCH: {
    retryable: false,
    hint: "Crunchyroll answered with a shape this server does not understand. Retrying will not help; report it.",
  },
  INVALID_ARGUMENTS: { retryable: false, hint: "Fix the arguments as described by the tool's input schema." },
  OPERATION_NOT_MIGRATED: {
    retryable: false,
    hint: "This tool is not available in this version. Use another tool for the same data.",
  },
};

// ── Tool Definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Auth
    {
      // BT4 completion §8 — BREAKING: no credential arguments of any kind.
      // The human types into Crunchyroll's own page in the managed browser;
      // this server never receives an email, password, code or cookie.
      name: "crunchyroll_login",
      description:
        "Log in to Crunchyroll interactively in the managed browser. Takes no arguments: you type your credentials into Crunchyroll's own page, and this server never receives them.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "crunchyroll_logout",
      description: "Log out and clear saved Crunchyroll session tokens.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "crunchyroll_status",
      description:
        "Report current Crunchyroll readiness: whether authenticated work is permitted, the browser lifecycle, and the auth state.",
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
      description:
        "Get all seasons of an anime series: id, title, season_number, number_of_episodes, original_audio and audio_versions (audio locale -> season id).",
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
      description:
        "Get all episodes in a specific season. Pass episode_number to get just that episode (recommended for long seasons).",
      inputSchema: {
        type: "object",
        properties: {
          season_id: { type: "string", description: "Crunchyroll season ID" },
          episode_number: {
            type: "number",
            description: "Optional: return only the episode with this episode_number",
          },
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
      description:
        "Get the user's watchlist (series saved to watch later): id, title, type, is_favorite, date_added. Honours n (default 20).",
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Series or movie ID to add" },
        },
        required: ["content_id"],
        additionalProperties: false,
      },
    },
    {
      name: "crunchyroll_remove_from_watchlist",
      description: "Remove an anime series or movie from the watchlist.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Series or movie ID to remove" },
        },
        required: ["content_id"],
        additionalProperties: false,
      },
    },

    {
      name: "crunchyroll_set_favorite",
      description:
        "Set whether a series or movie is a favorite (the heart). Idempotent: pass the state you want, favorite true or false; repeating the call never undoes it. Favoriting an item that is not on the watchlist adds it first (added_to_watchlist: true). Unfavoriting an item not on the watchlist is a NOOP.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Series or movie ID" },
          favorite: { type: "boolean", description: "true to favorite, false to unfavorite" },
        },
        required: ["content_id", "favorite"],
        additionalProperties: false,
      },
    },

    // History & Progress
    {
      name: "crunchyroll_get_history",
      description:
        "Get recently watched episodes, newest first: episode id, title, series/season/episode numbers, playhead (seconds), fully_watched and audio_versions (audio locale -> episode id to play).",
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          content_id: { type: "string", description: "Episode or movie ID" },
          playhead: { type: "number", description: "Position in seconds" },
        },
        required: ["content_id", "playhead"],
        additionalProperties: false,
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

    // Playback
    {
      name: "crunchyroll_play",
      description:
        "Play an episode or movie: opens its Crunchyroll watch page in the signed-in managed browser (reusing the playback tab if one is open). Use the episode id from crunchyroll_get_episodes (not a series or season id). Optional autoplay/fullscreen run the native player controls once the player loads and report each step as verified or not.",
      inputSchema: {
        type: "object",
        properties: {
          episode_id: { type: "string", description: "Crunchyroll episode or movie id, e.g. GRVN8MNQY" },
          autoplay: { type: "boolean", description: "Optional: start playback once the player loads (default false)" },
          fullscreen: { type: "boolean", description: "Optional: enter fullscreen once the player loads (default false)" },
        },
        required: ["episode_id"],
        additionalProperties: false,
      },
    },
    {
      name: "crunchyroll_player_control",
      description:
        "Control the video already open in the managed browser's playback tab: play, pause, fullscreen, exit_fullscreen, or status. Reports whether the command ran and whether the resulting state was verified. Use this instead of any script, terminal or browser automation.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [...PLAYER_ACTIONS],
            description: "play | pause | fullscreen | exit_fullscreen | status",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  ],
}));

// ── Tool Handlers ─────────────────────────────────────────────────────────────

// B6-core: every tool call runs inside an operation-scoped redaction scope.
// The registry is cleared unconditionally in `finally` (success, thrown
// error, rejected promise, early return), so registered sensitive material
// can never leak across operations — including concurrent ones, since the
// scope is carried by AsyncLocalStorage per async chain.
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  return withRedactionScope(async (scope) => {
    const { name, arguments: args = {} } = request.params;

    // B6: anything credential-shaped that arrives at the login tool is still
    // registered before it can reach an error path — the tool now REFUSES such
    // input (§8), and a refused credential must not leak on the way out either.
    if (name === "crunchyroll_login") {
      scope.registerSecret(
        ...Object.values(args as Record<string, unknown>)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
      );
    }

    // B6-FIX-1 (blocker B6-C2): register known-sensitive argument fields for
    // ANY tool, regardless of name (the deterministic MethodNotFound boundary
    // test relies on this too). Values are registered through the active
    // AsyncLocalStorage scope — outside a scope this is a no-op.
    for (const key of SENSITIVE_ARG_KEYS) {
      const v = (args as Record<string, unknown>)[key];
      if (typeof v === "string" && v.length > 0) scope.registerSecret(v);
    }

    try {
      // B6-FIX-2 (blocker B6-C1): the switch dispatch runs inside an internal
      // async IIFE so that EVERY tool success return converges to the single
      // `sanitizeToolResult(...)` call below — executed INSIDE the active
      // `withRedactionScope` callback, before `finally` clears the registry.
      // No per-tool patch: all 21 tools are covered by this one structure.
      // McpError throws from the switch (default case) propagate untouched to
      // the catch — ErrorCode and MethodNotFound semantics are preserved.
      const result = await (async () => {
        // ── BT5 cutover boundary ────────────────────────────────────────────
        //
        // Every content tool is decided HERE, once, before any handler runs.
        // A migrated operation goes to the browser transport; an unmigrated one
        // is refused with OPERATION_NOT_MIGRATED. Neither outcome can reach the
        // legacy Node client, because this boundary is the only route left and
        // it has no legacy branch.
        if (contentGateway.isContentTool(name)) {
          const payload = await callContentTool(name, args as Record<string, unknown>, extra?.signal);
          return jsonResult(payload);
        }

        switch (name) {
        // ── Auth ──────────────────────────────────────────────────────────────
        case "crunchyroll_login": {
          // Fails closed on BOTH surfaces: the published schema admits no
          // property, and any supplied argument is refused here with a typed
          // error rather than silently ignored. The refusal names no key and
          // echoes no value.
          if (Object.keys(args as Record<string, unknown>).length > 0) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "crunchyroll_login takes no arguments. Login is interactive: type your credentials into the Crunchyroll page in the managed browser. This server never accepts or stores them."
            );
          }
          const outcome = await authOrchestrator.login();
          return jsonResult({ accepted: outcome.accepted, ...outcome.readiness });
      }

      case "crunchyroll_logout": {
        // BT4: the exclusive logout gate holds for the whole transaction, the
        // live authority is invalidated BEFORE any filesystem work, and the
        // structured LogoutResult is passed through verbatim — the public
        // output contract is unchanged (the four-axis result is BT8's).
        const logoutResult = (await authOrchestrator.logout()).persistence as LogoutResult;
        const presentation = formatLogoutResult(logoutResult);
        return jsonResult(presentation);
      }

      case "crunchyroll_play": {
        const input = args as Record<string, unknown>;
        const episodeId = input.episode_id;
        const optionKeys = ["autoplay", "fullscreen"];
        if (
          Object.keys(input).some((key) => key !== "episode_id" && !optionKeys.includes(key)) ||
          optionKeys.some((key) => input[key] !== undefined && typeof input[key] !== "boolean") ||
          typeof episodeId !== "string" ||
          !CONTENT_ID_PATTERN.test(episodeId)
        ) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "crunchyroll_play takes episode_id (an uppercase Crunchyroll id such as GRVN8MNQY) and optional booleans autoplay and fullscreen."
          );
        }
        const session = managedBrowser();
        await session.start();
        await session.openWatchPage(episodeId);
        const opened = { opened: true, episode_id: episodeId, url: `${CRUNCHYROLL_WATCH_URL_PREFIX}${episodeId}` };
        // Without options the result is exactly the original contract.
        const steps: Array<["autoplay" | "fullscreen", PlayerAction]> = [];
        if (input.autoplay === true) steps.push(["autoplay", "play"]);
        if (input.fullscreen === true) steps.push(["fullscreen", "fullscreen"]);
        if (steps.length === 0) {
          return jsonResult(opened);
        }
        const reports: Record<string, unknown> = {};
        let allConfirmed = true;
        for (const [key, action] of steps) {
          const outcome = await playerController.perform(action, {
            expectContentId: episodeId,
            waitForReadyMs: PLAY_READY_WAIT_MS,
            ...(action === "play" ? { confirmProgressMs: PLAY_PROGRESS_WAIT_MS } : {}),
            signal: extra?.signal,
          });
          reports[key] = outcome;
          allConfirmed &&= outcome.success;
        }
        // "Opened" and "playing" are different facts: playing_verified is true
        // only when current_time was seen advancing after play.
        const playReport = reports.autoplay as { progress?: string } | undefined;
        const playingVerified = playReport ? playReport.progress === "ADVANCING" : undefined;
        return jsonResult({
          ...opened,
          success: allConfirmed,
          partial: !allConfirmed,
          ...(playingVerified === undefined ? {} : { playing_verified: playingVerified }),
          ...reports,
        });
      }

      case "crunchyroll_player_control": {
        const input = args as Record<string, unknown>;
        const action = input.action;
        // Discriminated by `action`: every action takes no other field, so any
        // extra key is refused instead of silently ignored.
        if (
          Object.keys(input).some((key) => key !== "action") ||
          typeof action !== "string" ||
          !PLAYER_ACTIONS.includes(action as PlayerAction)
        ) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "crunchyroll_player_control takes exactly one argument, action: play, pause, fullscreen, exit_fullscreen or status."
          );
        }
        const outcome = await playerController.perform(action as PlayerAction, {
          ...(action === "play" ? { confirmProgressMs: PLAY_PROGRESS_WAIT_MS } : {}),
          signal: extra?.signal,
        });
        return jsonResult(outcome, !outcome.success);
      }

      case "crunchyroll_status": {
        // Strictly read-only (§10): it never logs in, refreshes, mints,
        // commits, invalidates, mutates storage, navigates or reopens a
        // browser. It reports current known readiness and nothing else.
        const status = authOrchestrator.readiness();
        return jsonResult(status);
      }

        // ── Content ─────────────────────────────────────────────────────────
        // BT5 cutover: every content tool is decided by the gateway BEFORE
        // this switch is reached, so no content case exists here any more and
        // no content path can reach the legacy Node client. See the
        // composition root's content boundary above.

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      })();
      return sanitizeToolResult(result);
    } catch (err) {
      // B6-FIX-2 (blocker B6-C1): every outward CallTool result — success or
      // error — passes through the central redaction boundary WHILE the
      // `withRedactionScope` callback is still executing, so the finally
      // cleanup still sees the full registry at redaction time. The error
      // path builds its own result below; see `return sanitizeToolResult(...)`
      // in the catch body.
      // B6-core: sanitize the error (preserving class, never mutating the
      // original) and redact registered secrets + static class patterns
      // from the message and stack before it reaches the model.
      if (err instanceof McpError) {
        // Re-derive the McpError message through the redactor: the SDK may
        // echo err.message into the wire payload.
        throw new McpError(err.code, redactSecrets(err.message));
      }
      if (err instanceof SessionRequiredError) {
        // Structured, fixed and secret-free: the code says WHY, the hint says
        // what to do, and neither is a reason to loop.
        return sanitizeToolResult(
          jsonResult(
            { error: err.message, code: err.code, session_state: err.sessionState, hint: SESSION_HINTS[err.code] },
            true
          )
        );
      }
      const safe = safeErrorWithCleanStack(err);
      const message = safe.message;
      let errResult;
      if (err instanceof TransportError) {
        // Closed vocabulary only: the kind, a whitelisted structural detail and
        // fixed guidance. No URL, header, body or identity can reach this.
        const guidance = TRANSPORT_ERROR_GUIDANCE[err.kind];
        const detail = err.detail !== undefined && PUBLIC_ERROR_DETAILS.has(err.detail) ? err.detail : undefined;
        errResult = jsonResult(
          {
            error: message,
            code: err.kind,
            ...(detail ? { detail } : {}),
            retryable: guidance?.retryable ?? false,
            ...(guidance ? { hint: guidance.hint } : {}),
          },
          true
        );
      } else {
        const isAuthError =
          message.includes("Not logged in") || message.includes("401") || message.includes("Not authenticated");
        errResult = jsonResult(
          {
            error: message,
            ...(isAuthError ? { hint: LOGIN_HINT } : {}),
          },
          true
        );
      }
      // B6-FIX-1: even error results cross the central boundary (the error
      // message is already redacted, but static patterns in surrounding text
      // and any remaining registered literal must also be covered here).
      return sanitizeToolResult(errResult);
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

/**
 * BT4: invalidate the live authority before asynchronous teardown.
 *
 * This is the existing teardown seam — no process manager is invented for it.
 * Shutting down is not logging out: persisted credentials are deliberately left
 * alone, only the process-local authority is dropped.
 */
function installShutdownInvalidation(): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      authProducer.invalidateForShutdown();
    } catch {
      // a terminal authority is already unavailable; never block teardown
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function main() {
  installShutdownInvalidation();

  // BT4 startup bootstrap: hardened storage is loaded and validated OUTSIDE the
  // authority and installed through an explicit ESTABLISH compare-and-swap.
  // Nothing is trusted merely because a file exists, and every non-installing
  // outcome leaves the process unavailable rather than pretending otherwise.
  // It never throws: a broken store must not stop the server from starting and
  // reporting an honest LOGIN_REQUIRED.
  try {
    await authProducer.bootstrapFromStorage();
  } catch {
    // fail closed and stay unavailable
  }

  const transport = new StdioServerTransport();
  // The stdio close path is the other teardown seam (§11): when the client
  // goes away, the process-local authority is dropped BEFORE the SDK's own
  // asynchronous teardown — the SDK chains this handler ahead of its own.
  // Closing is not logging out: persisted credentials are left alone.
  transport.onclose = () => {
    try {
      authProducer.invalidateForShutdown();
    } catch {
      // a terminal authority is already unavailable; never block teardown
    }
  };
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
