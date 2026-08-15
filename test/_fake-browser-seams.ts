import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  ) {}

  spawn(executable: string, args: readonly string[]): SpawnedBrowserProcessHandle {
    const handle = new FakeSpawnedHandle(
      this.nextPid++, executable, Object.freeze([...args]), Boolean(this.options.ignoreSigterm),
    );
    this.launches.push(handle);
    if (this.options.failLaunch) throw new Error("synthetic launch failure");
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
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly closeListeners = new Set<() => void>();
  private readonly historicalCloseListeners = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly closeAfterHandshake = false,
    private readonly allowSendAfterClose = false,
  ) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, ...(params ? { params } : {}) });
    if (this.closed && !this.allowSendAfterClose) throw new Error("fake connection closed");
    if (method === "Browser.getVersion") {
      if (this.closeAfterHandshake) queueMicrotask(() => this.emitClose());
      return { product: "FakeBrowser/1.0" };
    }
    return {};
  }

  on(event: string, listener: (params: unknown) => void): void {
    const listeners = this.eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
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

  emitEvent(event: string, params: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) listener(params);
  }
}

export class FakeConnector {
  readonly connections: FakeConnection[] = [];

  constructor(private readonly options: WireFakeOptions) {}

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
    );
    this.connections.push(connection);
    if (isFirst && this.options.closeImmediatelyAfterConnect) connection.emitClose();
    return connection;
  }
}

export class FakeProcessIdentityInspector implements ProcessIdentityInspector {
  readonly adoptedPid = 30_000;
  readonly canonicalExecutable = process.execPath;
  private readonly startTimes = new Map<number, number | null>();

  constructor() { this.startTimes.set(this.adoptedPid, 1_234_567); }
  isAlive(pid: number): boolean { return this.startTimeTicks(pid) !== null; }
  executable(_pid: number): string | null { return this.canonicalExecutable; }
  startTimeTicks(pid: number): number | null { return this.startTimes.get(pid) ?? 1_234_567; }
  argv(_pid: number): readonly string[] | null { return [process.execPath]; }
  canonicalPath(path: string): string | null { return path; }
  setStartTime(pid: number, value: number | null): void { this.startTimes.set(pid, value); }
}

export interface WireFakeOptions {
  launchMode?: "visible" | "headless";
  failLaunch?: boolean;
  exitBeforeReady?: boolean;
  neverReady?: boolean;
  ignoreSigterm?: boolean;
  launchDeadlineMs?: number;
  cdpCommandTimeoutMs?: number;
  initialPageUrl?: string;
  alwaysCrash?: boolean;
  failReconnects?: number;
  closeImmediatelyAfterConnect?: boolean;
  closeAfterHandshake?: boolean;
  existingOwnedBrowser?: string;
  adoptedExitsOnClose?: boolean;
}

export function wireFakes(options: WireFakeOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), "bt2-manager-"));
  const profileDir = join(base, "browser-profile");
  mkdirSync(profileDir);
  chmodSync(profileDir, 0o700);
  const spawner = new FakeSpawner(profileDir, options);
  const clock = new FakeClock();
  const connector = new FakeConnector(options);
  const processInspector = new FakeProcessIdentityInspector();
  const seams: BrowserSessionSeams = { spawner, clock, connector, processInspector };
  const config: BrowserSessionConfig = {
    launchMode: options.launchMode ?? "visible",
    maxRecoveryAttempts: 3,
    backoffMs: [250, 500, 1000],
    launchDeadlineMs: options.launchDeadlineMs ?? 30_000,
    cdpCommandTimeoutMs: options.cdpCommandTimeoutMs ?? 10_000,
    initialPageUrl: options.initialPageUrl ?? "about:blank",
    profileDir,
    executablePath: process.execPath,
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
