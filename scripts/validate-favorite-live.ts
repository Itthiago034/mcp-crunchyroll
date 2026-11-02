// Explicit opt-in live check: only reasserts true on an ALREADY favorited item.
// Uses the MCP stdio surface; never reads credentials or exposes browser/CDP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { browserLaunchEnvironment } from "./browser-subprocess-environment.js";

const id = process.argv[2];
if (!id || !/^[A-Z0-9]{1,32}$/.test(id)) throw new Error("Supply an explicit public series/movie ID");
const client = new Client({ name: "favorite-live-validation", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  cwd: fileURLToPath(new URL("../", import.meta.url)), env: browserLaunchEnvironment(), stderr: "pipe" });
transport.stderr?.on("data", () => {}); // Do not retain diagnostics from authenticated runtime.
const report: Record<string, unknown> = { scope: "real MCP stdio; preserve existing favorite=true", passed: false };
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
  const text = (result.content as Array<{type:string;text?:string}>).find(c => c.type === "text")?.text;
  const data = text ? JSON.parse(text) : {};
  if (result.isError) throw new Error(typeof data.code === "string" ? data.code : "tool_error");
  return data;
}
try {
  await client.connect(transport);
  report.phase = "login_existing_session";
  const login = await call("crunchyroll_login");
  if (login.profile_ready !== true) throw new Error("manual_login_required");
  report.phase = "precondition";
  const before = await call("crunchyroll_get_watchlist", { n: 50 });
  const item = before.items?.find((entry: {id:string}) => entry.id === id);
  if (item?.is_favorite !== true) throw new Error("precondition_existing_favorite_true_required");
  report.before_favorite = true;
  report.phase = "explicit_set_true_twice";
  const first = await call("crunchyroll_set_favorite", { content_id: id, favorite: true });
  const second = await call("crunchyroll_set_favorite", { content_id: id, favorite: true });
  report.outcomes = [first, second].map(value => ({
    outcome: value.outcome, certainty: value.outcome_certainty,
    favorite: value.favorite, retry_performed: value.retry_performed,
    verify_with: value.verify_with,
  }));
  if ([first, second].some(value => value.outcome !== "APPLIED" || value.favorite !== true)) throw new Error("setter_not_confirmed");
  report.phase = "readback";
  const after = await call("crunchyroll_get_watchlist", { n: 50 });
  if (after.items?.find((entry: {id:string}) => entry.id === id)?.is_favorite !== true) throw new Error("favorite_readback_failed");
  report.after_favorite = true;
  report.wire_contract_accepted = "SET_FAVORITE requires HTTP 204/EMPTY; GET_WATCHLIST_ENTRY exact target accepted";
  report.passed = true;
  report.phase = "complete";
} catch (error) {
  const allowed = new Set(["manual_login_required", "tool_error", "precondition_existing_favorite_true_required", "setter_not_confirmed", "favorite_readback_failed"]);
  report.blocker = error instanceof Error && allowed.has(error.message) ? error.message : "live_validation_failed";
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  const text = JSON.stringify(report, null, 2) + "\n";
  if (process.env.CRUNCHYROLL_LIVE_REPORT_PATH) await writeFile(process.env.CRUNCHYROLL_LIVE_REPORT_PATH, text);
  process.stdout.write(text);
}
