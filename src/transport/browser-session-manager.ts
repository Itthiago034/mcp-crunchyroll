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
  let nextConnectionGeneration = 0;
  let activeConnectionGeneration = 0;
  let connectionRegistration: {
    readonly connection: CdpConnection;
    readonly generation: number;
    handledClose: boolean;
    phase: "candidate" | "ready";
    unsubscribeClose: () => void;
  } | undefined;
  let removeExitListener: (() => void) | undefined;
  let stopExitResolve: (() => void) | undefined;
  let recoveryFlight: Promise<void> | undefined;
  let reconnectFlight: Promise<void> | undefined;
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
    disposeConnection();
    endpoint = undefined;
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
    if (exit.source === "adopted") return;
    if (exit.code === 0 && exit.signal === null) {
      emit({ type: "exit.classified", classification: "USER_CLOSED" });
      disposeActive();
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

  const startInternal = async (attempt = 1) => {
    const launchDeadline = seams.clock.now() + config.launchDeadlineMs;
    transition("BROWSER_STARTING");
    stopRequested = false;
    emit({ type: "launch.attempt", attempt });
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
      endpoint = await Promise.race([
        waitForEndpoint(config, seams.clock, launchDeadline),
        earlyExit,
      ]);
      const candidate = await Promise.race([connectCandidate(endpoint), earlyExit]);
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
