// BT7 — F-1 and F-2, the live findings and their ruling.
//
// F-1: `continue_watching` was proved live to be unrouted (404 with the site's
// HTML shell, identical with a full query, a partial query and no query). The
// ruling defers it: no descriptor, no path, no legacy fallback.
//
// F-2: the live provider names `content_ids` as the required parameter and
// rejects the legacy `content_ids[]` wire outright. Comma-joined is the only
// encoding that resolved more than one id. The ruling corrects the contract.
//
// Deterministic and offline. Every identity value here is synthetic.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCTION_OPERATIONS,
  createOperationRegistry,
  resolveCall,
} from "../src/transport/operation-registry.js";
import { createTransportDispatcher } from "../src/transport/dispatcher.js";
import { createContentGateway } from "../src/transport/content-gateway.js";
import { buildRequestUrl } from "../src/transport/browser-api-backend.js";
import { TransportError } from "../src/transport/transport-error.js";
import { FakeTransportBackend } from "./_fake-backend.js";
import type { OperationDescriptor, TransportResult } from "../src/transport/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(REPO_ROOT, "src");
const ORIGIN = "https://www.crunchyroll.com";
const ACCOUNT = "SYNTHETIC-ACCOUNT-ID-F1F2";

function harness(json: unknown = { data: [] }) {
  const backend = new FakeTransportBackend({
    result: { status: 200, contentType: "application/json", json } as TransportResult,
  });
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const gateway = createContentGateway(createTransportDispatcher(registry, backend), registry);
  return { backend, gateway, registry };
}

function sources(): Array<{ path: string; code: string }> {
  const files: Array<{ path: string; code: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push({ path: full, code: readFileSync(full, "utf-8") });
    }
  };
  walk(SRC);
  return files;
}

/** A synthetic descriptor, so the generic capabilities are provable on their own. */
function probeDescriptor(overrides: Partial<OperationDescriptor>): OperationDescriptor {
  return Object.freeze({
    id: "PROBE" as never,
    method: "GET" as const,
    pathTemplate: "/content/v2/{accountId}/probe",
    callerParams: Object.freeze({}),
    authDerivedParams: Object.freeze({ accountId: { source: "accountId" as const } }),
    fixedQuery: Object.freeze({}),
    queryParams: Object.freeze({}),
    repeatedQueryParams: Object.freeze({}),
    joinedQueryParams: Object.freeze({}),
    scope: "ACCOUNT" as const,
    auth: "BEARER" as const,
    mutation: false as const,
    ...overrides,
  }) as OperationDescriptor;
}

const render = (operation: string, params: Record<string, unknown>): string =>
  buildRequestUrl(resolveCall(createOperationRegistry(PRODUCTION_OPERATIONS), operation, params), {
    accountId: ACCOUNT,
  });

// ── F-1 ─────────────────────────────────────────────────────────────────────

describe("F-1 — GET_CONTINUE_WATCHING is deferred, not migrated", () => {
  test("the production table holds fifteen operations and not this one", () => {
    const ids = PRODUCTION_OPERATIONS.map((d) => d.id as unknown as string).sort();
    assert.equal(ids.length, 15, "PRODUCTION_OPERATIONS must be exactly 15");
    assert.equal(ids.includes("GET_CONTINUE_WATCHING"), false);
    assert.deepEqual(ids, [
      "ADD_TO_WATCHLIST",
      "BROWSE",
      "GET_CATEGORIES",
      "GET_EPISODE",
      "GET_EPISODES",
      "GET_HISTORY",
      "GET_PLAYHEADS",
      "GET_RECOMMENDATIONS",
      "GET_SEASONS",
      "GET_SERIES",
      "GET_SIMILAR",
      "GET_SIMULCAST_SEASONS",
      "GET_WATCHLIST",
      "REMOVE_FROM_WATCHLIST",
      "SEARCH",
    ]);
  });

  test("the registry has no descriptor for it", () => {
    const { registry } = harness();
    assert.equal(registry.has("GET_CONTINUE_WATCHING" as never), false);
    assert.equal(registry.get("GET_CONTINUE_WATCHING" as never), undefined);
  });

  test("resolveCall refuses it, exactly as it refuses the other deferred one", () => {
    const { registry } = harness();
    // Two layers, two vocabularies, both closed: the registry knows only that
    // no such operation exists; the gateway, which knows the tool is real,
    // is where OPERATION_NOT_MIGRATED is spoken. GET_SUBSCRIPTION has answered
    // this way since D-1c, and F-1 joins it rather than inventing a third shape.
    for (const deferred of ["GET_CONTINUE_WATCHING", "GET_SUBSCRIPTION"]) {
      assert.throws(
        () => resolveCall(registry, deferred, { n: 10 }),
        (e: unknown) => e instanceof TransportError && e.kind === "UNKNOWN_OPERATION",
        deferred
      );
    }
  });

  test("the tool answers OPERATION_NOT_MIGRATED with zero transport attempts", async () => {
    const { gateway, backend } = harness();
    await assert.rejects(
      gateway.callTool("crunchyroll_continue_watching", { n: 10 }),
      (e: unknown) => e instanceof TransportError && e.kind === "OPERATION_NOT_MIGRATED"
    );
    assert.equal(backend.calls.length, 0, "refusal happens before any transport");
  });

  test("the boundary still KNOWS the tool — deferred is not forgotten", async () => {
    const { gateway } = harness();
    assert.equal(gateway.isContentTool("crunchyroll_continue_watching"), true);
  });

  test("no continue_watching URL path survives anywhere in src", () => {
    for (const { path, code } of sources()) {
      assert.equal(
        /\/continue_watching/.test(code),
        false,
        `${path} still carries a continue_watching path — no legacy fallback was authorised`
      );
    }
  });

  test("it is deferred exactly as GET_SUBSCRIPTION is", async () => {
    const { gateway, backend } = harness();
    for (const tool of ["crunchyroll_continue_watching", "crunchyroll_get_subscription"]) {
      await assert.rejects(
        gateway.callTool(tool, {}),
        (e: unknown) => e instanceof TransportError && e.kind === "OPERATION_NOT_MIGRATED"
      );
    }
    assert.equal(backend.calls.length, 0);
  });
});

// ── F-2 ─────────────────────────────────────────────────────────────────────

describe("F-2 — GET_PLAYHEADS sends the wire the provider actually accepts", () => {
  test("three ids render as one comma-joined content_ids, in caller order", () => {
    const url = render("GET_PLAYHEADS", { content_ids: ["AAA", "BBB", "CCC"] });
    const params = new URL(url).searchParams;
    assert.deepEqual(params.getAll("content_ids"), ["AAA,BBB,CCC"], "exactly one value");
    assert.equal(params.get("content_ids"), "AAA,BBB,CCC", "order preserved");
  });

  test("the rendered URL is exact", () => {
    assert.equal(
      render("GET_PLAYHEADS", { content_ids: ["AAA", "BBB"] }),
      `${ORIGIN}/content/v2/${ACCOUNT}/playheads?content_ids=AAA%2CBBB`
    );
    assert.equal(
      render("GET_PLAYHEADS", { content_ids: ["AAA"] }),
      `${ORIGIN}/content/v2/${ACCOUNT}/playheads?content_ids=AAA`
    );
  });

  test("the retired bracket wire appears in no rendering and in no source", () => {
    const url = render("GET_PLAYHEADS", { content_ids: ["AAA", "BBB"] });
    assert.equal(url.includes("content_ids[]"), false);
    assert.equal(url.includes("content_ids%5B%5D"), false);
    // A comment may still NAME the retired wire — the reason F-2 exists is worth
    // keeping next to the code. What must not survive is a line that DECLARES
    // it, so comment lines are excluded rather than the whole file.
    for (const { path, code } of sources()) {
      const declaring = code
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .filter((line) => line.includes("content_ids[]"));
      assert.deepEqual(declaring, [], `${path} still declares the rejected content_ids[] wire`);
    }
  });

  test("the key is never repeated", () => {
    const url = render("GET_PLAYHEADS", { content_ids: ["AAA", "BBB", "CCC"] });
    const keys = [...new URL(url).searchParams.keys()];
    assert.deepEqual(keys, ["content_ids"], "one key, once");
  });

  test("no locale is added — the legacy call sent none and the live one accepts none", () => {
    const url = render("GET_PLAYHEADS", { content_ids: ["AAA"] });
    assert.equal(url.includes("locale"), false);
  });

  test("malformed, empty and oversized lists are refused before any URL exists", () => {
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const rejected: unknown[] = [
      [],
      "AAA",
      ["AAA", ""],
      ["AAA", null],
      ["AAA", 7],
      ["AAA", { id: "BBB" }],
      ["with space"],
      ["comma,inside"],
      Array.from({ length: 101 }, (_, i) => `ID${i}`),
    ];
    for (const bad of rejected) {
      assert.throws(
        () => resolveCall(registry, "GET_PLAYHEADS", { content_ids: bad as never }),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `must be refused: ${JSON.stringify(bad)?.slice(0, 48)}`
      );
    }
    // The bound is inclusive at 100 and 1.
    assert.doesNotThrow(() =>
      resolveCall(registry, "GET_PLAYHEADS", {
        content_ids: Array.from({ length: 100 }, (_, i) => `ID${i}`),
      })
    );
    assert.doesNotThrow(() => resolveCall(registry, "GET_PLAYHEADS", { content_ids: ["AAA"] }));
  });

  test("a caller can choose neither the wire key nor the separator", () => {
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    for (const injected of [
      { separator: ";" },
      { content_ids_separator: ";" },
      { joinedQueryParams: { content_ids: { separator: ";" } } },
      { "content_ids[]": ["AAA"] },
      { content_ids_key: "ids" },
    ]) {
      assert.throws(
        () => resolveCall(registry, "GET_PLAYHEADS", { content_ids: ["AAA"], ...injected }),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `undeclared parameter must be refused: ${Object.keys(injected)[0]}`
      );
    }
  });

  test("the descriptor owns the separator, frozen", () => {
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const descriptor = registry.get("GET_PLAYHEADS" as never);
    assert.ok(descriptor);
    const joined = (descriptor as OperationDescriptor).joinedQueryParams;
    assert.deepEqual(Object.keys(joined), ["content_ids"]);
    assert.equal(joined.content_ids.callerParam, "content_ids");
    assert.equal(joined.content_ids.separator, ",");
    assert.ok(Object.isFrozen(joined), "the map is frozen");
    assert.ok(Object.isFrozen(joined.content_ids), "each entry is frozen");
    assert.deepEqual((descriptor as OperationDescriptor).repeatedQueryParams, {},
      "GET_PLAYHEADS must no longer consume G-2");
  });
});

// ── The joined mechanism itself ─────────────────────────────────────────────

describe("F-2 — joined query rendering is a closed, general mechanism", () => {
  test("no operation is special-cased by id inside the URL builder", () => {
    const builder = readFileSync(join(SRC, "transport", "browser-api-backend.ts"), "utf-8");
    for (const forbidden of ["GET_PLAYHEADS", "content_ids"]) {
      assert.equal(
        builder.includes(forbidden),
        false,
        `the URL builder must not know ${forbidden} by name`
      );
    }
  });

  test("it renders any declared list, with the descriptor's own separator", () => {
    const descriptor = probeDescriptor({
      callerParams: Object.freeze({ ids: { required: true, validate: () => true } }),
      joinedQueryParams: Object.freeze({
        wire_ids: Object.freeze({ callerParam: "ids", separator: "|" }),
      }),
    });
    const url = buildRequestUrl(
      { descriptor, callerParams: Object.freeze({ ids: ["A", "B"] }) },
      { accountId: ACCOUNT }
    );
    assert.equal(new URL(url).searchParams.get("wire_ids"), "A|B");
  });

  test("an absent optional list emits no key at all", () => {
    const descriptor = probeDescriptor({
      callerParams: Object.freeze({ ids: { required: false, validate: () => true } }),
      joinedQueryParams: Object.freeze({
        wire_ids: Object.freeze({ callerParam: "ids", separator: "," }),
      }),
    });
    const url = buildRequestUrl({ descriptor, callerParams: Object.freeze({}) }, { accountId: ACCOUNT });
    assert.equal(url.includes("wire_ids"), false);
  });

  test("a non-array value for a joined param is refused at build time", () => {
    const descriptor = probeDescriptor({
      callerParams: Object.freeze({ ids: { required: true, validate: () => true } }),
      joinedQueryParams: Object.freeze({
        wire_ids: Object.freeze({ callerParam: "ids", separator: "," }),
      }),
    });
    assert.throws(
      () =>
        buildRequestUrl(
          { descriptor, callerParams: Object.freeze({ ids: "A,B" }) },
          { accountId: ACCOUNT }
        ),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
  });

  test("the registry refuses an incoherent joined declaration", () => {
    const cases: Array<[string, Partial<OperationDescriptor>]> = [
      [
        "undeclared caller param",
        {
          callerParams: Object.freeze({}),
          joinedQueryParams: Object.freeze({ k: Object.freeze({ callerParam: "ids", separator: "," }) }),
        },
      ],
      [
        "key also scalar",
        {
          callerParams: Object.freeze({ ids: { required: true, validate: () => true } }),
          queryParams: Object.freeze({ k: "ids" }),
          joinedQueryParams: Object.freeze({ k: Object.freeze({ callerParam: "ids", separator: "," }) }),
        },
      ],
      [
        "key also fixed",
        {
          callerParams: Object.freeze({ ids: { required: true, validate: () => true } }),
          fixedQuery: Object.freeze({ k: "constant" }),
          joinedQueryParams: Object.freeze({ k: Object.freeze({ callerParam: "ids", separator: "," }) }),
        },
      ],
      [
        "key also repeated",
        {
          callerParams: Object.freeze({ ids: { required: true, validate: () => true } }),
          repeatedQueryParams: Object.freeze({ k: "ids" }),
          joinedQueryParams: Object.freeze({ k: Object.freeze({ callerParam: "ids", separator: "," }) }),
        },
      ],
      [
        "empty separator",
        {
          callerParams: Object.freeze({ ids: { required: true, validate: () => true } }),
          joinedQueryParams: Object.freeze({ k: Object.freeze({ callerParam: "ids", separator: "" }) }),
        },
      ],
    ];
    for (const [label, overrides] of cases) {
      assert.throws(
        () => createOperationRegistry([probeDescriptor(overrides)]),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `must be refused at construction: ${label}`
      );
    }
  });

  test("G-2 remains a working capability even though no production operation uses it", () => {
    // The ruling retired the PREMISE for GET_PLAYHEADS, not the mechanism.
    for (const descriptor of PRODUCTION_OPERATIONS) {
      assert.deepEqual(
        descriptor.repeatedQueryParams,
        {},
        `${String(descriptor.id)} must not consume repeated query params`
      );
    }
    const probe = probeDescriptor({
      callerParams: Object.freeze({ ids: { required: true, validate: () => true } }),
      repeatedQueryParams: Object.freeze({ "wire[]": "ids" }),
    });
    const url = buildRequestUrl(
      { descriptor: probe, callerParams: Object.freeze({ ids: ["A", "B"] }) },
      { accountId: ACCOUNT }
    );
    assert.deepEqual(new URL(url).searchParams.getAll("wire[]"), ["A", "B"]);
  });
});

// ── What the ruling must not disturb ────────────────────────────────────────

describe("F-1/F-2 — the rest of BT7 is untouched", () => {
  test("the five functional BT7 operations still render exactly as before", () => {
    assert.equal(
      render("GET_SIMILAR", { series_id: "GT00377907", n: 20 }),
      `${ORIGIN}/content/v2/discover/${ACCOUNT}/similar_to/GT00377907?n=20&locale=en-US`
    );
    assert.equal(
      render("GET_RECOMMENDATIONS", { n: 20 }),
      `${ORIGIN}/content/v2/discover/${ACCOUNT}/recommendations?n=20&locale=en-US`
    );
    assert.equal(
      render("GET_WATCHLIST", { n: 20, order: "desc" }),
      `${ORIGIN}/content/v2/${ACCOUNT}/watchlist?n=20&order=desc&locale=en-US`
    );
    assert.equal(
      render("GET_HISTORY", { n: 20 }),
      `${ORIGIN}/content/v2/${ACCOUNT}/watch-history?n=20&locale=en-US`
    );
  });

  test("the public surface is still twenty-one tools", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf-8");
    const names = [...index.matchAll(/name: "(crunchyroll_[a-z_]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(names).size, 21);
    assert.ok(names.includes("crunchyroll_continue_watching"), "the deferred tool stays published");
    assert.ok(names.includes("crunchyroll_get_playheads"));
  });

  test("the unadopted BT8 mutation remains refused with no transport", async () => {
    const { gateway, backend } = harness();
    for (const [tool, args] of [
      ["crunchyroll_update_playhead", { content_id: "A", playhead: 1 }],
    ] as Array<[string, Record<string, unknown>]>) {
      await assert.rejects(
        gateway.callTool(tool, args),
        (e: unknown) => e instanceof TransportError && e.kind === "OPERATION_NOT_MIGRATED"
      );
    }
    assert.equal(backend.calls.length, 0);
  });

  test("playheads still routes and parses through the gateway", async () => {
    const { gateway, backend } = harness({
      data: [{ content_id: "AAA", playhead: 12, fully_watched: false, last_modified: "x" }],
    });
    const result = await gateway.callTool("crunchyroll_get_playheads", { content_ids: ["AAA"] });
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(backend.calls.length, 1);
    assert.equal(String(backend.calls[0].descriptor.id), "GET_PLAYHEADS");
    assert.deepEqual(backend.calls[0].callerParams, { content_ids: ["AAA"] });
  });
});
