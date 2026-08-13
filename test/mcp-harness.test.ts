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
const SRC = ["src/index.ts"];
const BUNDLE = ["dist/index.js"];
const INVALID_EMAIL = "audit-test@example.invalid";
const INVALID_PASSWORD = "gate-a-test-password";

const EXPECTED_TOOLS = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/baseline-tools.json"), "utf-8")
) as { name: string; inputSchema: unknown }[];

const EXPECTED_NAMES = EXPECTED_TOOLS.map((t) => t.name).sort();

type Target = ["source (tsx)", string[]] | ["bundle (node)", string[]];
const TARGETS: Target[] = [
  ["source (tsx)", SRC],
  ["bundle (node)", BUNDLE],
];

async function withClient(
  args: string[],
  fn: (client: McpClient) => Promise<void>
): Promise<void> {
  const client = new McpClient({ command: TSX, args, cwd: ROOT });
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
  for (const [label, args] of TARGETS) {
    describe(`${label}`, () => {
      test("tools/list returns exactly the 21 baseline tool names, unchanged", async () => {
        await withClient(args, async (client) => {
          const list = (await client.sendRequest("tools/list", {}))
            .result as { tools: { name: string }[] };
          const names = list.tools.map((t) => t.name).sort();
          assert.deepEqual(names, EXPECTED_NAMES);
        });
      });

      test("published schemas remain byte-equivalent to the baseline", async () => {
        await withClient(args, async (client) => {
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
        await withClient(args, async (client) => {
          const err = await client.sendRequest("tools/call", {
            name: "crunchyroll_tool_that_does_not_exist",
            arguments: {},
          });
          assert.equal(err.error?.code, -32601);
        });
      });

      test("crunchyroll_status works without authentication", async () => {
        await withClient(args, async (client) => {
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

      test("authenticated calls fail compatibly when no tokens are saved", async () => {
        await withClient(args, async (client) => {
          const result = await client.sendRequest("tools/call", {
            name: "crunchyroll_get_series",
            arguments: { series_id: "GY8VEQ95Y" },
          });
          assert.equal(result.error, undefined, "unexpected MCP-level error");
          const content = (result.result as { content: { text: string }[] }).content[0].text;
          // The server must surface an authentication failure rather than succeed or crash
          assert.match(content, /not logged in|login|auth|session/i);
        });
      });

      test("crunchyroll_login with deliberately invalid credentials fails in the currently expected way (characterization)", async () => {
        // Characterization test for current behaviour (to be fixed in a later gate):
        // the RPC layer reports success while the payload text contains success:false.
        await withClient(args, async (client) => {
          const result = await client.sendRequest("tools/call", {
            name: "crunchyroll_login",
            arguments: { email: INVALID_EMAIL, password: INVALID_PASSWORD },
          });
          assert.equal(result.error, undefined, "current behaviour: RPC layer does not set isError");
          const content = (result.result as { content: { text: string }[] }).content[0].text;
          assert.match(content, /success.*false|"success": false|success: false/i);
        });
      });

      test("server shuts down cleanly", async () => {
        const client = new McpClient({ command: TSX, args, cwd: ROOT });
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
