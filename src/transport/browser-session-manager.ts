import { spawn } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import type {
  AdoptedBrowserProcessHandle,
  BrowserLifecycleState,
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
} from "./browser-lifecycle-types.js";
import { BrowserLifecycleError } from "./browser-lifecycle-error.js";
import { createCdpConnector } from "./cdp-client.js";
import {
  clearStaleEndpoint,
  ensureBrowserProfile,
  readDevToolsEndpoint,
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
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  managedPageId(): string | undefined;
  ensureManagedPage(): Promise<string>;
  onStateChange(
    listener: (from: BrowserLifecycleState, to: BrowserLifecycleState) => void,
  ): void;
  onLifecycleEvent(listener: (event: LifecycleEvent) => void): void;
}

const ENDPOINT_POLL_INTERVAL_MS = 50;
const ADOPTED_PROCESS_POLL_INTERVAL_MS = 250;

interface ValidatedProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: number;
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

function launchArguments(config: BrowserSessionConfig): readonly string[] {
  const common = [
    `--user-data-dir=${config.profileDir}`,
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
  let stopFlight: Promise<void> | undefined;
  let stopRequested = false;
  let processHandle: BrowserProcessHandle | undefined;
  let connection: CdpConnection | undefined;
  let endpoint: DevToolsEndpoint | undefined;
  let removeExitListener: (() => void) | undefined;
  let stopExitResolve: (() => void) | undefined;
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

  const disposeActive = () => {
    removeExitListener?.();
    removeExitListener = undefined;
    processHandle?.dispose();
    processHandle = undefined;
    connection?.close();
    connection = undefined;
    endpoint = undefined;
  };

  const installExitObservation = (handle: BrowserProcessHandle) => {
    removeExitListener?.();
    removeExitListener = handle.onExit(() => {
      if (stopRequested) stopExitResolve?.();
      // Exit classification and recovery are added in Task 6.
    });
  };

  const startInternal = async () => {
    const launchDeadline = seams.clock.now() + config.launchDeadlineMs;
    transition("BROWSER_STARTING");
    stopRequested = false;
    emit({ type: "launch.attempt", attempt: 1 });
    await ensureBrowserProfile(config.profileDir);
    await clearStaleEndpoint(config.profileDir);

    let spawned: SpawnedBrowserProcessHandle;
    try {
      spawned = seams.spawner.spawn(config.executablePath, launchArguments(config));
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
      const readiness = (async () => {
        endpoint = await waitForEndpoint(config, seams.clock, launchDeadline);
        connection = await seams.connector.connect(endpoint.webSocketDebuggerUrl);
        await connection.send("Browser.getVersion");
      })();
      await Promise.race([readiness, earlyExit]);
      cancelEarlyExit?.();
      installExitObservation(spawned);
      emit({ type: "cdp.connected" });
      transition("BROWSER_READY");
    } catch (error) {
      cancelEarlyExit?.();
      if (processHandle?.source === "spawned") processHandle.requestTermination();
      disposeActive();
      transition("STOPPED");
      if (error instanceof BrowserLifecycleError) throw error;
      throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
    }
  };

  const stopInternal = async () => {
    stopRequested = true;
    if (!processHandle) {
      disposeActive();
      transition("STOPPED");
      return;
    }

    if (processHandle.source === "spawned") {
      const handle = processHandle;
      let timeout: { cancel(): void } | undefined;
      const exited = new Promise<void>((resolve) => {
        stopExitResolve = resolve;
      });
      const timedOut = new Promise<"timeout">((resolve) => {
        timeout = seams.clock.setTimeout(() => resolve("timeout"), config.cdpCommandTimeoutMs);
      });
      handle.requestTermination();
      const outcome = await Promise.race([exited.then(() => "exit" as const), timedOut]);
      if (outcome === "timeout") {
        handle.forceKill();
        await exited;
      }
      timeout?.cancel();
      stopExitResolve = undefined;
    }

    disposeActive();
    await clearStaleEndpoint(config.profileDir);
    transition("STOPPED");
  };

  const manager: BrowserSessionManager = {
    state: () => lifecycleState,
    start() {
      if (lifecycleState === "BROWSER_READY") return Promise.resolve();
      if (startFlight) return startFlight;
      startFlight = startInternal().finally(() => { startFlight = undefined; });
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
    managedPageId: () => undefined,
    async ensureManagedPage() {
      throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
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
    const child = spawn(executable, [...args], { stdio: "ignore", detached: false });
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

function readStartTimeTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fieldsFromState = stat.slice(closeParen + 1).trim().split(/\s+/);
    const value = Number(fieldsFromState[19]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function createRealProcessIdentityInspector(): ProcessIdentityInspector {
  return {
    isAlive(pid) {
      try {
        // Signal 0 probes existence/permission without delivery to the target.
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    executable(pid) {
      try { return realpathSync(readlinkSync(`/proc/${pid}/exe`)); }
      catch { return null; }
    },
    startTimeTicks: readStartTimeTicks,
    argv(pid) {
      try {
        const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (parts.at(-1) === "") parts.pop();
        return parts.length > 0 && parts.every((part) => part.length > 0) ? parts : null;
      } catch {
        return null;
      }
    },
    canonicalPath(path) {
      try { return realpathSync(path); }
      catch { return null; }
    },
  };
}

export function createRealBrowserSessionSeams(commandTimeoutMs: number): BrowserSessionSeams {
  return {
    spawner: REAL_SPAWNER,
    clock: REAL_CLOCK,
    connector: createCdpConnector(commandTimeoutMs),
    processInspector: createRealProcessIdentityInspector(),
  };
}
