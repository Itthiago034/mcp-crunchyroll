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
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
  close(): void;
  onClose(listener: () => void): () => void;
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
