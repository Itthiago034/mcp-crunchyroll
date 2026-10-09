import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserSubprocessEnvironment } from "./browser-subprocess-environment.js";

// Opt-in integration runner. No writes, watch history, account IDs or credentials
// are accepted as arguments or copied into the diagnostic report.
const root = fileURLToPath(new URL("../", import.meta.url));
const client = new Client({ name: "crunchyroll-live-validation", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], cwd: root,
  env: browserSubprocessEnvironment(), stderr: "pipe" });
transport.stderr?.on("data", () => { /* Avoid retaining or printing credential-bearing diagnostics. */ });
const report: Record<string, unknown> = {
  target: "Crunchyroll real via MCP stdio", plannedRequests: 12, concurrency: 2,
  completedRequests: 0, status: "blocked", blockers: [],
};

function payload(result: unknown): Record<string, unknown> {
  const tool = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  if (tool.isError) throw new Error("tool_error");
  const text = tool.content?.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("missing_text_result");
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_result_shape");
  return value as Record<string, unknown>;
}

try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 21);
  let readiness = payload(await client.callTool({ name: "crunchyroll_status", arguments: {} }));
  if (process.argv.includes("--login") && readiness.authenticated !== true) {
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      report.blockers = ["interactive_login_required", "interactive_browser_display_unavailable"];
    } else {
      console.error("Complete sign-in in the managed Crunchyroll browser window. Do not enter credentials in the terminal.");
      await client.callTool({ name: "crunchyroll_login", arguments: {} }, undefined, { timeout: 360_000 });
      readiness = payload(await client.callTool({ name: "crunchyroll_status", arguments: {} }));
    }
  }
  // Only structural readiness is retained; no identity, profile or auth material.
  report.readiness = { authenticated: readiness.authenticated === true,
    browserConnected: readiness.browser_connected === true, authState: readiness.auth_state };
  if (readiness.authenticated !== true || readiness.browser_connected !== true) {
    if (!(report.blockers as string[]).length) {
      report.blockers = [readiness.authenticated !== true ? "interactive_login_required" : "managed_browser_not_connected"];
    }
    process.exitCode = 2;
  } else {
    const operations = [
      { name: "crunchyroll_get_categories", arguments: {}, collection: "categories" },
      { name: "crunchyroll_search", arguments: { query: "Naruto", n: 5 }, collection: "results" },
      { name: "crunchyroll_browse", arguments: { n: 5 }, collection: "items" },
    ];
    const outcomes: Array<{ index: number; tool: string; passed: boolean; durationMs: number }> = [];
    let next = 0;
    // Twelve bounded reads, two in flight. No retry, regardless of error kind.
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (next < 12) {
        const index = next++;
        const operation = operations[index % operations.length];
        const started = performance.now();
        let passed = false;
        try {
          const value = payload(await client.callTool({ name: operation.name, arguments: operation.arguments },
            undefined, { timeout: 30_000 }));
          assert.ok(Array.isArray(value[operation.collection]));
          assert.equal(value.count, (value[operation.collection] as unknown[]).length);
          passed = true;
        } catch { /* Report the failing operation, never the raw provider body or error. */ }
        outcomes.push({ index, tool: operation.name, passed,
          durationMs: Number((performance.now() - started).toFixed(2)) });
      }
    }));
    report.completedRequests = outcomes.length;
    report.passedRequests = outcomes.filter((outcome) => outcome.passed).length;
    report.failedRequests = outcomes.filter((outcome) => !outcome.passed).length;
    report.status = outcomes.every((outcome) => outcome.passed) ? "passed" : "failed";
    report.outcomes = outcomes.sort((a, b) => a.index - b.index);
    process.exitCode = report.status === "passed" ? 0 : 1;
  }
} catch {
  report.status = "failed";
  report.blockers = ["mcp_initialization_or_login_failed"];
  process.exitCode = 1;
} finally {
  await client.close();
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (process.env.CRUNCHYROLL_LIVE_REPORT_PATH) await writeFile(process.env.CRUNCHYROLL_LIVE_REPORT_PATH, serialized);
  process.stdout.write(serialized);
}
