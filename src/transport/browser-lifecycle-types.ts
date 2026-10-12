/** Lifecycle only. Authentication states belong to BT3. */
export type BrowserLifecycleState =
  | "STOPPED"
  | "BROWSER_STARTING"
  | "BROWSER_READY"
  | "DEGRADED";

export type BrowserExitClassification =
  | "MANAGER_STOP"
  | "USER_CLOSED"
  | "CRASH"
  | "ADOPTED_EXIT_UNKNOWN";

export type LaunchMode = "visible" | "headless";

export type BrowserProcessExit =
  | {
      readonly source: "spawned";
      readonly code: number | null;
      readonly signal: string | null;
    }
  | {
      readonly source: "adopted";
      readonly reason: "disappeared" | "identity-changed";
    };

export interface SpawnedBrowserProcessHandle {
  readonly source: "spawned";
  readonly pid: number;
  onExit(listener: (exit: BrowserProcessExit) => void): () => void;
  requestTermination(): void;
  forceKill(): void;
  dispose(): void;
}

export interface AdoptedBrowserProcessHandle {
  readonly source: "adopted";
  readonly pid: number;
  onExit(listener: (exit: BrowserProcessExit) => void): () => void;
  dispose(): void;
}

export type BrowserProcessHandle =
  | SpawnedBrowserProcessHandle
  | AdoptedBrowserProcessHandle;

export interface ProcessSpawner {
  spawn(executable: string, args: readonly string[]): SpawnedBrowserProcessHandle;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(listener: () => void, ms: number): { cancel(): void };
}

/** Linux process identity inspection only; this seam never controls a process. */
export interface ProcessIdentityInspector {
  isAlive(pid: number): boolean;
  executable(pid: number): string | null;
  startTimeTicks(pid: number): number | null;
  canonicalPath(path: string): string | null;
}

export interface CdpConnection {
  /**
   * `sessionId` is optional and additive (BT4): a flattened target session
   * needs it, while every existing browser-level caller and every fake stays
   * source-compatible.
   */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  /** The returned disposer releases the subscriber without closing CDP. */
  on(event: string, listener: (params: unknown, sessionId?: string) => void): () => void;
  close(): void;
  onClose(listener: () => void): () => void;
}

// ── BT4 — closed response-stage interception ────────────────────────────────

/** A paused response, reduced to the closed fields an observer may read. */
export interface PausedResponse {
  readonly requestId: string;
  readonly url: string;
  readonly responseStatusCode?: number;
}

/**
 * A closed interception channel on the managed page.
 *
 * It deliberately exposes NO generic CDP send: only the four operations a
 * response-stage observer needs, on a URL pattern fixed when the channel is
 * opened. The lifecycle manager gains no auth field, no token and no identity
 * from it — it only opens and closes the channel.
 */
export interface ResponseInterception {
  /** The BT2 connection generation, so a stale observation can be discarded. */
  readonly connectionGeneration: number;
  onPaused(listener: (event: PausedResponse) => void): void;
  getResponseBody(requestId: string): Promise<{ body: string; base64Encoded: boolean }>;
  continueResponse(requestId: string): Promise<void>;
  close(): Promise<void>;
}

// ── BT5 — closed browser-context API execution ──────────────────────────────

/**
 * The single response cap for the browser API transport. It lives here, in the
 * neutral vocabulary module, so the page-side channel and the transport that
 * re-checks it in Node can never drift apart.
 */
export const MAX_API_RESPONSE_BYTES = 512 * 1024;

/**
 * BT8.1. The request body, when the registry descriptor declares one.
 *
 * Two values, both produced by the transport from a frozen descriptor and
 * already-validated caller params. It is NOT a header map and NOT a document
 * the caller can hand over: `text` is serialized by the transport from
 * descriptor-owned key mappings, and `contentType` accompanies it so the page
 * never has to guess an encoding — nor invent one when there is no body.
 */
export interface ApiExecutionBody {
  readonly contentType: string;
  readonly text: string;
}

/**
 * One request the managed page performs on our behalf.
 *
 * Every field is derived by the transport from the frozen registry descriptor
 * and the AuthContext snapshot. There is deliberately no field that could
 * carry a header map or a cookie, and none that could carry anything the page
 * would execute: the function that runs in the page is a constant of this
 * build, and these are its only arguments.
 *
 * BT8.1 widened `method` past the single read verb and added an OPTIONAL body.
 * Both remain descriptor-owned — a caller can name neither — and the set of
 * methods is closed here exactly as it is closed in the registry.
 */
export interface ApiExecutionRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "DELETE";
  /** The complete Authorization header value, from the auth snapshot. */
  readonly authorization: string;
  readonly deadlineMs: number;
  readonly maxBytes: number;
  /** Absent for every GET and every DELETE. Its absence is what a read looks like. */
  readonly body?: ApiExecutionBody;
}

/** The bounded shape the page function returns. Never a page object. */
export interface ApiExecutionResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly truncated: boolean;
}

/**
 * A closed execution channel on the managed Crunchyroll page.
 *
 * It exposes ONE verb. There is no generic evaluate, no method string, no
 * caller-chosen function and no way to reach any other execution context.
 */
export interface ApiExecutionChannel {
  /** The BT2 connection generation this channel was opened on. */
  readonly connectionGeneration: number;
  request(input: ApiExecutionRequest): Promise<ApiExecutionResponse>;
  close(): Promise<void>;
}

export interface CdpConnector {
  connect(webSocketDebuggerUrl: string): Promise<CdpConnection>;
}

export interface DevToolsEndpoint {
  readonly port: number;
  readonly browserPath: string;
  readonly webSocketDebuggerUrl: string;
}

export interface BrowserOwnershipRecord {
  readonly version: 1;
  readonly pid: number;
  readonly launcherExecutable: string;
  readonly runtimeExecutable: string;
  readonly profile: string;
  readonly startTimeTicks: number;
}

/** Result of all thirteen successful ownership/adoption checks. */
export interface ValidatedOwnedBrowser {
  readonly record: BrowserOwnershipRecord;
  readonly endpoint: DevToolsEndpoint;
  readonly connection: CdpConnection;
  readonly process: AdoptedBrowserProcessHandle;
}

export interface BrowserSessionConfig {
  readonly launchMode: LaunchMode;
  readonly maxRecoveryAttempts: number;
  readonly backoffMs: readonly number[];
  readonly launchDeadlineMs: number;
  readonly cdpCommandTimeoutMs: number;
  readonly initialPageUrl: string;
  /**
   * Fixed prefix for playback pages (`<prefix><content id>`). A build constant
   * set by the composition root; without it playback is unavailable.
   */
  readonly watchPageBaseUrl?: string;
  readonly profileDir: string;
  readonly executablePath: string;
}

export const DEFAULT_BROWSER_SESSION_CONFIG: Omit<
  BrowserSessionConfig,
  "profileDir" | "executablePath"
> = Object.freeze({
  launchMode: "visible",
  maxRecoveryAttempts: 3,
  backoffMs: Object.freeze([250, 500, 1000]),
  launchDeadlineMs: 30_000,
  cdpCommandTimeoutMs: 10_000,
  initialPageUrl: "about:blank",
});
