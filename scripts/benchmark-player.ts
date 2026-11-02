// Benchmark — previous behaviour versus Crunchyroll MCP 2.0.
//
// Two separately labelled parts, never mixed:
//
//  A. REAL measurements in real Chromium against the synthetic loopback player
//     fixture (no Crunchyroll, no account): native player control through the
//     closed channel, versus an APPROXIMATION of the previous ad hoc path the
//     agent improvised (a fresh Node process per action that reads
//     DevToolsActivePort, opens its own CDP WebSocket and evaluates a script).
//  B. SYNTHETIC measurements of the auth layer: the previous callContentTool
//     logic (copied verbatim below) and the new callWithSession, run against the
//     SAME fake authority, fake login and fake gateway, so only the logic differs.
//
// Usage (non-root, a Chromium-family browser available):
//   CRUNCHYROLL_BROWSER_EXECUTABLE=/path/to/chrome npx tsx scripts/benchmark-player.ts [iterations]
// Writes docs/validation-results/benchmark-player.json.

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_BROWSER_SESSION_CONFIG } from "../src/transport/browser-lifecycle-types.js";
import { resolveBrowserExecutable } from "../src/transport/browser-profile.js";
import { createBrowserSessionManager, createRealBrowserSessionSeams } from "../src/transport/browser-session-manager.js";
import { createPlayerController, type PlayerAction } from "../src/transport/player-controller.js";
import { callWithSession, createSessionRecovery } from "../src/transport/session-recovery.js";
import { TransportError } from "../src/transport/transport-error.js";
import { startPlayerFixture } from "../test/_player-fixture.js";

const ITERATIONS = Number(process.argv[2] ?? 15);

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
  const round = (v: number) => Math.round(v * 10) / 10;
  return { n: values.length, p50_ms: round(pick(0.5)), p95_ms: round(pick(0.95)), max_ms: round(sorted.at(-1) ?? 0) };
}

/** Total resident memory of the browser processes using this profile, in MiB. */
async function browserRssMiB(profileDir: string): Promise<number> {
  let pages = 0;
  for (const pid of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf-8");
      if (!cmdline.includes(profileDir)) continue;
      pages += Number((await readFile(`/proc/${pid}/statm`, "utf-8")).split(" ")[1]);
    } catch {
      // the process exited between listing and reading
    }
  }
  return Math.round((pages * 4096) / 1024 / 1024);
}

/** The previous ad hoc approach, approximated: one fresh process and one raw CDP socket per action. */
const AD_HOC_SCRIPT = `
const { readFileSync } = require("node:fs");
const WebSocket = require(process.env.WS_MODULE);
const [port, path] = readFileSync(process.env.PROFILE + "/DevToolsActivePort", "utf-8").trim().split("\\n");
const ws = new WebSocket("ws://127.0.0.1:" + port + path);
let id = 0; const pending = new Map();
const send = (method, params, sessionId) => new Promise((resolve) => {
  const n = ++id; pending.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params, sessionId }));
});
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
ws.on("open", async () => {
  const { targetInfos } = await send("Target.getTargets", {});
  const page = targetInfos.find((t) => t.type === "page" && t.url.includes("/watch/"));
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const expr = process.env.ACTION === "play" ? "document.querySelector('video').play().then(() => !document.querySelector('video').paused)"
    : process.env.ACTION === "pause" ? "(document.querySelector('video').pause(), document.querySelector('video').paused)"
    : process.env.ACTION === "fullscreen" ? "document.querySelector('video').parentElement.requestFullscreen().then(() => !!document.fullscreenElement)"
    : "document.exitFullscreen().then(() => !document.fullscreenElement)";
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  await send("Target.detachFromTarget", { sessionId });
  process.stdout.write(JSON.stringify({ ok: r && r.result && r.result.value === true }));
  ws.close(); process.exit(0);
});
`;

async function adHoc(action: string, profileDir: string): Promise<{ ms: number; ok: boolean }> {
  const started = performance.now();
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", AD_HOC_SCRIPT], {
      env: { ...process.env, PROFILE: profileDir, ACTION: action, WS_MODULE: require_resolve_ws() },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("exit", () => resolve(out));
  });
  const ms = performance.now() - started;
  let ok = false;
  try { ok = JSON.parse(output).ok === true; } catch { ok = false; }
  return { ms, ok };
}

function require_resolve_ws(): string {
  return join(process.cwd(), "node_modules", "ws");
}

async function partA() {
  const executablePath = resolveBrowserExecutable(process.env);
  const base = await mkdtemp(join(tmpdir(), "mcp-player-bench-"));
  const profileDir = join(base, "profile");
  const fixture = await startPlayerFixture();
  const manager = createBrowserSessionManager(
    {
      ...DEFAULT_BROWSER_SESSION_CONFIG,
      launchMode: "headless",
      initialPageUrl: "about:blank",
      watchPageBaseUrl: fixture.watchBase,
      playerFrameOrigins: fixture.origins,
      profileDir,
      executablePath,
    },
    createRealBrowserSessionSeams(DEFAULT_BROWSER_SESSION_CONFIG.cdpCommandTimeoutMs),
  );
  const controller = createPlayerController({
    openChannel: () => manager.openPlaybackControlChannel(),
    permission: () => "OK",
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const result: Record<string, unknown> = {
    kind: "REAL",
    browser: execFileSync(executablePath, ["--version"], { encoding: "utf-8" }).trim(),
    launch_mode: "headless",
    iterations: ITERATIONS,
  };
  try {
    const startedBrowser = performance.now();
    await manager.start();
    result.browser_start_ms = Math.round(performance.now() - startedBrowser);
    // Top-level player page, so the ad hoc approximation (which, like the
    // improvised scripts, only evaluates in the top document) can work at all.
    const opened = performance.now();
    await manager.openWatchPage("GTOP1");
    const first = await controller.perform("play", { expectContentId: "GTOP1", waitForReadyMs: 15_000 });
    result.open_and_autoplay_ms = Math.round(performance.now() - opened);
    result.open_and_autoplay_outcome = first.outcome;
    await controller.perform("pause");

    const rssBefore = await browserRssMiB(profileDir);
    const native: Record<string, number[]> = {};
    const nativeVerified: Record<string, number> = {};
    const cpuBefore = process.cpuUsage();
    const actions: PlayerAction[] = ["play", "pause", "fullscreen", "exit_fullscreen", "status"];
    for (let i = 0; i < ITERATIONS; i += 1) {
      for (const action of actions) {
        const t0 = performance.now();
        const report = await controller.perform(action);
        (native[action] ??= []).push(performance.now() - t0);
        nativeVerified[action] = (nativeVerified[action] ?? 0) + (report.verified ? 1 : 0);
      }
    }
    const cpu = process.cpuUsage(cpuBefore);
    const rssAfter = await browserRssMiB(profileDir);
    // Control: the same tab left alone (paused) for a while, with no control action.
    await new Promise((r) => setTimeout(r, 5_000));
    const rssIdle = await browserRssMiB(profileDir);
    // Second native round: growth that continues per action would show here.
    for (let i = 0; i < ITERATIONS; i += 1) for (const action of actions) await controller.perform(action);
    const rssSecondRound = await browserRssMiB(profileDir);
    result.native = Object.fromEntries(actions.map((a) => [a, { ...stats(native[a]), verified_rate: nativeVerified[a] / ITERATIONS }]));
    result.native_node_cpu_ms_per_action = Math.round(((cpu.user + cpu.system) / 1000 / (ITERATIONS * actions.length)) * 100) / 100;
    result.browser_rss_mib = {
      before_native_round: rssBefore,
      after_native_round: rssAfter,
      after_5s_idle: rssIdle,
      after_second_native_round: rssSecondRound,
    };

    const adhoc: Record<string, number[]> = {};
    const adhocOk: Record<string, number> = {};
    for (let i = 0; i < ITERATIONS; i += 1) {
      for (const action of ["play", "pause", "fullscreen", "exit_fullscreen"]) {
        const run = await adHoc(action, profileDir);
        (adhoc[action] ??= []).push(run.ms);
        adhocOk[action] = (adhocOk[action] ?? 0) + (run.ok ? 1 : 0);
      }
    }
    result.browser_rss_mib_after_ad_hoc = await browserRssMiB(profileDir);
    result.ad_hoc_approximation = Object.fromEntries(
      Object.keys(adhoc).map((a) => [a, { ...stats(adhoc[a]), self_reported_ok_rate: adhocOk[a] / ITERATIONS }]),
    );
  } finally {
    await manager.stop().catch(() => undefined);
    await fixture.close();
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

// ── Part B: auth logic under identical fakes ────────────────────────────────

interface World {
  installedAt: number | undefined;
  expiresAt: number;
  everEstablished: boolean;
  logins: number;
  dispatches: number;
  gatewayCalls: number;
  loginFlight?: Promise<{ accepted: boolean }>;
}

const LOGIN_MS = 120; // simulated observation of a signed-in page minting a bearer
const REQUEST_MS = 20; // simulated provider round trip

function makeWorld(state: "COLD" | "EXPIRED"): World {
  return { installedAt: state === "EXPIRED" ? 1 : undefined, expiresAt: 0, everEstablished: state === "EXPIRED", logins: 0, dispatches: 0, gatewayCalls: 0 };
}
const usable = (w: World) => w.installedAt !== undefined && w.expiresAt > Date.now();
function login(w: World): Promise<{ accepted: boolean }> {
  // Single-flight, like the real orchestrator.
  w.loginFlight ??= (async () => {
    w.logins += 1;
    await new Promise((r) => setTimeout(r, LOGIN_MS));
    w.installedAt = Date.now();
    w.expiresAt = Date.now() + 300_000;
    w.everEstablished = true;
    return { accepted: true };
  })().finally(() => { w.loginFlight = undefined; });
  return w.loginFlight;
}
async function gateway(w: World, probe?: { dispatched: boolean }) {
  w.gatewayCalls += 1;
  if (!usable(w)) throw new TransportError("AUTH_NOT_READY");
  if (probe) probe.dispatched = true;
  w.dispatches += 1;
  await new Promise((r) => setTimeout(r, REQUEST_MS));
  return { ok: true };
}

/** The previous logic, verbatim apart from the injected world. */
async function previousCallContentTool(w: World) {
  try {
    return await gateway(w);
  } catch (error) {
    const expired = error instanceof TransportError && error.kind === "AUTH_NOT_READY" && w.installedAt !== undefined && !usable(w);
    if (!expired) throw error;
    const outcome = await login(w);
    if (!outcome?.accepted || !usable(w)) throw error;
    return await gateway(w);
  }
}

function newRecovery(w: World) {
  return createSessionRecovery({
    usable: () => usable(w),
    diagnostics: () => ({ availability: w.installedAt !== undefined ? "READY" : "UNAVAILABLE", reason: w.installedAt ? undefined : "INITIAL" }),
    authState: () => (usable(w) ? "PROFILE_READY" : "LOGIN_REQUIRED"),
    // Cold start: the human authorized this profile in an earlier process.
    eligibleForColdStart: async () => true,
    establishSilently: async () => (await login(w)).accepted,
    now: () => Date.now(),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
  });
}

async function scenario(name: string, state: "COLD" | "EXPIRED", concurrency: number, impl: "previous" | "new") {
  const w = makeWorld(state);
  const recovery = newRecovery(w);
  const started = performance.now();
  const results = await Promise.allSettled(Array.from({ length: concurrency }, () =>
    impl === "previous"
      ? previousCallContentTool(w)
      : callWithSession(recovery, (probe) => gateway(w, probe), (e) => e instanceof TransportError && e.kind === "AUTH_NOT_READY")));
  let failed = results.filter((r) => r.status === "rejected").length;
  let agentFollowUpCalls = 0;
  if (failed > 0) {
    // What the agent was instructed to do (skill, previous version): call
    // crunchyroll_login once, then repeat each failed call.
    agentFollowUpCalls += 1;
    await login(w);
    const retries = await Promise.allSettled(Array.from({ length: failed }, () => previousCallContentTool(w)));
    agentFollowUpCalls += failed;
    failed = retries.filter((r) => r.status === "rejected").length;
  }
  return {
    scenario: name,
    implementation: impl,
    concurrency,
    mcp_tool_calls: concurrency + agentFollowUpCalls,
    failed_tool_results: results.filter((r) => r.status === "rejected").length,
    auth_attempts: w.logins,
    gateway_attempts: w.gatewayCalls,
    provider_dispatches: w.dispatches,
    final_failures: failed,
    wall_ms: Math.round(performance.now() - started),
  };
}

async function partB() {
  const rows = [];
  for (const impl of ["previous", "new"] as const) {
    rows.push(await scenario("cold start, one content call", "COLD", 1, impl));
    rows.push(await scenario("cold start, two concurrent content calls", "COLD", 2, impl));
    rows.push(await scenario("expired session, one content call", "EXPIRED", 1, impl));
    rows.push(await scenario("expired session, ten concurrent content calls", "EXPIRED", 10, impl));
  }
  return { kind: "SYNTHETIC", simulated_login_ms: LOGIN_MS, simulated_request_ms: REQUEST_MS, rows };
}

const output = {
  generated_at: new Date().toISOString(),
  node: process.version,
  part_a_real_browser: await partA(),
  part_b_synthetic_auth: await partB(),
};
await writeFile(join(process.cwd(), "docs/validation-results/benchmark-player.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
