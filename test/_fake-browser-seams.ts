import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import type {
  BrowserLifecycleState,
  BrowserProcessExit,
  BrowserSessionConfig,
  CdpConnection,
  Clock,
  ProcessIdentityInspector,
  ProcessSpawner,
  SpawnedBrowserProcessHandle,
} from "../src/transport/browser-lifecycle-types.js";
import {
  createBrowserSessionManager,
  type BrowserSessionSeams,
  type LifecycleEvent,
} from "../src/transport/browser-session-manager.js";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";

interface FakeTimer {
  due: number;
  listener: () => void;
  cancelled: boolean;
}

export class FakeClock implements Clock {
  private time = 0;
  private readonly timers: FakeTimer[] = [];
  readonly sleeps: number[] = [];

  now(): number { return this.time; }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return new Promise((resolve) => { this.setTimeout(resolve, ms); });
  }

  setTimeout(listener: () => void, ms: number): { cancel(): void } {
    const timer: FakeTimer = { due: this.time + ms, listener, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const next = this.timers
        .filter((timer) => !timer.cancelled && timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      next.cancelled = true;
      this.time = next.due;
      next.listener();
      await this.settleMicrotasks();
    }
    this.time = target;
    await this.settleMicrotasks();
  }

  async drain(): Promise<void> {
    let guard = 0;
    for (;;) {
      if (guard++ > 1_000) throw new Error("FakeClock timer drain did not settle");
      await this.settleMicrotasks();
      const active = this.timers.filter((timer) => !timer.cancelled);
      if (active.length === 0) {
        await this.settleMicrotasks();
        if (!this.timers.some((timer) => !timer.cancelled)) return;
        continue;
      }
      const nextDue = Math.min(...active.map((timer) => timer.due));
      await this.advance(nextDue - this.time);
    }
  }

  private async settleMicrotasks(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }
}

export class FakeSpawnedHandle implements SpawnedBrowserProcessHandle {
  readonly source = "spawned" as const;
  readonly listeners = new Set<(exit: BrowserProcessExit) => void>();
  terminationRequested = false;
  forceKilled = false;
  private terminal: BrowserProcessExit | undefined;

  constructor(
    readonly pid: number,
    readonly executable: string,
    readonly args: readonly string[],
    private readonly ignoreSigterm: boolean,
  ) {}

  onExit(listener: (exit: BrowserProcessExit) => void): () => void {
    let active = true;
    if (this.terminal) queueMicrotask(() => { if (active) listener(this.terminal!); });
    else this.listeners.add(listener);
    return () => { active = false; this.listeners.delete(listener); };
  }

  requestTermination(): void {
    this.terminationRequested = true;
    if (!this.ignoreSigterm) queueMicrotask(() => { void this.emitExit(0, null); });
  }

  forceKill(): void {
    this.forceKilled = true;
    queueMicrotask(() => { void this.emitExit(null, "SIGKILL"); });
  }

  dispose(): void { this.listeners.clear(); }

  async emitExit(code: number | null, signal: string | null): Promise<void> {
    if (this.terminal) return;
    this.terminal = { source: "spawned", code, signal };
    for (const listener of [...this.listeners]) listener(this.terminal);
    await Promise.resolve();
    await Promise.resolve();
  }
}

export class FakeSpawner implements ProcessSpawner {
  readonly launches: FakeSpawnedHandle[] = [];
  private nextPid = 40_000;

  constructor(
    private readonly profileDir: string,
    private readonly options: WireFakeOptions,
    private readonly inspector: FakeProcessIdentityInspector,
  ) {}

  spawn(executable: string, args: readonly string[]): SpawnedBrowserProcessHandle {
    const handle = new FakeSpawnedHandle(
      this.nextPid++, executable, Object.freeze([...args]), Boolean(this.options.ignoreSigterm),
    );
    this.launches.push(handle);
    if (this.options.failLaunch) throw new Error("synthetic launch failure");
    this.inspector.registerSpawn(handle.pid, this.profileDir, executable);
    if (this.options.runtimeCmdlineRewritten) {
      this.inspector.setArgv(handle.pid, [args.join(" ")]);
    }
    // The fake browser, not BT2, owns ProcessSingleton creation/replacement.
    rmSync(join(this.profileDir, "SingletonLock"), { recursive: true, force: true });
    symlinkSync(`${hostname()}-${handle.pid}`, join(this.profileDir, "SingletonLock"));
    handle.onExit(() => {
      this.inspector.setAlive(handle.pid, false);
      this.inspector.setStartTime(handle.pid, null);
    });
    if (!this.options.neverReady) {
      writeFileSync(
        join(this.profileDir, "DevToolsActivePort"),
        `45000\n/devtools/browser/fake-${handle.pid}\n`,
      );
    }
    if (this.options.exitBeforeReady) {
      void handle.emitExit(1, null);
    }
    if (this.options.alwaysCrash && this.launches.length > 1) {
      void handle.emitExit(1, null);
    }
    return handle;
  }
}

export class FakeConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  private readonly eventListeners = new Map<
    string,
    Set<(params: unknown, sessionId?: string) => void>
  >();
  private readonly closeListeners = new Set<() => void>();
  private readonly historicalCloseListeners = new Set<() => void>();
  private closed = false;
  private nextTargetId = 1;

  constructor(
    private readonly closeAfterHandshake = false,
    private readonly allowSendAfterClose = false,
    private readonly failHandshake = false,
    private readonly onBrowserClose?: () => void,
    private readonly apiExecution: WireFakeOptions["apiExecution"] = "success",
    private readonly failBrowserClose = false,
  ) {}

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    this.calls.push({ method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) });
    if (this.closed && !this.allowSendAfterClose) throw new Error("fake connection closed");
    if (method === "Browser.getVersion") {
      if (this.failHandshake) throw new Error("synthetic handshake failure");
      if (this.closeAfterHandshake) queueMicrotask(() => this.emitClose());
      return { product: "FakeBrowser/1.0" };
    }
    if (method === "Browser.close") {
      if (this.failBrowserClose) throw new Error("synthetic close failure");
      this.onBrowserClose?.();
      this.emitClose();
      return {};
    }
    if (method === "Target.createTarget") {
      return { targetId: `managed-${this.nextTargetId++}` };
    }
    if (method === "Target.attachToTarget") {
      return { sessionId: "fake-page-session" };
    }
    if (method === "Runtime.enable") {
      this.emitEvent(
        "Runtime.executionContextCreated",
        {
          context: {
            id: 7,
            origin: "https://www.crunchyroll.com",
            auxData: { isDefault: true },
          },
        },
        "fake-page-session",
      );
      return {};
    }
    if (method === "Runtime.callFunctionOn") {
      if (this.apiExecution === "pending") return new Promise(() => undefined);
      if (this.apiExecution === "disconnect") {
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
      }
      if (this.apiExecution === "page-exception") return { exceptionDetails: {} };
      if (this.apiExecution === "malformed") return { result: { value: { status: "bad" } } };
      if (this.apiExecution === "null-result") return null;
      return {
        result: {
          value: { status: 204, contentType: "", body: "", truncated: false },
        },
      };
    }
    return {};
  }

  listenerCount(event: string): number {
    return this.eventListeners.get(event)?.size ?? 0;
  }

  on(event: string, listener: (params: unknown, sessionId?: string) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.eventListeners.get(event) === listeners) {
        this.eventListeners.delete(event);
      }
    };
  }

  close(): void { this.emitClose(); }

  onClose(listener: () => void): () => void {
    let active = true;
    if (this.closed) queueMicrotask(() => { if (active) listener(); });
    else {
      this.closeListeners.add(listener);
      this.historicalCloseListeners.add(listener);
    }
    return () => { active = false; this.closeListeners.delete(listener); };
  }

  emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
    this.closeListeners.clear();
  }

  emitHistoricalClose(): void {
    for (const listener of [...this.historicalCloseListeners]) listener();
  }

  emitEvent(event: string, params: unknown, sessionId?: string): void {
    for (const listener of this.eventListeners.get(event) ?? []) listener(params, sessionId);
  }
}

export class FakeConnector {
  readonly connections: FakeConnection[] = [];

  constructor(
    private readonly options: WireFakeOptions,
    private readonly inspector: FakeProcessIdentityInspector,
    private readonly spawner: FakeSpawner,
  ) {}

  async connect(_url: string): Promise<CdpConnection> {
    if (
      this.connections.length > 0 &&
      this.connections.length <= (this.options.failReconnects ?? 0)
    ) {
      this.connections.push(new FakeConnection());
      throw new Error("synthetic reconnect failure");
    }
    const isFirst = this.connections.length === 0;
    const connection = new FakeConnection(
      isFirst && Boolean(this.options.closeAfterHandshake),
      isFirst && Boolean(this.options.closeImmediatelyAfterConnect),
      isFirst && this.options.existingOwnedBrowser === "handshake-fails",
      () => {
        if (this.options.adoptedExitsOnClose) {
          this.inspector.setStartTime(this.inspector.adoptedPid, null);
        }
        if (!this.options.ignoreBrowserClose) {
          void this.spawner.launches.at(-1)?.emitExit(0, null);
        }
      },
      this.options.apiExecution,
      Boolean(this.options.failBrowserClose),
    );
    this.connections.push(connection);
    if (isFirst && this.options.closeImmediatelyAfterConnect) connection.emitClose();
    return connection;
  }
}

export class FakeProcessIdentityInspector implements ProcessIdentityInspector {
  readonly adoptedPid = 30_000;
  readonly canonicalLauncherExecutable = realpathSync(process.execPath);
  readonly canonicalRuntimeExecutable: string;
  readonly inspectionCalls: string[] = [];
  private readonly startTimes = new Map<number, number | null>();
  private readonly executables = new Map<number, string | null>();
  private readonly argumentsByPid = new Map<number, readonly string[] | null>();
  private readonly alive = new Map<number, boolean>();

  constructor(runtimeExecutable = realpathSync(process.execPath)) {
    this.canonicalRuntimeExecutable = runtimeExecutable;
    this.startTimes.set(this.adoptedPid, 1_234_567);
    this.executables.set(this.adoptedPid, runtimeExecutable);
    this.argumentsByPid.set(this.adoptedPid, [process.execPath]);
    this.alive.set(this.adoptedPid, true);
  }
  isAlive(pid: number): boolean {
    this.inspectionCalls.push(`alive:${pid}`);
    return this.alive.get(pid) ?? this.startTimes.has(pid);
  }
  executable(pid: number): string | null {
    this.inspectionCalls.push(`executable:${pid}`);
    return this.executables.get(pid) ?? null;
  }
  startTimeTicks(pid: number): number | null {
    this.inspectionCalls.push(`start:${pid}`);
    return this.startTimes.get(pid) ?? null;
  }
  argv(pid: number): readonly string[] | null {
    this.inspectionCalls.push(`argv:${pid}`);
    return this.argumentsByPid.get(pid) ?? null;
  }
  canonicalPath(path: string): string | null {
    this.inspectionCalls.push(`canonical:${path}`);
    try { return realpathSync(path); } catch { return null; }
  }
  setStartTime(pid: number, value: number | null): void { this.startTimes.set(pid, value); }
  setAlive(pid: number, value: boolean): void { this.alive.set(pid, value); }
  setExecutable(pid: number, value: string | null): void { this.executables.set(pid, value); }
  setArgv(pid: number, value: readonly string[] | null): void {
    this.argumentsByPid.set(pid, value);
  }
  registerSpawn(pid: number, profileDir: string, executable: string): void {
    this.alive.set(pid, true);
    this.startTimes.set(pid, 2_000_000 + pid);
    this.executables.set(pid, this.canonicalRuntimeExecutable);
    this.argumentsByPid.set(pid, [executable, `--user-data-dir=${realpathSync(profileDir)}`]);
  }
}

export interface WireFakeOptions {
  launchMode?: "visible" | "headless";
  failLaunch?: boolean;
  exitBeforeReady?: boolean;
  neverReady?: boolean;
  ignoreSigterm?: boolean;
  ignoreBrowserClose?: boolean;
  failBrowserClose?: boolean;
  launchDeadlineMs?: number;
  cdpCommandTimeoutMs?: number;
  initialPageUrl?: string;
  watchPageBaseUrl?: string;
  alwaysCrash?: boolean;
  failReconnects?: number;
  closeImmediatelyAfterConnect?: boolean;
  closeAfterHandshake?: boolean;
  existingOwnedBrowser?: string;
  adoptedExitsOnClose?: boolean;
  distinctRuntimeExecutable?: boolean;
  runtimeCmdlineRewritten?: boolean;
  apiExecution?: "success" | "pending" | "disconnect" | "page-exception" | "malformed" | "null-result";
}

export function wireFakes(options: WireFakeOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), "bt2-manager-"));
  const profileDir = join(base, "browser-profile");
  mkdirSync(profileDir);
  chmodSync(profileDir, 0o700);
  const distinctRuntime = options.distinctRuntimeExecutable || [
    "valid-distinct-executables",
    "launcher-mismatch",
    "runtime-mismatch",
  ].includes(options.existingOwnedBrowser ?? "");
  const processInspector = new FakeProcessIdentityInspector(
    distinctRuntime ? "/canonical/runtime" : undefined,
  );
  let executablePath = process.execPath;
  if (options.existingOwnedBrowser === "valid-symlink-executable") {
    executablePath = join(base, "browser-launcher");
    symlinkSync(process.execPath, executablePath);
  }
  const canonicalProfile = realpathSync(profileDir);
  const canonicalExecutable = realpathSync(executablePath);
  const existing = options.existingOwnedBrowser;
  if (existing) {
    const otherProfile = join(base, "other-profile");
    mkdirSync(otherProfile);
    chmodSync(otherProfile, 0o700);
    let recordProfile = canonicalProfile;
    let recordLauncherExecutable = canonicalExecutable;
    let recordRuntimeExecutable = processInspector.canonicalRuntimeExecutable;
    let recordStartTime = 1_234_567;
    processInspector.setArgv(processInspector.adoptedPid, [
      executablePath,
      `--user-data-dir=${canonicalProfile}`,
    ]);
    if (existing === "stale-pid") {
      processInspector.setAlive(processInspector.adoptedPid, false);
      processInspector.setStartTime(processInspector.adoptedPid, null);
    } else if (existing === "record-profile-mismatch") {
      recordProfile = realpathSync(otherProfile);
    } else if (existing === "singleton-valid-rewritten-cmdline") {
      processInspector.setArgv(processInspector.adoptedPid, [
        `${executablePath} --user-data-dir=${canonicalProfile}`,
      ]);
    } else if (existing === "canonical-executable-mismatch") {
      processInspector.setExecutable(processInspector.adoptedPid, "/different/browser");
    } else if (existing === "launcher-mismatch") {
      recordLauncherExecutable = "/different/launcher";
    } else if (existing === "runtime-mismatch") {
      processInspector.setExecutable(processInspector.adoptedPid, "/different/runtime");
    } else if (existing === "starttime-mismatch") {
      recordStartTime += 1;
    }
    writeFileSync(join(profileDir, ".mcp-browser-owner.json"), JSON.stringify({
      version: 1,
      pid: processInspector.adoptedPid,
      launcherExecutable: recordLauncherExecutable,
      runtimeExecutable: recordRuntimeExecutable,
      profile: recordProfile,
      startTimeTicks: recordStartTime,
    }), { mode: 0o600 });
    writeFileSync(
      join(profileDir, "DevToolsActivePort"),
      existing === "bad-endpoint"
        ? "malformed\n"
        : "45000\n/devtools/browser/adopted\n",
    );
    const singletonPath = join(profileDir, "SingletonLock");
    if (existing === "singleton-regular-file") {
      writeFileSync(singletonPath, `${hostname()}-${processInspector.adoptedPid}`);
    } else if (existing !== "singleton-missing") {
      let singletonTarget = `${hostname()}-${processInspector.adoptedPid}`;
      if (existing === "singleton-wrong-hostname") {
        singletonTarget = `other-host-${processInspector.adoptedPid}`;
      } else if (existing === "singleton-wrong-pid") {
        singletonTarget = `${hostname()}-${processInspector.adoptedPid + 1}`;
      }
      symlinkSync(singletonTarget, singletonPath);
    }
  }
  const spawner = new FakeSpawner(profileDir, options, processInspector);
  const clock = new FakeClock();
  const connector = new FakeConnector(options, processInspector, spawner);
  const seams: BrowserSessionSeams = { spawner, clock, connector, processInspector };
  const config: BrowserSessionConfig = {
    launchMode: options.launchMode ?? "visible",
    maxRecoveryAttempts: 3,
    backoffMs: [250, 500, 1000],
    launchDeadlineMs: options.launchDeadlineMs ?? 30_000,
    cdpCommandTimeoutMs: options.cdpCommandTimeoutMs ?? 10_000,
    initialPageUrl: options.initialPageUrl ?? "about:blank",
    ...(options.watchPageBaseUrl ? { watchPageBaseUrl: options.watchPageBaseUrl } : {}),
    profileDir,
    executablePath,
  };
  const manager = createBrowserSessionManager(config, seams);
  const transitions: Array<[BrowserLifecycleState, BrowserLifecycleState]> = [];
  const events: LifecycleEvent[] = [];
  manager.onStateChange((from, to) => transitions.push([from, to]));
  manager.onLifecycleEvent((event) => events.push(event));
  return {
    manager,
    spawner,
    clock,
    connector,
    processInspector,
    transitions,
    events,
    profileDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
