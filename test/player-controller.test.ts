import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import type {
  PlaybackChannelLoss,
  PlaybackControlChannel,
  PlayerCommand,
  PlayerCommandResult,
  PlayerFrameState,
  PlayerPageError,
} from "../src/transport/browser-lifecycle-types.js";
import {
  createPlayerController,
  type PlaybackPermission,
  type PlayerAction,
  type PlayerControlReport,
} from "../src/transport/player-controller.js";

// ── A scripted player behind the closed channel ─────────────────────────────

interface PlayerScript {
  /** Probes that still report "no source yet" before the video loads. */
  loadingProbes?: number;
  noVideo?: boolean;
  /** The page refuses this command with this error, and the state does not change. */
  refuse?: Partial<Record<PlayerCommand, PlayerPageError>>;
  /** The command "succeeds" but the state never changes (e.g. a player that swallows it). */
  ignore?: PlayerCommand[];
  /** The state reaches the target only after this many probes. */
  lagProbes?: number;
  /** The command never answers; the channel's own deadline fires. */
  hang?: PlayerCommand;
  /** The tab closes when this command is sent. */
  closeTabOn?: PlayerCommand;
  /** The connection is replaced when this command is sent. */
  disconnectOn?: PlayerCommand;
  contentIds?: Array<string | undefined>;
  openError?: BrowserLifecycleError;
}

function frame(overrides: Partial<PlayerFrameState> = {}): PlayerFrameState {
  return {
    hasVideo: true,
    hasSource: true,
    paused: true,
    ended: false,
    readyState: 4,
    currentTime: 12,
    duration: 1420,
    muted: false,
    fullscreen: false,
    fullscreenEnabled: true,
    topLevel: false,
    ...overrides,
  };
}

function scriptedHarness(script: PlayerScript = {}, initial: Partial<PlayerFrameState> = {}) {
  let time = 0;
  let state = frame(initial);
  let loading = script.loadingProbes ?? 0;
  let pendingTarget: Partial<PlayerFrameState> | undefined;
  let lag = 0;
  let lost: PlaybackChannelLoss | undefined;
  const sent: PlayerCommand[] = [];
  let opened = 0;
  let closed = 0;
  let permission: PlaybackPermission = "OK";
  const contentIds = [...(script.contentIds ?? [])];

  const effect: Record<Exclude<PlayerCommand, "probe">, Partial<PlayerFrameState>> = {
    play: { paused: false },
    pause: { paused: true },
    enter_fullscreen: { fullscreen: true },
    exit_fullscreen: { fullscreen: false },
  };

  const channel = (): PlaybackControlChannel => ({
    connectionGeneration: 1,
    targetId: "watch-1",
    loss: () => lost,
    async currentContentId() {
      if (lost) throw new BrowserLifecycleError("BROWSER_DISCONNECTED", lost);
      return contentIds.length > 1 ? contentIds.shift() : contentIds[0];
    },
    async run(command, deadlineMs): Promise<PlayerCommandResult | undefined> {
      assert.ok(deadlineMs > 0, "every command carries a positive deadline");
      if (lost) throw new BrowserLifecycleError("BROWSER_DISCONNECTED", lost);
      sent.push(command);
      if (script.noVideo) return undefined;
      if (command === "probe") {
        if (loading > 0) {
          loading -= 1;
          return { state: { ...state, hasSource: false, readyState: 0 } };
        }
        if (pendingTarget) {
          if (lag > 0) lag -= 1;
          else {
            state = { ...state, ...pendingTarget };
            pendingTarget = undefined;
          }
        }
        return { state };
      }
      if (script.closeTabOn === command) {
        lost = "TAB_CLOSED";
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED", "TAB_CLOSED");
      }
      if (script.disconnectOn === command) {
        lost = "DISCONNECTED";
        throw new BrowserLifecycleError("BROWSER_DISCONNECTED", "DISCONNECTED");
      }
      if (script.hang === command) {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "deadline");
      }
      const refusal = script.refuse?.[command];
      if (refusal) return { state, error: refusal };
      if (script.ignore?.includes(command)) return { state };
      if (script.lagProbes) {
        pendingTarget = effect[command];
        lag = script.lagProbes;
        return { state };
      }
      state = { ...state, ...effect[command] };
      return { state };
    },
    async close() {
      closed += 1;
    },
  });

  const controller = createPlayerController({
    openChannel: async () => {
      opened += 1;
      if (script.openError) throw script.openError;
      return channel();
    },
    permission: () => permission,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
      await Promise.resolve();
    },
    timing: { verifyTimeoutMs: 1_000, pollIntervalMs: 100, actionDeadlineMs: 5_000, commandDeadlineMs: 2_000 },
  });

  return {
    controller,
    sent,
    get state() { return state; },
    get opened() { return opened; },
    get closed() { return closed; },
    setPermission(value: PlaybackPermission) { permission = value; },
    advance(ms: number) { time += ms; },
  };
}

/** The central invariant: success implies a verified observation of the requested state. */
function assertHonest(report: PlayerControlReport) {
  if (report.success) {
    assert.equal(report.verified, true, `${report.action}: success without verification`);
    assert.equal(report.outcome, "CONFIRMED");
    assert.notEqual(report.state, null);
  }
  if (report.outcome !== "CONFIRMED") assert.equal(report.success, false);
  if (report.verified && report.state) {
    const s = report.state;
    if (report.action === "play") assert.equal(s.playing, true);
    if (report.action === "pause") assert.equal(s.paused, true);
    if (report.action === "fullscreen") assert.equal(s.fullscreen, true);
    if (report.action === "exit_fullscreen") assert.equal(s.fullscreen, false);
  }
}

// ── Basic actions ────────────────────────────────────────────────────────────

describe("player controller — play, pause, fullscreen", () => {
  test("play is sent once and confirmed by the state it produced", async () => {
    const h = scriptedHarness();
    const report = await h.controller.perform("play");
    assertHonest(report);
    assert.equal(report.outcome, "CONFIRMED");
    assert.equal(report.executed, true);
    assert.equal(report.state?.playing, true);
    assert.deepEqual(h.sent.filter((c) => c !== "probe"), ["play"]);
    assert.equal(h.closed, h.opened, "every channel is closed");
  });

  test("pause after play is confirmed and leaves the player paused", async () => {
    const h = scriptedHarness({}, { paused: false });
    const report = await h.controller.perform("pause");
    assertHonest(report);
    assert.equal(report.outcome, "CONFIRMED");
    assert.equal(report.state?.paused, true);
  });

  test("fullscreen and exit_fullscreen are each verified by a later observation", async () => {
    const h = scriptedHarness({ lagProbes: 2 });
    const enter = await h.controller.perform("fullscreen");
    assertHonest(enter);
    assert.equal(enter.outcome, "CONFIRMED");
    assert.equal(enter.state?.fullscreen, true);
    const exit = await h.controller.perform("exit_fullscreen");
    assertHonest(exit);
    assert.equal(exit.outcome, "CONFIRMED");
    assert.equal(exit.state?.fullscreen, false);
  });

  test("an action already in effect sends nothing and is confirmed by observation", async () => {
    const h = scriptedHarness({}, { paused: false });
    const report = await h.controller.perform("play");
    assertHonest(report);
    assert.equal(report.executed, false);
    assert.equal(report.reason, "ALREADY_IN_STATE");
    assert.deepEqual(h.sent, ["probe"]);
  });

  test("status only probes and never sends a command", async () => {
    const h = scriptedHarness();
    const report = await h.controller.perform("status");
    assert.equal(report.outcome, "CONFIRMED");
    assert.equal(report.executed, false);
    assert.deepEqual(h.sent, ["probe"]);
    assert.deepEqual(Object.keys(report.state!).sort(), [
      "buffering", "current_time", "duration", "ended", "fullscreen", "loading", "muted", "paused", "player_error", "playing", "ready_state",
    ]);
  });
});

// ── Player availability ──────────────────────────────────────────────────────

describe("player controller — missing, loading and refused players", () => {
  test("no video in any allowed frame is PLAYER_UNAVAILABLE, nothing executed", async () => {
    const h = scriptedHarness({ noVideo: true });
    const report = await h.controller.perform("play");
    assertHonest(report);
    assert.equal(report.outcome, "PLAYER_UNAVAILABLE");
    assert.equal(report.reason, "NO_VIDEO");
    assert.equal(report.executed, false);
  });

  test("a loading video is PLAYER_LOADING without waiting, and status reports loading", async () => {
    const h = scriptedHarness({ loadingProbes: 5 });
    const report = await h.controller.perform("play");
    assert.equal(report.outcome, "PLAYER_LOADING");
    assert.equal(report.executed, false);
    const status = await h.controller.perform("status");
    assert.equal(status.state?.loading, true);
  });

  test("with waitForReadyMs the action waits for the video, then acts", async () => {
    const h = scriptedHarness({ loadingProbes: 3 });
    const report = await h.controller.perform("play", { waitForReadyMs: 2_000 });
    assertHonest(report);
    assert.equal(report.outcome, "CONFIRMED");
    assert.equal(h.sent.filter((c) => c === "play").length, 1);
  });

  test("autoplay policy refusal is REFUSED_BY_BROWSER with a named reason, never success", async () => {
    const h = scriptedHarness({ refuse: { play: "NOT_ALLOWED" } });
    const report = await h.controller.perform("play");
    assertHonest(report);
    assert.equal(report.outcome, "REFUSED_BY_BROWSER");
    assert.equal(report.reason, "AUTOPLAY_BLOCKED_USER_ACTIVATION_REQUIRED");
    assert.equal(report.executed, true);
    assert.equal(report.verified, false);
  });

  test("fullscreen without user activation is REFUSED_BY_BROWSER", async () => {
    const h = scriptedHarness({ refuse: { enter_fullscreen: "NOT_ALLOWED" } });
    const report = await h.controller.perform("fullscreen");
    assertHonest(report);
    assert.equal(report.outcome, "REFUSED_BY_BROWSER");
    assert.equal(report.reason, "USER_ACTIVATION_REQUIRED_OR_DENIED");
    assert.equal(report.state?.fullscreen, false);
  });

  test("a frame without fullscreen permission is REFUSED_BY_BROWSER (not allowed in frame)", async () => {
    const h = scriptedHarness({ refuse: { enter_fullscreen: "FULLSCREEN_DISABLED" } });
    const report = await h.controller.perform("fullscreen");
    assert.equal(report.outcome, "REFUSED_BY_BROWSER");
    assert.equal(report.reason, "FULLSCREEN_NOT_ALLOWED_IN_FRAME");
  });

  test("a command that runs but changes nothing is NOT_CONFIRMED, never success", async () => {
    const h = scriptedHarness({ ignore: ["enter_fullscreen"] });
    const report = await h.controller.perform("fullscreen");
    assertHonest(report);
    assert.equal(report.outcome, "NOT_CONFIRMED");
    assert.equal(report.executed, true);
    assert.equal(report.verified, false);
    assert.equal(report.reason, "STATE_NOT_OBSERVED");
  });

  test("a pending play() that later starts is confirmed; one that never starts is not", async () => {
    const later = scriptedHarness({ lagProbes: 3 });
    assert.equal((await later.controller.perform("play")).outcome, "CONFIRMED");
    const never = scriptedHarness({ refuse: { play: "PENDING" } });
    const report = await never.controller.perform("play");
    assertHonest(report);
    assert.equal(report.outcome, "NOT_CONFIRMED");
    assert.equal(report.reason, "PAGE_PENDING");
  });
});

// ── Lifecycle failures ───────────────────────────────────────────────────────

describe("player controller — tabs, connections and deadlines", () => {
  test("no playback tab, ambiguous tabs and unconfigured control map to closed outcomes", async () => {
    const cases: Array<[BrowserLifecycleError, string, string | undefined]> = [
      [new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-playback-tab"), "TAB_NOT_FOUND", "NO_PLAYBACK_TAB"],
      [new BrowserLifecycleError("BROWSER_UNAVAILABLE", "ambiguous-playback-tab"), "TAB_NOT_FOUND", "AMBIGUOUS_PLAYBACK_TAB"],
      [new BrowserLifecycleError("BROWSER_UNAVAILABLE", "player-control-unconfigured"), "PLAYER_UNAVAILABLE", "UNCONFIGURED"],
      [new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-owned-browser"), "SESSION_DISCONNECTED", undefined],
    ];
    for (const [error, outcome, reason] of cases) {
      const report = await scriptedHarness({ openError: error }).controller.perform("play");
      assert.equal(report.outcome, outcome);
      assert.equal(report.reason, reason);
      assert.equal(report.executed, false);
    }
  });

  test("the tab closing during the action is TAB_CLOSED", async () => {
    const h = scriptedHarness({ closeTabOn: "play" });
    const report = await h.controller.perform("play");
    assertHonest(report);
    assert.equal(report.outcome, "TAB_CLOSED");
    assert.equal(report.executed, true);
    assert.equal(h.closed, 1, "the channel is still released");
  });

  test("a CDP reconnect during the action is SESSION_DISCONNECTED; the next action opens a fresh channel", async () => {
    const h = scriptedHarness({ disconnectOn: "pause" }, { paused: false });
    const report = await h.controller.perform("pause");
    assert.equal(report.outcome, "SESSION_DISCONNECTED");
    assert.equal(h.opened, 1);
    await h.controller.perform("status");
    assert.equal(h.opened, 2, "no channel is reused across actions");
  });

  test("a command that outlives its deadline is TIMEOUT", async () => {
    const h = scriptedHarness({ hang: "play" });
    const report = await h.controller.perform("play");
    assertHonest(report);
    assert.equal(report.outcome, "TIMEOUT");
  });

  test("the whole-action budget bounds waiting for a player that never loads", async () => {
    const h = scriptedHarness({ loadingProbes: 10_000 });
    const report = await h.controller.perform("play", { waitForReadyMs: 1_000 });
    assert.equal(report.outcome, "PLAYER_LOADING");
    assert.equal(report.executed, false);
  });

  test("crunchyroll_play's target: acting waits for the tab to reach the requested episode", async () => {
    const h = scriptedHarness({ contentIds: ["GOLD", "GOLD", "GNEW"] });
    const report = await h.controller.perform("play", { expectContentId: "GNEW", waitForReadyMs: 2_000 });
    assert.equal(report.outcome, "CONFIRMED");
    const stuck = scriptedHarness({ contentIds: ["GOLD"] });
    const refused = await stuck.controller.perform("play", { expectContentId: "GNEW", waitForReadyMs: 500 });
    assert.equal(refused.outcome, "PLAYER_LOADING");
    assert.equal(refused.reason, "NAVIGATION_PENDING");
    assert.equal(stuck.sent.includes("play"), false, "never acts on the previous episode");
  });
});

// ── Concurrency and the logout gate ─────────────────────────────────────────

describe("player controller — concurrency and permission", () => {
  test("two concurrent actions run one after the other, in arrival order", async () => {
    const h = scriptedHarness();
    const [play, pause] = await Promise.all([h.controller.perform("play"), h.controller.perform("pause")]);
    assert.equal(play.outcome, "CONFIRMED");
    assert.equal(pause.outcome, "CONFIRMED");
    const commands = h.sent.filter((c) => c !== "probe");
    assert.deepEqual(commands, ["play", "pause"]);
    assert.equal(h.state.paused, true, "the later action wins, deterministically");
  });

  test("a queue beyond its bound answers BUSY instead of growing", async () => {
    const h = scriptedHarness();
    const reports = await Promise.all(Array.from({ length: 8 }, () => h.controller.perform("status")));
    assert.ok(reports.some((r) => r.outcome === "BUSY"));
    assert.ok(reports.filter((r) => r.outcome === "CONFIRMED").length >= 1);
  });

  test("player control is refused during logout and after logout, before any channel opens", async () => {
    for (const permission of ["LOGGING_OUT", "LOGGED_OUT"] as const) {
      const h = scriptedHarness();
      h.setPermission(permission);
      const report = await h.controller.perform("play");
      assert.equal(report.outcome, "NOT_PERMITTED");
      assert.equal(report.reason, permission);
      assert.equal(h.opened, 0);
    }
  });

  test("a logout that starts mid-action stops it before the command is sent", async () => {
    const h = scriptedHarness({ loadingProbes: 2 });
    const pending = h.controller.perform("play", { waitForReadyMs: 2_000 });
    await Promise.resolve();
    h.setPermission("LOGGING_OUT");
    const report = await pending;
    assert.equal(report.outcome, "NOT_PERMITTED");
    assert.equal(h.sent.includes("play"), false);
  });

  test("a cancelled request stops at the next checkpoint", async () => {
    const h = scriptedHarness({ loadingProbes: 3 });
    const abort = new AbortController();
    abort.abort();
    const report = await h.controller.perform("play", { signal: abort.signal, waitForReadyMs: 1_000 });
    assert.equal(report.outcome, "TIMEOUT");
    assert.equal(report.reason, "CANCELLED");
    assert.equal(h.sent.includes("play"), false);
  });

  test("an unknown action is rejected before anything happens", async () => {
    const h = scriptedHarness();
    await assert.rejects(h.controller.perform("seek" as PlayerAction), TypeError);
    assert.equal(h.opened, 0);
  });
});

describe("player controller — honesty property over every scripted failure", () => {
  test("no combination reports success without a verified observation", async () => {
    const scripts: PlayerScript[] = [
      {}, { noVideo: true }, { loadingProbes: 50 }, { refuse: { play: "NOT_ALLOWED", enter_fullscreen: "NOT_ALLOWED" } },
      { ignore: ["play", "pause", "enter_fullscreen", "exit_fullscreen"] }, { hang: "play" }, { hang: "enter_fullscreen" },
      { closeTabOn: "pause" }, { disconnectOn: "exit_fullscreen" }, { lagProbes: 100 }, { refuse: { play: "UNKNOWN" } },
    ];
    for (const script of scripts) {
      for (const initial of [{}, { paused: false }, { fullscreen: true }]) {
        for (const action of ["play", "pause", "fullscreen", "exit_fullscreen", "status"] as PlayerAction[]) {
          assertHonest(await scriptedHarness(script, initial).controller.perform(action));
        }
      }
    }
  });
});

// ── Playback progress (opened vs. actually playing) ──────────────────────────

function progressHarness(opts: { advance: boolean; mediaError?: number }) {
  let time = 0;
  let state = frame({ paused: true, currentTime: 10 });
  const sent: PlayerCommand[] = [];
  const channel: PlaybackControlChannel = {
    connectionGeneration: 1,
    targetId: "watch-1",
    loss: () => undefined,
    async currentContentId() { return undefined; },
    async run(command) {
      sent.push(command);
      if (command === "play") state = { ...state, paused: false };
      else if (command === "probe" && !state.paused) {
        state = {
          ...state,
          currentTime: opts.advance ? state.currentTime + 0.1 : state.currentTime,
          mediaError: opts.mediaError ?? 0,
        };
      }
      return { state };
    },
    async close() {},
  };
  const controller = createPlayerController({
    openChannel: async () => channel,
    permission: () => "OK",
    now: () => time,
    sleep: async (ms) => { time += ms; await Promise.resolve(); },
    timing: { verifyTimeoutMs: 1_000, pollIntervalMs: 100, actionDeadlineMs: 5_000, commandDeadlineMs: 2_000 },
  });
  return { controller, sent, get time() { return time; } };
}

describe("player controller — playback progress", () => {
  test("without confirmProgressMs nothing extra is probed and no progress is reported", async () => {
    const h = progressHarness({ advance: true });
    const report = await h.controller.perform("play");
    assert.equal(report.outcome, "CONFIRMED");
    assert.equal(report.progress, undefined);
    assert.deepEqual(h.sent, ["probe", "play"]);
  });

  test("an advancing current_time is reported as ADVANCING after one extra probe", async () => {
    const h = progressHarness({ advance: true });
    const report = await h.controller.perform("play", { confirmProgressMs: 2_000 });
    assertHonest(report);
    assert.equal(report.progress, "ADVANCING");
    assert.deepEqual(h.sent, ["probe", "play", "probe"]);
    assert.ok(h.time <= 100, "returns as soon as time moves");
  });

  test("a stuck current_time is STALLED, still honest, and bounded by the wait", async () => {
    const h = progressHarness({ advance: false });
    const report = await h.controller.perform("play", { confirmProgressMs: 500 });
    assertHonest(report);
    assert.equal(report.outcome, "CONFIRMED");
    assert.equal(report.progress, "STALLED");
    assert.match(report.message, /did not advance/);
    assert.ok(h.time <= 600);
  });

  test("a media error stops the wait early and is named in the state", async () => {
    const h = progressHarness({ advance: false, mediaError: 2 });
    const report = await h.controller.perform("play", { confirmProgressMs: 2_000 });
    assert.equal(report.progress, "STALLED");
    assert.equal(report.state?.player_error, "MEDIA_ERR_NETWORK");
    assert.ok(h.time <= 100);
  });
});
