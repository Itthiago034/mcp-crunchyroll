// Player control against REAL Chromium and a loopback fixture.
//
// Synthetic only: a local HTTP server serves a watch page whose player lives in
// a CROSS-SITE iframe (127.0.0.1 → localhost), so Chromium puts it in its own
// process and the channel must reach it through auto-attach. No Crunchyroll,
// no account, no network beyond loopback.
//
// The browser is launched with `--autoplay-policy=user-gesture-required` HERE,
// in the test only, so the policy is strict and deterministic: the page's own
// gesture-less play() must be refused, and the controller's must not be.
// Production never adds an autoplay flag.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
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

/** A short mono 8-bit PCM tone: a real, decodable media resource with no codec dependency. */
function toneWav(seconds = 30, rate = 8000): Buffer {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i += 1) buffer[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buffer;
}

test("real Chromium: native player control through the closed channel", { timeout: 120_000 }, async (t) => {
  // Fail if no browser exists: this validation must never silently pass by skipping.
  const executablePath = resolveBrowserExecutable(process.env);
  const base = await mkdtemp(join(tmpdir(), "mcp-player-real-"));
  const wav = toneWav();
  const reports: string[] = [];
  const sockets = new Set<Socket>();
  let port = 0;

  const page = (body: string) => `<!doctype html><meta charset="utf-8"><title>fixture</title><body style="margin:0">${body}</body>`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    const html = (body: string) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(page(body)); };
    if (url.pathname === "/watch/GFRAME1") {
      return html(`<iframe src="http://localhost:${port}/player" allow="fullscreen" style="width:640px;height:360px;border:0"></iframe>`);
    }
    if (url.pathname === "/watch/GNOFS1") {
      return html(`<iframe src="http://localhost:${port}/player" allow="fullscreen 'none'" style="width:640px;height:360px;border:0"></iframe>`);
    }
    if (url.pathname === "/watch/GTOP1") {
      return html(`<div><video src="/tone.wav" preload="auto" style="width:640px;height:360px"></video></div>`);
    }
    if (url.pathname === "/player") {
      // The page's OWN autoplay attempt: no user gesture, so a strict policy refuses it.
      return html(`<video src="/tone.wav" preload="auto" style="width:640px;height:360px"></video>
        <script>
          const v = document.querySelector("video");
          v.addEventListener("loadedmetadata", () => {
            v.play().then(() => fetch("/report?autoplay=started"), (e) => fetch("/report?autoplay=" + e.name));
          });
        </script>`);
    }
    if (url.pathname === "/tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Accept-Ranges": "none" });
      return res.end(wav);
    }
    if (url.pathname === "/report") {
      reports.push(url.searchParams.get("autoplay") ?? "");
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  // The player frame is served from localhost on the same port: listen there too.
  const localhostServer = createServer(server.listeners("request")[0] as never);
  localhostServer.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    localhostServer.once("error", reject);
    localhostServer.listen(port, "localhost", resolve);
  }).catch(() => undefined);

  const real = createRealBrowserSessionSeams(DEFAULT_BROWSER_SESSION_CONFIG.cdpCommandTimeoutMs);
  const manager = createBrowserSessionManager(
    {
      ...DEFAULT_BROWSER_SESSION_CONFIG,
      launchMode: "headless",
      initialPageUrl: "about:blank",
      watchPageBaseUrl: `http://127.0.0.1:${port}/watch/`,
      playerFrameOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
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
        const fixtureTargets = listed.targetInfos.filter((info) => info.url.includes(`:${port}/`));
        assert.ok(fixtureTargets.length >= 1, "the playback tab is still open");
        for (const info of fixtureTargets) assert.equal(info.attached, false, `${info.type} ${info.url}`);
      } finally {
        raw.close();
      }
    });
  } finally {
    await manager.stop().catch(() => undefined);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => localhostServer.close(() => resolve()));
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
});
