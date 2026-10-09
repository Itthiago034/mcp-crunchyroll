import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserLaunchEnvironment } from "../scripts/browser-subprocess-environment.js";

test("real Chromium retains a persistent fixture session across two subprocesses with the same profile/environment", {
  timeout: 45_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), "mcp-handoff-"));
  const profile = join(base, "profile");
  let established = 0;
  const resumed: boolean[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/establish") {
      established++;
      res.setHeader("Set-Cookie", "fixture_session=persistent-synthetic; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/");
    } else if (req.url === "/resume") {
      // Only the fixture's server checks its synthetic cookie. Never inspect
      // a real profile, cookie DB, provider response or browser cookie API.
      resumed.push(req.headers.cookie === "fixture_session=persistent-synthetic");
    }
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Offline profile handoff fixture</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let transport: StdioClientTransport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Both fixture subprocesses use headless Chromium + CDP for graceful
    // shutdown in CI. This verifies persistence, not interactive onboarding,
    // provider acceptance, or the desktop's real keyring service.
    const child = spawn(process.execPath,
      ["--import", "tsx", "test/_profile-handoff-child.ts", profile, `${origin}/establish`], {
      env: browserLaunchEnvironment(), stdio: "ignore", shell: false,
    });
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("first browser subprocess timed out")), 15_000);
        child.once("error", reject);
        child.once("exit", resolve);
      });
      assert.equal(exit, 0);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    assert.equal(established, 1);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "test/_profile-handoff-child.ts", profile, `${origin}/resume`],
      env: browserLaunchEnvironment(), stderr: "pipe",
    });
    const notification = new Promise<{ ready: boolean; browserStopped: boolean }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("SDK profile handoff timed out")), 20_000);
      transport!.onerror = reject;
      transport!.onmessage = (message) => {
        if ("method" in message && message.method === "test.handoff") {
          resolve(message.params as { ready: boolean; browserStopped: boolean });
        }
      };
    });
    const result = notification.then((value) => ({ value }), (error: unknown) => ({ error }));
    await transport.start();
    const received = await result;
    if ("error" in received) throw received.error;
    assert.deepEqual(received.value, { ready: true, browserStopped: true });
    assert.deepEqual(resumed, [true], "the profile retained the persistent fixture session across processes");
  } finally {
    clearTimeout(timer);
    await transport?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(base, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});
