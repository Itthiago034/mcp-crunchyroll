import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createBrowserSessionManager, createRealBrowserSessionSeams,
} from "../src/transport/browser-session-manager.js";
import {
  resolveBrowserExecutable, readDevToolsEndpoint,
} from "../src/transport/browser-profile.js";
import { DEFAULT_BROWSER_SESSION_CONFIG } from "../src/transport/browser-lifecycle-types.js";
import { startLocalServer, type LocalServer } from "./_local-server.js";

const BROWSER = (() => {
  try { return resolveBrowserExecutable(process.env); } catch { return null; }
})();

/** Set by the bwrap host gate; absent in CI. Recorded, never required. */
const NET_ISOLATED = process.env.BT2_NET_ISOLATED === "1";

interface Harness {
  manager: ReturnType<typeof createBrowserSessionManager>;
  profileDir: string;
  server: LocalServer;
  cleanup: () => Promise<void>;
}

async function removeTemporaryProfileTree(base: string): Promise<void> {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    try {
      rmSync(base, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 50) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function harness(): Promise<Harness> {
  const server = await startLocalServer();
  const base = mkdtempSync(join(tmpdir(), "bt2-int-"));
  const profileDir = join(base, "browser-profile");
  const manager = createBrowserSessionManager(
    {
      ...DEFAULT_BROWSER_SESSION_CONFIG,
      launchMode: "headless",
      initialPageUrl: `${server.origin}/ok`,
      profileDir,
      executablePath: BROWSER!,
    },
    createRealBrowserSessionSeams(DEFAULT_BROWSER_SESSION_CONFIG.cdpCommandTimeoutMs),
  );
  return {
    manager,
    profileDir,
    server,
    cleanup: async () => {
      await manager.stop().catch(() => undefined);
      await server.close();
      await removeTemporaryProfileTree(base);
    },
  };
}

describe("BT2 integration — real browser against a loopback server", {
  skip: BROWSER ? false : "no supported browser executable",
}, () => {
  test("network isolation tier is recorded", () => {
    assert.ok(typeof NET_ISOLATED === "boolean");
  });

  test("start reaches BROWSER_READY and stop returns to STOPPED", async () => {
    const h = await harness();
    try {
      await h.manager.start();
      assert.equal(h.manager.state(), "BROWSER_READY");
      await h.manager.stop();
      assert.equal(h.manager.state(), "STOPPED");
    } finally { await h.cleanup(); }
  });

  test("the discovered endpoint is loopback with an ephemeral port", async () => {
    const h = await harness();
    try {
      await h.manager.start();
      const ep = await readDevToolsEndpoint(h.profileDir);
      assert.ok(ep.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:"), ep.webSocketDebuggerUrl);
      assert.notEqual(ep.port, 9222, "must not be the well-known default port");
      assert.ok(ep.port > 0 && ep.port < 65536);
    } finally { await h.cleanup(); }
  });

  test("the managed page is created at the loopback origin", async () => {
    const h = await harness();
    try {
      await h.manager.start();
      const pageId = await h.manager.ensureManagedPage();
      assert.ok(pageId.length > 0);
      assert.equal(h.manager.managedPageId(), pageId);
    } finally { await h.cleanup(); }
  });

  test("the managed browser actually loads the local test page", async () => {
    const h = await harness();
    try {
      await h.manager.start();
      assert.deepEqual(h.server.requests, [], "fresh server history is empty");
      const waiting = h.server.waitForRequest(
        (r) => r.method === "GET" && r.url === "/ok",
        5_000,
      );
      await h.manager.ensureManagedPage();
      const request = await waiting;
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/ok");
    } finally { await h.cleanup(); }
  });

  test("the profile and its ownership record survive across stop correctly", async () => {
    const h = await harness();
    try {
      await h.manager.start();
      const recordPath = join(h.profileDir, ".mcp-browser-owner.json");
      assert.equal(statSync(recordPath).mode & 0o777, 0o600, "record is 0600 while running");
      await h.manager.stop();
      assert.equal(statSync(h.profileDir).mode & 0o777, 0o700, "profile survives stop");
      assert.equal(existsSync(recordPath), false, "ownership record is cleared on stop");
    } finally { await h.cleanup(); }
  });

  test("a second start reuses the same profile directory", async () => {
    const h = await harness();
    try {
      await h.manager.start();
      await h.manager.stop();
      await h.manager.start();
      assert.equal(h.manager.state(), "BROWSER_READY");
      assert.equal(statSync(h.profileDir).mode & 0o777, 0o700);
    } finally { await h.cleanup(); }
  });

  test("cleanup runs even when the body fails", async () => {
    const h = await harness();
    let cleaned = false;
    try {
      await h.manager.start();
      throw new Error("deliberate failure");
    } catch (error) {
      assert.equal((error as Error).message, "deliberate failure");
    } finally {
      await h.cleanup();
      cleaned = true;
    }
    assert.equal(cleaned, true);
    assert.equal(existsSync(h.profileDir), false, "temporary profile removed");
  });

  test("cleanup closes the loopback server even when profile removal fails", async () => {
    const h = await harness();
    const base = dirname(h.profileDir);
    const locked = join(base, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "sentinel"), "synthetic");
    chmodSync(locked, 0);

    let cleanupError: unknown;
    try {
      await h.cleanup();
    } catch (error) {
      cleanupError = error;
    }

    try {
      assert.equal((cleanupError as NodeJS.ErrnoException | undefined)?.code, "EACCES");
      await assert.rejects(fetch(`${h.server.origin}/ok`));
    } finally {
      await h.server.close();
      if (existsSync(locked)) chmodSync(locked, 0o700);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
