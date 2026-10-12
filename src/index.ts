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
import { TransportError } from "./transport/transport-error.js";
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
const authOrchestrator = createAuthOrchestrator({
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

/** How long a content call waits for a silent re-establishment. */
const SILENT_REAUTH_WAIT_MS = 45_000;

/**
 * The observed bearer expires within minutes and carries no refresh token.
 * When a content call finds the session EXPIRED (it was established in this
 * process and has simply run out), re-establish it from the signed-in browser
 * once and retry. AUTH_NOT_READY is raised before anything is dispatched, so
 * the retry can never repeat a request. A session that was never established
 * (or was logged out) still gets the honest error: opening a browser stays an
 * explicit crunchyroll_login decision.
 */
async function callContentTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await contentGateway.callTool(name, args);
  } catch (error) {
    const expired =
      error instanceof TransportError &&
      error.kind === "AUTH_NOT_READY" &&
      authAuthority.diagnostics().availability === "READY" &&
      !authAuthority.hasUsableRecord();
    if (!expired) throw error;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      authOrchestrator.login(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), SILENT_REAUTH_WAIT_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (!outcome?.accepted || !authAuthority.hasUsableRecord()) throw error;
    return await contentGateway.callTool(name, args);
  }
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
    openChannel: () => managedBrowser().openApiExecutionChannel(),
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
        "Play an episode or movie: opens its Crunchyroll watch page in a new tab of the signed-in managed browser. Use the episode id from crunchyroll_get_episodes (not a series or season id).",
      inputSchema: {
        type: "object",
        properties: {
          episode_id: { type: "string", description: "Crunchyroll episode or movie id, e.g. GRVN8MNQY" },
        },
        required: ["episode_id"],
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
server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
          const payload = await callContentTool(name, args as Record<string, unknown>);
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          };
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
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ accepted: outcome.accepted, ...outcome.readiness }, null, 2),
              },
            ],
          };
      }

      case "crunchyroll_logout": {
        // BT4: the exclusive logout gate holds for the whole transaction, the
        // live authority is invalidated BEFORE any filesystem work, and the
        // structured LogoutResult is passed through verbatim — the public
        // output contract is unchanged (the four-axis result is BT8's).
        const logoutResult = (await authOrchestrator.logout()).persistence as LogoutResult;
        const presentation = formatLogoutResult(logoutResult);
        return {
          content: [{ type: "text", text: JSON.stringify(presentation) }],
        };
      }

      case "crunchyroll_play": {
        const input = args as Record<string, unknown>;
        const episodeId = input.episode_id;
        if (
          Object.keys(input).some((key) => key !== "episode_id") ||
          typeof episodeId !== "string" ||
          !CONTENT_ID_PATTERN.test(episodeId)
        ) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "crunchyroll_play takes exactly one argument, episode_id: an uppercase Crunchyroll id such as GRVN8MNQY."
          );
        }
        const session = managedBrowser();
        await session.start();
        await session.openWatchPage(episodeId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { opened: true, episode_id: episodeId, url: `${CRUNCHYROLL_WATCH_URL_PREFIX}${episodeId}` },
                null,
                2
              ),
            },
          ],
        };
      }

      case "crunchyroll_status": {
        // Strictly read-only (§10): it never logs in, refreshes, mints,
        // commits, invalidates, mutates storage, navigates or reopens a
        // browser. It reports current known readiness and nothing else.
        const status = authOrchestrator.readiness();
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
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
      const safe = safeErrorWithCleanStack(err);
      const message = safe.message;
      const isAuthError = message.includes("Not logged in") || message.includes("401");
      const errResult = {
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
