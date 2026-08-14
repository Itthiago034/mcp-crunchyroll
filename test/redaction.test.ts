import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./_harness-client.js";

// B6-core evidence suite: operation-scoped secret redaction.
// Real credentials: NO — only synthetic sentinels (test-only strings).
//
// NOTE: test-only seam. The production code imports src/redact.ts internals
// (withRedactionScope, SecretScope, redactSecrets, sanitizeError,
// safeErrorWithCleanStack, REDACTED_MARKER) directly. This file imports the
// same module for assertion purposes; no new API surface is introduced for
// production callers, and the bundle's published top level exports nothing
// from it (verified separately in the MCP harness via tools/list = 21 and the
// clean-tree/build checks).

import {
  REDACTED_MARKER,
  withRedactionScope,
  redactSecrets,
  sanitizeError,
  safeErrorWithCleanStack,
  getActiveScope,
  SecretScope,
} from "../src/redact.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const TSX = join(ROOT, "node_modules/.bin/tsx");

// Synthetic sentinels only. No real tokens, passwords or accounts.
const SENTINEL_ACCESS = "B6_ACCESS_TOKEN_SENTINEL_7Q9X";
const SENTINEL_REFRESH = "B6_REFRESH_TOKEN_SENTINEL_8M2P";
const SENTINEL_PASSWORD = "B6_PASSWORD_SENTINEL_4K1R";
const SENTINEL_BEARER = "B6_BEARER_SENTINEL_6D3N";

// ── Core unit: static patterns + registered literals ──────────────────────────

describe("B6-core: redaction core (static + registered)", () => {
  test("Bearer header fragment is redacted by the static pattern", () => {
    const out = redactSecrets(`Authorization: Bearer ${SENTINEL_ACCESS}`);
    assert.equal(out.includes(SENTINEL_ACCESS), false);
    assert.ok(out.includes(REDACTED_MARKER));
  });

  test("Basic header fragment is redacted by the static pattern", () => {
    const out = redactSecrets(`Authorization: Basic ${SENTINEL_BEARER}`);
    assert.equal(out.includes(SENTINEL_BEARER), false);
    assert.ok(out.includes(REDACTED_MARKER));
  });

  test("key-value style bodies are redacted by the static patterns", () => {
    const cases = [
      `error: refresh_token=${SENTINEL_REFRESH}`,
      `"access_token":"${SENTINEL_ACCESS}"`,
      `password: ${SENTINEL_PASSWORD}`,
      `password="${SENTINEL_PASSWORD}"`,
    ];
    for (const c of cases) {
      const out = redactSecrets(c);
      assert.equal(out.includes(SENTINEL_ACCESS), false, c);
      assert.equal(out.includes(SENTINEL_REFRESH), false, c);
      assert.equal(out.includes(SENTINEL_PASSWORD), false, c);
    }
  });

  test("registered runtime literals are redacted only inside an active scope", () => {
    let outside = "";
    redactSecrets(`plain ${SENTINEL_ACCESS}`); // no-op without scope
    assert.equal(outside, "");
  });

  test("registered literals are redacted inside withRedactionScope", async () => {
    const out = await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      return redactSecrets(`user token: ${SENTINEL_ACCESS}, ok`);
    });
    assert.equal(out.includes(SENTINEL_ACCESS), false);
    assert.match(out, /user token: \*\*\*REDACTED\*\*\*, ok/);
  });

  test("multiple registered literals are all redacted", async () => {
    const out = await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS, SENTINEL_REFRESH, SENTINEL_PASSWORD);
      return redactSecrets(`${SENTINEL_ACCESS} / ${SENTINEL_REFRESH} / ${SENTINEL_PASSWORD}`);
    });
    assert.equal(out.includes(SENTINEL_ACCESS), false);
    assert.equal(out.includes(SENTINEL_REFRESH), false);
    assert.equal(out.includes(SENTINEL_PASSWORD), false);
    assert.equal(out.split(REDACTED_MARKER).length, 4, "exactly three replacements");
  });

  test("duplicate registration is idempotent (deterministic)", async () => {
    const out = await withRedactionScope(async (scope) => {
      for (let i = 0; i < 10; i++) scope.registerSecret(SENTINEL_ACCESS);
      return redactSecrets(`dup ${SENTINEL_ACCESS} ${SENTINEL_ACCESS}`);
    });
    assert.equal(out.split(REDACTED_MARKER).length, 3);
  });

  test("longest-first ordering prevents partial secret leakage on overlap", async () => {
    // A shorter registered literal is a prefix of the longer one.
    const out = await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS.slice(0, 12), SENTINEL_ACCESS);
      return redactSecrets(`head ${SENTINEL_ACCESS}`);
    });
    // The whole long literal must be replaced by a single marker; no residual
    // of either secret (and no double marker) remains.
    assert.equal(out.includes(SENTINEL_ACCESS), false);
    assert.equal(out.split(REDACTED_MARKER).length, 2);
  });

  test("empty and whitespace-only values are never registered", async () => {
    const out = await withRedactionScope(async (scope) => {
      scope.registerSecret("", "   ");
      // If an empty value were registered, EVERY string would be redacted.
      return redactSecrets("normal text stays intact");
    });
    assert.equal(out, "normal text stays intact");
  });

  test("regex-special characters in a registered literal do not break redaction", async () => {
    const secret = "secret with (parens) [brackets] and +*?^$.";
    const out = await withRedactionScope(async (scope) => {
      scope.registerSecret(secret);
      return redactSecrets(`leak: ${secret}, clean after`);
    });
    assert.equal(out.includes(secret), false);
    assert.match(out, /leak: \*\*\*REDACTED\*\*\*, clean after/);
  });

  test("normal text without secrets passes through unchanged", async () => {
    const out = await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      return redactSecrets("no secrets here at all");
    });
    assert.equal(out, "no secrets here at all");
  });

  test("empty string passes through unchanged", () => {
    assert.equal(redactSecrets(""), "");
  });

  test("static patterns fire even with no registered secrets", () => {
    const out = redactSecrets(`Authorization: Bearer ${SENTINEL_ACCESS}`);
    assert.equal(out.includes(SENTINEL_ACCESS), false);
  });
});

// ── Lifecycle: cleanup semantics ──────────────────────────────────────────────

describe("B6-core: lifecycle and finally cleanup", () => {
  test("cleanup runs after a successful operation", async () => {
    await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      assert.equal(getActiveScope()!.secrets.size, 1);
    });
    // After the finally cleanup the registry of the finished operation is
    // empty; a fresh read outside any scope sees no context at all.
    assert.equal(getActiveScope(), undefined);
  });

  test("cleanup runs after a thrown error", async () => {
    let caught: Error | undefined;
    try {
      await withRedactionScope(async (scope) => {
        scope.registerSecret(SENTINEL_ACCESS);
        throw new Error(`boom ${SENTINEL_ACCESS}`);
      });
    } catch (err) {
      caught = err as Error;
    }
    assert.equal(caught?.message, `boom ${SENTINEL_ACCESS}`); // original untouched in flight
    assert.equal(getActiveScope(), undefined);
  });

  test("cleanup runs after a rejected promise", async () => {
    try {
      await withRedactionScope(async (scope) => {
        scope.registerSecret(SENTINEL_ACCESS);
        await Promise.reject(new Error("rejected"));
      });
    } catch {
      // expected
    }
    assert.equal(getActiveScope(), undefined);
  });

  test("cleanup runs on early return", async () => {
    await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      return; // early return
    });
    assert.equal(getActiveScope(), undefined);
  });

  test("a finished operation does NOT leak secrets into the next operation", async () => {
    await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      return redactSecrets(SENTINEL_ACCESS); // redacted: secret registered
    });
    const leaked = await withRedactionScope(async (scope) => {
      void scope;
      return redactSecrets(SENTINEL_ACCESS); // NOT registered here
    });
    assert.equal(leaked, SENTINEL_ACCESS, "second operation has no memory of the first");
  });

  test("nested scopes isolate independently", async () => {
    const result = await withRedactionScope(async (outer) => {
      outer.registerSecret(SENTINEL_ACCESS);
      const inner = await withRedactionScope(async (innerScope) => {
        innerScope.registerSecret(SENTINEL_REFRESH);
        // Inside the inner scope BOTH the inner registration and the outer
        // chain's context... are separate: outer's secret is NOT visible.
        const innerText = redactSecrets(`${SENTINEL_ACCESS} ${SENTINEL_REFRESH}`);
        return innerText;
      });
      // Back in the outer scope, the outer secret is redacted; the inner
      // scope's cleanup must not have disturbed the outer registry.
      const outerText = redactSecrets(SENTINEL_ACCESS);
      return { inner, outerText };
    });
    assert.equal(result.outerText, REDACTED_MARKER);
    // Inner scope only redacts what it registered itself:
    assert.equal(result.inner.includes(SENTINEL_REFRESH), false);
  });

  test("SecretScope.clear() is idempotent and does not throw after cleanup", async () => {
    await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      scope.clear();
      scope.clear(); // idempotent
    });
    assert.equal(getActiveScope(), undefined);
  });
});

// ── Concurrency: overlapping operations never cross-contaminate ───────────────

describe("B6-core: concurrency isolation", () => {
  async function concurrentPair(): Promise<{ opA: string; opB: string }> {
    const opA = withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      // Hold the scope alive while the other operation runs concurrently.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return redactSecrets(`${SENTINEL_ACCESS} ${SENTINEL_REFRESH}`);
    });
    const opB = withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_REFRESH);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return redactSecrets(`${SENTINEL_ACCESS} ${SENTINEL_REFRESH}`);
    });
    return { opA: await opA, opB: await opB };
  }

  test("two concurrent operations redact only their own registered secrets", async () => {
    const { opA, opB } = await concurrentPair();
    // opA registered only ACCESS → ACCESS redacted, REFRESH raw
    assert.equal(opA.includes(SENTINEL_ACCESS), false);
    assert.equal(opA.includes(SENTINEL_REFRESH), true);
    // opB registered only REFRESH → REFRESH redacted, ACCESS raw
    assert.equal(opB.includes(SENTINEL_ACCESS), true);
    assert.equal(opB.includes(SENTINEL_REFRESH), false);
  });

  test("completion of one concurrent operation does not clear the other's registry", async () => {
    // Variant: opA finishes first while opB still holds its registration.
    const opA = withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      await new Promise((r) => setImmediate(r));
      return redactSecrets(SENTINEL_ACCESS);
    });
    const opB = withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_REFRESH);
      await new Promise((r) => setTimeout(r, 30));
      return redactSecrets(SENTINEL_REFRESH);
    });
    const [a, b] = await Promise.all([opA, opB]);
    assert.equal(a, REDACTED_MARKER);
    assert.equal(b, REDACTED_MARKER);
  });

  test("registering after a scope has finished is ignored", async () => {
    let orphan: SecretScope | undefined;
    await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      orphan = scope;
    });
    // Try to pollute after cleanup (must be silently ignored).
    orphan!.registerSecret(SENTINEL_REFRESH);
    const later = await withRedactionScope(async (scope) => {
      void scope;
      return redactSecrets(SENTINEL_REFRESH);
    });
    assert.equal(later, SENTINEL_REFRESH);
  });
});

// ── Error sanitization ────────────────────────────────────────────────────────

describe("B6-core: error sanitization", () => {
  test("Error instances: new Error with redacted message, original untouched", async () => {
    const original = new Error(`failed: ${SENTINEL_ACCESS}`);
    const safe = await withRedactionScope(async (scope) => {
      // In production sanitizeError is always called inside an operation
      // scope that registered the credentials it may contain.
      scope.registerSecret(SENTINEL_ACCESS);
      return sanitizeError(original);
    });
    assert.notEqual(safe, original, "never mutates the original");
    assert.equal(safe.message.includes(SENTINEL_ACCESS), false);
    assert.equal(safe.name, "Error");
    assert.ok(safe.message.includes(REDACTED_MARKER));
    assert.equal(original.message, `failed: ${SENTINEL_ACCESS}`);
  });

  test("thrown strings are wrapped in a safe Error with redacted message", async () => {
    const safe = await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_PASSWORD);
      return sanitizeError(`crashed ${SENTINEL_PASSWORD}`);
    });
    assert.ok(safe instanceof Error);
    assert.equal(safe.message.includes(SENTINEL_PASSWORD), false);
  });

  test("unknown objects: guarded String() — no deep dumps, never echoes values", () => {
    const obj = { secret: SENTINEL_ACCESS, nested: { a: 1 } };
    const safe = sanitizeError(obj);
    assert.ok(safe instanceof Error);
    // String(obj) is "[object Object]" for plain objects by JS design; the
    // guarded path deliberately does NOT serialize the object tree (a deep
    // dump would create a new leak surface), so the sentinel never appears.
    assert.equal(safe.message.includes(SENTINEL_ACCESS), false);
    assert.equal(safe.message.includes("secret"), false);
    assert.equal(safe.message.includes("nested"), false);
  });

  test("safeErrorWithCleanStack redacts the message quoted in the stack", async () => {
    const safe = await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS);
      return safeErrorWithCleanStack(new Error(`leak ${SENTINEL_ACCESS}`));
    });
    assert.equal(safe.message.includes(SENTINEL_ACCESS), false);
    // V8 stacks quote the original message on the first frame; sanitize it.
    assert.equal(safe.stack!.includes(SENTINEL_ACCESS), false);
  });

  test("sanitizeError outside any scope still redacts static patterns", () => {
    const safe = sanitizeError(new Error(`Authorization: Bearer ${SENTINEL_BEARER}`));
    assert.equal(safe.message.includes(SENTINEL_BEARER), false);
    assert.ok(safe.message.includes(REDACTED_MARKER));
  });
});

// ── MCP boundary: real server process (source + compiled bundle) ──────────────

type Target = [string, { command: string; args: string[] }];
const TARGETS: Target[] = [
  ["source (tsx)", { command: TSX, args: ["src/index.ts"] }],
  ["bundle (node)", { command: process.execPath, args: ["dist/index.js"] }],
];

describe("B6-core: MCP boundary (no real credentials, synthetic only)", () => {
  for (const [label, target] of TARGETS) {
    describe(`${label}`, () => {
      test("crunchyroll_login never echoes the password in the failure payload", async () => {
        // Synthetic password (not any real account). The login path registers
        // the credential; the current characterized failure payload must not
        // contain the raw password.
        const client = new McpClient({ command: target.command, args: target.args, cwd: ROOT });
        try {
          const init = await client.initialize();
          assert.equal(init.result?.protocolVersion, "2025-03-26");
          const result = await client.sendRequest("tools/call", {
            name: "crunchyroll_login",
            arguments: {
              email: "b6-audit-test@example.invalid",
              password: SENTINEL_PASSWORD,
            },
          });
          const text = (result.result as { content: { text: string }[] })?.content?.[0]?.text ??
            JSON.stringify(result.error ?? result);
          assert.equal(text.includes(SENTINEL_PASSWORD), false, "password echoed over the MCP boundary");
        } finally {
          client.kill();
        }
      });

      test("registered secrets do not leak through the MethodNotFound error path", async () => {
        // Contract boundary: the handler boundary re-derives McpError messages
        // through redactSecrets, and the error payload must never contain a
        // registered credential (here the synthetic password).
        const client = new McpClient({ command: target.command, args: target.args, cwd: ROOT });
        try {
          await client.initialize();
          const err = await client.sendRequest("tools/call", {
            name: "crunchyroll_tool_that_does_not_exist",
            arguments: { password: SENTINEL_PASSWORD },
          });
          assert.equal(err.error?.code, -32601);
          // The MCP error payload (data/JSON) must not echo the registered secret.
          const msg = JSON.stringify(err);
          assert.equal(msg.includes(SENTINEL_PASSWORD), false, "registered secret echoed in MCP error payload");
        } finally {
          client.kill();
        }
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// B6-FIX-1 — deterministic evidence (blockers B6-C1 / B6-C2 / B6-E1)
// Sentinels only; never real credentials.
// ═══════════════════════════════════════════════════════════════════════════════

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  sanitizeToolResult,
  registerSensitiveValue,
} from "../src/redact.js";

const SENTINEL_SUCCESS = "B6_SUCCESS_SENTINEL_5W7K";
const SENTINEL_BOUNDARY = "B6_BOUNDARY_SENTINEL_2R4V";
const SENTINEL_TOKEN_RESPONSE = "B6_TOKEN_RESPONSE_SENTINEL_9P3M";

// ── B6-FIX-1 unit: sanitizeToolResult (blocker B6-C1) ────────────────────────

describe("B6-FIX-1: sanitizeToolResult central boundary", () => {
  test("registered literal is removed from success content", async () => {
    const out = await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_SUCCESS);
      return sanitizeToolResult({
        content: [{ type: "text", text: `result contains ${SENTINEL_SUCCESS}` }],
      });
    });
    const raw = JSON.stringify(out);
    assert.equal(raw.includes(SENTINEL_SUCCESS), false, "sentinel must not reach the outward payload");
    assert.equal(raw.includes(REDACTED_MARKER), true, "marker must replace the sentinel");
    assert.ok(raw.includes("result contains"), "unrelated text preserved");
    assert.equal(out.isError, undefined, "isError untouched");
  });

  test("multiple text items sanitized; non-text content and isError preserved", async () => {
    const out = await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_SUCCESS);
      return sanitizeToolResult({
        content: [
          { type: "text", text: `first ${SENTINEL_SUCCESS}` },
          { type: "image", data: "base64-payload" },
          { type: "text", text: `second ${SENTINEL_SUCCESS}` },
        ],
        isError: true,
      });
    });
    const texts = (out.content as { type: string; text?: string }[]).map((c) => c.text ?? "");
    assert.equal(texts[0].includes(SENTINEL_SUCCESS), false);
    assert.equal(texts[0].includes(REDACTED_MARKER), true);
    assert.equal(texts[2].includes(SENTINEL_SUCCESS), false);
    assert.equal(texts[2].includes(REDACTED_MARKER), true);
    const img = (out.content as { type: string; data?: string }[]).find((c) => c.type === "image")!;
    assert.equal(img.data, "base64-payload", "non-text entry preserved verbatim");
    assert.equal(out.isError, true, "isError preserved");
  });

  test("result without content passes through untouched", async () => {
    const result = { isError: true };
    const out = sanitizeToolResult(result);
    assert.deepStrictEqual(out, { isError: true });
  });

  test("text without a secret is unchanged", async () => {
    const out = await withRedactionScope(async () =>
      sanitizeToolResult({ content: [{ type: "text", text: "nothing sensitive here" }] })
    );
    assert.equal((out.content as { type: string; text: string }[])[0].text, "nothing sensitive here");
  });

  test("static Authorization/Bearer pattern inside success text is redacted", async () => {
    const out = await withRedactionScope(async () =>
      sanitizeToolResult({ content: [{ type: "text", text: `auth: Authorization: Bearer ${SENTINEL_ACCESS}` }] })
    );
    const text = (out.content as { type: string; text: string }[])[0].text;
    assert.equal(text.includes(SENTINEL_ACCESS), false);
    assert.ok(text.includes(REDACTED_MARKER));
    assert.equal(text.startsWith("auth:"), true);
  });

  test("boundary runs while the scope is still active (registry not yet cleared)", async () => {
    // Timing proof: sanitizeToolResult MUST be applied before the finally
    // cleanup; this test captures the outward payload inside the scope.
    let captured: string | undefined;
    await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_SUCCESS);
      const handled = sanitizeToolResult({ content: [{ type: "text", text: SENTINEL_SUCCESS }] });
      captured = (handled.content as { text: string }[])[0].text;
    });
    assert.equal(captured?.includes(SENTINEL_SUCCESS), false);
    assert.equal(captured?.includes(REDACTED_MARKER), true);
  });
});

// ── B6-FIX-1 unit: registerSensitiveValue semantics (blocker B6-C2) ──────────

describe("B6-FIX-1: registerSensitiveValue semantics", () => {
  test("no active scope => no-op, nothing retained anywhere", async () => {
    registerSensitiveValue(SENTINEL_SUCCESS);
    // With no scope, redactSecrets applies only static patterns — the bare
    // literal passes through untouched, proving nothing was retained.
    const out = redactSecrets(`plain ${SENTINEL_SUCCESS}`);
    assert.equal(out.includes(SENTINEL_SUCCESS), true);
    assert.equal(out.includes(REDACTED_MARKER), false);
  });

  test("active scope => value registered and redacted in the same operation", async () => {
    const out = await withRedactionScope(async () => {
      registerSensitiveValue(SENTINEL_SUCCESS);
      return redactSecrets(`diag ${SENTINEL_SUCCESS}`);
    });
    assert.equal(out.includes(SENTINEL_SUCCESS), false);
    assert.ok(out.includes(REDACTED_MARKER));
  });

  test("closed scope => registration ignored", async () => {
    await withRedactionScope(async (scope) => {
      scope.clear(); // closes the scope early; finally will still run
      registerSensitiveValue(SENTINEL_SUCCESS);
      const out = redactSecrets(SENTINEL_SUCCESS);
      assert.equal(out, SENTINEL_SUCCESS, "closed scope must not register");
    });
  });

  test("empty / whitespace values never registered", async () => {
    await withRedactionScope(async () => {
      registerSensitiveValue("", "   ");
      const out = redactSecrets(`plain ${SENTINEL_SUCCESS}`);
      assert.equal(out.includes(SENTINEL_SUCCESS), true, "empty registration must not redact everything");
    });
  });

  test("registration never alters the value — persistence semantics untouched", async () => {
    await withRedactionScope(async (scope) => {
      scope.registerSecret(SENTINEL_ACCESS, SENTINEL_REFRESH);
      const out = redactSecrets(`tokens: ${SENTINEL_ACCESS} / ${SENTINEL_REFRESH}`);
      assert.equal(out.includes(SENTINEL_ACCESS), false);
      assert.equal(out.includes(SENTINEL_REFRESH), false);
      assert.equal(out.split(REDACTED_MARKER).length, 3);
    });
  });
});

// ── B6-FIX-1: deterministic MCP boundary (blocker B6-E1) ─────────────────────
// Fully deterministic: no network (unknown tool → MethodNotFound), the same
// sentinel appears in BOTH the tool name and the password argument. The raw
// serialized MCP response (stdout) must contain the marker and never the
// sentinel — proving the central boundary, not static regexes alone.

interface MiniMessage {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function deterministicCall(
  target: { command: string; args: string[] },
  method: string,
  params: unknown
): Promise<{ stdoutRaw: string; error?: { code: number; message: string } }> {
  const proc = spawn(target.command, target.args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  proc.stdout.on("data", (d) => (stdout += String(d)));
  const pending = new Map<number, (v: MiniMessage) => void>();
  const rl = readline.createInterface({ input: proc.stdout as NodeJS.ReadableStream });
  rl.on("line", (raw) => {
    let msg: MiniMessage;
    try {
      msg = JSON.parse(raw) as MiniMessage;
    } catch {
      return; // non-JSON lines ignored
    }
    if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
  });
  const send = (msg: Record<string, unknown>) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  };
  const resp = new Promise<MiniMessage>((resolve) => {
    const id = 1;
    pending.set(id, resolve);
    send({ id, method, params });
  });
  send({
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "b6-fix1-test", version: "0.0.1" },
    },
  });
  const res = await resp;
  rl.close();
  proc.kill();
  return { stdoutRaw: stdout, error: (res as MiniMessage).error };
}

describe("B6-FIX-1: deterministic MCP boundary", () => {
  const FIX1_TARGETS: Target[] = [
    ["source (tsx)", { command: TSX, args: ["src/index.ts"] }],
    ...(existsSync(join(ROOT, "dist/index.js"))
      ? [["bundle (node)", { command: process.execPath, args: ["dist/index.js"] }]]
      : []),
  ];
  for (const [label, target] of FIX1_TARGETS) {
    describe(`${label}`, () => {
      test("password-arg sentinel + unknown tool: raw MCP response never contains the literal", async () => {
        // Causal chain (deterministic, zero network):
        // 1) arguments.password contains the sentinel → registered at handler
        //    entry by the closed sensitive-args list, regardless of tool name.
        // 2) the tool name itself embeds the same sentinel → the
        //    MethodNotFound message embeds the raw literal.
        // 3) the McpError re-derivation + the central sanitizeToolResult
        //    boundary strip it before any serialization.
        const { stdoutRaw, error } = await deterministicCall(target, "tools/call", {
          name: `crunchyroll_missing_${SENTINEL_BOUNDARY}`,
          arguments: { password: SENTINEL_BOUNDARY },
        });
        assert.equal(error?.code, -32601, "unknown tool → MethodNotFound");
        assert.equal(
          stdoutRaw.includes(SENTINEL_BOUNDARY),
          false,
          "raw serialized MCP response must NOT contain the sentinel"
        );
        assert.equal(
          stdoutRaw.includes(REDACTED_MARKER),
          true,
          "raw serialized MCP response must contain the marker"
        );
      });
    });
  }
});
