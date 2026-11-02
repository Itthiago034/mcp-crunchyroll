import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { createPlayerController } from "../src/transport/player-controller.js";
import type { PlayerCommand, PlayerFrameState } from "../src/transport/browser-lifecycle-types.js";
import { observeOpenedPlayback } from "../src/transport/playback-workflow.js";

function harness(initial: Partial<PlayerFrameState> = {}, behavior: { advance?: boolean; contentId?: string; timeout?: boolean } = {}) {
  let now = 0;
  let state: PlayerFrameState = {
    hasVideo: true, hasSource: true, paused: true, ended: false,
    readyState: 4, currentTime: 12, duration: 100, muted: false,
    fullscreen: false, fullscreenEnabled: true, topLevel: false, ...initial,
  };
  const commands: PlayerCommand[] = [];
  const controller = createPlayerController({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      if (behavior.advance && !state.paused) state = { ...state, currentTime: state.currentTime + ms / 1_000 };
    },
    permission: () => "OK",
    timing: { actionDeadlineMs: 1_000, verifyTimeoutMs: 300, pollIntervalMs: 100 },
    openChannel: async () => ({
      connectionGeneration: 1, targetId: "test-watch", loss: () => undefined,
      currentContentId: async () => behavior.contentId ?? "GTEST",
      close: async () => {},
      run: async (command) => {
        commands.push(command);
        if (behavior.timeout) throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "deadline");
        if (command === "play") state = { ...state, paused: false };
        if (command === "enter_fullscreen") state = { ...state, fullscreen: true };
        return { state };
      },
    }),
  });
  return { controller, commands };
}

test("an opened page with no options still observes status and explicitly reports paused, not playing", async () => {
  const h = harness();
  const report = await observeOpenedPlayback(h.controller, "GTEST", {});
  assert.equal(report.state, "paused");
  assert.equal(report.playing_verified, false);
  assert.equal(report.current_time, 12);
  assert.equal(report.fullscreen, false);
  assert.equal(report.player_error, null);
  assert.match(report.message, /page opened.*playback was not verified/i);
  assert.deepEqual(h.commands, ["probe"], "no implicit autoplay or fullscreen");
  assert.equal(report.observation.action, "status");
});

test("optional fullscreen success cannot turn a stalled autoplay into verified playback", async () => {
  const h = harness();
  const report = await observeOpenedPlayback(h.controller, "GTEST", { autoplay: true, fullscreen: true });
  assert.equal(report.state, "unknown");
  assert.equal(report.playing_verified, false);
  assert.equal(report.fullscreen, true);
  assert.equal(report.success, false);
  assert.equal(report.partial, true);
  assert.equal(report.autoplay?.outcome, "NOT_CONFIRMED");
  assert.equal(report.fullscreen_control?.outcome, "CONFIRMED");
  assert.deepEqual(h.commands.filter((command) => command !== "probe"), ["play", "enter_fullscreen"]);
});

test("the play result exposes verified clock progress, not merely a successful command", async () => {
  const h = harness({}, { advance: true });
  const report = await observeOpenedPlayback(h.controller, "GTEST", { autoplay: true });
  assert.equal(report.state, "playing");
  assert.equal(report.playing_verified, true);
  assert.ok(report.current_time! > 12);
  assert.equal(report.autoplay?.playback.playing_verified, true);
  assert.equal(report.success, true);
  assert.match(report.message, /playback was verified by an advancing player clock/);
});

test("an opened but stalled unpaused player stays unknown after a bounded read-only wait", async () => {
  const h = harness({ paused: false });
  const report = await observeOpenedPlayback(h.controller, "GTEST", {});
  assert.equal(report.state, "unknown");
  assert.equal(report.playing_verified, false);
  assert.ok(h.commands.length > 1 && h.commands.length <= 4);
  assert.ok(h.commands.every((command) => command === "probe"));
});

test("loading and player errors remain distinguishable on an opened page", async () => {
  const loading = await observeOpenedPlayback(harness({ hasSource: false, readyState: 0 }).controller, "GTEST", {});
  assert.equal(loading.state, "loading");
  assert.equal(loading.playing_verified, false);
  const error = await observeOpenedPlayback(harness({ playerError: "MEDIA_DECODE", audioLocale: "ja-JP" }).controller, "GTEST", {});
  assert.equal(error.state, "error");
  assert.equal(error.player_error, "MEDIA_DECODE");
  assert.equal(error.audio_locale, "ja-JP");
  assert.equal(error.playing_verified, false);
});

test("navigation pending reports loading without probing the previous episode", async () => {
  const h = harness({ paused: false }, { advance: true, contentId: "GOLD" });
  const report = await observeOpenedPlayback(h.controller, "GTEST", { waitForReadyMs: 300 });
  assert.equal(report.state, "loading");
  assert.equal(report.current_time, null);
  assert.equal(report.fullscreen, null);
  assert.equal(report.playing_verified, false);
  assert.equal(report.observation.reason, "NAVIGATION_PENDING");
  assert.deepEqual(h.commands, []);
});

test("a timed out player probe does not erase the fact that only the page was opened", async () => {
  const h = harness({}, { timeout: true });
  const report = await observeOpenedPlayback(h.controller, "GTEST", {});
  assert.equal(report.state, "unknown");
  assert.equal(report.playing_verified, false);
  assert.equal(report.current_time, null);
  assert.equal(report.player_error, null);
  assert.equal(report.observation.outcome, "TIMEOUT");
  assert.match(report.message, /page opened.*playback was not verified/i);
});
