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
} from "./browser-lifecycle-types.js";
import { MAX_API_RESPONSE_BYTES } from "./browser-lifecycle-types.js";
import { BrowserLifecycleError } from "./browser-lifecycle-error.js";
import { createCdpConnector } from "./cdp-client.js";
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
  start(): Promise<void>;
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
   * BT5: open the closed browser-context execution channel on the managed
   * Crunchyroll page.
   *
   * It exposes exactly one verb, `request`, which runs one frozen function
   * with structured arguments. There is no evaluate, no caller-supplied
   * function, no method string and no access to any other execution context.
   */
  openApiExecutionChannel(): Promise<ApiExecutionChannel>;
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
 */
export const CRUNCHYROLL_FETCH_FUNCTION = `
  async function (url, method, authorization, maxChars) {
    const response = await fetch(url, {
      method,
      headers: { Authorization: authorization },
      credentials: "omit",
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const truncated = text.length > maxChars;
    return {
      status: response.status,
      contentType,
      body: truncated ? text.slice(0, maxChars) : text,
      truncated,
    };
  }
`;

/** Origin+scheme equality, parsed — never a prefix test. */
function isCrunchyrollApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "www.crunchyroll.com" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
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
    managedTargetId = undefined;
    managedPageFlight = undefined;
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

  const beginManagedPageCreation = (recreated: boolean): Promise<string> => {
    if (managedPageFlight) return managedPageFlight;
    managedPageFlight = createManagedPage(recreated).finally(() => {
      managedPageFlight = undefined;
    });
    return managedPageFlight;
  };

  const prepareTargetObservation = async (registration: ConnectionRegistration) => {
    registration.connection.on("Target.targetDestroyed", (params) => {
      if (
        registration.generation !== activeConnectionGeneration ||
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

  const startInternal = async (attempt = 1) => {
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
    managedPageId: () => managedTargetId,
    async ensureManagedPage() {
      if (lifecycleState !== "BROWSER_READY" || stopRequested) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE");
      }
      if (managedTargetId) return managedTargetId;
      return beginManagedPageCreation(false);
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

      active.connection.on("Fetch.requestPaused", (params, frameSessionId) => {
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
      await active.connection.send(
        "Fetch.enable",
        { patterns: [{ urlPattern, requestStage: "Response" }] },
        sessionId
      );

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

      // Only contexts announced on THIS page's session are ever considered, and
      // among those only the page's own default context on the expected origin.
      // An extension, a devtools page or an unrelated isolated world can never
      // match, and nothing is ever "recovered" by falling back to another one.
      let executionContextId: number | undefined;
      active.connection.on("Runtime.executionContextCreated", (params, frameSessionId) => {
        if (frameSessionId !== sessionId) return;
        if (generation !== activeConnectionGeneration) return;
        const context = (params as { context?: { id?: unknown; origin?: unknown; auxData?: unknown } })
          ?.context;
        if (!context || typeof context.id !== "number") return;
        if (context.origin !== CRUNCHYROLL_PAGE_ORIGIN) return;
        if ((context.auxData as { isDefault?: unknown } | undefined)?.isDefault !== true) return;
        executionContextId = context.id;
      });

      await active.connection.send("Runtime.enable", undefined, sessionId);

      const detach = async (): Promise<void> => {
        try {
          await active.connection.send("Target.detachFromTarget", { sessionId });
        } catch {
          // a disconnected browser is already the outcome close wants
        }
      };

      if (executionContextId === undefined) {
        // Fail closed: no legitimate Crunchyroll page context exists right now.
        await detach();
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-page-context");
      }

      let closed = false;
      const contextId = executionContextId;

      const channel: ApiExecutionChannel = {
        connectionGeneration: generation,

        async request(input: ApiExecutionRequest): Promise<ApiExecutionResponse> {
          if (closed) throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "channel-closed");
          // Revalidated here as well as at the transport: the page is only ever
          // asked for the origin this build is allowed to talk to.
          if (!isCrunchyrollApiUrl(input.url)) {
            throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "origin");
          }
          if (
            generation !== activeConnectionGeneration ||
            lifecycleState !== "BROWSER_READY" ||
            stopRequested
          ) {
            throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
          }

          let timer: { cancel(): void } | undefined;
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = seams.clock.setTimeout(
              () => reject(new BrowserLifecycleError("BROWSER_UNAVAILABLE", "deadline")),
              input.deadlineMs
            );
          });

          let raw: unknown;
          try {
            raw = await Promise.race([
              active.connection.send(
                "Runtime.callFunctionOn",
                {
                  functionDeclaration: CRUNCHYROLL_FETCH_FUNCTION,
                  executionContextId: contextId,
                  // The variable parts cross as STRUCTURED arguments. They are
                  // never concatenated into the function source.
                  arguments: [
                    { value: input.url },
                    { value: input.method },
                    { value: input.authorization },
                    { value: input.maxBytes },
                  ],
                  awaitPromise: true,
                  returnByValue: true,
                  silent: true,
                  userGesture: false,
                },
                sessionId
              ),
              deadline,
            ]);
          } finally {
            timer?.cancel();
          }

          const frame = raw as {
            result?: { value?: unknown };
            exceptionDetails?: unknown;
          };
          if (frame.exceptionDetails !== undefined) {
            // The page threw. Its text may quote a URL or a header, so nothing
            // from it is carried out — only the structural fact.
            throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "page-exception");
          }
          const value = frame.result?.value as Partial<ApiExecutionResponse> | undefined;
          if (
            !value ||
            typeof value.status !== "number" ||
            typeof value.contentType !== "string" ||
            typeof value.body !== "string" ||
            typeof value.truncated !== "boolean"
          ) {
            throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "malformed-result");
          }
          return Object.freeze({
            status: value.status,
            contentType: value.contentType,
            body: value.body,
            truncated: value.truncated,
          });
        },

        async close() {
          if (closed) return;
          closed = true;
          await detach();
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

export function createRealBrowserSessionSeams(commandTimeoutMs: number): BrowserSessionSeams {
  return {
    spawner: REAL_SPAWNER,
    clock: REAL_CLOCK,
    connector: createCdpConnector(commandTimeoutMs),
    processInspector: createProcessIdentityInspector(),
  };
}
