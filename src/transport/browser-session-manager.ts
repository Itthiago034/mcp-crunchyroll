import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type {
  AdoptedBrowserProcessHandle,
  BrowserLifecycleState,
  BrowserOwnershipRecord,
  BrowserProcessExit,
  BrowserProcessHandle,
  BrowserSessionConfig,
  CdpConnection,
  CdpConnector,
  Clock,
  DevToolsEndpoint,
  ProcessIdentityInspector,
  ProcessSpawner,
  SpawnedBrowserProcessHandle,
  ValidatedOwnedBrowser,
  ResponseInterception,
  PausedResponse,
  ApiExecutionChannel,
  ApiExecutionRequest,
  ApiExecutionResponse,
  PlaybackChannelLoss,
  PlaybackControlChannel,
  PlayerCommand,
  PlayerCommandResult,
  PlayerFrameState,
  PlayerPageError,
} from "./browser-lifecycle-types.js";
import { MAX_API_RESPONSE_BYTES, PLAYER_COMMANDS } from "./browser-lifecycle-types.js";
import { BrowserLifecycleError } from "./browser-lifecycle-error.js";
import { createCdpConnector } from "./cdp-client.js";
import { desktopSessionEnvironment } from "./desktop-session.js";
import {
  clearOwnershipRecord,
  clearStaleEndpoint,
  createProcessIdentityInspector,
  ensureBrowserProfile,
  profileSingletonMatchesPid,
  readOwnershipRecord,
  readDevToolsEndpoint,
  writeOwnershipRecord,
} from "./browser-profile.js";

export interface BrowserSessionSeams {
  readonly spawner: ProcessSpawner;
  readonly clock: Clock;
  readonly connector: CdpConnector;
  readonly processInspector: ProcessIdentityInspector;
}

export type LifecycleEvent =
  | { readonly type: "launch.attempt"; readonly attempt: number }
  | { readonly type: "exit.classified"; readonly classification: string }
  | { readonly type: "cdp.connected" }
  | { readonly type: "cdp.disconnected" }
  | { readonly type: "reconnect.attempt"; readonly attempt: number }
  | { readonly type: "recovery.exhausted" }
  | { readonly type: "page.recreated" }
  | { readonly type: "ownership.adopted" }
  | { readonly type: "ownership.rejected"; readonly reason: string };

export interface BrowserSessionManager {
  state(): BrowserLifecycleState;
  /**
   * BT4-R1: the CURRENT connection generation, or `undefined` when no
   * connection is live. Read-only evidence of identity — it grants no
   * capability and exposes nothing about the session — so a consumer holding
   * material observed on an older connection can refuse to act on it.
   */
  connectionGeneration(): number | undefined;
  /**
   * Start or adopt the owned browser. With `adoptOnly`, only an already-running
   * browser that passes every ownership check is adopted; nothing is spawned,
   * so a control action can never open a browser window by itself.
   */
  start(options?: { readonly adoptOnly?: boolean }): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  managedPageId(): string | undefined;
  ensureManagedPage(): Promise<string>;
  /**
   * BT4: open a closed response-stage interception channel on the managed page
   * for ONE fixed URL pattern.
   *
   * This is not a generic CDP surface: the returned channel exposes only
   * paused-response notification, a bounded body read, response continuation
   * and close. The manager itself gains no auth field, no token and no
   * identity — it opens and closes a channel and nothing more.
   */
  openResponseInterception(urlPattern: string): Promise<ResponseInterception>;
  /**
   * Reload the EXISTING managed page, so the provider's own page mints a fresh
   * bearer while an interception is armed. Takes no URL. A missing page is a
   * no-op: creating one already navigates.
   */
  reloadManagedPage(): Promise<void>;
  /**
   * Open a Crunchyroll playback page for ONE content id in a focused tab of the
   * signed-in browser, reusing an existing playback tab when there is one. The id must be a plain Crunchyroll id; the URL is
   * the configured fixed prefix plus that id. The tab is not the managed page,
   * so re-authentication never navigates away from what is playing.
   */
  openWatchPage(contentId: string): Promise<void>;
  /**
   * BT5: open the closed browser-context execution channel on the managed
   * Crunchyroll page.
   *
   * It exposes exactly one verb, `request`, which runs one frozen function
   * with structured arguments. There is no evaluate, no caller-supplied
   * function, no method string and no access to any other execution context.
   */
  openApiExecutionChannel(): Promise<ApiExecutionChannel>;
  /**
   * Open the closed playback control channel on the playback tab: the tab this
   * manager opened with `openWatchPage`, or the single watch tab of the owned
   * browser. It runs one frozen page function with a closed command enum, only
   * in page and player-frame contexts on the configured origins. There is no
   * evaluate, no caller-chosen function and no other target.
   */
  openPlaybackControlChannel(): Promise<PlaybackControlChannel>;
  onStateChange(
    listener: (from: BrowserLifecycleState, to: BrowserLifecycleState) => void,
  ): void;
  onLifecycleEvent(listener: (event: LifecycleEvent) => void): void;
}

const ENDPOINT_POLL_INTERVAL_MS = 50;
const ADOPTED_PROCESS_POLL_INTERVAL_MS = 250;

// ── BT5 — the authorized browser-context execution channel ──────────────────

/** The only origin a page context may have to be used, and to be talked to. */
const CRUNCHYROLL_PAGE_ORIGIN = "https://www.crunchyroll.com";

/**
 * The ONE function that ever runs in the page, frozen as a source literal.
 *
 * It is never assembled, interpolated or influenced by a caller, the registry,
 * the response or anything remote: the url, method, Authorization value and cap
 * arrive as structured CDP arguments, which is exactly why this can be a
 * constant. `credentials: "omit"` keeps the browser's cookie jar out of the
 * request, and `redirect: "manual"` means a redirect is reported rather than
 * silently followed to an unvalidated origin.
 *
 * BT8.1 added two further structured arguments so a descriptor-declared body
 * can travel. They change nothing about who decides what is sent: this function
 * still sets exactly TWO header names, both literal in its own source, and a
 * caller can name neither. `Content-Type` is set ONLY when a body is actually
 * present, so a bodyless request keeps the header set it has always had, and a
 * write can never be sent under whatever default the page would have chosen.
 */
export const CRUNCHYROLL_FETCH_FUNCTION = `
  async function (url, method, authorization, maxBytes, bodyText, bodyContentType) {
    const headers = { Authorization: authorization };
    const init = { method, headers, credentials: "omit", redirect: "manual" };
    if (typeof bodyText === "string") {
      headers["Content-Type"] = bodyContentType;
      init.body = bodyText;
    }
    const response = await fetch(url, init);
    const contentType = response.headers.get("content-type") || "";
    let text = "";
    let truncated = false;
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let finished = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            finished = true;
            text += decoder.decode();
            break;
          }
          const remaining = maxBytes - bytes;
          if (chunk.value.byteLength > remaining) {
            text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
            truncated = true;
            break;
          }
          bytes += chunk.value.byteLength;
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        if (!finished) {
          try { await reader.cancel(); } catch {}
        }
        reader.releaseLock();
      }
    }
    return {
      status: response.status,
      contentType,
      body: text,
      truncated,
    };
  }
`;

/** Origin+scheme equality, parsed — never a prefix test. */
function isCrunchyrollApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === CRUNCHYROLL_PAGE_ORIGIN &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

// ── Player control — the frozen player function ─────────────────────────────

/**
 * The ONE function the playback channel ever runs in a player frame, frozen as
 * a source literal exactly like the fetch function above.
 *
 * `command` is a member of a closed enum validated in Node before it is sent;
 * the switch below is the page's own refusal of anything else. It touches only
 * the frame's own `<video>` elements and the Fullscreen API, reads no cookie,
 * storage or network state, and returns primitives only — never `currentSrc`,
 * whose stream URL carries signed policy. `playWaitMs` bounds how long `play()`
 * may stay pending, so a stalled source reports PENDING instead of hanging.
 */
export const CRUNCHYROLL_PLAYER_FUNCTION = `
  async function (command, playWaitMs) {
    const pick = () => {
      let best = null;
      let bestScore = -1;
      for (const video of Array.from(document.querySelectorAll("video"))) {
        const rect = video.getBoundingClientRect();
        const sourced = video.currentSrc || video.srcObject ? 1 : 0;
        const score = sourced * 1e9 + Math.max(0, rect.width) * Math.max(0, rect.height);
        if (score > bestScore) { best = video; bestScore = score; }
      }
      return best;
    };
    const finite = (value) => (typeof value === "number" && isFinite(value) ? value : 0);
    const snapshot = (video) => ({
      hasVideo: video !== null,
      hasSource: video !== null && Boolean(video.currentSrc || video.srcObject),
      paused: video === null ? true : video.paused,
      ended: video === null ? false : video.ended,
      readyState: video === null ? 0 : video.readyState,
      currentTime: video === null ? 0 : finite(video.currentTime),
      duration: video === null ? 0 : finite(video.duration),
      muted: video === null ? false : video.muted,
      fullscreen: document.fullscreenElement !== null && document.fullscreenElement !== undefined,
      fullscreenEnabled: document.fullscreenEnabled === true,
      topLevel: window === window.top,
      mediaError: video !== null && video.error ? finite(video.error.code) : 0,
    });
    const video = pick();
    let error = null;
    try {
      if (command === "probe") {
        // read only
      } else if (command === "play") {
        if (video === null) error = "NO_VIDEO";
        else {
          const outcome = await Promise.race([
            video.play().then(() => "started"),
            new Promise((resolve) => setTimeout(() => resolve("pending"), playWaitMs)),
          ]);
          if (outcome === "pending") error = "PENDING";
        }
      } else if (command === "pause") {
        if (video === null) error = "NO_VIDEO";
        else video.pause();
      } else if (command === "enter_fullscreen") {
        if (video === null) error = "NO_VIDEO";
        else if (document.fullscreenEnabled !== true) error = "FULLSCREEN_DISABLED";
        else if (!document.fullscreenElement) {
          const target = window === window.top ? (video.parentElement || video) : document.documentElement;
          await target.requestFullscreen({ navigationUI: "hide" });
        }
      } else if (command === "exit_fullscreen") {
        if (document.fullscreenElement) await document.exitFullscreen();
      } else {
        error = "UNSUPPORTED_COMMAND";
      }
    } catch (caught) {
      const name = caught && caught.name;
      error =
        name === "NotAllowedError" ? "NOT_ALLOWED" :
        name === "AbortError" ? "ABORTED" :
        name === "NotSupportedError" ? "NOT_SUPPORTED" :
        name === "TypeError" ? "TYPE_ERROR" : "UNKNOWN";
    }
    return { state: snapshot(video), error };
  }
`;

const PLAYER_PAGE_ERRORS: readonly PlayerPageError[] = Object.freeze([
  "NO_VIDEO",
  "NOT_ALLOWED",
  "ABORTED",
  "NOT_SUPPORTED",
  "TYPE_ERROR",
  "PENDING",
  "FULLSCREEN_DISABLED",
  "UNSUPPORTED_COMMAND",
  "UNKNOWN",
]);

/** How long the page lets one `play()` stay pending before reporting PENDING. */
const PLAYER_PLAY_WAIT_MS = 3_000;

const CONTENT_ID = /^[A-Z0-9]{1,32}$/;

/**
 * Reduce whatever the page returned to the closed state shape. Every field is
 * type-checked; anything malformed makes the whole result unusable rather than
 * partially trusted.
 */
function parsePlayerResult(raw: unknown): PlayerCommandResult | undefined {
  const frame = (typeof raw === "object" && raw !== null ? raw : {}) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  if (frame.exceptionDetails !== undefined) return undefined;
  const value = frame.result?.value as { state?: Record<string, unknown>; error?: unknown } | undefined;
  const state = value?.state;
  if (typeof state !== "object" || state === null) return undefined;
  const booleans = ["hasVideo", "hasSource", "paused", "ended", "muted", "fullscreen", "fullscreenEnabled", "topLevel"];
  const numbers = ["readyState", "currentTime", "duration"];
  if (!booleans.every((key) => typeof state[key] === "boolean")) return undefined;
  if (!numbers.every((key) => typeof state[key] === "number" && Number.isFinite(state[key]))) return undefined;
  const parsed: PlayerFrameState = Object.freeze({
    hasVideo: state.hasVideo as boolean,
    hasSource: state.hasSource as boolean,
    paused: state.paused as boolean,
    ended: state.ended as boolean,
    readyState: state.readyState as number,
    currentTime: state.currentTime as number,
    duration: state.duration as number,
    muted: state.muted as boolean,
    fullscreen: state.fullscreen as boolean,
    fullscreenEnabled: state.fullscreenEnabled as boolean,
    topLevel: state.topLevel as boolean,
    mediaError:
      typeof state.mediaError === "number" && Number.isInteger(state.mediaError) &&
      state.mediaError >= 0 && state.mediaError <= 4
        ? state.mediaError
        : 0,
  });
  const error = value?.error;
  if (error === null || error === undefined) return Object.freeze({ state: parsed });
  return Object.freeze({
    state: parsed,
    error: PLAYER_PAGE_ERRORS.includes(error as PlayerPageError) ? (error as PlayerPageError) : "UNKNOWN",
  });
}

/** Parsed-origin membership, never a prefix test. */
function originAllowed(url: unknown, origins: readonly string[]): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.username === "" && parsed.password === "" && origins.includes(parsed.origin);
  } catch {
    return false;
  }
}

/** The content id of a watch URL under `base`, compared field by field. */
function watchContentId(url: unknown, base: string): string | undefined {
  if (typeof url !== "string") return undefined;
  let parsed: URL;
  let prefix: URL;
  try {
    parsed = new URL(url);
    prefix = new URL(base);
  } catch {
    return undefined;
  }
  if (parsed.origin !== prefix.origin || parsed.username !== "" || parsed.password !== "") return undefined;
  if (!parsed.pathname.startsWith(prefix.pathname)) return undefined;
  const id = parsed.pathname.slice(prefix.pathname.length).split("/")[0];
  return CONTENT_ID.test(id) ? id : undefined;
}

interface ValidatedProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: number;
}

interface ConnectionRegistration {
  readonly connection: CdpConnection;
  readonly generation: number;
  handledClose: boolean;
  phase: "candidate" | "ready";
  unsubscribeClose: () => void;
}

function createValidatedAdoptedProcessHandle(
  identity: ValidatedProcessIdentity,
  inspector: ProcessIdentityInspector,
  clock: Clock,
): AdoptedBrowserProcessHandle {
  const listeners = new Set<(exit: BrowserProcessExit) => void>();
  let timer: { cancel(): void } | undefined;
  let terminal: BrowserProcessExit | undefined;
  let disposed = false;

  const finish = (reason: "disappeared" | "identity-changed") => {
    if (terminal || disposed) return;
    terminal = { source: "adopted", reason };
    timer?.cancel();
    timer = undefined;
    for (const listener of [...listeners]) listener(terminal);
  };

  const poll = () => {
    if (disposed || terminal) return;
    timer = clock.setTimeout(() => {
      const current = inspector.startTimeTicks(identity.pid);
      if (current === null) finish("disappeared");
      else if (current !== identity.startTimeTicks) finish("identity-changed");
      else poll();
    }, ADOPTED_PROCESS_POLL_INTERVAL_MS);
  };

  return {
    source: "adopted",
    pid: identity.pid,
    onExit(listener) {
      let active = true;
      if (terminal) queueMicrotask(() => { if (active) listener(terminal!); });
      else {
        listeners.add(listener);
        if (!timer) poll();
      }
      return () => { active = false; listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      timer?.cancel();
      timer = undefined;
      listeners.clear();
    },
  };
}

function launchArguments(
  config: BrowserSessionConfig,
  canonicalProfile = config.profileDir,
): readonly string[] {
  const common = [
    `--user-data-dir=${canonicalProfile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-mode",
  ];
  return Object.freeze(
    config.launchMode === "headless" ? [...common, "--headless=new"] : common,
  );
}

async function waitForEndpoint(
  config: BrowserSessionConfig,
  clock: Clock,
  deadline: number,
): Promise<DevToolsEndpoint> {
  for (;;) {
    try {
      return await readDevToolsEndpoint(config.profileDir);
    } catch (error) {
      if (
        !(error instanceof BrowserLifecycleError) ||
        error.kind !== "ENDPOINT_UNAVAILABLE"
      ) throw error;
    }
    if (clock.now() >= deadline) throw new BrowserLifecycleError("LAUNCH_TIMEOUT");
    await clock.sleep(Math.min(ENDPOINT_POLL_INTERVAL_MS, deadline - clock.now()));
  }
}

export function createBrowserSessionManager(
  config: BrowserSessionConfig,
  seams: BrowserSessionSeams,
): BrowserSessionManager {
  let lifecycleState: BrowserLifecycleState = "STOPPED";
  let startFlight: Promise<void> | undefined;
  let startFlightAdoptOnly = false;
  let stopFlight: Promise<void> | undefined;
  let stopRequested = false;
  let processHandle: BrowserProcessHandle | undefined;
  let connection: CdpConnection | undefined;
  let endpoint: DevToolsEndpoint | undefined;
  let nextConnectionGeneration = 0;
  let activeConnectionGeneration = 0;
  let connectionRegistration: ConnectionRegistration | undefined;
  let removeExitListener: (() => void) | undefined;
  let stopExitResolve: (() => void) | undefined;
  let recoveryFlight: Promise<void> | undefined;
  let reconnectFlight: Promise<void> | undefined;
  let managedTargetId: string | undefined;
  let managedPageFlight: Promise<string> | undefined;
  /** The tab `openWatchPage` last opened or reused. Browser-scoped target id. */
  let playbackTargetId: string | undefined;
  const stateListeners = new Set<(
    from: BrowserLifecycleState,
    to: BrowserLifecycleState,
  ) => void>();
  const lifecycleListeners = new Set<(event: LifecycleEvent) => void>();

  const emit = (event: LifecycleEvent) => {
    for (const listener of lifecycleListeners) listener(event);
  };
  const transition = (next: BrowserLifecycleState) => {
    if (lifecycleState === next) return;
    const previous = lifecycleState;
    lifecycleState = next;
    for (const listener of stateListeners) listener(previous, next);
  };

  const disposeConnection = () => {
    const registration = connectionRegistration;
    connectionRegistration = undefined;
    if (registration) {
      registration.unsubscribeClose();
      registration.connection.close();
      if (activeConnectionGeneration === registration.generation) {
        activeConnectionGeneration = 0;
      }
    } else {
      connection?.close();
    }
    connection = undefined;
  };

  const disposeActive = () => {
    removeExitListener?.();
    removeExitListener = undefined;
    processHandle?.dispose();
    processHandle = undefined;
    releaseApiAttachment();
    disposeConnection();
    endpoint = undefined;
    managedTargetId = undefined;
    managedPageFlight = undefined;
    playbackTargetId = undefined;
  };

  const createManagedPage = async (recreated: boolean): Promise<string> => {
    const active = connectionRegistration;
    if (
      lifecycleState !== "BROWSER_READY" ||
      stopRequested ||
      !active ||
      active.generation !== activeConnectionGeneration
    ) {
      throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
    }
    // The dedicated browser outlives this process and is adopted by the next
    // one. Reuse a page already on the managed origin instead of opening a new
    // tab per process: otherwise every client session leaves one more live
    // Crunchyroll tab behind. Playback tabs are left alone.
    const reusable = await findReusableManagedPage(active);
    if (reusable) {
      if (active.generation !== activeConnectionGeneration) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      managedTargetId = reusable;
      if (recreated) emit({ type: "page.recreated" });
      return reusable;
    }
    const result = (await active.connection.send("Target.createTarget", {
      url: config.initialPageUrl,
    })) as { targetId?: unknown };
    if (
      active.generation !== activeConnectionGeneration ||
      typeof result.targetId !== "string" ||
      result.targetId.length === 0
    ) {
      throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
    }
    managedTargetId = result.targetId;
    if (recreated) emit({ type: "page.recreated" });
    return result.targetId;
  };

  const findReusableManagedPage = async (
    active: ConnectionRegistration,
  ): Promise<string | undefined> => {
    let origin: string;
    try {
      origin = new URL(config.initialPageUrl).origin;
    } catch {
      return undefined;
    }
    if (origin === "null") return undefined;
    let listed: unknown;
    try {
      listed = await active.connection.send("Target.getTargets", {});
    } catch {
      return undefined;
    }
    const infos = (listed as { targetInfos?: unknown } | undefined)?.targetInfos;
    if (!Array.isArray(infos)) return undefined;
    for (const info of infos) {
      if (typeof info !== "object" || info === null) continue;
      const { type, url, targetId, attached } = info as Record<string, unknown>;
      if (type !== "page" || typeof url !== "string" || typeof targetId !== "string") continue;
      if (attached === true) continue;
      if (config.watchPageBaseUrl && url.startsWith(config.watchPageBaseUrl)) continue;
      let pageOrigin: string;
      try {
        pageOrigin = new URL(url).origin;
      } catch {
        continue;
      }
      if (pageOrigin === origin) return targetId;
    }
    return undefined;
  };

  const findPlaybackPage = async (
    active: ConnectionRegistration,
    base: string,
  ): Promise<string | undefined> => {
    let listed: unknown;
    try {
      listed = await active.connection.send("Target.getTargets", {});
    } catch {
      return undefined;
    }
    const infos = (listed as { targetInfos?: unknown } | undefined)?.targetInfos;
    if (!Array.isArray(infos)) return undefined;
    for (const info of infos) {
      if (typeof info !== "object" || info === null) continue;
      const { type, url, targetId } = info as Record<string, unknown>;
      if (type !== "page" || typeof url !== "string" || typeof targetId !== "string") continue;
      if (targetId === managedTargetId) continue;
      if (url.startsWith(base)) return targetId;
    }
    return undefined;
  };

  const beginManagedPageCreation = (recreated: boolean): Promise<string> => {
    if (managedPageFlight) return managedPageFlight;
    managedPageFlight = createManagedPage(recreated).finally(() => {
      managedPageFlight = undefined;
    });
    return managedPageFlight;
  };

  const prepareTargetObservation = async (registration: ConnectionRegistration) => {
    registration.connection.on("Target.targetDestroyed", (params) => {
      if (registration.generation !== activeConnectionGeneration) return;
      const destroyed = (params as { targetId?: unknown } | null)?.targetId;
      if (destroyed !== undefined && destroyed === playbackTargetId) playbackTargetId = undefined;
      if (
        typeof params !== "object" ||
        params === null ||
        (params as { targetId?: unknown }).targetId !== managedTargetId
      ) return;
      managedTargetId = undefined;
      if (lifecycleState === "BROWSER_READY" && !stopRequested && !managedPageFlight) {
        void beginManagedPageCreation(true).catch(() => undefined);
      }
    });
    await registration.connection.send("Target.setDiscoverTargets", { discover: true });
  };

  async function reconnectFromDisconnect(): Promise<void> {
    const reconnectEndpoint = endpoint;
    if (!reconnectEndpoint) return;
    for (let attempt = 1; attempt <= config.maxRecoveryAttempts; attempt += 1) {
      if (stopRequested) return;
      emit({ type: "reconnect.attempt", attempt });
      try {
        const candidate = await connectCandidate(reconnectEndpoint);
        if (stopRequested) {
          candidate.unsubscribeClose();
          candidate.connection.close();
          return;
        }
        if (candidate.handledClose) {
          throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
        }
        await prepareTargetObservation(candidate);
        if (candidate.handledClose) {
          throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
        }
        const previous = connectionRegistration;
        connection = candidate.connection;
        connectionRegistration = candidate;
        previous?.unsubscribeClose();
        candidate.phase = "ready";
        emit({ type: "cdp.connected" });
        transition("BROWSER_READY");
        return;
      } catch {
        await seams.clock.sleep(
          config.backoffMs[attempt - 1] ?? config.backoffMs.at(-1) ?? 0,
        );
      }
    }
    if (stopRequested) return;
    disposeActive();
    transition("STOPPED");
    emit({ type: "recovery.exhausted" });
  }

  function handleReadyConnectionClose(): void {
    if (stopRequested || lifecycleState !== "BROWSER_READY") return;
    emit({ type: "cdp.disconnected" });
    transition("DEGRADED");
    if (!reconnectFlight) {
      reconnectFlight = reconnectFromDisconnect().finally(() => {
        reconnectFlight = undefined;
      });
    }
  }

  async function connectCandidate(candidateEndpoint: DevToolsEndpoint) {
    const candidateConnection = await seams.connector.connect(
      candidateEndpoint.webSocketDebuggerUrl,
    );
    const generation = ++nextConnectionGeneration;
    activeConnectionGeneration = generation;
    let rejectClosed!: (error: Error) => void;
    const closed = new Promise<never>((_resolve, reject) => { rejectClosed = reject; });
    const registration = {
      connection: candidateConnection,
      generation,
      handledClose: false,
      phase: "candidate" as "candidate" | "ready",
      unsubscribeClose: (() => undefined) as () => void,
    };
    registration.unsubscribeClose = candidateConnection.onClose(() => {
      if (
        registration.handledClose ||
        registration.generation !== activeConnectionGeneration
      ) return;
      registration.handledClose = true;
      if (registration.phase === "candidate") {
        rejectClosed(new BrowserLifecycleError("BROWSER_DISCONNECTED"));
        return;
      }
      handleReadyConnectionClose();
    });

    try {
      await Promise.race([
        candidateConnection.send("Browser.getVersion"),
        closed,
      ]);
      if (registration.handledClose) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      return registration;
    } catch (error) {
      registration.unsubscribeClose();
      candidateConnection.close();
      if (activeConnectionGeneration === generation) activeConnectionGeneration = 0;
      if (error instanceof BrowserLifecycleError) throw error;
      throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
    }
  }

  const recoverFromCrash = async () => {
    disposeActive();
    transition("BROWSER_STARTING");
    for (let attempt = 1; attempt <= config.maxRecoveryAttempts; attempt += 1) {
      await seams.clock.sleep(config.backoffMs[attempt - 1] ?? config.backoffMs.at(-1) ?? 0);
      if (stopRequested) return;
      try {
        await startInternal(attempt);
        return;
      } catch {
        // The bounded loop owns recovery failure; no attempt escapes it.
      }
    }
    disposeActive();
    transition("STOPPED");
    emit({ type: "recovery.exhausted" });
  };

  const handleObservedExit = (exit: BrowserProcessExit) => {
    if (stopRequested) {
      emit({ type: "exit.classified", classification: "MANAGER_STOP" });
      stopExitResolve?.();
      return;
    }
    if (exit.source === "adopted") {
      emit({ type: "exit.classified", classification: "ADOPTED_EXIT_UNKNOWN" });
      disposeActive();
      void clearOwnershipRecord(config.profileDir);
      void clearStaleEndpoint(config.profileDir);
      transition("STOPPED");
      return;
    }
    if (exit.code === 0 && exit.signal === null) {
      emit({ type: "exit.classified", classification: "USER_CLOSED" });
      disposeActive();
      void clearOwnershipRecord(config.profileDir);
      void clearStaleEndpoint(config.profileDir);
      transition("STOPPED");
      return;
    }
    emit({ type: "exit.classified", classification: "CRASH" });
    if (!recoveryFlight) {
      recoveryFlight = recoverFromCrash().finally(() => { recoveryFlight = undefined; });
    }
  };

  const installExitObservation = (handle: BrowserProcessHandle) => {
    removeExitListener?.();
    removeExitListener = handle.onExit(handleObservedExit);
  };

  const endpointIsLoopback = (candidateEndpoint: DevToolsEndpoint): boolean => {
    try {
      const parsed = new URL(candidateEndpoint.webSocketDebuggerUrl);
      return (
        parsed.protocol === "ws:" &&
        parsed.hostname === "127.0.0.1" &&
        Number(parsed.port) === candidateEndpoint.port &&
        parsed.pathname === candidateEndpoint.browserPath
      );
    } catch {
      return false;
    }
  };

  async function tryAdoptOwnedBrowser(
    canonicalProfile: string,
    canonicalLauncherExecutable: string,
  ): Promise<{
    owned: ValidatedOwnedBrowser;
    registration: ConnectionRegistration;
  } | null> {
    let candidate: ConnectionRegistration | undefined;
    try {
      // Checks 1–3: schema, exact 0600 mode, and owner uid.
      const record = await readOwnershipRecord(config.profileDir);
      if (!record) return null;
      // Checks 4–5: canonical profile and configured launcher identities.
      if (record.profile !== canonicalProfile) throw new Error("profile");
      if (record.launcherExecutable !== canonicalLauncherExecutable) {
        throw new Error("launcher-executable");
      }
      // Checks 6–9: live pid, runtime executable, start time, and exact ProcessSingleton binding.
      if (!seams.processInspector.isAlive(record.pid)) throw new Error("dead");
      if (seams.processInspector.executable(record.pid) !== record.runtimeExecutable) {
        throw new Error("runtime-executable");
      }
      if (seams.processInspector.startTimeTicks(record.pid) !== record.startTimeTicks) {
        throw new Error("start-time");
      }
      if (!profileSingletonMatchesPid(canonicalProfile, record.pid, hostname())) {
        throw new Error("process-singleton");
      }
      // Checks 10–12: exact-profile endpoint, loopback invariant, and handshake.
      const ownedEndpoint = await readDevToolsEndpoint(config.profileDir);
      if (!endpointIsLoopback(ownedEndpoint)) throw new Error("endpoint");
      candidate = await connectCandidate(ownedEndpoint);
      if (candidate.handledClose) throw new Error("closed");
      // Check 13: final identity reread, then and only then construct the handle.
      if (seams.processInspector.startTimeTicks(record.pid) !== record.startTimeTicks) {
        throw new Error("final-identity");
      }
      const adoptedProcess = createValidatedAdoptedProcessHandle(
        { pid: record.pid, startTimeTicks: record.startTimeTicks },
        seams.processInspector,
        seams.clock,
      );
      return {
        owned: {
          record,
          endpoint: ownedEndpoint,
          connection: candidate.connection,
          process: adoptedProcess,
        },
        registration: candidate,
      };
    } catch {
      candidate?.unsubscribeClose();
      candidate?.connection.close();
      emit({ type: "ownership.rejected", reason: "validation" });
      await clearOwnershipRecord(config.profileDir).catch(() => undefined);
      await clearStaleEndpoint(config.profileDir).catch(() => undefined);
      return null;
    }
  }

  const startInternal = async (attempt = 1, adoptOnly = false) => {
    const launchDeadline = seams.clock.now() + config.launchDeadlineMs;
    transition("BROWSER_STARTING");
    stopRequested = false;
    emit({ type: "launch.attempt", attempt });
    await ensureBrowserProfile(config.profileDir);
    const canonicalProfile = seams.processInspector.canonicalPath(config.profileDir);
    const canonicalLauncherExecutable = seams.processInspector.canonicalPath(config.executablePath);
    if (!canonicalProfile || !canonicalLauncherExecutable) {
      transition("STOPPED");
      throw new BrowserLifecycleError("OWNERSHIP_INVALID");
    }

    const adopted = await tryAdoptOwnedBrowser(canonicalProfile, canonicalLauncherExecutable);
    if (adopted) {
      endpoint = adopted.owned.endpoint;
      connection = adopted.owned.connection;
      connectionRegistration = adopted.registration;
      processHandle = adopted.owned.process;
      try {
        installExitObservation(adopted.owned.process);
        await prepareTargetObservation(adopted.registration);
        if (adopted.registration.handledClose) {
          throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
        }
        adopted.registration.phase = "ready";
        emit({ type: "ownership.adopted" });
        emit({ type: "cdp.connected" });
        transition("BROWSER_READY");
        return;
      } catch {
        disposeActive();
        await clearOwnershipRecord(config.profileDir).catch(() => undefined);
        await clearStaleEndpoint(config.profileDir).catch(() => undefined);
      }
    }
    if (adoptOnly) {
      transition("STOPPED");
      throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-owned-browser");
    }
    await clearStaleEndpoint(config.profileDir);
    await clearOwnershipRecord(config.profileDir);

    let spawned: SpawnedBrowserProcessHandle;
    try {
      spawned = seams.spawner.spawn(
        config.executablePath,
        launchArguments(config, canonicalProfile),
      );
    } catch {
      transition("STOPPED");
      throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
    }
    processHandle = spawned;

    let cancelEarlyExit: (() => void) | undefined;
    const earlyExit = new Promise<never>((_resolve, reject) => {
      cancelEarlyExit = spawned.onExit(() => {
        reject(new BrowserLifecycleError("BROWSER_UNAVAILABLE"));
      });
    });

    try {
      if (spawned.pid <= 0) throw new BrowserLifecycleError("OWNERSHIP_INVALID");
      if (!seams.processInspector.isAlive(spawned.pid)) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      const startTimeTicks = seams.processInspector.startTimeTicks(spawned.pid);
      if (startTimeTicks === null) {
        throw new BrowserLifecycleError("OWNERSHIP_INVALID");
      }
      endpoint = await Promise.race([
        waitForEndpoint(config, seams.clock, launchDeadline),
        earlyExit,
      ]);
      const candidate = await Promise.race([connectCandidate(endpoint), earlyExit]);
      if (candidate.handledClose) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      if (
        !seams.processInspector.isAlive(spawned.pid) ||
        seams.processInspector.startTimeTicks(spawned.pid) !== startTimeTicks
      ) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      const runtimeExecutable = seams.processInspector.executable(spawned.pid);
      if (
        !runtimeExecutable ||
        seams.processInspector.startTimeTicks(spawned.pid) !== startTimeTicks ||
        !profileSingletonMatchesPid(canonicalProfile, spawned.pid, hostname())
      ) {
        throw new BrowserLifecycleError("OWNERSHIP_INVALID");
      }
      const record: BrowserOwnershipRecord = {
        version: 1,
        pid: spawned.pid,
        launcherExecutable: canonicalLauncherExecutable,
        runtimeExecutable,
        profile: canonicalProfile,
        startTimeTicks,
      };
      await writeOwnershipRecord(record, config.profileDir);
      await Promise.race([prepareTargetObservation(candidate), earlyExit]);
      if (candidate.handledClose) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      connection = candidate.connection;
      connectionRegistration = candidate;
      cancelEarlyExit?.();
      installExitObservation(spawned);
      candidate.phase = "ready";
      emit({ type: "cdp.connected" });
      transition("BROWSER_READY");
    } catch (error) {
      cancelEarlyExit?.();
      if (processHandle?.source === "spawned") processHandle.requestTermination();
      disposeActive();
      await clearOwnershipRecord(config.profileDir).catch(() => undefined);
      await clearStaleEndpoint(config.profileDir).catch(() => undefined);
      transition("STOPPED");
      if (error instanceof BrowserLifecycleError) throw error;
      throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
    }
  };

  // ── Shared page attachment for the API execution channel ────────────────
  //
  // One flat CDP session on the managed page, kept across requests. It tracks
  // the page's default Crunchyroll context through navigations, and is dropped
  // (and re-created on next use) whenever the connection generation, the
  // managed target or the session itself changes, or a request on it fails.
  interface ApiAttachment {
    readonly generation: number;
    readonly targetId: string;
    readonly sessionId: string;
    readonly connection: CdpConnection;
    contextId: number | undefined;
    live: boolean;
    unsubscribe: Array<() => void>;
  }
  let apiAttachment: ApiAttachment | undefined;
  let apiAttachmentFlight: Promise<ApiAttachment> | undefined;

  // The connection is going away: forget the attachment without talking to it.
  function releaseApiAttachment(): void {
    const current = apiAttachment;
    apiAttachment = undefined;
    if (!current) return;
    current.live = false;
    for (const off of current.unsubscribe) {
      try { off(); } catch {}
    }
    current.unsubscribe = [];
  }

  const dropApiAttachment = async (target?: ApiAttachment): Promise<void> => {
    const current = target ?? apiAttachment;
    if (!current) return;
    if (apiAttachment === current) apiAttachment = undefined;
    if (!current.live) return;
    current.live = false;
    for (const off of current.unsubscribe) {
      try { off(); } catch {}
    }
    current.unsubscribe = [];
    try {
      await current.connection.send("Target.detachFromTarget", { sessionId: current.sessionId });
    } catch {
      // a disconnected browser is already the outcome a drop wants
    }
  };

  const attachApiSession = async (
    active: ConnectionRegistration,
    targetId: string,
  ): Promise<ApiAttachment> => {
    const generation = active.generation;
    const attached = (await active.connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: unknown };
    const sessionId = attached.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
    }
    const attachment: ApiAttachment = {
      generation,
      targetId,
      sessionId,
      connection: active.connection,
      contextId: undefined,
      live: true,
      unsubscribe: [],
    };

    // Only contexts announced on THIS page's session are ever considered, and
    // among those only the main frame's default context on the expected
    // origin. An extension, a devtools page, an iframe or an unrelated
    // isolated world can never match, and nothing is ever "recovered" by
    // falling back to another one.
    attachment.unsubscribe.push(
      active.connection.on("Runtime.executionContextCreated", (params, frameSessionId) => {
        if (frameSessionId !== sessionId || !attachment.live) return;
        if (generation !== activeConnectionGeneration) return;
        const context = (params as { context?: { id?: unknown; origin?: unknown; auxData?: unknown } })
          ?.context;
        if (!context || typeof context.id !== "number") return;
        if (context.origin !== CRUNCHYROLL_PAGE_ORIGIN) return;
        const auxData = context.auxData as { isDefault?: unknown; frameId?: unknown } | undefined;
        if (auxData?.isDefault !== true) return;
        if (auxData.frameId !== undefined && auxData.frameId !== targetId) return;
        attachment.contextId = context.id;
      }),
      active.connection.on("Runtime.executionContextDestroyed", (params, frameSessionId) => {
        if (frameSessionId !== sessionId) return;
        const id = (params as { executionContextId?: unknown } | null)?.executionContextId;
        if (id === attachment.contextId) attachment.contextId = undefined;
      }),
      active.connection.on("Runtime.executionContextsCleared", (_params, frameSessionId) => {
        if (frameSessionId !== sessionId) return;
        attachment.contextId = undefined;
      }),
      active.connection.on("Target.detachedFromTarget", (params) => {
        if ((params as { sessionId?: unknown } | null)?.sessionId !== sessionId) return;
        attachment.live = false;
        if (apiAttachment === attachment) apiAttachment = undefined;
      }),
    );

    try {
      await active.connection.send("Runtime.enable", undefined, sessionId);
    } catch (error) {
      await dropApiAttachment(attachment);
      throw error;
    }
    if (attachment.contextId === undefined) {
      // Fail closed: no legitimate Crunchyroll page context exists right now.
      await dropApiAttachment(attachment);
      throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-page-context");
    }
    return attachment;
  };

  const acquireApiAttachment = async (active: ConnectionRegistration): Promise<ApiAttachment> => {
    const targetId = await manager.ensureManagedPage();
    const cached = apiAttachment;
    if (
      cached &&
      cached.live &&
      cached.generation === active.generation &&
      cached.connection === active.connection &&
      cached.targetId === targetId &&
      cached.contextId !== undefined
    ) {
      return cached;
    }
    // Concurrent first requests share one attach instead of racing several.
    if (apiAttachmentFlight) return apiAttachmentFlight;
    const flight = (async () => {
      if (cached) await dropApiAttachment(cached);
      const fresh = await attachApiSession(active, targetId);
      if (
        active.generation !== activeConnectionGeneration ||
        lifecycleState !== "BROWSER_READY" ||
        stopRequested
      ) {
        await dropApiAttachment(fresh);
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      apiAttachment = fresh;
      return fresh;
    })();
    apiAttachmentFlight = flight;
    try {
      return await flight;
    } finally {
      if (apiAttachmentFlight === flight) apiAttachmentFlight = undefined;
    }
  };

  const stopInternal = async () => {
    stopRequested = true;
    managedTargetId = undefined;
    if (!processHandle) {
      disposeActive();
      transition("STOPPED");
      return;
    }

    if (processHandle.source === "spawned") {
      const handle = processHandle;
      const exited = new Promise<void>((resolve) => {
        stopExitResolve = resolve;
      });
      const waitForExit = async () => {
        let timeout: { cancel(): void } | undefined;
        const timedOut = new Promise<"timeout">((resolve) => {
          timeout = seams.clock.setTimeout(() => resolve("timeout"), config.cdpCommandTimeoutMs);
        });
        try {
          return await Promise.race([exited.then(() => "exit" as const), timedOut]);
        } finally {
          timeout?.cancel();
        }
      };
      // Let Chromium flush the persistent profile before stopping the process.
      // SIGTERM alone can exit before recently accepted cookies reach disk.
      // A CDP acknowledgement is not an exit: wait for the owned child itself.
      let closedNormally = false;
      if (connection) {
        void connection.send("Browser.close").catch(() => undefined);
        closedNormally = (await waitForExit()) === "exit";
      }
      if (!closedNormally) {
        handle.requestTermination();
        if ((await waitForExit()) === "timeout") {
          handle.forceKill();
          await exited;
        }
      }
      stopExitResolve = undefined;
      disposeActive();
      await clearOwnershipRecord(config.profileDir);
      await clearStaleEndpoint(config.profileDir);
      transition("STOPPED");
      return;
    }

    const adoptedHandle = processHandle;
    let timeout: { cancel(): void } | undefined;
    const exited = new Promise<void>((resolve) => { stopExitResolve = resolve; });
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = seams.clock.setTimeout(() => resolve("timeout"), config.cdpCommandTimeoutMs);
    });
    void connection?.send("Browser.close").catch(() => undefined);
    const outcome = await Promise.race([exited.then(() => "exit" as const), timedOut]);
    timeout?.cancel();
    stopExitResolve = undefined;
    if (outcome === "exit") {
      adoptedHandle.dispose();
      disposeActive();
      await clearOwnershipRecord(config.profileDir);
      await clearStaleEndpoint(config.profileDir);
      transition("STOPPED");
      return;
    }
    adoptedHandle.dispose();
    disposeActive();
    transition("STOPPED");
    throw new BrowserLifecycleError("BROWSER_STOP_TIMEOUT");
  };

  const manager: BrowserSessionManager = {
    state: () => lifecycleState,
    // Zero is the module's own "no live connection" sentinel: generations start
    // at one and are reset to zero when the connection is disposed.
    connectionGeneration: () =>
      activeConnectionGeneration === 0 ? undefined : activeConnectionGeneration,
    start(options = {}) {
      if (lifecycleState === "BROWSER_READY") return Promise.resolve();
      const adoptOnly = options.adoptOnly === true;
      if (startFlight) {
        // A full start that finds an adopt-only flight must still be able to
        // spawn: if adoption fails, it starts again on its own terms.
        if (startFlightAdoptOnly && !adoptOnly) return startFlight.catch(() => manager.start());
        return startFlight;
      }
      startFlightAdoptOnly = adoptOnly;
      startFlight = startInternal(1, adoptOnly).finally(() => {
        startFlight = undefined;
        startFlightAdoptOnly = false;
      });
      return startFlight;
    },
    stop() {
      if (stopFlight) return stopFlight;
      stopFlight = stopInternal().finally(() => { stopFlight = undefined; });
      return stopFlight;
    },
    async restart() {
      await manager.stop();
      await manager.start();
    },
    managedPageId: () => managedTargetId,
    async ensureManagedPage() {
      if (lifecycleState !== "BROWSER_READY" || stopRequested) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      if (managedTargetId) return managedTargetId;
      return beginManagedPageCreation(false);
    },
    async reloadManagedPage() {
      const active = connectionRegistration;
      const targetId = managedTargetId;
      if (
        lifecycleState !== "BROWSER_READY" ||
        stopRequested ||
        !active ||
        active.generation !== activeConnectionGeneration ||
        !targetId
      ) {
        return;
      }
      const attached = (await active.connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId?: unknown };
      const sessionId = attached.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      try {
        // Reload what the page shows (a signed-in Crunchyroll page) instead of
        // returning to the login URL: a plain reload is ordinary browsing,
        // repeated trips to /login are what bot protection flags.
        await active.connection.send("Page.reload", {}, sessionId);
      } finally {
        try { await active.connection.send("Target.detachFromTarget", { sessionId }); } catch {}
      }
    },
    async openWatchPage(contentId: string) {
      if (typeof contentId !== "string" || !/^[A-Z0-9]{1,32}$/.test(contentId)) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      const base = config.watchPageBaseUrl;
      const active = connectionRegistration;
      if (
        !base ||
        lifecycleState !== "BROWSER_READY" ||
        stopRequested ||
        !active ||
        active.generation !== activeConnectionGeneration
      ) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      const url = `${base}${contentId}`;
      // "Play X" while something is already playing means switch to X: reuse
      // an existing playback tab instead of stacking one tab per request.
      let targetId = await findPlaybackPage(active, base);
      if (targetId) {
        const attached = (await active.connection.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        })) as { sessionId?: unknown };
        const sessionId = attached.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
        }
        try {
          await active.connection.send("Page.navigate", { url }, sessionId);
        } finally {
          try { await active.connection.send("Target.detachFromTarget", { sessionId }); } catch {}
        }
      } else {
        const result = (await active.connection.send("Target.createTarget", { url })) as {
          targetId?: unknown;
        };
        if (typeof result.targetId !== "string" || result.targetId.length === 0) {
          throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
        }
        targetId = result.targetId;
      }
      if (active.generation !== activeConnectionGeneration) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      playbackTargetId = targetId;
      await active.connection.send("Target.activateTarget", { targetId });
    },
    async openResponseInterception(urlPattern: string) {
      const active = connectionRegistration;
      if (
        lifecycleState !== "BROWSER_READY" ||
        stopRequested ||
        !active ||
        active.generation !== activeConnectionGeneration
      ) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      const targetId = await manager.ensureManagedPage();
      const generation = active.generation;

      const attached = (await active.connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId?: unknown };
      const sessionId = attached.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }

      const listeners = new Set<(event: PausedResponse) => void>();
      let closed = false;

      const unsubscribePaused = active.connection.on("Fetch.requestPaused", (params, frameSessionId) => {
        if (closed) return;
        if (frameSessionId !== sessionId) return;
        if (generation !== activeConnectionGeneration) return;
        if (typeof params !== "object" || params === null) return;
        const paused = params as {
          requestId?: unknown;
          request?: { url?: unknown };
          responseStatusCode?: unknown;
        };
        if (typeof paused.requestId !== "string") return;
        const url = paused.request?.url;
        if (typeof url !== "string") return;
        const event: PausedResponse = Object.freeze({
          requestId: paused.requestId,
          url,
          responseStatusCode:
            typeof paused.responseStatusCode === "number" ? paused.responseStatusCode : undefined,
        });
        for (const listener of [...listeners]) listener(event);
      });

      // Response stage only, for exactly the pattern the caller fixed. No
      // request-stage pause, so nothing here can modify an outgoing request.
      try {
        await active.connection.send(
          "Fetch.enable",
          { patterns: [{ urlPattern, requestStage: "Response" }] },
          sessionId
        );
      } catch (error) {
        unsubscribePaused();
        try { await active.connection.send("Target.detachFromTarget", { sessionId }); } catch {}
        throw error;
      }

      const interception: ResponseInterception = {
        connectionGeneration: generation,
        onPaused(listener) {
          listeners.add(listener);
        },
        async getResponseBody(requestId: string) {
          const result = (await active.connection.send(
            "Fetch.getResponseBody",
            { requestId },
            sessionId
          )) as { body?: unknown; base64Encoded?: unknown };
          return {
            body: typeof result.body === "string" ? result.body : "",
            base64Encoded: result.base64Encoded === true,
          };
        },
        async continueResponse(requestId: string) {
          await active.connection.send("Fetch.continueResponse", { requestId }, sessionId);
        },
        async close() {
          if (closed) return;
          closed = true;
          unsubscribePaused();
          listeners.clear();
          // Best effort: a disconnected browser is already the outcome close
          // wants, and teardown must never throw over it.
          try {
            await active.connection.send("Fetch.disable", undefined, sessionId);
          } catch {
            // ignored
          }
          try {
            await active.connection.send("Target.detachFromTarget", { sessionId });
          } catch {
            // ignored
          }
        },
      };
      return interception;
    },

    async openApiExecutionChannel() {
      const active = connectionRegistration;
      if (
        lifecycleState !== "BROWSER_READY" ||
        stopRequested ||
        !active ||
        active.generation !== activeConnectionGeneration
      ) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      // Latency: the page session is attached ONCE and reused by every later
      // request on the same connection generation and managed target. Only the
      // per-request `Runtime.callFunctionOn` crosses CDP on the hot path; the
      // attach / Runtime.enable / detach round trips are paid on first use and
      // after the page, target or connection changes.
      const attachment = await acquireApiAttachment(active);
      const generation = attachment.generation;
      const sessionId = attachment.sessionId;
      let closed = false;

      const channel: ApiExecutionChannel = {
        connectionGeneration: generation,

        async request(input: ApiExecutionRequest): Promise<ApiExecutionResponse> {
          if (closed) throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "channel-closed");
          // Revalidated here as well as at the transport: the page is only ever
          // asked for the origin this build is allowed to talk to.
          if (!isCrunchyrollApiUrl(input.url)) {
            throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "origin");
          }
          // BT8.1. Re-checked here for the same reason the origin is: a body is
          // ASSEMBLED, and anything assembled is worth checking twice, on both
          // sides of the boundary that carries it. The registry already refuses
          // a body on anything but a POST; this is the page's own refusal.
          if (input.body !== undefined && input.method !== "POST") {
            throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "body-method");
          }
          if (
            generation !== activeConnectionGeneration ||
            lifecycleState !== "BROWSER_READY" ||
            stopRequested
          ) {
            throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
          }
          // Read at request time: a navigation replaces the page context and the
          // attachment tracks it. No context right now is a pre-dispatch refusal.
          const contextId = attachment.contextId;
          if (!attachment.live || contextId === undefined) {
            throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-page-context");
          }

          let timer: { cancel(): void } | undefined;
          const deadlineError = new BrowserLifecycleError(
            "BROWSER_UNAVAILABLE",
            "deadline",
            "POSSIBLY_DISPATCHED",
            "deadline",
          );
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = seams.clock.setTimeout(
              () => reject(deadlineError),
              input.deadlineMs
            );
          });

          // The variable parts cross as STRUCTURED arguments. They are never
          // concatenated into the function source.
          //
          // BT8.1: the body pair is APPENDED, never sent as two empty slots, so
          // a request without one produces byte-identical CDP parameters to the
          // ones this channel has always sent.
          const callArguments: Array<{ value: unknown }> = [
            { value: input.url },
            { value: input.method },
            { value: input.authorization },
            { value: input.maxBytes },
          ];
          if (input.body !== undefined) {
            callArguments.push({ value: input.body.text }, { value: input.body.contentType });
          }

          let raw: unknown;
          try {
            // This invocation is the dispatch boundary. Once it starts, the
            // page-side fetch may have reached Crunchyroll even if CDP loses
            // the answer. Every failure from this promise is therefore marked
            // structurally as possibly dispatched; pre-flight checks above
            // retain the default PRE_DISPATCH state.
            const dispatched = active.connection.send(
              "Runtime.callFunctionOn",
              {
                functionDeclaration: CRUNCHYROLL_FETCH_FUNCTION,
                executionContextId: contextId,
                arguments: callArguments,
                awaitPromise: true,
                returnByValue: true,
                silent: true,
                userGesture: false,
              },
              sessionId
            );
            raw = await Promise.race([
              dispatched,
              deadline,
            ]);
          } catch (error) {
            // The shared attachment is no longer trusted after any failure on
            // it: the next request re-attaches from scratch.
            void dropApiAttachment(attachment);
            if (error === deadlineError) throw error;
            throw new BrowserLifecycleError(
              "BROWSER_DISCONNECTED",
              undefined,
              "POSSIBLY_DISPATCHED",
              "disconnect",
            );
          } finally {
            timer?.cancel();
          }

          // A valid JSON/CDP result can still be null or a primitive. Preserve
          // post-dispatch uncertainty instead of leaking an incidental TypeError.
          const frame = (typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? raw : {}) as {
            result?: { value?: unknown };
            exceptionDetails?: unknown;
          };
          if (frame.exceptionDetails !== undefined) {
            // The page threw. Its text may quote a URL or a header, so nothing
            // from it is carried out — only the structural fact.
            throw new BrowserLifecycleError(
              "BROWSER_UNAVAILABLE",
              "page-exception",
              "POSSIBLY_DISPATCHED",
              "page-exception",
            );
          }
          const value = frame.result?.value as Partial<ApiExecutionResponse> | undefined;
          if (
            !value ||
            typeof value.status !== "number" ||
            typeof value.contentType !== "string" ||
            typeof value.body !== "string" ||
            typeof value.truncated !== "boolean"
          ) {
            throw new BrowserLifecycleError(
              "BROWSER_UNAVAILABLE",
              "malformed-result",
              "POSSIBLY_DISPATCHED",
              "malformed",
            );
          }
          return Object.freeze({
            status: value.status,
            contentType: value.contentType,
            body: value.body,
            truncated: value.truncated,
          });
        },

        async close() {
          // Closing a channel releases this handle only. The shared page
          // attachment stays for the next request.
          closed = true;
        },
      };
      return channel;
    },
    async openPlaybackControlChannel(): Promise<PlaybackControlChannel> {
      const base = config.watchPageBaseUrl;
      const origins = config.playerFrameOrigins;
      const active = connectionRegistration;
      if (!base || !origins || origins.length === 0) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "player-control-unconfigured");
      }
      if (
        lifecycleState !== "BROWSER_READY" ||
        stopRequested ||
        !active ||
        active.generation !== activeConnectionGeneration
      ) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      const generation = active.generation;
      const cdp = active.connection;

      // ── Which tab: the one we opened, else the ONLY watch tab ─────────────
      let listed: unknown;
      try {
        listed = await cdp.send("Target.getTargets", {});
      } catch {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      const infos = (listed as { targetInfos?: unknown } | undefined)?.targetInfos;
      const watchTabs: string[] = [];
      let ownTabNavigating = false;
      for (const info of Array.isArray(infos) ? infos : []) {
        if (typeof info !== "object" || info === null) continue;
        const { type, url, targetId } = info as Record<string, unknown>;
        if (type !== "page" || typeof targetId !== "string" || targetId === managedTargetId) continue;
        if (watchContentId(url, base) !== undefined) watchTabs.push(targetId);
        // Mid-navigation Chromium reports an empty URL. The tab WE navigated is
        // still ours then; any other URL means it left the watch path.
        else if (targetId === playbackTargetId && (url === "" || url === "about:blank")) ownTabNavigating = true;
      }
      let targetId: string;
      if (playbackTargetId !== undefined && (ownTabNavigating || watchTabs.includes(playbackTargetId))) {
        targetId = playbackTargetId;
      } else if (watchTabs.length === 1) {
        targetId = watchTabs[0];
      } else {
        throw new BrowserLifecycleError(
          "BROWSER_UNAVAILABLE",
          watchTabs.length === 0 ? "no-playback-tab" : "ambiguous-playback-tab",
        );
      }
      if (generation !== activeConnectionGeneration) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }

      const attached = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
        sessionId?: unknown;
      };
      const sessionId = attached?.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }

      // ── Context bookkeeping, restricted to this tab and its player frames ──
      //
      // Only the page's own session and the iframe sessions auto-attached UNDER
      // it are ever considered, and only default worlds on an allowed origin.
      // An extension, an isolated world, another tab or an unrelated frame can
      // never become a target.
      interface FrameContext { readonly sessionId: string; readonly id: number; readonly top: boolean }
      const contexts = new Map<string, FrameContext>();
      const childSessions = new Set<string>();
      const ours = (sid: string | undefined) => sid === sessionId || (sid !== undefined && childSessions.has(sid));
      let lost: PlaybackChannelLoss | undefined;
      const unsubscribers: Array<() => void> = [];
      const markLost = (reason: PlaybackChannelLoss) => { if (!lost) lost = reason; };
      const childEnables: Array<Promise<unknown>> = [];

      unsubscribers.push(cdp.on("Runtime.executionContextCreated", (params, sid) => {
        if (!ours(sid) || generation !== activeConnectionGeneration) return;
        const context = (params as { context?: { id?: unknown; origin?: unknown; auxData?: unknown } })?.context;
        if (!context || typeof context.id !== "number") return;
        if ((context.auxData as { isDefault?: unknown } | undefined)?.isDefault !== true) return;
        if (!originAllowed(context.origin, origins)) return;
        contexts.set(`${sid}:${context.id}`, Object.freeze({ sessionId: sid!, id: context.id, top: sid === sessionId }));
      }));
      unsubscribers.push(cdp.on("Runtime.executionContextDestroyed", (params, sid) => {
        const id = (params as { executionContextId?: unknown })?.executionContextId;
        if (ours(sid) && typeof id === "number") contexts.delete(`${sid}:${id}`);
      }));
      unsubscribers.push(cdp.on("Runtime.executionContextsCleared", (_params, sid) => {
        if (!ours(sid)) return;
        for (const [key, context] of contexts) if (context.sessionId === sid) contexts.delete(key);
      }));
      unsubscribers.push(cdp.on("Target.attachedToTarget", (params, sid) => {
        if (!ours(sid) || generation !== activeConnectionGeneration) return;
        const child = params as { sessionId?: unknown; targetInfo?: { type?: unknown } };
        if (typeof child?.sessionId !== "string") return;
        if (child.targetInfo?.type !== "iframe") {
          void cdp.send("Target.detachFromTarget", { sessionId: child.sessionId }, sid).catch(() => undefined);
          return;
        }
        childSessions.add(child.sessionId);
        // Kept, so opening the channel can wait for the frames that already
        // exist: a probe issued before their contexts arrive would miss them.
        childEnables.push(cdp.send("Runtime.enable", undefined, child.sessionId).catch(() => undefined));
      }));
      unsubscribers.push(cdp.on("Target.detachedFromTarget", (params) => {
        const detached = (params as { sessionId?: unknown })?.sessionId;
        if (detached === sessionId) markLost("TAB_CLOSED");
        else if (typeof detached === "string" && childSessions.delete(detached)) {
          for (const [key, context] of contexts) if (context.sessionId === detached) contexts.delete(key);
        }
      }));
      unsubscribers.push(cdp.on("Target.targetDestroyed", (params) => {
        if ((params as { targetId?: unknown })?.targetId === targetId) markLost("TAB_CLOSED");
      }));
      unsubscribers.push(cdp.onClose(() => markLost("DISCONNECTED")));

      const release = async () => {
        for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
        contexts.clear();
        try { await cdp.send("Target.detachFromTarget", { sessionId }); } catch { /* already gone */ }
      };

      try {
        await cdp.send("Runtime.enable", undefined, sessionId);
        await cdp.send(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          sessionId,
        );
        // Existing frames are announced before setAutoAttach answers; their
        // Runtime.enable answers only after their contexts were announced.
        await Promise.all(childEnables.splice(0));
      } catch {
        await release();
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }

      const assertUsable = () => {
        if (generation !== activeConnectionGeneration) markLost("DISCONNECTED");
        if (lost) throw new BrowserLifecycleError("BROWSER_DISCONNECTED", lost);
        if (lifecycleState !== "BROWSER_READY" || stopRequested) {
          throw new BrowserLifecycleError("BROWSER_DISCONNECTED", "DISCONNECTED");
        }
      };

      const invoke = async (
        context: FrameContext,
        command: PlayerCommand,
        userGesture: boolean,
      ): Promise<PlayerCommandResult | undefined> => {
        let raw: unknown;
        try {
          raw = await cdp.send(
            "Runtime.callFunctionOn",
            {
              functionDeclaration: CRUNCHYROLL_PLAYER_FUNCTION,
              executionContextId: context.id,
              arguments: [{ value: command }, { value: PLAYER_PLAY_WAIT_MS }],
              awaitPromise: true,
              returnByValue: true,
              silent: true,
              userGesture,
            },
            context.sessionId,
          );
        } catch {
          // A context that vanished mid-call (navigation, frame removal) is not
          // a reason to try another one for the SAME command: report nothing.
          return undefined;
        }
        return parsePlayerResult(raw);
      };

      let closed = false;
      const channel: PlaybackControlChannel = {
        connectionGeneration: generation,
        targetId,
        loss: () => (closed ? "CLOSED" : generation !== activeConnectionGeneration ? "DISCONNECTED" : lost),
        async currentContentId() {
          assertUsable();
          let info: unknown;
          try {
            info = await cdp.send("Target.getTargetInfo", { targetId });
          } catch {
            throw new BrowserLifecycleError("BROWSER_DISCONNECTED", lost ?? "TAB_CLOSED");
          }
          const id = watchContentId((info as { targetInfo?: { url?: unknown } })?.targetInfo?.url, base);
          if (id === undefined) markLost("NAVIGATED_AWAY");
          return id;
        },
        async run(command: PlayerCommand, deadlineMs: number) {
          if (closed) throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "channel-closed");
          if (!PLAYER_COMMANDS.includes(command)) {
            throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "command");
          }
          assertUsable();
          let timer: { cancel(): void } | undefined;
          const deadlineError = new BrowserLifecycleError("BROWSER_UNAVAILABLE", "deadline");
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = seams.clock.setTimeout(() => reject(deadlineError), deadlineMs);
          });
          const work = async (): Promise<PlayerCommandResult | undefined> => {
            const frames = [...contexts.values()].sort((a, b) => Number(b.top) - Number(a.top));
            const probes: Array<{ context: FrameContext; result: PlayerCommandResult }> = [];
            for (const context of frames) {
              const result = await invoke(context, "probe", false);
              assertUsable();
              if (result) probes.push({ context, result });
            }
            const anyFullscreen = probes.some((probe) => probe.result.state.fullscreen);
            const players = probes.filter((probe) => probe.result.state.hasVideo);
            if (players.length === 0) return undefined;
            const player = players.find((probe) => probe.result.state.hasSource) ?? players[0];
            const merge = (result: PlayerCommandResult): PlayerCommandResult => Object.freeze({
              ...result,
              state: Object.freeze({ ...result.state, fullscreen: result.state.fullscreen || anyFullscreen }),
            });
            if (command === "probe") return merge(player.result);
            if (command === "exit_fullscreen") {
              // Exit wherever fullscreen actually is; the top document first,
              // because leaving it there leaves it everywhere.
              for (const probe of probes) {
                if (!probe.result.state.fullscreen) continue;
                await invoke(probe.context, "exit_fullscreen", false);
                assertUsable();
              }
              const after = await invoke(player.context, "probe", false);
              assertUsable();
              return after ? Object.freeze({ state: after.state }) : undefined;
            }
            if (command === "play" || command === "enter_fullscreen") {
              // A gesture-gated request goes to the foreground tab, and only
              // that one command carries the CDP user gesture.
              await cdp.send("Target.activateTarget", { targetId }).catch(() => undefined);
              assertUsable();
            }
            const result = await invoke(player.context, command, command === "play" || command === "enter_fullscreen");
            assertUsable();
            if (!result) throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "context-lost");
            return command === "enter_fullscreen" ? result : merge(result);
          };
          try {
            return await Promise.race([work(), deadline]);
          } finally {
            timer?.cancel();
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          await release();
        },
      };
      return channel;
    },
    onStateChange(listener) { stateListeners.add(listener); },
    onLifecycleEvent(listener) { lifecycleListeners.add(listener); },
  };
  return manager;
}

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout(listener, ms) {
    const timer = setTimeout(listener, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

const REAL_SPAWNER: ProcessSpawner = {
  spawn(executable, args) {
    const child = spawn(executable, [...args], {
      stdio: "ignore",
      detached: false,
      env: desktopSessionEnvironment(),
    });
    let terminal: BrowserProcessExit | undefined;
    const listeners = new Set<(exit: BrowserProcessExit) => void>();
    const finish = (code: number | null, signal: string | null) => {
      if (terminal) return;
      terminal = { source: "spawned", code, signal };
      for (const listener of [...listeners]) listener(terminal);
    };
    child.on("exit", finish);
    child.on("error", () => finish(null, "SPAWN_ERROR"));
    return {
      source: "spawned",
      get pid() { return child.pid ?? -1; },
      onExit(listener) {
        let active = true;
        if (terminal) queueMicrotask(() => { if (active) listener(terminal!); });
        else listeners.add(listener);
        return () => { active = false; listeners.delete(listener); };
      },
      requestTermination() { if (!terminal) child.kill("SIGTERM"); },
      forceKill() { if (!terminal) child.kill("SIGKILL"); },
      dispose() { listeners.clear(); },
    };
  },
};

export function createRealBrowserSessionSeams(commandTimeoutMs: number): BrowserSessionSeams {
  return {
    spawner: REAL_SPAWNER,
    clock: REAL_CLOCK,
    connector: createCdpConnector(commandTimeoutMs),
    processInspector: createProcessIdentityInspector(),
  };
}
