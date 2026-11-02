// Offline SDK subprocess fixture: reopen a temporary browser profile using
// the same manager as MCP. No provider, real account or cookie extraction.
import { createBrowserSessionManager, createRealBrowserSessionSeams } from "../src/transport/browser-session-manager.js";
import { DEFAULT_BROWSER_SESSION_CONFIG } from "../src/transport/browser-lifecycle-types.js";
import { readDevToolsEndpoint, resolveBrowserExecutable } from "../src/transport/browser-profile.js";
import { createCdpConnector } from "../src/transport/cdp-client.js";

const [profileDir, fixtureUrl] = process.argv.slice(2);
const url = new URL(fixtureUrl);
if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("loopback fixture required");
const manager = createBrowserSessionManager({
  ...DEFAULT_BROWSER_SESSION_CONFIG, launchMode: "headless",
  profileDir, initialPageUrl: fixtureUrl, executablePath: resolveBrowserExecutable(),
}, createRealBrowserSessionSeams(10_000));
let connection: Awaited<ReturnType<ReturnType<typeof createCdpConnector>["connect"]>> | undefined;
let ready = false;
process.once("SIGTERM", () => {
  connection?.close();
  void manager.stop().then(() => process.exit(0), () => process.exit(1));
});
try {
  await manager.start();
  const targetId = await manager.ensureManagedPage();
  connection = await createCdpConnector(10_000).connect((await readDevToolsEndpoint(profileDir)).webSocketDebuggerUrl);
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = await connection.send("Runtime.evaluate", {
      // Read only loading/origin booleans of this offline fixture, no cookies.
      expression: `location.origin === ${JSON.stringify(url.origin)} && document.readyState === 'complete'`,
      returnByValue: true,
    }, sessionId) as { result?: { value?: boolean } };
    if (frame.result?.value === true) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
} finally {
  connection?.close();
  await manager.stop();
}
if (!ready) process.exitCode = 1;
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test.handoff", params: {
  ready, browserStopped: manager.state() === "STOPPED",
} }) + "\n");
