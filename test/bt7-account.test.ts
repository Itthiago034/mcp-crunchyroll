// BT7 — account read operations.
//
// Deterministic and offline: the REAL BT3 authority driven through its REAL
// reader, a fake execution channel, no browser, no network, no credentials.
// Every identity value here is synthetic.
//
// Frozen design: BT7-DESIGN.md over the closed BT5/BT6 contracts.

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
import {
  createBrowserApiBackend,
  buildRequestUrl,
} from "../src/transport/browser-api-backend.js";
import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import { TransportError } from "../src/transport/transport-error.js";
import { FakeTransportBackend } from "./_fake-backend.js";
import type { ApiExecutionChannel, ApiExecutionRequest } from "../src/transport/browser-lifecycle-types.js";
import type { OperationDescriptor, TransportResult } from "../src/transport/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(REPO_ROOT, "src");

const ACCOUNT_SENTINEL = "SYNTHETIC-ACCOUNT-ID-BT7";
const PROFILE_SENTINEL = "SYNTHETIC-PROFILE-ID-BT7";
const BEARER_SENTINEL = "SYNTHETIC-BEARER-BT7-MUST-NOT-LEAK";

/**
 * The operations BT7 migrates, and no others.
 *
 * NARROWED BY THE F-1 RULING: GET_CONTINUE_WATCHING left this list. It was
 * migrated in the first BT7 candidate and the live smoke proved the endpoint
 * unrouted, so it is deferred rather than kept as a promise the provider will
 * not honour. Everything in this file that asserted its migration is retired
 * in place, at the site, with the reason.
 */
const BT7_OPERATIONS = [
  "GET_HISTORY",
  "GET_PLAYHEADS",
  "GET_RECOMMENDATIONS",
  "GET_SIMILAR",
  "GET_WATCHLIST",
];

const BT5_BT6_OPERATIONS = [
  "BROWSE",
  "GET_CATEGORIES",
  "GET_EPISODE",
  "GET_EPISODES",
  "GET_SEASONS",
  "GET_SERIES",
  "GET_SIMULCAST_SEASONS",
  "SEARCH",
];

/** Minimum valid caller arguments per BT7 operation. */
const MINIMUM_ARGS: Record<string, Record<string, unknown>> = {
  GET_SIMILAR: { series_id: "GY8VEQ95Y", n: 20 },
  GET_RECOMMENDATIONS: { n: 20 },
  GET_WATCHLIST: { n: 20, order: "desc" },
  GET_HISTORY: { n: 20 },
  GET_PLAYHEADS: { content_ids: ["GE00377909ENUS", "GE00377910ENUS"] },
};

/** Migrated once, then deferred by F-1. Its behaviour lives in bt7-f1-f2. */
const BT7_DEFERRED = ["GET_CONTINUE_WATCHING", "GET_SUBSCRIPTION"];

/** A READY authority holding synthetic material, with a profile id present. */
function readyAuthority(withProfile = true) {
  const authority = createAuthContextAuthority();
  const writer = authority.asWriter();
  writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", {
    accessToken: BEARER_SENTINEL,
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000,
    accountId: ACCOUNT_SENTINEL,
    ...(withProfile ? { profileId: PROFILE_SENTINEL } : {}),
  } as never);
  return authority;
}

interface ChannelFake {
  channel: ApiExecutionChannel;
  requests: ApiExecutionRequest[];
  opens: () => number;
}

function channelFake(body: unknown = { data: [] }): ChannelFake {
  const requests: ApiExecutionRequest[] = [];
  const state = { opens: 0 };
  return {
    requests,
    opens: () => state.opens,
    channel: {
      connectionGeneration: 1,
      async request(input) {
        requests.push(input);
        return Object.freeze({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(body),
          truncated: false,
        });
      },
      async close() {
        /* nothing to release in the fake */
      },
    },
  };
}

/** The production backend, wired to a fake channel and the REAL reader. */
function backendHarness(options: { authority?: ReturnType<typeof createAuthContextAuthority>; body?: unknown } = {}) {
  const authority = options.authority ?? readyAuthority();
  const fake = channelFake(options.body);
  const state = { opens: 0 };
  const backend = createBrowserApiBackend({
    openChannel: async () => {
      state.opens += 1;
      return fake.channel;
    },
    reader: authority.asReader(),
    deadlineMs: 5_000,
  });
  return { authority, fake, backend, channelOpens: () => state.opens };
}

function gatewayHarness(json: unknown = { data: [] }) {
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

// ── The table ───────────────────────────────────────────────────────────────

describe("BT7 — the production table after the account-read migration", () => {
  test("holds the BT5/BT6 catalog reads, five BT7 reads and all BT8 mutations", () => {
    // Was 14 before the F-1 ruling. Thirteen is not a smaller migration, it is
    // an honest one: an operation nobody can serve does not belong in a table
    // whose whole meaning is "this is served here now".
    assert.deepEqual(
      PRODUCTION_OPERATIONS.map((d) => String(d.id)).sort(),
      [
        ...BT5_BT6_OPERATIONS,
        ...BT7_OPERATIONS,
        "ADD_TO_WATCHLIST",
        "REMOVE_FROM_WATCHLIST",
        "UPDATE_PLAYHEAD",
        "SET_FAVORITE",
        // Internal read with no tool of its own: names the watchlist's bare ids.
        "GET_OBJECTS",
      ].sort()
    );
    assert.equal(PRODUCTION_OPERATIONS.length, 18);
  });

  test("both deferred operations are absent — D-1c and F-1, neither forgotten", () => {
    for (const id of BT7_DEFERRED) {
      assert.equal(PRODUCTION_OPERATIONS.some((d) => String(d.id) === id), false, id);
    }
  });

  test("all three BT8 mutations entered the table", () => {
    assert.equal(PRODUCTION_OPERATIONS.some((d) => String(d.id) === "ADD_TO_WATCHLIST"), true);
    assert.equal(PRODUCTION_OPERATIONS.some((d) => String(d.id) === "REMOVE_FROM_WATCHLIST"), true);
    assert.equal(PRODUCTION_OPERATIONS.some((d) => String(d.id) === "UPDATE_PLAYHEAD"), true);
  });

  test("every BT7 descriptor is an ACCOUNT read that resolves exactly one identity", () => {
    for (const id of BT7_OPERATIONS) {
      const d = PRODUCTION_OPERATIONS.find((x) => String(x.id) === id)!;
      assert.ok(d, `${id} missing`);
      assert.equal(d.method, "GET", id);
      assert.equal(d.scope, "ACCOUNT", id);
      assert.equal(d.auth, "BEARER", id);
      assert.equal(d.mutation, false, id);
      assert.deepEqual(Object.keys(d.authDerivedParams), ["accountId"], id);
      assert.equal(d.authDerivedParams.accountId.source, "accountId", id);
      // Identity is a PATH parameter, never a caller argument.
      assert.match(d.pathTemplate, /\{accountId\}/, id);
      assert.equal("accountId" in d.callerParams, false, id);
      assert.equal("profileId" in d.callerParams, false, id);
    }
  });

  test("no BT7 descriptor resolves a profile id — these are account-scoped", () => {
    for (const id of BT7_OPERATIONS) {
      const d = PRODUCTION_OPERATIONS.find((x) => String(x.id) === id)!;
      assert.equal("profileId" in d.authDerivedParams, false, id);
      assert.equal(/\{profileId\}/.test(d.pathTemplate), false, id);
    }
  });

  test("the BT5/BT6 catalog reads are untouched by BT7", () => {
    for (const id of BT5_BT6_OPERATIONS) {
      const d = PRODUCTION_OPERATIONS.find((x) => String(x.id) === id)!;
      assert.equal(d.scope, "PUBLIC", id);
      assert.equal(d.auth, "BEARER", id);
      assert.deepEqual(Object.keys(d.authDerivedParams), [], id);
    }
  });
});

// ── G-1: the URL is materialized only after bind() ──────────────────────────

describe("BT7 G-1 — identity reaches the URL only through bind()", () => {
  test("the rendered URL carries the authenticated account id, which no caller supplied", async () => {
    const h = backendHarness();
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);

    for (const id of BT7_OPERATIONS) {
      const call = resolveCall(registry, id, MINIMUM_ARGS[id]);
      await h.backend.executeResolved(call);
    }

    assert.equal(h.fake.requests.length, BT7_OPERATIONS.length);
    for (const request of h.fake.requests) {
      assert.ok(
        request.url.includes(ACCOUNT_SENTINEL),
        "the authenticated account id must appear in the path"
      );
      assert.equal(request.url.includes("{accountId}"), false, "no unresolved placeholder");
      assert.equal(new URL(request.url).origin, "https://www.crunchyroll.com");
      assert.equal(request.method, "GET");
      assert.equal(request.authorization, `Bearer ${BEARER_SENTINEL}`);
    }
  });

  test("buildRequestUrl gives auth-derived values precedence over caller params", () => {
    // The registry forbids the collision, so this asserts the builder's rule
    // directly: identity wins, explicitly, not by accident of ordering.
    const descriptor = Object.freeze({
      id: "PROBE" as never,
      method: "GET" as const,
      pathTemplate: "/content/v2/{accountId}/thing",
      callerParams: Object.freeze({}),
      authDerivedParams: Object.freeze({ accountId: { source: "accountId" as const } }),
      fixedQuery: Object.freeze({}),
      queryParams: Object.freeze({}),
      repeatedQueryParams: Object.freeze({}),
      scope: "ACCOUNT" as const,
      auth: "BEARER" as const,
      mutation: false as const,
    }) as OperationDescriptor;

    const url = buildRequestUrl(
      { descriptor, callerParams: Object.freeze({ accountId: "CALLER-SUPPLIED" }) },
      { accountId: ACCOUNT_SENTINEL }
    );
    assert.ok(url.includes(ACCOUNT_SENTINEL));
    assert.equal(url.includes("CALLER-SUPPLIED"), false, "caller value must never win");
  });

  test("without a usable AuthContext nothing is built and no channel is opened", async () => {
    const empty = createAuthContextAuthority();
    const fake = channelFake();
    let opens = 0;
    const backend = createBrowserApiBackend({
      openChannel: async () => {
        opens += 1;
        return fake.channel;
      },
      reader: empty.asReader(),
      deadlineMs: 5_000,
    });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);

    for (const id of BT7_OPERATIONS) {
      await assert.rejects(
        backend.executeResolved(resolveCall(registry, id, MINIMUM_ARGS[id])),
        (e: unknown) => e instanceof TransportError && e.kind === "AUTH_NOT_READY",
        id
      );
    }
    assert.equal(opens, 0, "no channel may be opened without identity");
    assert.equal(fake.requests.length, 0, "no request may be attempted");
  });

  test("a generation change during the call discards the response", async () => {
    const authority = readyAuthority();
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const backend = createBrowserApiBackend({
      openChannel: async () => ({
        connectionGeneration: 1,
        async request() {
          // The user logs out while the response is in flight.
          authority.invalidate("LOGOUT");
          return Object.freeze({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ data: [] }),
            truncated: false,
          });
        },
        async close() {},
      }),
      reader: authority.asReader(),
      deadlineMs: 5_000,
    });

    await assert.rejects(
      backend.executeResolved(resolveCall(registry, "GET_WATCHLIST", MINIMUM_ARGS.GET_WATCHLIST)),
      (e: unknown) => e instanceof TransportError && e.kind === "AUTH_GENERATION_CHANGED"
    );
  });

  test("no failure path renders the bearer or the account id", async () => {
    const rendered: string[] = [];
    const empty = createAuthContextAuthority();
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const backend = createBrowserApiBackend({
      openChannel: async () => channelFake().channel,
      reader: empty.asReader(),
      deadlineMs: 5_000,
    });
    for (const id of BT7_OPERATIONS) {
      try {
        await backend.executeResolved(resolveCall(registry, id, MINIMUM_ARGS[id]));
      } catch (error) {
        rendered.push(`${(error as Error).message}|${JSON.stringify(error)}`);
      }
    }
    const everything = rendered.join("\n");
    assert.equal(everything.includes(BEARER_SENTINEL), false);
    assert.equal(everything.includes(ACCOUNT_SENTINEL), false);
  });
});

// ── The content_ids wire ────────────────────────────────────────────────────

describe("BT7 — the content_ids wire, as the provider accepts it", () => {
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);

  // RETIRED BY THE F-2 RULING: these two asserted the repeated `content_ids[]`
  // wire, copied faithfully from the legacy client. Live evidence overruled the
  // copy — the v2 endpoint answers 400 `missing_required_field` to it and drops
  // all but the first value when the bare key is repeated. The full replacement
  // contract, including the retired forms, lives in test/bt7-f1-f2.test.ts.
  test("content_ids is emitted once, comma-joined, in caller order", async () => {
    const h = backendHarness();
    await h.backend.executeResolved(
      resolveCall(registry, "GET_PLAYHEADS", { content_ids: ["AAA", "BBB", "CCC"] })
    );
    const url = h.fake.requests[0].url;
    assert.deepEqual(new URL(url).searchParams.getAll("content_ids"), ["AAA,BBB,CCC"]);
    assert.equal(url.includes("content_ids%5B%5D"), false, "the bracket wire is retired");
    assert.equal(url.includes("%5B%22AAA%22"), false, "never JSON-encoded");
  });

  test("GET_PLAYHEADS sends no locale — the legacy request did not", async () => {
    const h = backendHarness();
    await h.backend.executeResolved(
      resolveCall(registry, "GET_PLAYHEADS", { content_ids: ["AAA"] })
    );
    const params = new URL(h.fake.requests[0].url).searchParams;
    assert.equal(params.has("locale"), false, "no locale on this endpoint");
    assert.deepEqual([...params.keys()], ["content_ids"]);
  });

  test("a malformed, empty or oversized array is refused before any URL exists", () => {
    for (const bad of [
      [],
      ["ok", ""],
      ["ok", "has/slash"],
      ["ok", 42],
      "not-an-array",
      Array.from({ length: 101 }, (_v, i) => `ID${i}`),
    ]) {
      assert.throws(
        () => resolveCall(registry, "GET_PLAYHEADS", { content_ids: bad as never }),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `content_ids=${JSON.stringify(bad).slice(0, 40)} must be refused`
      );
    }
  });

  test("the registry refuses an incoherent repeated-query declaration", () => {
    const base = {
      method: "GET" as const,
      pathTemplate: "/content/v2/{accountId}/thing",
      authDerivedParams: { accountId: { source: "accountId" as const } },
      scope: "ACCOUNT" as const,
      auth: "BEARER" as const,
      mutation: false as const,
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "repeated key naming an undeclared param",
        { ...base, id: "X1", callerParams: {}, fixedQuery: {}, queryParams: {}, repeatedQueryParams: { "ids[]": "ids" } },
      ],
      [
        "same wire key both repeated and scalar",
        {
          ...base,
          id: "X2",
          callerParams: { ids: { required: true, validate: () => true } },
          fixedQuery: {},
          queryParams: { "ids[]": "ids" },
          repeatedQueryParams: { "ids[]": "ids" },
        },
      ],
      [
        "same wire key both repeated and fixed",
        {
          ...base,
          id: "X3",
          callerParams: { ids: { required: true, validate: () => true } },
          fixedQuery: { "ids[]": "1" },
          queryParams: {},
          repeatedQueryParams: { "ids[]": "ids" },
        },
      ],
    ];
    for (const [label, descriptor] of cases) {
      assert.throws(
        () => createOperationRegistry([descriptor as never]),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        label
      );
    }
  });
});

// ── Per-operation endpoints and defaults ────────────────────────────────────

describe("BT7 — each operation renders exactly the endpoint the legacy client used", () => {
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const authority = readyAuthority();
  const reader = authority.asReader();

  /** Renders through the real bind(), exactly as the backend does. */
  function render(id: string, params: Record<string, unknown>): string {
    const call = resolveCall(registry, id, params);
    const execution = reader.bind(call);
    assert.equal(execution.kind, "AUTHENTICATED", `${id} must bind to an authorized call`);
    return buildRequestUrl(call, (execution as { authDerivedParams: Record<string, string> }).authDerivedParams);
  }

  const A = ACCOUNT_SENTINEL;
  const ORIGIN = "https://www.crunchyroll.com";

  test("GET_SIMILAR", () => {
    assert.equal(
      render("GET_SIMILAR", { series_id: "GY8VEQ95Y", n: 20 }),
      `${ORIGIN}/content/v2/discover/${A}/similar_to/GY8VEQ95Y?n=20&locale=en-US`
    );
  });

  test("GET_RECOMMENDATIONS", () => {
    assert.equal(
      render("GET_RECOMMENDATIONS", { n: 20 }),
      `${ORIGIN}/content/v2/discover/${A}/recommendations?n=20&locale=en-US`
    );
  });

  test("GET_WATCHLIST, with its order argument", () => {
    assert.equal(
      render("GET_WATCHLIST", { n: 20, order: "desc" }),
      `${ORIGIN}/content/v2/${A}/watchlist?n=20&order=desc&locale=en-US`
    );
    assert.match(render("GET_WATCHLIST", { n: 5, order: "asc" }), /order=asc/);
  });

  test("GET_HISTORY", () => {
    assert.equal(
      render("GET_HISTORY", { n: 20 }),
      `${ORIGIN}/content/v2/${A}/watch-history?n=20&locale=en-US`
    );
  });

  // GET_CONTINUE_WATCHING had its exact rendering asserted here. F-1 deferred
  // the operation, so there is no URL to render and no template to own.

  test("GET_PLAYHEADS", () => {
    assert.equal(
      render("GET_PLAYHEADS", { content_ids: ["AAA", "BBB"] }),
      `${ORIGIN}/content/v2/${A}/playheads?content_ids=AAA%2CBBB`
    );
  });
});

describe("BT7 — domain defaults survive the migration verbatim", () => {
  // The continue-watching default of 10 left with F-1: the gateway case that
  // held it is gone, and a default for an unserved operation is dead policy.
  test("the account reads default to 20", async () => {
    const seen: Record<string, string | null> = {};
    for (const [tool, id] of [
      ["crunchyroll_get_watchlist", "GET_WATCHLIST"],
      ["crunchyroll_get_history", "GET_HISTORY"],
      ["crunchyroll_get_recommendations", "GET_RECOMMENDATIONS"],
    ] as Array<[string, string]>) {
      const h = gatewayHarness({ data: [] });
      await h.gateway.callTool(tool, {});
      seen[id] = String(h.backend.calls[0].callerParams.n ?? "");
    }
    assert.equal(seen.GET_WATCHLIST, "20");
    assert.equal(seen.GET_HISTORY, "20");
    assert.equal(seen.GET_RECOMMENDATIONS, "20");
  });

  test("watchlist defaults to order=desc", async () => {
    const h = gatewayHarness({ data: [] });
    await h.gateway.callTool("crunchyroll_get_watchlist", {});
    assert.equal(h.backend.calls[0].callerParams.order, "desc");
  });
});

// ── Caller injection, per operation ─────────────────────────────────────────

describe("BT7 — the caller can never supply identity or transport control", () => {
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);

  for (const id of BT7_OPERATIONS) {
    test(`${id} refuses caller-supplied identity and transport fields`, () => {
      // accountId is the descriptor's own auth-derived name: the registry
      // answers with the precise reason rather than a generic refusal.
      assert.throws(
        () => resolveCall(registry, id, { ...MINIMUM_ARGS[id], accountId: "OTHER-ACCOUNT" }),
        (e: unknown) => e instanceof TransportError && e.kind === "CALLER_SUPPLIED_IDENTITY",
        `${id} accepted accountId`
      );
      for (const injection of [
        { account_id: "OTHER" },
        { profileId: "OTHER" },
        { profile_id: "OTHER" },
        { Authorization: "Bearer stolen" },
        { headers: { Authorization: "Bearer stolen" } },
        { token: "stolen" },
        { url: "https://evil.invalid/x" },
        { method: "DELETE" },
        { locale: "pt-BR" },
        { totally_unknown_key: 1 },
      ]) {
        assert.throws(
          () => resolveCall(registry, id, { ...MINIMUM_ARGS[id], ...injection }),
          (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
          `${id} accepted ${JSON.stringify(injection)}`
        );
      }
    });
  }

  test("an injection never reaches a channel", async () => {
    const h = backendHarness();
    const registryLocal = createOperationRegistry(PRODUCTION_OPERATIONS);
    for (const id of BT7_OPERATIONS) {
      try {
        await h.backend.executeResolved(
          resolveCall(registryLocal, id, { ...MINIMUM_ARGS[id], accountId: "OTHER" })
        );
      } catch {
        /* refused at resolve time, as required */
      }
    }
    assert.equal(h.channelOpens(), 0);
    assert.equal(h.fake.requests.length, 0);
  });
});

// ── Non-mutation ────────────────────────────────────────────────────────────

describe("BT7 — nothing here can become a write", () => {
  test("every BT7 request the backend emits is a GET", async () => {
    const h = backendHarness();
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    for (const id of BT7_OPERATIONS) {
      await h.backend.executeResolved(resolveCall(registry, id, MINIMUM_ARGS[id]));
    }
    for (const request of h.fake.requests) assert.equal(request.method, "GET");
  });

  test("the execution request record has no body, headers or method choice", async () => {
    const h = backendHarness();
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    await h.backend.executeResolved(resolveCall(registry, "GET_PLAYHEADS", MINIMUM_ARGS.GET_PLAYHEADS));
    assert.deepEqual(Object.keys(h.fake.requests[0]).sort(), [
      "authorization",
      "deadlineMs",
      "maxBytes",
      "method",
      "url",
    ]);
  });

  test("a descriptor that is not a read is refused by the backend", async () => {
    const authority = readyAuthority();
    const backend = createBrowserApiBackend({
      openChannel: async () => channelFake().channel,
      reader: authority.asReader(),
      deadlineMs: 5_000,
    });
    const mutation = Object.freeze({
      id: "PROBE_MUTATION" as never,
      method: "POST" as const,
      pathTemplate: "/content/v2/{accountId}/watchlist",
      callerParams: Object.freeze({}),
      authDerivedParams: Object.freeze({ accountId: { source: "accountId" as const } }),
      fixedQuery: Object.freeze({}),
      queryParams: Object.freeze({}),
      repeatedQueryParams: Object.freeze({}),
      scope: "ACCOUNT" as const,
      auth: "BEARER" as const,
      mutation: "ACCOUNT" as const,
    }) as OperationDescriptor;

    await assert.rejects(
      backend.executeResolved({ descriptor: mutation, callerParams: Object.freeze({}) }),
      (e: unknown) => e instanceof TransportError && e.kind === "OPERATION_NOT_MIGRATED"
    );
  });
});

// ── Boundaries that must not move ───────────────────────────────────────────

describe("BT7 — the deferred boundary holds", () => {
  for (const [tool, args] of [["crunchyroll_get_subscription", {}]] as Array<[string, Record<string, unknown>]>) {
    test(`${tool} stays OPERATION_NOT_MIGRATED with zero transport calls`, async () => {
      const h = gatewayHarness();
      await assert.rejects(
        h.gateway.callTool(tool, args),
        (e: unknown) => e instanceof TransportError && e.kind === "OPERATION_NOT_MIGRATED"
      );
      assert.equal(h.backend.calls.length, 0);
    });
  }

  test("the subscription paths never entered the registry", () => {
    const registryCode = readFileSync(join(SRC, "transport", "operation-registry.ts"), "utf-8");
    assert.equal(registryCode.includes("/subs/v1/"), false);
    assert.equal(registryCode.includes("subscriptions/v1"), false);
  });
});

// ── Routing and output shapes ───────────────────────────────────────────────

describe("BT7 — each tool routes to its operation and keeps its public shape", () => {
  const PANEL = { id: "GE1", title: "Ep", type: "episode" };

  const CASES: Array<[string, Record<string, unknown>, string, unknown, (r: unknown) => void]> = [
    [
      "crunchyroll_get_similar",
      { series_id: "GY8VEQ95Y" },
      "GET_SIMILAR",
      { data: [{ id: "S1", title: "T", type: "series" }] },
      (r) => assert.deepEqual(Object.keys(r as object).sort(), ["count", "similar"]),
    ],
    [
      "crunchyroll_get_recommendations",
      {},
      "GET_RECOMMENDATIONS",
      { data: [{ id: "S1", title: "T", type: "series" }] },
      (r) => assert.deepEqual(Object.keys(r as object).sort(), ["count", "recommendations"]),
    ],
    [
      "crunchyroll_get_watchlist",
      {},
      "GET_WATCHLIST",
      { data: [{ panel: PANEL, playhead: { playhead: 10, fully_watched: false } }] },
      (r) => assert.deepEqual(Object.keys(r as object).sort(), ["count", "items"]),
    ],
    [
      "crunchyroll_get_history",
      {},
      "GET_HISTORY",
      { data: [{ panel: PANEL, playhead: { playhead: 3, fully_watched: false } }] },
      (r) => assert.deepEqual(Object.keys(r as object).sort(), ["count", "items"]),
    ],
    [
      "crunchyroll_get_playheads",
      { content_ids: ["GE1"] },
      "GET_PLAYHEADS",
      { data: [{ content_id: "GE1", playhead: 12, fully_watched: false }] },
      (r) => assert.ok(Array.isArray(r), "playheads returns the data array, as it always did"),
    ],
  ];

  for (const [tool, args, operation, payload, check] of CASES) {
    test(`${tool} → ${operation}`, async () => {
      const h = gatewayHarness(payload);
      const result = await h.gateway.callTool(tool, args);
      assert.equal(h.backend.calls.length, 1);
      assert.equal(String(h.backend.calls[0].descriptor.id), operation);
      check(result);
    });
  }

  test("an unrecognised payload is a typed refusal, and carries none of it", async () => {
    const h = gatewayHarness({ data: "not-an-array" });
    await assert.rejects(
      h.gateway.callTool("crunchyroll_get_watchlist", {}),
      (error: unknown) => {
        assert.equal(JSON.stringify(error).includes("not-an-array"), false);
        return error instanceof TransportError && error.kind === "SCHEMA_MISMATCH";
      }
    );
  });

  test("an empty account is a valid, successful result", async () => {
    // crunchyroll_continue_watching was a third case here until F-1: an empty
    // result and an absent endpoint are different answers, and only one of them
    // is this test's subject.
    for (const tool of ["crunchyroll_get_watchlist", "crunchyroll_get_history"]) {
      const h = gatewayHarness({ data: [] });
      const result = (await h.gateway.callTool(tool, {})) as { count: number; items: unknown[] };
      assert.equal(result.count, 0, tool);
      assert.deepEqual(result.items, [], tool);
    }
  });
});

// ── Move, not copy ──────────────────────────────────────────────────────────

describe("BT7 — transport ownership moved out of the legacy client", () => {
  /** The exact read templates BT7 moved into the registry. */
  const MIGRATED_READ_TEMPLATES = [
    "/content/v2/discover/{accountId}/similar_to/{series_id}",
    "/content/v2/discover/{accountId}/recommendations",
    "/content/v2/{accountId}/watchlist",
    "/content/v2/{accountId}/watch-history",
    // "/content/v2/{accountId}/continue_watching" was here. F-1 removed it from
    // the registry WITHOUT returning it to src/api.ts: no owner at all is the
    // correct state for a path the provider does not route.
    "/content/v2/{accountId}/playheads",
  ];

  test("the registry is the only owner of every migrated read template", () => {
    const registryPath = join(SRC, "transport", "operation-registry.ts");
    for (const template of MIGRATED_READ_TEMPLATES) {
      const holders = sources()
        .filter((f) => f.code.includes(template))
        .map((f) => f.path);
      assert.deepEqual(holders, [registryPath], `${template} has more than one owner`);
    }
  });

  test("every path literal left in the legacy client belongs to BT8 or to the deferred operation", () => {
    // Segment overlap is real and legitimate: UPDATE_PLAYHEAD (BT8) posts to
    // the SAME path GET_PLAYHEADS reads, and the watchlist writes sit under the
    // watchlist path. What must be true is not "the segment is gone" but "no
    // READ still owns a path here" — so the check is per owning function.
    const api = readFileSync(join(SRC, "api.ts"), "utf-8");
    const owners: Array<[string, string]> = [];
    for (const match of api.matchAll(/export async function (\w+)/g)) {
      const start = match.index!;
      const end = api.indexOf("\n}\n", start);
      const body = api.slice(start, end);
      for (const url of body.matchAll(/`\$\{API_BASE\}[^`]*`/g)) {
        owners.push([match[1], url[0]]);
      }
    }
    const ALLOWED_OWNERS = new Set(["getSubscription"]);
    for (const [fn, url] of owners) {
      assert.ok(
        ALLOWED_OWNERS.has(fn),
        `${fn} still owns a Crunchyroll path in the legacy client: ${url.slice(0, 60)}`
      );
    }
    // All three BT8 mutations now have registry owners, not legacy owners.
    assert.equal(owners.some(([fn]) => fn === "updatePlayhead"), false);
  });

  test("the legacy transport functions for the six are gone", () => {
    const api = readFileSync(join(SRC, "api.ts"), "utf-8");
    for (const fn of [
      "getSimilar",
      "getRecommendations",
      "getWatchlist",
      "getWatchHistory",
      "getContinueWatching",
      "getPlayheads",
    ]) {
      assert.equal(
        new RegExp(`export async function ${fn}\\b`).test(api),
        false,
        `${fn} still owns transport in api.ts`
      );
    }
  });

  test("the deferred operation keeps its legacy owner while BT8 owners stay removed", () => {
    const api = readFileSync(join(SRC, "api.ts"), "utf-8");
    assert.match(api, /export async function getSubscription\b/, "GET_SUBSCRIPTION is deferred, not deleted");
    assert.equal(/export async function addToWatchlist\b/.test(api), false, "ADD owner must be removed");
    assert.equal(/export async function removeFromWatchlist\b/.test(api), false, "REMOVE owner must be removed");
    assert.equal(/export async function updatePlayhead\b/.test(api), false, "UPDATE owner must be removed");
  });

  test("infrastructure the remaining legacy callers need is preserved", () => {
    const api = readFileSync(join(SRC, "api.ts"), "utf-8");
    for (const kept of ["getValidToken", "API_BASE", "DEFAULT_LOCALE"]) {
      assert.ok(api.includes(kept), `${kept} is still needed by BT8 operations`);
    }
  });

  test("no transport module imports a content function from the legacy client", () => {
    const ALLOWED = ["login", "refreshRequest", "getStatus", "LogoutResult"];
    for (const file of sources()) {
      if (!file.path.includes("/transport/")) continue;
      const imported = [...file.code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"[^"]*\/api\.js"/g)]
        .flatMap((m) => m[1].split(","))
        .map((name) => name.replace(/\btype\b/, "").trim())
        .filter(Boolean);
      for (const name of imported) {
        assert.ok(ALLOWED.includes(name), `${file.path} imports ${name}`);
      }
    }
  });
});

// ── Public surface ──────────────────────────────────────────────────────────

describe("BT7 — the public contract is frozen", () => {
  test("24 tools, and none of the six gained an argument", () => {
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, "test/fixtures/baseline-tools.json"), "utf-8")
    ) as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
    assert.equal(baseline.length, 24);

    const expected: Record<string, string[]> = {
      crunchyroll_get_similar: ["series_id", "n"],
      crunchyroll_get_recommendations: ["n"],
      crunchyroll_get_watchlist: ["n", "order"],
      crunchyroll_get_history: ["n"],
      crunchyroll_continue_watching: ["n"],
      crunchyroll_get_playheads: ["content_ids"],
    };
    for (const [tool, properties] of Object.entries(expected)) {
      const schema = baseline.find((t) => t.name === tool)!.inputSchema;
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...properties].sort(), tool);
      for (const forbidden of ["accountId", "account_id", "profileId", "profile_id", "locale"]) {
        assert.equal(forbidden in (schema.properties ?? {}), false, `${tool}.${forbidden}`);
      }
    }
  });
});
