// Player control against REAL Chromium and a loopback fixture.
//
// Synthetic only: a local HTTP server serves a watch page whose player lives in
// a CROSS-SITE iframe (127.0.0.1 → 127.0.0.2), so Chromium puts it in its own
// process and the channel must reach it through auto-attach. No Crunchyroll,
// no account, no network beyond loopback.
//
// The browser is launched with `--autoplay-policy=user-gesture-required` HERE,
// in the test only, so the policy is strict and deterministic: the page's own
// gesture-less play() must be refused, and the controller's must not be.
// Production never adds an autoplay flag.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDevToolsEndpoint, resolveBrowserExecutable } from "../src/transport/browser-profile.js";
import { createCdpConnector } from "../src/transport/cdp-client.js";
import {
  createBrowserSessionManager,
  createRealBrowserSessionSeams,
} from "../src/transport/browser-session-manager.js";
import { DEFAULT_BROWSER_SESSION_CONFIG } from "../src/transport/browser-lifecycle-types.js";
import { createPlayerController } from "../src/transport/player-controller.js";
import { startPlayerFixture } from "./_player-fixture.js";

test("real Chromium: native player control through the closed channel", { timeout: 120_000 }, async (t) => {
  // Fail if no browser exists: this validation must never silently pass by skipping.
  const executablePath = resolveBrowserExecutable(process.env);
  const base = await mkdtemp(join(tmpdir(), "mcp-player-real-"));
  const fixture = await startPlayerFixture();
  const reports = fixture.autoplayReports;

  const real = createRealBrowserSessionSeams(DEFAULT_BROWSER_SESSION_CONFIG.cdpCommandTimeoutMs);
  const manager = createBrowserSessionManager(
    {
      ...DEFAULT_BROWSER_SESSION_CONFIG,
      launchMode: "headless",
      initialPageUrl: "about:blank",
      watchPageBaseUrl: fixture.watchBase,
      playerFrameOrigins: fixture.origins,
      profileDir: join(base, "profile"),
      executablePath,
    },
    {
      ...real,
      spawner: { spawn: (exe, args) => real.spawner.spawn(exe, [...args, "--autoplay-policy=user-gesture-required"]) },
    },
  );
  const controller = createPlayerController({
    openChannel: () => manager.openPlaybackControlChannel(),
    permission: () => "OK",
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  try {
    await manager.start();
    await manager.openWatchPage("GFRAME1");

    await t.test("play: the page's own gesture-less play() is refused, the controller's is verified", async () => {
      const report = await controller.perform("play", { expectContentId: "GFRAME1", waitForReadyMs: 15_000 });
      for (let i = 0; i < 50 && reports.length === 0; i += 1) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(reports, ["NotAllowedError"], "the strict autoplay policy is really active");
      assert.equal(report.outcome, "CONFIRMED", JSON.stringify(report));
      assert.equal(report.verified, true);
      assert.equal(report.state?.playing, true);
    });

    await t.test("status reports a progressing player without sending anything", async () => {
      const first = await controller.perform("status");
      await new Promise((r) => setTimeout(r, 600));
      const second = await controller.perform("status");
      assert.equal(second.executed, false);
      assert.ok((second.state?.current_time ?? 0) > (first.state?.current_time ?? 0), "currentTime advances");
    });

    await t.test("pause is verified", async () => {
      const report = await controller.perform("pause");
      assert.equal(report.outcome, "CONFIRMED", JSON.stringify(report));
      assert.equal(report.state?.paused, true);
    });

    await t.test("fullscreen and exit_fullscreen in the out-of-process frame are verified", async () => {
      const enter = await controller.perform("fullscreen");
      assert.equal(enter.outcome, "CONFIRMED", JSON.stringify(enter));
      assert.equal(enter.state?.fullscreen, true);
      const exit = await controller.perform("exit_fullscreen");
      assert.equal(exit.outcome, "CONFIRMED", JSON.stringify(exit));
      assert.equal(exit.state?.fullscreen, false);
    });

    await t.test("a frame denied fullscreen by its embedder is REFUSED_BY_BROWSER, never success", async () => {
      await manager.openWatchPage("GNOFS1");
      const report = await controller.perform("fullscreen", { expectContentId: "GNOFS1", waitForReadyMs: 15_000 });
      assert.equal(report.success, false, JSON.stringify(report));
      assert.equal(report.outcome, "REFUSED_BY_BROWSER");
      assert.equal(report.reason, "FULLSCREEN_NOT_ALLOWED_IN_FRAME");
    });

    await t.test("a top-level player in the reused tab is controlled after navigation", async () => {
      await manager.openWatchPage("GTOP1");
      const play = await controller.perform("play", { expectContentId: "GTOP1", waitForReadyMs: 15_000 });
      assert.equal(play.outcome, "CONFIRMED", JSON.stringify(play));
      const enter = await controller.perform("fullscreen");
      assert.equal(enter.outcome, "CONFIRMED", JSON.stringify(enter));
      const exit = await controller.perform("exit_fullscreen");
      assert.equal(exit.outcome, "CONFIRMED", JSON.stringify(exit));
    });

    await t.test("no CDP session is left attached to the playback tab or its player frame", async () => {
      // An independent loopback connection to the same test browser, used only
      // to READ target state. The channel under test has already been closed.
      const endpoint = await readDevToolsEndpoint(join(base, "profile"));
      const raw = await createCdpConnector(5_000).connect(endpoint.webSocketDebuggerUrl);
      try {
        const listed = (await raw.send("Target.getTargets", {})) as {
          targetInfos: Array<{ type: string; url: string; attached: boolean }>;
        };
        const fixtureTargets = listed.targetInfos.filter((info) => fixture.origins.some((o) => info.url.startsWith(o)));
        assert.ok(fixtureTargets.length >= 1, "the playback tab is still open");
        for (const info of fixtureTargets) assert.equal(info.attached, false, `${info.type} ${info.url}`);
      } finally {
        raw.close();
      }
    });
  } finally {
    await manager.stop().catch(() => undefined);
    await fixture.close();
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
});
