import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSessionManager, createRealBrowserSessionSeams } from "../src/transport/browser-session-manager.js";
import { DEFAULT_BROWSER_SESSION_CONFIG, type CdpConnection } from "../src/transport/browser-lifecycle-types.js";
import { resolveBrowserExecutable, readDevToolsEndpoint } from "../src/transport/browser-profile.js";
import { createCdpConnector } from "../src/transport/cdp-client.js";
import { performance } from "node:perf_hooks";

// Anonymous HTTPS navigation and six bounded reads. No credentials, page content, cookies,
// headers, query strings or authentication material are logged.
const base = await mkdtemp(join(tmpdir(), "mcp-live-probe-"));
const profileDir = join(base, "profile");
const manager = createBrowserSessionManager({ ...DEFAULT_BROWSER_SESSION_CONFIG,
  executablePath: resolveBrowserExecutable(process.env), launchMode: "headless", profileDir,
}, createRealBrowserSessionSeams(20_000));
let connection: CdpConnection | undefined;
const report: Record<string, unknown> = { target: "https://www.crunchyroll.com", status: "failed" };
try {
  await manager.start();
  const targetId = await manager.ensureManagedPage();
  connection = await createCdpConnector(20_000).connect((await readDevToolsEndpoint(profileDir)).webSocketDebuggerUrl);
  const version = await connection.send("Browser.getVersion") as { product: string };
  report.browser = version.product;
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
  connection.on("Network.responseReceived", (params, frameSession) => {
    const frame = params as { type?: string; response?: { status?: number } };
    if (frameSession === sessionId && frame.type === "Document") report.httpStatus = frame.response?.status;
  });
  await connection.send("Network.enable", undefined, sessionId);
  const result = await connection.send("Page.navigate", { url: "https://www.crunchyroll.com" }, sessionId) as { errorText?: string };
  if (result.errorText) {
    report.status = "blocked";
    report.networkError = /^net::ERR_[A-Z_]+$/.test(result.errorText) ? result.errorText : "navigation_failed";
    process.exitCode = 2;
  } else {
    // Wait for the actual page context, rather than evaluate in about:blank.
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const frame = await connection.send("Runtime.evaluate", {
        expression: "location.origin === 'https://www.crunchyroll.com' && document.readyState === 'complete'",
        returnByValue: true,
      }, sessionId) as { result?: { value?: boolean } };
      if (frame.result?.value === true) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("page_context_unavailable");
    let contextId: number | undefined;
    const unsubscribe = connection.on("Runtime.executionContextCreated", (params, frameSession) => {
      const context = (params as { context?: { id: number; origin: string; auxData?: { isDefault?: boolean } } }).context;
      if (frameSession === sessionId && context?.origin === "https://www.crunchyroll.com" && context.auxData?.isDefault) contextId = context.id;
    });
    try { await connection.send("Runtime.enable", undefined, sessionId); } finally { unsubscribe(); }
    if (contextId === undefined) throw new Error("page_context_unavailable");
    const cdp = connection;
    const paths = ["/", "/robots.txt", "/content/v2/discover/categories?locale=en-US"];
    const outcomes: Array<Record<string, unknown>> = [];
    let next = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (next < 6) {
        const index = next++;
        const path = paths[index % paths.length];
        const started = performance.now();
        try {
          const frame = await cdp.send("Runtime.callFunctionOn", {
            // Anonymous connectivity probe, deliberately separate from the
            // authenticated production primitive. Read headers, cancel body.
            functionDeclaration: `async function(url) {
              const response = await fetch(url, { credentials: "omit", redirect: "manual" });
              const status = response.status;
              const contentType = response.headers.get("content-type") || "";
              if (response.body) await response.body.cancel();
              return { status, contentType };
            }`,
            executionContextId: contextId,
            arguments: [{ value: "https://www.crunchyroll.com" + path }],
            awaitPromise: true, returnByValue: true, silent: true,
          }, sessionId) as { exceptionDetails?: unknown; result?: { value?: { status: number; contentType: string } } };
          const value = frame.result?.value;
          outcomes.push({ index, endpoint: path.split("?")[0],
            status: frame.exceptionDetails === undefined ? value?.status : undefined,
            responseReceived: frame.exceptionDetails === undefined && value !== undefined,
            durationMs: Number((performance.now() - started).toFixed(2)) });
        } catch {
          outcomes.push({ index, endpoint: path.split("?")[0], responseReceived: false,
            durationMs: Number((performance.now() - started).toFixed(2)) });
        }
      }
    }));
    report.concurrency = 2;
    report.anonymousReads = outcomes.sort((a, b) => Number(a.index) - Number(b.index));
    report.completedRequests = outcomes.length;
    report.status = outcomes.every((outcome) => outcome.responseReceived) ? "anonymous_responses_received" : "partial_network_failure";
    report.authenticatedOperationsValidated = false;
    if (report.status !== "anonymous_responses_received") process.exitCode = 1;
  }
} catch {
  report.status = "failed";
  report.failure = "browser_or_cdp_failure";
  process.exitCode = 1;
} finally {
  connection?.close();
  try { await manager.stop(); } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
  report.browserStopped = manager.state() === "STOPPED";
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (process.env.CRUNCHYROLL_LIVE_PROBE_REPORT_PATH) await writeFile(process.env.CRUNCHYROLL_LIVE_PROBE_REPORT_PATH, serialized);
  process.stdout.write(serialized);
}
