/**
 * Gate B5 — MCP boundary presentation tests for crunchyroll_logout.
 *
 * TDD RED B: these tests are written AGAINST the legacy handler (frozen
 * literal message) and MUST fail until GREEN B lands. GREEN B adds
 * formatLogoutResult() at the MCP boundary and the corresponding MCP case.
 *
 * The tests exercise the SAME real production path as the B2 suite
 * (withClient spawns the real server — source via tsx AND the compiled
 * bundle via plain node) and focus on the logout presentation contract:
 * structured JSON, no secrets, no paths, state-specific human messages,
 * and non-throwing error handling.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpClient } from "./_harness-client.js";
import {
  ensureConfigDir,
  saveTokens,
  saveSessionInfo,
  __resetTestHooks,
  __setUnlinkHook,
} from "../src/auth.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const TSX = join(ROOT, "node_modules/.bin/tsx");

// Each target is modeled with its real production executable, identical to
// the Gate A harness regression contract.
const TARGETS = [
  ["source (tsx)", { command: TSX, args: ["src/index.ts"] }] as const,
  ["bundle (node)", { command: process.execPath, args: ["dist/index.js"] }] as const,
];

function makeTokens() {
  return {
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
    expires_at: Date.now() + 3_600_000,
    token_type: "Bearer",
    account_id: "synthetic-account",
  };
}

async function withFakeHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "b5-boundary-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = prev;
    await import("node:fs/promises").then((fsp) =>
      fsp.rm(home, { recursive: true, force: true })
    );
  }
}

async function withClient(
  target: { command: string; args: string[] },
  fn: (client: McpClient) => Promise<void>
): Promise<void> {
  const client = new McpClient({ command: target.command, args: target.args, cwd: ROOT });
  try {
    const init = await client.initialize();
    assert.equal(init.result?.protocolVersion, "2025-03-26");
    assert.equal((init.result?.serverInfo as { name: string })?.name, "crunchyroll");
    await fn(client);
  } finally {
    client.kill();
  }
}

function logoutPayloadText(result: { content?: { type: string; text?: string }[] }): string {
  const content = result?.content ?? [];
  assert.equal(content[0]?.type, "text", "logout must respond with text content");
  return content[0].text ?? "";
}

describe("B5 MCP boundary logout presentation", () => {
  for (const [label, target] of TARGETS) {
    describe(`${label}`, () => {
      beforeEach(() => {
        __resetTestHooks();
      });
      afterEach(() => {
        __resetTestHooks();
      });

      // ---------------------------------------------------------------------------
      // B5-11 — successful clear returns STRUCTURED JSON output
      // ---------------------------------------------------------------------------
      test("B5-11: CLEARED → structured content with success/state/tokens/session/message", async () => {
        await withFakeHome(async () => {
          await ensureConfigDir();
          await saveTokens(makeTokens());
          await saveSessionInfo({
            email: "synthetic@example.com",
            account_id: "synthetic-account",
          });

          await withClient(target, async (client) => {
            const resp = await client.sendRequest("tools/call", {
              name: "crunchyroll_logout",
              arguments: {},
            });
            const text = logoutPayloadText(resp.result as { content?: { type: string; text?: string }[] });
            const payload = JSON.parse(text);
            assert.equal(payload.success, true);
            assert.equal(payload.state, "CLEARED");
            assert.equal(payload.tokens.state, "REMOVED");
            assert.equal(payload.session.state, "REMOVED");
            assert.equal(typeof payload.message, "string");
          });
        });
      });

      // ---------------------------------------------------------------------------
      // B5-12 — absence returns ALREADY_ABSENT with its own message
      // ---------------------------------------------------------------------------
      test("B5-12: ALREADY_ABSENT → structured content stating nothing to clear", async () => {
        await withFakeHome(async () => {
          // Brand-new fake HOME: no persisted artifacts.
          await withClient(target, async (client) => {
            const resp = await client.sendRequest("tools/call", {
              name: "crunchyroll_logout",
              arguments: {},
            });
            const text = logoutPayloadText(resp.result as { content?: { type: string; text?: string }[] });
            const payload = JSON.parse(text);
            assert.equal(payload.success, true);
            assert.equal(payload.state, "ALREADY_ABSENT");
            assert.ok(
              /nothing|no|already/i.test(payload.message),
              "absence message must reflect that nothing was persisted"
            );
          });
        });
      });

      // ---------------------------------------------------------------------------
      // B5-13 — failure states keep success:false with per-artifact reasons
      // ---------------------------------------------------------------------------
      test("B5-13: FAILED state → success false, reasons surfaced, no raw errors", async () => {
        await withFakeHome(async () => {
          const root = join(process.env.HOME!, ".strider", "crunchyroll");
          await ensureConfigDir();
          await saveTokens(makeTokens());
          // Insecure config directory → shared validation failure → global FAILED.
          await chmod(root, 0o755);

          await withClient(target, async (client) => {
            const resp = await client.sendRequest("tools/call", {
              name: "crunchyroll_logout",
              arguments: {},
            });
            const text = logoutPayloadText(resp.result as { content?: { type: string; text?: string }[] });
            const payload = JSON.parse(text);
            assert.equal(payload.success, false);
            assert.equal(payload.state, "FAILED");
            assert.equal(payload.tokens.reason, "INSECURE_DIR");
            assert.equal(payload.session.reason, "INSECURE_DIR");
            const dumped = JSON.stringify(payload);
            assert.ok(!dumped.includes("stack"));
            assert.ok(!dumped.includes("Error"));
            assert.ok(!dumped.includes("/.strider"));
          });

          await chmod(root, 0o700);
        });
      });

      // ---------------------------------------------------------------------------
      // B5-14 — non-throwing contract: a failing clear never crashes the MCP layer
      // ---------------------------------------------------------------------------
      test("B5-14: a failing clear never surfaces as an MCP-level error", async () => {
        // NOTE: the spawned server lives in a separate process, so in-process
        // failure injection (__setUnlinkHook) cannot reach it. Instead the
        // failure is driven through the shared filesystem validation path:
        // an insecure config directory makes clearAuthData resolve to a
        // global FAILED state — the handler must still return structured
        // JSON with success:false, never an MCP-level error object
        // (isError:true).
        await withFakeHome(async () => {
          const root = join(process.env.HOME!, ".strider", "crunchyroll");
          await ensureConfigDir();
          await saveTokens(makeTokens());
          // Insecure config directory → global FAILED (INSECURE_DIR), no
          // unlink attempted, handler resolves normally.
          await chmod(root, 0o750);

          await withClient(target, async (client) => {
            const resp = await client.sendRequest("tools/call", {
              name: "crunchyroll_logout",
              arguments: {},
            });
            assert.equal(
              (resp.result as { isError?: boolean })?.isError,
              undefined,
              "must not be an MCP-level error"
            );
            const text = logoutPayloadText(resp.result as { content?: { type: string; text?: string }[] });
            const payload = JSON.parse(text);
            assert.equal(payload.success, false);
            assert.equal(payload.state, "FAILED");
          });
        });
      });
    });
  }
});
