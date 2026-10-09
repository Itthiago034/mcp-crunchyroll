import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { DEFAULT_BROWSER_SESSION_CONFIG, MAX_API_RESPONSE_BYTES,
  type ApiExecutionResponse, type CdpConnection } from "../src/transport/browser-lifecycle-types.js";
import { readDevToolsEndpoint, resolveBrowserExecutable } from "../src/transport/browser-profile.js";
import { createBrowserSessionManager, createRealBrowserSessionSeams,
  CRUNCHYROLL_FETCH_FUNCTION } from "../src/transport/browser-session-manager.js";
import { createCdpConnector, DEFAULT_CDP_LIMITS } from "../src/transport/cdp-client.js";

const AUTHORIZATION = "Bearer synthetic-load-fixture";
const CONCURRENCIES = [1, 6, 24, 64];

async function pool<T>(count: number, concurrency: number, task: (id: number) => Promise<T>) {
  let next = 0;
  const results = new Array<T>(count);
  // Wait for all workers even if one fails, so teardown never races owned work.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const id = next++;
      results[id] = await task(id);
    }
  }));
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  return results;
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

test("real Chromium validates concurrent HTTP requests, resource limits and recovery", {
  timeout: 120_000,
}, async (t) => {
  // Fail if no browser exists: this validation must never silently pass by skipping.
  const executablePath = resolveBrowserExecutable(process.env);
  const base = await mkdtemp(join(tmpdir(), "mcp-browser-load-"));
  const profileDir = join(base, "profile");
  const seen = new Map<string, number>();
  const guards: Array<{ cookieAbsent: boolean; authorizationExpected: boolean }> = [];
  const streamResults: Array<{ bytes: number; cancelled: boolean }> = [];
  const sockets = new Set<Socket>();
  let active = 0;
  let peakActive = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    if (url.pathname === "/page") {
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "fixture_cookie=must-not-travel; SameSite=Lax" });
      res.end("<!doctype html><title>MCP load fixture</title>");
      return;
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    seen.set(req.url!, (seen.get(req.url!) ?? 0) + 1);
    guards.push({ cookieAbsent: req.headers.cookie === undefined,
      authorizationExpected: req.headers.authorization === AUTHORIZATION });
    active += 1;
    peakActive = Math.max(peakActive, active);
    res.once("close", () => { active -= 1; });
    if (url.pathname === "/disconnect") { req.socket.destroy(); return; }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { Location: "/redirect-target" }); res.end(); return;
    }
    if (url.pathname === "/oversize") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const observation = { bytes: 0, cancelled: false };
      streamResults.push(observation);
      const total = 1024 * 1024;
      const chunk = Buffer.alloc(16 * 1024, 120);
      const timer = setInterval(() => {
        observation.bytes += chunk.length;
        res.write(chunk);
        if (observation.bytes >= total) { clearInterval(timer); res.end(); }
      }, 2);
      res.once("close", () => {
        clearInterval(timer);
        observation.cancelled = observation.bytes < total;
      });
      return;
    }
    const status = url.pathname === "/error" ? Number(url.searchParams.get("status")) : 200;
    const timer = setTimeout(() => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ id: url.searchParams.get("id"), marker: "á😀", status }));
    }, 20);
    res.once("close", () => clearTimeout(timer));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  const manager = createBrowserSessionManager({
    ...DEFAULT_BROWSER_SESSION_CONFIG, launchMode: "headless", executablePath,
    profileDir, initialPageUrl: `${origin}/page`,
  }, createRealBrowserSessionSeams(DEFAULT_BROWSER_SESSION_CONFIG.cdpCommandTimeoutMs));
  let connection: CdpConnection | undefined;
  const timings: Array<Record<string, number>> = [];
  try {
    await manager.start();
    const generation = manager.connectionGeneration();
    const targetId = await manager.ensureManagedPage();
    const endpoint = await readDevToolsEndpoint(profileDir);
    connection = await createCdpConnector(10_000).connect(endpoint.webSocketDebuggerUrl);
    const cdp = connection;
    const version = await cdp.send("Browser.getVersion") as { product: string };
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId, flatten: true,
    }) as { sessionId: string };
    // Wait for the real page origin before fetching; about:blank may still be
    // active immediately after Target.createTarget returns.
    let pageReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const frame = await cdp.send("Runtime.evaluate", {
        expression: "({ origin: location.origin, state: document.readyState })", returnByValue: true,
      }, sessionId) as { result: { value: { origin: string; state: string } } };
      if (frame.result.value.origin === origin && frame.result.value.state === "complete") {
        pageReady = true; break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(pageReady, true, "fixture page reached its real network origin");
    const cookie = await cdp.send("Runtime.evaluate", {
      expression: 'document.cookie.includes("fixture_cookie=must-not-travel")', returnByValue: true,
    }, sessionId) as { result: { value: boolean } };
    assert.equal(cookie.result.value, true, "a cookie exists, so credentials omission is actually exercised");

    async function request(path: string, maxBytes = MAX_API_RESPONSE_BYTES) {
      const frame = await cdp.send("Runtime.callFunctionOn", {
        functionDeclaration: CRUNCHYROLL_FETCH_FUNCTION,
        executionContextId: contextId,
        arguments: [origin + path, "GET", AUTHORIZATION, maxBytes].map((value) => ({ value })),
        awaitPromise: true, returnByValue: true, silent: true,
      }, sessionId) as { exceptionDetails?: unknown; result?: { value?: ApiExecutionResponse } };
      if (frame.exceptionDetails !== undefined) return { failed: true as const };
      assert.ok(frame.result?.value, "CDP returned a structured response");
      return { failed: false as const, response: frame.result.value };
    }
    let contextId: number | undefined;
    const unsubscribe = cdp.on("Runtime.executionContextCreated", (params, frameSession) => {
      const context = (params as { context?: { id: number; origin: string; auxData?: { isDefault?: boolean } } }).context;
      if (frameSession === sessionId && context?.origin === origin && context.auxData?.isDefault) contextId = context.id;
    });
    try { await cdp.send("Runtime.enable", undefined, sessionId); } finally { unsubscribe(); }
    assert.ok(contextId !== undefined);

    for (const concurrency of CONCURRENCIES) {
      peakActive = 0;
      const elapsed: number[] = [];
      const started = performance.now();
      await pool(64, concurrency, async (id) => {
        const begin = performance.now();
        const result = await request(`/ok?stage=${concurrency}&id=${id}`);
        elapsed.push(performance.now() - begin);
        assert.equal(result.failed, false);
        if (result.failed) throw new Error("Unexpected page fetch failure");
        assert.equal(result.response.status, 200);
        assert.equal(result.response.truncated, false);
        assert.deepEqual(JSON.parse(result.response.body), { id: String(id), marker: "á😀", status: 200 });
      });
      const durationMs = performance.now() - started;
      if (concurrency > 1) assert.ok(peakActive >= 2, "server observed overlapping real HTTP requests");
      timings.push({ requests: 64, concurrency, peakActiveHttp: peakActive,
        durationMs: Number(durationMs.toFixed(2)), p50Ms: percentile(elapsed, 0.5),
        p95Ms: percentile(elapsed, 0.95), requestsPerSecond: Number((64_000 / durationMs).toFixed(2)) });
    }
    await pool(24, 12, async (id) => {
      const status = id % 2 ? 429 : 503;
      const result = await request(`/error?status=${status}&id=${id}`);
      assert.equal(result.failed, false);
      if (result.failed) throw new Error("HTTP error must be returned as a response");
      assert.equal(result.response.status, status);
    });
    await pool(12, 12, async (id) => {
      const result = await request(`/redirect?id=${id}`);
      assert.equal(result.failed, false);
      if (result.failed) throw new Error("Manual redirect must not cause a fetch exception");
      assert.equal(result.response.status, 0, "browser returns an opaque manual redirect");
    });
    assert.equal([...seen.keys()].some((path) => path.startsWith("/redirect-target")), false);
    const reusableConnectionsBeforeReset = sockets.size;
    await pool(12, 12, async (id) => {
      const result = await request(`/disconnect?id=${id}`);
      assert.equal(result.failed, true, "real connection reset rejects the browser fetch");
    });
    await pool(12, 6, async (id) => {
      const budget = id % 2 ? 4096 : MAX_API_RESPONSE_BYTES;
      const result = await request(`/oversize?id=${id}`, budget);
      assert.equal(result.failed, false);
      if (result.failed) throw new Error("Oversized responses must produce the truncation marker");
      assert.equal(result.response.truncated, true);
      assert.ok(Buffer.byteLength(result.response.body, "utf8") <= budget);
    });
    // Browser cancellation can reach the server slightly after the CDP result.
    for (let attempt = 0; active !== 0 && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(active, 0);
    assert.equal(streamResults.length, 12);
    assert.ok(streamResults.every((stream) => stream.cancelled), "all oversized streams stopped before sending 1 MiB");
    const resetAttempts = [...seen.entries()].filter(([path]) => path.startsWith("/disconnect"));
    t.diagnostic(JSON.stringify({ resetAttempts: Object.fromEntries(resetAttempts) }));
    assert.equal(resetAttempts.length, 12);
    // ShouldResendRequest permits another attempt on a reused connection
    // before headers arrive. Each reset destroys that socket; a fresh socket
    // has no successful response and cannot trigger this resend path. These
    // retries do not use Chromium's separate kMaxRetryAttempts counter.
    const implicitGetRetries = resetAttempts.reduce((sum, [, count]) => sum + count - 1, 0);
    assert.ok(implicitGetRetries <= reusableConnectionsBeforeReset,
      "reset retries cannot exceed the pool of previously established connections");
    assert.ok([...seen.entries()].filter(([path]) => !path.startsWith("/disconnect"))
      .every(([, count]) => count === 1), "responses, redirects and oversize requests are not duplicated");
    assert.ok(guards.every((guard) => guard.cookieAbsent && guard.authorizationExpected));

    const burst = Array.from({ length: DEFAULT_CDP_LIMITS.maxPendingCommands }, () => cdp.send("Runtime.evaluate", {
      expression: "new Promise(resolve => setTimeout(() => resolve(true), 250))",
      awaitPromise: true, returnByValue: true,
    }, sessionId));
    const settledBurst = Promise.allSettled(burst);
    await assert.rejects(cdp.send("Runtime.evaluate", { expression: "true" }, sessionId),
      (error: unknown) => error instanceof BrowserLifecycleError && error.detail === "cdp-capacity");
    const settled = await settledBurst;
    assert.ok(settled.every((result) => result.status === "fulfilled"));
    const recovered = await request("/ok?stage=recovery&id=final");
    assert.equal(recovered.failed, false);
    if (recovered.failed) throw new Error("CDP did not recover after saturation");
    assert.equal(recovered.response.status, 200);
    assert.equal(manager.connectionGeneration(), generation, "one browser connection survived the workload");
    assert.equal(manager.state(), "BROWSER_READY");
    assert.ok(guards.every((guard) => guard.cookieAbsent && guard.authorizationExpected));
    assert.equal(seen.size, 317, "every logical request reached the fixture server");
    assert.equal(guards.length, 317 + implicitGetRetries);

    connection.close();
    await manager.stop();
    assert.equal(manager.state(), "STOPPED");
    const report = {
      browser: version.product, node: process.version, transport: "real Chromium + CDP + loopback HTTP/1.1",
      logicalRequests: 317, serverHttpAttempts: guards.length, successfulResponses: 257, expectedHttpErrors: 24,
      manualRedirects: 12, expectedConnectionResets: 12, cancelledOversizedResponses: 12,
      cdpBurst: { accepted: 128, rejectedAtCapacity: 1, recovered: true },
      cookiesOmitted: true, implicitGetRetriesOnReset: implicitGetRetries,
      reusableConnectionsBeforeReset,
      duplicateNormalRequests: 0, remainingActiveHttp: active,
      stopped: true, timings,
    };
    // Report persistence is opt-in; the test also prints results through TAP.
    if (process.env.CRUNCHYROLL_LOAD_REPORT_PATH) {
      await writeFile(process.env.CRUNCHYROLL_LOAD_REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
    }
    t.diagnostic(JSON.stringify(report));
  } finally {
    connection?.close();
    try { await manager.stop(); } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(base, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
    }
  }
});
