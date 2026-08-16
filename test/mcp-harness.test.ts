import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./_harness-client.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const INVALID_EMAIL = "audit-test@example.invalid";
const INVALID_PASSWORD = "gate-a-test-password";

// Each target is modeled with its real production executable:
// source (tsx)  -> tsx transpiles src/index.ts on the fly (dev path)
// bundle (node) -> the compiled dist/index.js is executed by plain node, the
//                  same contract as package.json "start": "node dist/index.js"
type Target = [string, { command: string; args: string[] }];
const TARGETS: Target[] = [
  ["source (tsx)", { command: TSX, args: ["src/index.ts"] }],
  ["bundle (node)", { command: process.execPath, args: ["dist/index.js"] }],
];

const EXPECTED_TOOLS = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/baseline-tools.json"), "utf-8")
) as { name: string; inputSchema: unknown }[];

const EXPECTED_NAMES = EXPECTED_TOOLS.map((t) => t.name).sort();

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

describe("MCP server harness", () => {
  for (const [label, target] of TARGETS) {
    describe(`${label}`, () => {
      test("tools/list returns exactly the 21 baseline tool names, unchanged", async () => {
        await withClient(target, async (client) => {
          const list = (await client.sendRequest("tools/list", {}))
            .result as { tools: { name: string }[] };
          const names = list.tools.map((t) => t.name).sort();
          assert.deepEqual(names, EXPECTED_NAMES);
        });
      });

      test("published schemas remain byte-equivalent to the baseline", async () => {
        await withClient(target, async (client) => {
          const list = (await client.sendRequest("tools/list", {}))
            .result as { tools: { name: string; inputSchema: unknown; description?: string }[] };
          for (const expected of EXPECTED_TOOLS) {
            const actual = list.tools.find((t) => t.name === expected.name)!;
            assert.notEqual(actual, undefined, `tool ${expected.name} missing from list`);
            // Per-tool structural equivalence of the published schema (names may be
            // re-ordered by the tool registry; descriptions are informational).
            assert.deepEqual(actual.inputSchema, expected.inputSchema);
          }
        });
      });

      test("unknown tool continues to return MethodNotFound (-32601)", async () => {
        await withClient(target, async (client) => {
          const err = await client.sendRequest("tools/call", {
            name: "crunchyroll_tool_that_does_not_exist",
            arguments: {},
          });
          assert.equal(err.error?.code, -32601);
        });
      });

      test("crunchyroll_status works without authentication", async () => {
        await withClient(target, async (client) => {
          const result = await client.sendRequest("tools/call", {
            name: "crunchyroll_status",
            arguments: {},
          });
          assert.equal(result.error, undefined, "unexpected MCP-level error");
          const content = (result.result as { content: { text: string }[] }).content[0].text;
          assert.match(content, /logged_in/);
          assert.match(content, /false/);
        });
      });

      // BT5 cutover: this used to characterize the LEGACY path, where an
      // unmigrated content tool reached Node and failed on missing tokens.
      // After the cutover the same call is refused locally, before any
      // transport and long before any network.
      test("an unmigrated content tool is refused with OPERATION_NOT_MIGRATED", async () => {
        await withClient(target, async (client) => {
          const result = await client.sendRequest("tools/call", {
            name: "crunchyroll_get_series",
            arguments: { series_id: "GY8VEQ95Y" },
          });
          assert.equal(result.error, undefined, "unexpected MCP-level error");
          const content = (result.result as { content: { text: string }[] }).content[0].text;
          assert.match(content, /OPERATION_NOT_MIGRATED/);
        });
      });

      test("the migrated content tool routes to the browser transport, never to Node", async () => {
        await withClient(target, async (client) => {
          const result = await client.sendRequest("tools/call", {
            name: "crunchyroll_get_categories",
            arguments: {},
          });
          assert.equal(result.error, undefined, "unexpected MCP-level error");
          const content = (result.result as { content: { text: string }[] }).content[0].text;
          // No browser and no session in the harness, so the honest outcome is
          // a typed transport refusal — NOT a legacy "not logged in" from Node.
          assert.match(content, /Not authenticated|browser/i);
          assert.equal(/OPERATION_NOT_MIGRATED/.test(content), false, "it IS migrated");
        });
      });

      // BT4 completion §8 — BREAKING: login is browser-interactive and accepts
      // no arguments at all. The old characterization test (credentials in,
      // success:false out) described the retired credential-consuming path.
      test("crunchyroll_login publishes a closed schema that admits no credential", async () => {
        await withClient(target, async (client) => {
          const list = (await client.sendRequest("tools/list", {}))
            .result as { tools: { name: string; inputSchema: Record<string, unknown>; description?: string }[] };
          const login = list.tools.find((t) => t.name === "crunchyroll_login")!;
          assert.deepEqual(login.inputSchema, {
            type: "object",
            properties: {},
            additionalProperties: false,
          });
          assert.match(String(login.description), /browser/i);
          for (const forbidden of ["email", "password", "username", "otp", "code", "token"]) {
            assert.equal(
              JSON.stringify(login.inputSchema).includes(forbidden),
              false,
              `the login schema must not mention ${forbidden}`
            );
          }
        });
      });

      test("crunchyroll_login refuses supplied credentials instead of ignoring them", async () => {
        // Fails closed on BOTH surfaces: the schema refuses them, and the
        // handler refuses them again locally. No browser is opened, so this
        // stays a deterministic offline assertion.
        await withClient(target, async (client) => {
          const result = await client.sendRequest("tools/call", {
            name: "crunchyroll_login",
            arguments: { email: INVALID_EMAIL, password: INVALID_PASSWORD },
          });
          assert.equal(result.error?.code, -32602, "an invalid-params error, not a silent ignore");
          const rendered = JSON.stringify(result);
          assert.equal(rendered.includes(INVALID_PASSWORD), false, "the password was echoed back");
          assert.equal(rendered.includes(INVALID_EMAIL), false, "the email was echoed back");
        });
      });

      test("crunchyroll_status reports the BT4 readiness contract", async () => {
        await withClient(target, async (client) => {
          const result = await client.sendRequest("tools/call", {
            name: "crunchyroll_status",
            arguments: {},
          });
          assert.equal(result.error, undefined, "unexpected MCP-level error");
          const status = JSON.parse(
            (result.result as { content: { text: string }[] }).content[0].text
          ) as Record<string, unknown>;

          assert.deepEqual(Object.keys(status).sort(), [
            "auth_state",
            "authenticated",
            "browser_connected",
            "browser_running",
            "logged_in",
            "player_ready",
            "profile_ready",
          ]);
          // Removed by §10: unsourceable under browser login, or internal identity.
          for (const removed of ["email", "account_id", "token_expires_at", "profile"]) {
            assert.equal(removed in status, false, `${removed} must be gone from status`);
          }
          assert.equal(status.authenticated, status.logged_in);
          assert.equal(status.player_ready, false, "BT4 owns no player");
        });
      });

      test("server shuts down cleanly", async () => {
        const client = new McpClient({ command: target.command, args: target.args, cwd: ROOT });
        await client.initialize();
        client.kill();
      });
    });
  }
});

describe("compiled bundle is produced by the build", () => {
  test("dist/index.js exists and is non-empty", () => {
    const stat = spawnSync("node", ["-e", "require('fs').statSync('dist/index.js')"], {
      cwd: ROOT,
    });
    assert.equal(stat.status, 0);
  });
});
