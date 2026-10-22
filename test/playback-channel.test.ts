import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import type { BrowserSessionConfig, CdpConnection, PlayerFrameState } from "../src/transport/browser-lifecycle-types.js";
import {
  createBrowserSessionManager,
  CRUNCHYROLL_PLAYER_FUNCTION,
} from "../src/transport/browser-session-manager.js";
import {
  FakeClock,
  FakeConnection,
  FakeProcessIdentityInspector,
  FakeSpawner,
} from "./_fake-browser-seams.js";

const WWW = "https://www.crunchyroll.com";
const STATIC = "https://static.crunchyroll.com";
const WATCH = `${WWW}/watch/`;

type Frame = Partial<PlayerFrameState> | null;

interface PageModel {
  targets: Array<{ targetId: string; type: string; url: string }>;
  /** Contexts announced on the page session by Runtime.enable. */
  pageContexts: Array<{ id: number; origin: string; isDefault: boolean }>;
  /** Out-of-process iframes announced on Target.setAutoAttach. */
  children: Array<{ sessionId: string; type: string; contexts: Array<{ id: number; origin: string }> }>;
  /** What each context's player reports (null = no <video>). */
  frames: Map<number, Frame>;
  hangCalls?: boolean;
  urlFor?: (targetId: string) => string;
}

interface CallRecord {
  contextId: number;
  sessionId?: string;
  declaration: string;
  args: unknown[];
  userGesture: boolean;
}

class PlayerConnection extends FakeConnection {
  readonly functionCalls: CallRecord[] = [];
  readonly detached: string[] = [];
  readonly runtimeEnabled: string[] = [];

  constructor(private readonly model: PageModel, onBrowserClose: () => void) {
    super(false, false, false, onBrowserClose);
  }

  override async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (method === "Target.getTargets") {
      this.calls.push({ method, params, sessionId });
      return { targetInfos: this.model.targets.map((t) => ({ ...t, attached: false })) };
    }
    if (method === "Target.attachToTarget") {
      this.calls.push({ method, params, sessionId });
      return { sessionId: `sess-${String(params?.targetId)}` };
    }
    if (method === "Target.detachFromTarget") {
      this.calls.push({ method, params, sessionId });
      this.detached.push(String(params?.sessionId));
      return {};
    }
    if (method === "Runtime.enable") {
      this.calls.push({ method, params, sessionId });
      this.runtimeEnabled.push(String(sessionId));
      const child = this.model.children.find((c) => c.sessionId === sessionId);
      // Like real Chromium, an out-of-process frame announces its contexts a
      // little later than the page does — but before its enable answers.
      if (child) await new Promise((resolve) => setImmediate(resolve));
      const contexts = child
        ? child.contexts.map((c) => ({ ...c, isDefault: true }))
        : this.model.pageContexts;
      for (const context of contexts) {
        this.emitEvent(
          "Runtime.executionContextCreated",
          { context: { id: context.id, origin: context.origin, auxData: { isDefault: context.isDefault } } },
          sessionId,
        );
      }
      return {};
    }
    if (method === "Target.setAutoAttach") {
      this.calls.push({ method, params, sessionId });
      for (const child of this.model.children) {
        this.emitEvent(
          "Target.attachedToTarget",
          { sessionId: child.sessionId, targetInfo: { type: child.type, url: `${STATIC}/player` } },
          sessionId,
        );
      }
      return {};
    }
    if (method === "Target.getTargetInfo") {
      this.calls.push({ method, params, sessionId });
      const id = String(params?.targetId);
      return { targetInfo: { url: this.model.urlFor?.(id) ?? this.model.targets.find((t) => t.targetId === id)?.url } };
    }
    if (method === "Runtime.callFunctionOn") {
      this.calls.push({ method, params, sessionId });
      const record: CallRecord = {
        contextId: params?.executionContextId as number,
        sessionId,
        declaration: params?.functionDeclaration as string,
        args: (params?.arguments as Array<{ value: unknown }>).map((a) => a.value),
        userGesture: params?.userGesture === true,
      };
      this.functionCalls.push(record);
      if (this.model.hangCalls) return new Promise(() => undefined);
      const frame = this.model.frames.get(record.contextId);
      const command = record.args[0];
      const base: PlayerFrameState = {
        hasVideo: frame !== null && frame !== undefined,
        hasSource: true,
        paused: true,
        ended: false,
        readyState: 4,
        currentTime: 1,
        duration: 100,
        muted: false,
        fullscreen: false,
        fullscreenEnabled: true,
        topLevel: false,
        ...(frame ?? {}),
      };
      if (frame) {
        if (command === "play") frame.paused = false;
        if (command === "pause") frame.paused = true;
        if (command === "enter_fullscreen") frame.fullscreen = true;
        if (command === "exit_fullscreen") frame.fullscreen = false;
      }
      const after = { ...base, ...(frame ?? {}) };
      // The page tries to smuggle a stream URL; the channel must drop it.
      return { result: { value: { state: { ...after, src: "https://cdn.invalid/signed?Policy=secret" }, error: null } } };
    }
    return super.send(method, params, sessionId);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function defaultModel(overrides: Partial<PageModel> = {}): PageModel {
  return {
    targets: [
      { targetId: "login-1", type: "page", url: `${WWW}/login` },
      { targetId: "watch-1", type: "page", url: `${WATCH}GABC123/some-slug` },
    ],
    pageContexts: [
      { id: 1, origin: WWW, isDefault: true },
      { id: 2, origin: "chrome-extension://abcdefgh", isDefault: true },
      { id: 3, origin: WWW, isDefault: false },
      { id: 4, origin: STATIC, isDefault: true },
    ],
    children: [],
    frames: new Map<number, Frame>([[1, null], [4, { topLevel: false }]]),
    ...overrides,
  };
}

async function wire(model: PageModel, configOverrides: Partial<BrowserSessionConfig> = {}) {
  const base = mkdtempSync(join(tmpdir(), "player-channel-"));
  const profileDir = join(base, "browser-profile");
  mkdirSync(profileDir);
  chmodSync(profileDir, 0o700);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const inspector = new FakeProcessIdentityInspector();
  const spawner = new FakeSpawner(profileDir, {}, inspector);
  const clock = new FakeClock();
  const connections: PlayerConnection[] = [];
  const connector = {
    async connect(): Promise<CdpConnection> {
      const connection = new PlayerConnection(model, () => void spawner.launches.at(-1)?.emitExit(0, null));
      connections.push(connection);
      return connection;
    },
  };
  const manager = createBrowserSessionManager(
    {
      launchMode: "headless",
      maxRecoveryAttempts: 3,
      backoffMs: [0, 0, 0],
      launchDeadlineMs: 30_000,
      cdpCommandTimeoutMs: 10_000,
      initialPageUrl: `${WWW}/login`,
      watchPageBaseUrl: WATCH,
      playerFrameOrigins: [WWW, STATIC],
      profileDir,
      executablePath: process.execPath,
      ...configOverrides,
    },
    { spawner, clock, connector, processInspector: inspector },
  );
  await manager.start();
  return { manager, connections, clock, current: () => connections.at(-1)! };
}

describe("playback channel — which tab", () => {
  test("refuses when player control is not configured", async () => {
    const { manager } = await wire(defaultModel(), { playerFrameOrigins: undefined });
    await assert.rejects(
      manager.openPlaybackControlChannel(),
      (e: unknown) => e instanceof BrowserLifecycleError && e.detail === "player-control-unconfigured",
    );
  });

  test("no watch tab, or two watch tabs none of which we opened, are refused", async () => {
    const none = await wire(defaultModel({ targets: [{ targetId: "login-1", type: "page", url: `${WWW}/login` }] }));
    await assert.rejects(none.manager.openPlaybackControlChannel(), (e: unknown) => (e as BrowserLifecycleError).detail === "no-playback-tab");

    const two = await wire(defaultModel({
      targets: [
        { targetId: "watch-1", type: "page", url: `${WATCH}GAAA` },
        { targetId: "watch-2", type: "page", url: `${WATCH}GBBB` },
      ],
    }));
    await assert.rejects(two.manager.openPlaybackControlChannel(), (e: unknown) => (e as BrowserLifecycleError).detail === "ambiguous-playback-tab");
  });

  test("the tab openWatchPage used wins over other watch tabs", async () => {
    const model = defaultModel({
      targets: [
        { targetId: "watch-1", type: "page", url: `${WATCH}GAAA` },
        { targetId: "watch-2", type: "page", url: `${WATCH}GBBB` },
      ],
    });
    const { manager } = await wire(model);
    await manager.openWatchPage("GCCC"); // reuses the first watch tab it finds
    const channel = await manager.openPlaybackControlChannel();
    assert.equal(channel.targetId, "watch-1");
    await channel.close();
  });

  test("regression (real Chromium): our tab mid-navigation reports an empty URL and stays ours", async () => {
    const model = defaultModel({ targets: [{ targetId: "watch-1", type: "page", url: `${WATCH}GAAA` }] });
    const { manager } = await wire(model);
    await manager.openWatchPage("GBBB");
    model.targets[0].url = "";
    const channel = await manager.openPlaybackControlChannel();
    assert.equal(channel.targetId, "watch-1");
    await channel.close();
    // But a tab that left for another site is no longer a playback tab.
    model.targets[0].url = "https://elsewhere.invalid/";
    await assert.rejects(manager.openPlaybackControlChannel(), (e: unknown) => (e as BrowserLifecycleError).detail === "no-playback-tab");
  });

  test("a lookalike watch URL on another origin or with userinfo is never a playback tab", async () => {
    const { manager } = await wire(defaultModel({
      targets: [
        { targetId: "evil-1", type: "page", url: "https://www.crunchyroll.com.evil.invalid/watch/GABC" },
        { targetId: "evil-2", type: "page", url: "https://user:pw@www.crunchyroll.com/watch/GABC" },
        { targetId: "evil-3", type: "page", url: "http://www.crunchyroll.com/watch/GABC" },
        { targetId: "evil-4", type: "page", url: `${WATCH}not-an-id` },
      ],
    }));
    await assert.rejects(manager.openPlaybackControlChannel(), (e: unknown) => (e as BrowserLifecycleError).detail === "no-playback-tab");
  });
});

describe("playback channel — which frames and what runs there", () => {
  test("only default worlds on allowed origins are probed; the player frame is chosen", async () => {
    const { manager, current } = await wire(defaultModel());
    const channel = await manager.openPlaybackControlChannel();
    const result = await channel.run("probe", 1_000);
    assert.equal(result?.state.hasVideo, true);
    const contexts = new Set(current().functionCalls.map((c) => c.contextId));
    assert.deepEqual([...contexts].sort(), [1, 4], "never the extension (2) or the isolated world (3)");
    await channel.close();
  });

  test("every call runs the frozen function with a closed command and no other argument", async () => {
    const { manager, current } = await wire(defaultModel());
    const channel = await manager.openPlaybackControlChannel();
    for (const command of ["probe", "play", "pause", "enter_fullscreen", "exit_fullscreen"] as const) {
      await channel.run(command, 1_000);
    }
    for (const call of current().functionCalls) {
      assert.equal(call.declaration, CRUNCHYROLL_PLAYER_FUNCTION);
      assert.equal(call.args.length, 2);
      assert.ok(["probe", "play", "pause", "enter_fullscreen", "exit_fullscreen"].includes(call.args[0] as string));
      assert.equal(call.args[1], 3_000);
    }
    await channel.close();
  });

  test("the CDP user gesture is attached only to play and enter_fullscreen", async () => {
    const { manager, current } = await wire(defaultModel());
    const channel = await manager.openPlaybackControlChannel();
    for (const command of ["probe", "play", "pause", "enter_fullscreen", "exit_fullscreen"] as const) {
      await channel.run(command, 1_000);
    }
    for (const call of current().functionCalls) {
      const command = call.args[0];
      assert.equal(call.userGesture, command === "play" || command === "enter_fullscreen", String(command));
    }
    const activations = current().calls.filter((c) => c.method === "Target.activateTarget");
    assert.ok(activations.every((c) => c.params?.targetId === channel.targetId));
    await channel.close();
  });

  test("an unknown command is refused before anything is sent", async () => {
    const { manager, current } = await wire(defaultModel());
    const channel = await manager.openPlaybackControlChannel();
    const before = current().functionCalls.length;
    await assert.rejects(channel.run("seek" as never, 1_000), (e: unknown) => (e as BrowserLifecycleError).detail === "command");
    assert.equal(current().functionCalls.length, before);
    await channel.close();
  });

  test("the page result is reduced to the closed shape: no stream URL travels", async () => {
    const { manager } = await wire(defaultModel());
    const channel = await manager.openPlaybackControlChannel();
    const result = await channel.run("probe", 1_000);
    assert.equal(JSON.stringify(result).includes("Policy"), false);
    assert.equal("src" in (result!.state as unknown as Record<string, unknown>), false);
    await channel.close();
  });

  test("an out-of-process player iframe is auto-attached; workers are detached", async () => {
    const model = defaultModel({
      pageContexts: [{ id: 1, origin: WWW, isDefault: true }],
      children: [
        { sessionId: "child-frame", type: "iframe", contexts: [{ id: 10, origin: STATIC }] },
        { sessionId: "child-worker", type: "worker", contexts: [] },
      ],
      frames: new Map<number, Frame>([[1, null], [10, {}]]),
    });
    const { manager, current } = await wire(model);
    const channel = await manager.openPlaybackControlChannel();
    await new Promise((resolve) => setImmediate(resolve));
    const result = await channel.run("play", 1_000);
    assert.equal(result?.state.paused, false);
    const play = current().functionCalls.find((c) => c.args[0] === "play")!;
    assert.equal(play.contextId, 10);
    assert.equal(play.sessionId, "child-frame");
    assert.ok(current().detached.includes("child-worker"));
    assert.equal(current().runtimeEnabled.includes("child-worker"), false);
    await channel.close();
  });

  test("regression (real Chromium): an existing out-of-process frame is usable on the FIRST command", async () => {
    // The child's Runtime.enable answers only after its contexts were
    // announced; opening must wait for it, or the first probe misses the player.
    const model = defaultModel({
      pageContexts: [{ id: 1, origin: WWW, isDefault: true }],
      children: [{ sessionId: "child-frame", type: "iframe", contexts: [{ id: 10, origin: STATIC }] }],
      frames: new Map<number, Frame>([[1, null], [10, {}]]),
    });
    const { manager } = await wire(model);
    const channel = await manager.openPlaybackControlChannel();
    assert.equal((await channel.run("probe", 1_000))?.state.hasVideo, true);
    await channel.close();
  });

  test("a frame on a foreign origin is never probed, even when it holds a video", async () => {
    const model = defaultModel({
      pageContexts: [{ id: 1, origin: WWW, isDefault: true }, { id: 5, origin: "https://ads.invalid", isDefault: true }],
      frames: new Map<number, Frame>([[1, null], [5, {}]]),
    });
    const { manager, current } = await wire(model);
    const channel = await manager.openPlaybackControlChannel();
    assert.equal(await channel.run("probe", 1_000), undefined, "no allowed frame has a video");
    assert.equal(current().functionCalls.some((c) => c.contextId === 5), false);
    await channel.close();
  });

  test("the frozen function reads no cookie, storage or network state and never returns currentSrc", () => {
    for (const forbidden of ["cookie", "localStorage", "sessionStorage", "indexedDB", "fetch(", "XMLHttpRequest", "eval(", "Function("]) {
      assert.equal(CRUNCHYROLL_PLAYER_FUNCTION.includes(forbidden), false, forbidden);
    }
    const snapshot = CRUNCHYROLL_PLAYER_FUNCTION.slice(CRUNCHYROLL_PLAYER_FUNCTION.indexOf("const snapshot"));
    const returned = snapshot.slice(0, snapshot.indexOf("});"));
    assert.equal(/:\s*video\.currentSrc\b/.test(returned), false);
  });
});

describe("playback channel — identity, loss and teardown", () => {
  test("a reconnect makes the old channel unusable (stale generation)", async () => {
    const { manager, current } = await wire(defaultModel());
    const channel = await manager.openPlaybackControlChannel();
    const before = manager.connectionGeneration();
    current().emitClose();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(manager.connectionGeneration(), before);
    assert.equal(channel.loss(), "DISCONNECTED");
    await assert.rejects(channel.run("play", 1_000), (e: unknown) => (e as BrowserLifecycleError).detail === "DISCONNECTED");
    await channel.close();
  });

  test("the tab closing mid-life marks TAB_CLOSED and refuses further commands", async () => {
    const { manager, current } = await wire(defaultModel());
    const channel = await manager.openPlaybackControlChannel();
    current().emitEvent("Target.targetDestroyed", { targetId: channel.targetId });
    assert.equal(channel.loss(), "TAB_CLOSED");
    await assert.rejects(channel.run("probe", 1_000), (e: unknown) => (e as BrowserLifecycleError).detail === "TAB_CLOSED");
    await channel.close();
  });

  test("a command that never answers is bounded by the channel deadline", async () => {
    const model = defaultModel();
    const { manager, clock } = await wire(model);
    const channel = await manager.openPlaybackControlChannel();
    model.hangCalls = true;
    const pending = channel.run("probe", 500);
    const settled = assert.rejects(pending, (e: unknown) => (e as BrowserLifecycleError).detail === "deadline");
    await clock.advance(500);
    await settled;
    await channel.close();
  });

  test("currentContentId reads the validated watch URL only", async () => {
    const model = defaultModel();
    let url = `${WATCH}GXYZ/episode-title`;
    model.urlFor = () => url;
    const { manager } = await wire(model);
    const channel = await manager.openPlaybackControlChannel();
    assert.equal(await channel.currentContentId(), "GXYZ");
    url = "https://elsewhere.invalid/watch/GXYZ";
    assert.equal(await channel.currentContentId(), undefined);
    assert.equal(channel.loss(), "NAVIGATED_AWAY");
    await channel.close();
  });

  test("close detaches the page session and releases every listener", async () => {
    const { manager, current } = await wire(defaultModel());
    const events = ["Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Target.attachedToTarget", "Target.detachedFromTarget"];
    const baseline = events.map((e) => current().listenerCount(e));
    const channel = await manager.openPlaybackControlChannel();
    await channel.close();
    await channel.close();
    assert.deepEqual(events.map((e) => current().listenerCount(e)), baseline);
    assert.ok(current().detached.includes("sess-watch-1"));
    await assert.rejects(channel.run("probe", 1_000), (e: unknown) => (e as BrowserLifecycleError).detail === "channel-closed");
  });

  test("the channel exposes no generic CDP, evaluate or cookie surface", async () => {
    const { manager } = await wire(defaultModel());
    const channel = await manager.openPlaybackControlChannel();
    assert.deepEqual(Object.keys(channel).sort(), ["close", "connectionGeneration", "currentContentId", "loss", "run", "targetId"]);
    await channel.close();
  });

  test("adoptOnly start never spawns a browser", async () => {
    const base = mkdtempSync(join(tmpdir(), "player-adopt-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const profileDir = join(base, "browser-profile");
    mkdirSync(profileDir);
    chmodSync(profileDir, 0o700);
    const inspector = new FakeProcessIdentityInspector();
    const spawner = new FakeSpawner(profileDir, {}, inspector);
    const manager = createBrowserSessionManager(
      {
        launchMode: "headless", maxRecoveryAttempts: 1, backoffMs: [0], launchDeadlineMs: 1_000,
        cdpCommandTimeoutMs: 1_000, initialPageUrl: `${WWW}/login`, profileDir, executablePath: process.execPath,
      },
      { spawner, clock: new FakeClock(), connector: { connect: async () => { throw new Error("no"); } }, processInspector: inspector },
    );
    await assert.rejects(manager.start({ adoptOnly: true }), (e: unknown) => (e as BrowserLifecycleError).detail === "no-owned-browser");
    assert.equal(spawner.launches.length, 0);
    assert.equal(manager.state(), "STOPPED");
  });
});
