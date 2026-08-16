// BT5 — the fail-closed cutover.
//
// Deterministic and offline: fake CDP, fake browser, no network, no browser
// process. Proves the reachable graph, not merely the happy path.
//
// Frozen design: CRUNCHYROLL-BT5-CUTOVER-PLAN.md.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_OPERATIONS, createOperationRegistry } from "../src/transport/operation-registry.js";
import { createTransportDispatcher } from "../src/transport/dispatcher.js";
import {
  CONTENT_TOOL_OPERATIONS,
  createContentGateway,
  parseCategories,
} from "../src/transport/content-gateway.js";
import {
  installNodeCrunchyrollGuard,
  isGuardedCrunchyrollUrl,
} from "../src/transport/node-egress-guard.js";
import { TransportError } from "../src/transport/transport-error.js";
import { FakeTransportBackend } from "./_fake-backend.js";
import type { TransportResult } from "../src/transport/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(REPO_ROOT, "src");
const COMPOSITION_ROOT = join(SRC, "index.ts");

function sources(): Array<{ path: string; code: string }> {
  const files: Array<{ path: string; code: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: full,
          code: readFileSync(full, "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""),
        });
      }
    }
  };
  walk(SRC);
  return files;
}

/** The transitive import closure of a module, over relative imports only. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    let code: string;
    try {
      code = readFileSync(current, "utf-8");
    } catch {
      continue;
    }
    for (const match of code.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const resolved = join(current, "..", match[1].replace(/\.js$/, ".ts"));
      queue.push(resolved);
    }
  }
  return seen;
}

const CATEGORIES_BODY = {
  data: [
    { id: "action", localization: { title: "Action" } },
    { id: "comedy", localization: { title: "Comedy" } },
  ],
};

function gatewayHarness(result?: TransportResult) {
  const backend = new FakeTransportBackend({
    result: result ?? { status: 200, contentType: "application/json", json: CATEGORIES_BODY },
  });
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const gateway = createContentGateway(createTransportDispatcher(registry, backend), registry);
  return { backend, gateway, registry };
}

// ── The cutover table ───────────────────────────────────────────────────────

describe("BT5 cutover — exactly one migrated operation", () => {
  test("PRODUCTION_OPERATIONS contains exactly GET_CATEGORIES", () => {
    assert.equal(PRODUCTION_OPERATIONS.length, 1);
    assert.equal(Object.isFrozen(PRODUCTION_OPERATIONS), true);
    const [descriptor] = PRODUCTION_OPERATIONS;
    assert.equal(descriptor.id, "GET_CATEGORIES");
    assert.equal(descriptor.method, "GET");
    assert.equal(descriptor.pathTemplate, "/content/v2/discover/categories?locale=en-US");
    assert.deepEqual(Object.keys(descriptor.callerParams), []);
    assert.deepEqual(Object.keys(descriptor.authDerivedParams), []);
    // BT5-FIX1: the two dimensions are separate. The endpoint is not
    // account-scoped (no identity in its path), and it still requires a bearer.
    assert.equal(descriptor.scope, "PUBLIC");
    assert.equal(descriptor.auth, "BEARER");
    assert.deepEqual(Object.keys(descriptor.authDerivedParams), []);
    assert.equal(descriptor.mutation, false);
  });

  test("the descriptor is the only place the categories path literal lives", () => {
    const holders = sources()
      .filter((f) => f.code.includes("/content/v2/discover/categories"))
      .map((f) => f.path);
    assert.deepEqual(holders, [join(SRC, "transport", "operation-registry.ts")]);
  });
});

describe("BT5 cutover — migrated vs unmigrated, decided in one place", () => {
  test("GET_CATEGORIES routes to the browser transport", async () => {
    const h = gatewayHarness();
    const result = await h.gateway.callTool("crunchyroll_get_categories", {});

    assert.equal(h.backend.calls.length, 1, "exactly one transport call");
    assert.equal(h.backend.calls[0].descriptor.id, "GET_CATEGORIES");
    assert.deepEqual(result, {
      count: 2,
      categories: CATEGORIES_BODY.data,
    });
  });

  for (const tool of [
    "crunchyroll_search",
    "crunchyroll_get_series",
    "crunchyroll_get_watchlist",
    "crunchyroll_update_playhead",
    "crunchyroll_get_subscription",
    "crunchyroll_get_simulcast_seasons",
  ]) {
    test(`${tool} is refused with OPERATION_NOT_MIGRATED`, async () => {
      const h = gatewayHarness();
      await assert.rejects(
        h.gateway.callTool(tool, { query: "x", series_id: "y", content_id: "z", playhead: 1 }),
        (e: unknown) => e instanceof TransportError && e.kind === "OPERATION_NOT_MIGRATED"
      );
      assert.equal(h.backend.calls.length, 0, "no transport call for an unmigrated operation");
    });
  }

  test("every content tool is mapped: no tool can fall through undecided", () => {
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, "test/fixtures/baseline-tools.json"), "utf-8")
    ) as Array<{ name: string }>;
    const authTools = new Set([
      "crunchyroll_login",
      "crunchyroll_logout",
      "crunchyroll_status",
    ]);
    const contentTools = baseline.map((t) => t.name).filter((n) => !authTools.has(n));
    assert.equal(contentTools.length, 18);
    for (const tool of contentTools) {
      assert.equal(CONTENT_TOOL_OPERATIONS.has(tool), true, `${tool} is unmapped`);
    }
  });

  test("an unknown tool is not silently treated as content", () => {
    const h = gatewayHarness();
    assert.equal(h.gateway.isContentTool("crunchyroll_not_a_tool"), false);
    assert.equal(h.gateway.isContentTool("crunchyroll_login"), false);
    assert.equal(h.gateway.isContentTool("crunchyroll_get_categories"), true);
  });

  test("a transport failure is surfaced, never retried through another path", async () => {
    const backend = new FakeTransportBackend({
      failWith: new TransportError("BROWSER_UNAVAILABLE"),
    });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const gateway = createContentGateway(createTransportDispatcher(registry, backend), registry);

    await assert.rejects(
      gateway.callTool("crunchyroll_get_categories", {}),
      (e: unknown) => e instanceof TransportError && e.kind === "BROWSER_UNAVAILABLE"
    );
    assert.equal(backend.calls.length, 1, "exactly one attempt, no fallback attempt");
  });

  test("caller arguments to a migrated operation that declares none are refused", async () => {
    const h = gatewayHarness();
    await assert.rejects(
      h.gateway.callTool("crunchyroll_get_categories", { url: "https://evil.invalid" }),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
    assert.equal(h.backend.calls.length, 0);
  });

  test("the categories parser rejects a shape it does not recognise", () => {
    assert.deepEqual(parseCategories({ data: [] }), { count: 0, categories: [] });
    for (const bad of [null, undefined, 42, "x", { data: "no" }, { data: [1, 2] }]) {
      assert.throws(
        () => parseCategories(bad),
        (e: unknown) => e instanceof TransportError && e.kind === "SCHEMA_MISMATCH"
      );
    }
  });
});

// ── Reachability: Node Crunchyroll is out of the graph ──────────────────────

describe("BT5 cutover — the Node Crunchyroll path is unreachable", () => {
  test("the composition root no longer imports any content function from api.ts", () => {
    const code = readFileSync(COMPOSITION_ROOT, "utf-8");
    const apiImports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/api\.js"/g)]
      .flatMap((m) => m[1].split(","))
      .map((s) => s.replace(/\btype\b/, "").trim())
      .filter(Boolean);
    // Only the auth transition sink and the logout result TYPE may remain.
    // Only the auth transition sink remains as a value import; LogoutResult is
    // a type-only import and carries no runtime edge.
    assert.deepEqual(apiImports.sort(), ["setLegacyAuthTransitionSink"]);
    const typeImports = [...code.matchAll(/import type\s*\{([^}]*)\}\s*from\s*"\.\/api\.js"/g)]
      .flatMap((m) => m[1].split(","))
      .map((x) => x.trim());
    assert.deepEqual(typeImports, ["LogoutResult"]);
    for (const contentFn of [
      "searchAnime",
      "getSeriesDetails",
      "getSeasons",
      "getEpisodes",
      "getWatchlist",
      "getCategories",
      "browse",
      "getSubscription",
      "updatePlayhead",
    ]) {
      // Word-boundary, not substring: "browser" contains "browse".
      assert.equal(
        new RegExp(`\\b${contentFn}\\b`).test(code),
        false,
        `${contentFn} is still reachable`
      );
    }
  });

  test("no transport module imports a CONTENT function from the legacy api module", () => {
    // The producer's legacy AUTH ports (login/refresh/status) are BT4's
    // accepted design and stay. What must not exist is a content edge.
    for (const file of sources()) {
      if (!file.path.includes("/transport/")) continue;
      for (const contentFn of [
        "getCategories",
        "searchAnime",
        "getSeriesDetails",
        "getWatchlist",
        "updatePlayhead",
        "browse",
      ]) {
        assert.equal(
          new RegExp(`\\b${contentFn}\\b`).test(file.code),
          false,
          `${file.path} reaches ${contentFn}`
        );
      }
    }
  });

  test("the gateway's own closure never reaches the legacy api module", () => {
    // The gateway receives a transport rather than importing one, so its
    // closure is deliberately tiny — and api.ts is not in it.
    const reachable = importClosure(join(SRC, "transport", "content-gateway.ts"));
    assert.equal(reachable.has(join(SRC, "api.ts")), false, "the gateway must not reach api.ts");
    // The composition root is where the two halves meet.
    const rootClosure = importClosure(COMPOSITION_ROOT);
    assert.equal(rootClosure.has(join(SRC, "transport", "dispatcher.ts")), true);
    assert.equal(
      rootClosure.has(join(SRC, "transport", "browser-api-backend.ts")),
      true,
      "content must reach the browser transport"
    );
  });
});

// ── The Node egress guard ───────────────────────────────────────────────────

describe("BT5 guard — Node may not reach Crunchyroll", () => {
  function fakeGlobal() {
    const performed: string[] = [];
    const target = {
      fetch: (async (input: unknown) => {
        performed.push(String(input));
        return { status: 200 } as unknown as Response;
      }) as typeof fetch,
    };
    return { target, performed };
  }

  test("a Crunchyroll request from Node is refused before any socket", async () => {
    const g = fakeGlobal();
    const guard = installNodeCrunchyrollGuard(g.target as unknown as typeof globalThis);
    try {
      for (const url of [
        "https://www.crunchyroll.com/content/v2/discover/categories",
        "https://auth.crunchyroll.com/auth/v1/token",
        "https://sso.crunchyroll.com/login",
        "http://crunchyroll.com/",
      ]) {
        await assert.rejects(
          g.target.fetch(url),
          (e: unknown) =>
            e instanceof TransportError && e.kind === "NODE_CRUNCHYROLL_FORBIDDEN"
        );
      }
      assert.deepEqual(g.performed, [], "no request may be performed");
      assert.equal(guard.attempts(), 4, "every attempt is counted");
    } finally {
      guard.uninstall();
    }
  });

  test("it never blocks a legitimate local or unrelated destination", async () => {
    const g = fakeGlobal();
    const guard = installNodeCrunchyrollGuard(g.target as unknown as typeof globalThis);
    try {
      for (const url of [
        "http://127.0.0.1:8080/ok",
        "http://localhost:3000/fixture",
        "https://example.invalid/x",
        "https://notcrunchyroll.com/x",
        "https://crunchyroll.com.evil.invalid/x",
      ]) {
        await g.target.fetch(url);
      }
      assert.equal(g.performed.length, 5, "legitimate destinations pass through");
      assert.equal(guard.attempts(), 0);
    } finally {
      guard.uninstall();
    }
  });

  test("host matching is exact-suffix, not substring", () => {
    assert.equal(isGuardedCrunchyrollUrl("https://www.crunchyroll.com/x"), true);
    assert.equal(isGuardedCrunchyrollUrl("https://crunchyroll.com"), true);
    assert.equal(isGuardedCrunchyrollUrl("https://beta.crunchyroll.com/x"), true);
    assert.equal(isGuardedCrunchyrollUrl("https://crunchyroll.com.evil.invalid/x"), false);
    assert.equal(isGuardedCrunchyrollUrl("https://notcrunchyroll.com/x"), false);
    assert.equal(isGuardedCrunchyrollUrl("not a url"), false);
  });

  test("the refusal carries no url, header or body", async () => {
    const g = fakeGlobal();
    const guard = installNodeCrunchyrollGuard(g.target as unknown as typeof globalThis);
    try {
      await g.target
        .fetch("https://www.crunchyroll.com/x?bearer=SENTINEL-VALUE")
        .then(
          () => assert.fail("must reject"),
          (error: unknown) => {
            const rendered = `${(error as Error).message}|${JSON.stringify(error)}`;
            assert.equal(rendered.includes("SENTINEL-VALUE"), false);
            assert.equal(rendered.includes("crunchyroll.com/x"), false);
          }
        );
    } finally {
      guard.uninstall();
    }
  });

  test("uninstall restores the original implementation exactly", () => {
    const g = fakeGlobal();
    const original = g.target.fetch;
    const guard = installNodeCrunchyrollGuard(g.target as unknown as typeof globalThis);
    assert.notEqual(g.target.fetch, original);
    guard.uninstall();
    assert.equal(g.target.fetch, original);
  });

  test("the guard is installed by the composition root, not by a test", () => {
    const code = readFileSync(COMPOSITION_ROOT, "utf-8");
    assert.match(code, /installNodeCrunchyrollGuard\s*\(/);
    // It must not be conditional on an environment variable.
    const line = code.split("\n").find((l) => l.includes("installNodeCrunchyrollGuard("))!;
    assert.equal(/NODE_ENV|process\.env/.test(line), false, "the guard is unconditional");
  });
});

// ── Negative security surface ───────────────────────────────────────────────

describe("BT5 security — no arbitrary anything", () => {
  test("no production module exposes a generic CDP send or an arbitrary method string", () => {
    for (const file of sources()) {
      assert.equal(/\bsendCDP\b/.test(file.code), false, `${file.path}`);
      assert.equal(/Runtime\.evaluate/.test(file.code), false, `${file.path}`);
      assert.equal(/Network\.(enable|setExtraHTTPHeaders|setCookie)/.test(file.code), false);
    }
  });

  test("the tool boundary supplies no url, method, header or bearer", () => {
    const code = readFileSync(COMPOSITION_ROOT, "utf-8");
    const stripped = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const handler = stripped.slice(stripped.indexOf("setRequestHandler(CallToolRequestSchema"));
    for (const forbidden of ["Authorization", "Bearer", "headers", "openApiExecutionChannel", "callFunctionOn"]) {
      assert.equal(handler.includes(forbidden), false, `the boundary must not mention ${forbidden}`);
    }
  });

  test("no caller-reachable path can choose an origin", () => {
    const gateway = sources().find((f) => f.path.endsWith("content-gateway.ts"))!;
    assert.equal(/https?:\/\//.test(gateway.code), false, "the gateway holds no origin literal");
  });
});
