// BT6 — the remaining public catalog reads.
//
// Deterministic and offline: fake backend, synthetic payloads, no browser, no
// network. Proves the migration, the ownership move, and the account boundary
// that must NOT move.
//
// Frozen design: CRUNCHYROLL-BT6-CATALOG-PLAN.md.

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
import type { TransportResult } from "../src/transport/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(REPO_ROOT, "src");

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

/** Exactly the operations BT6 may migrate, and no others. */
const BT6_OPERATIONS = [
  "BROWSE",
  "GET_EPISODE",
  "GET_EPISODES",
  "GET_SEASONS",
  "GET_SERIES",
  "GET_SIMULCAST_SEASONS",
  "SEARCH",
];

const EXPECTED_TABLE = ["GET_CATEGORIES", ...BT6_OPERATIONS].sort();

function harness(json: unknown) {
  const backend = new FakeTransportBackend({
    result: { status: 200, contentType: "application/json", json } as TransportResult,
  });
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const gateway = createContentGateway(createTransportDispatcher(registry, backend), registry);
  return { backend, gateway, registry };
}

// ── The table ───────────────────────────────────────────────────────────────

describe("BT6 — the production table after the catalog migration", () => {
  test("holds exactly GET_CATEGORIES plus the seven public catalog reads", () => {
    assert.deepEqual([...PRODUCTION_OPERATIONS.map((d) => String(d.id))].sort(), EXPECTED_TABLE);
  });

  test("every migrated operation is a public, non-mutating, bearer-carrying read", () => {
    for (const d of PRODUCTION_OPERATIONS) {
      assert.equal(d.method, "GET", `${d.id}`);
      assert.equal(d.scope, "PUBLIC", `${d.id}`);
      assert.equal(d.auth, "BEARER", `${d.id}`);
      assert.equal(d.mutation, false, `${d.id}`);
      assert.deepEqual(Object.keys(d.authDerivedParams), [], `${d.id} resolves identity`);
    }
  });

  test("no account-scoped or mutating operation slipped in", () => {
    for (const forbidden of [
      "GET_SIMILAR",
      "GET_RECOMMENDATIONS",
      "GET_WATCHLIST",
      "GET_HISTORY",
      "GET_PLAYHEADS",
      "GET_CONTINUE_WATCHING",
      "GET_SUBSCRIPTION",
      "ADD_TO_WATCHLIST",
      "REMOVE_FROM_WATCHLIST",
      "UPDATE_PLAYHEAD",
    ]) {
      assert.equal(
        PRODUCTION_OPERATIONS.some((d) => String(d.id) === forbidden),
        false,
        `${forbidden} must not be migrated at BT6`
      );
    }
  });
});

// ── Ownership move: the literal leaves api.ts ───────────────────────────────

describe("BT6 — transport knowledge moved, not copied", () => {
  const MIGRATED_PATHS = [
    "/content/v2/discover/search",
    "/content/v2/cms/series/",
    "/content/v2/cms/seasons/",
    "/content/v2/cms/episodes/",
    "/content/v2/discover/seasonal_tags",
    "/content/v2/discover/browse",
    "/content/v2/discover/categories",
  ];

  test("each migrated path literal lives only in the registry", () => {
    const registryPath = join(SRC, "transport", "operation-registry.ts");
    for (const literal of MIGRATED_PATHS) {
      const holders = sources()
        .filter((f) => f.code.includes(literal))
        .map((f) => f.path);
      assert.deepEqual(holders, [registryPath], `${literal} is duplicated or misplaced`);
    }
  });

  test("the legacy module keeps no query builder for a migrated operation", () => {
    const api = readFileSync(join(SRC, "api.ts"), "utf-8");
    for (const fn of [
      "searchAnime",
      "getSeriesDetails",
      "getSeasons",
      "getEpisodes",
      "getEpisodeDetails",
      "getSimulcastSeasons",
      "browse",
    ]) {
      assert.equal(
        new RegExp(`export async function ${fn}\\\\b`).test(api),
        false,
        `${fn} still owns transport in api.ts`
      );
    }
  });

  test("the account operations still own their paths in api.ts — BT6 moved nothing of theirs", () => {
    const api = readFileSync(join(SRC, "api.ts"), "utf-8");
    assert.match(api, /similar_to/);
    assert.match(api, /recommendations/);
    assert.match(api, /watchlist/);
  });

  test("the LIVE-COMPAT-01 normalizer exists exactly once", () => {
    const holders = sources()
      .filter((f) => /function normalizeDiscoverItem/.test(f.code))
      .map((f) => f.path);
    assert.deepEqual(holders, [join(SRC, "catalog-domain.ts")]);
  });
});

// ── URL construction is descriptor-driven and closed ────────────────────────

describe("BT6 — the URL is built from the descriptor alone", () => {
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const urlFor = (operation: string, params: Record<string, unknown> = {}) =>
    buildRequestUrl(resolveCall(registry, operation, params));

  test("each operation renders exactly the endpoint the legacy code used", () => {
    assert.equal(
      urlFor("SEARCH", { q: "frieren", n: 20 }),
      "https://www.crunchyroll.com/content/v2/discover/search?q=frieren&n=20&locale=en-US"
    );
    assert.equal(
      urlFor("GET_SERIES", { series_id: "GY8VEQ95Y" }),
      "https://www.crunchyroll.com/content/v2/cms/series/GY8VEQ95Y?locale=en-US"
    );
    assert.equal(
      urlFor("GET_SEASONS", { series_id: "GY8VEQ95Y" }),
      "https://www.crunchyroll.com/content/v2/cms/series/GY8VEQ95Y/seasons?series_id=GY8VEQ95Y&locale=en-US"
    );
    assert.equal(
      urlFor("GET_EPISODES", { season_id: "GR5V0QW0R" }),
      "https://www.crunchyroll.com/content/v2/cms/seasons/GR5V0QW0R/episodes?locale=en-US"
    );
    assert.equal(
      urlFor("GET_EPISODE", { episode_id: "GZ7UV13VE" }),
      "https://www.crunchyroll.com/content/v2/cms/episodes/GZ7UV13VE?locale=en-US"
    );
    assert.equal(
      urlFor("GET_SIMULCAST_SEASONS"),
      "https://www.crunchyroll.com/content/v2/discover/seasonal_tags?locale=en-US"
    );
    assert.equal(
      urlFor("BROWSE", { n: 20, start: 0 }),
      "https://www.crunchyroll.com/content/v2/discover/browse?n=20&start=0&locale=en-US"
    );
  });

  test("optional query parameters appear only when supplied", () => {
    assert.equal(
      urlFor("SEARCH", { q: "x", n: 5, type: "series" }),
      "https://www.crunchyroll.com/content/v2/discover/search?q=x&n=5&type=series&locale=en-US"
    );
    assert.equal(
      urlFor("BROWSE", { n: 1, start: 2, sort_by: "popularity", categories: "action,fantasy", is_subbed: true }),
      "https://www.crunchyroll.com/content/v2/discover/browse?n=1&start=2&sort_by=popularity&categories=action%2Cfantasy&is_subbed=true&locale=en-US"
    );
  });

  test("a value is encoded, never able to escape its segment", () => {
    // The legacy code interpolated ids raw; the validator refuses anything but
    // an id, so traversal cannot even be attempted.
    for (const hostile of ["../../evil", "a/b", "a?b", "a#b", "a b", "%2e%2e", ""]) {
      assert.throws(
        () => urlFor("GET_SERIES", { series_id: hostile }),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `series_id=${JSON.stringify(hostile)} must be refused`
      );
    }
    // A query value with separators is encoded rather than refused.
    assert.match(urlFor("SEARCH", { q: "a&b=c", n: 1 }), /q=a%26b%3Dc/);
  });

  test("every rendered URL stays on the frozen origin", () => {
    for (const [op, params] of [
      ["SEARCH", { q: "x", n: 1 }],
      ["GET_SERIES", { series_id: "A1" }],
      ["BROWSE", { n: 1, start: 0 }],
    ] as const) {
      assert.equal(new URL(urlFor(op, params)).origin, "https://www.crunchyroll.com");
    }
  });
});

// ── Negative surface, table-driven over the whole family ────────────────────

describe("BT6 — the caller controls nothing but declared values", () => {
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);

  const INJECTIONS = [
    { url: "https://evil.invalid/x" },
    { method: "DELETE" },
    { headers: { Authorization: "Bearer stolen" } },
    { Authorization: "Bearer stolen" },
    { bearer: "stolen" },
    { locale: "pt-BR" },
    { unexpected_key: 1 },
  ];

  for (const operation of BT6_OPERATIONS) {
    test(`${operation} refuses every undeclared key`, () => {
      for (const injection of INJECTIONS) {
        assert.throws(
          () => resolveCall(registry, operation, injection as never),
          (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
          `${operation} accepted ${JSON.stringify(injection)}`
        );
      }
    });

    test(`${operation} refuses caller-supplied identity`, () => {
      for (const key of ["accountId", "profileId", "account_id", "profile_id"]) {
        assert.throws(
          () => resolveCall(registry, operation, { [key]: "injected" }),
          (e: unknown) =>
            e instanceof TransportError &&
            (e.kind === "CALLER_SUPPLIED_IDENTITY" || e.kind === "INVALID_ARGUMENTS")
        );
      }
    });
  }

  test("required ids are required, and malformed ids are refused", () => {
    for (const [operation, key] of [
      ["GET_SERIES", "series_id"],
      ["GET_SEASONS", "series_id"],
      ["GET_EPISODES", "season_id"],
      ["GET_EPISODE", "episode_id"],
    ] as const) {
      assert.throws(
        () => resolveCall(registry, operation, {}),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `${operation} accepted a missing ${key}`
      );
      for (const bad of ["", "   ", "a/b", "a b", 42, null]) {
        assert.throws(
          () => resolveCall(registry, operation, { [key]: bad } as never),
          (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
          `${operation} accepted ${key}=${JSON.stringify(bad)}`
        );
      }
    }
  });

  test("enums and ranges are closed", () => {
    assert.throws(
      () => resolveCall(registry, "SEARCH", { q: "x", n: 20, type: "movie" }),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
    assert.throws(
      () => resolveCall(registry, "BROWSE", { n: 20, start: 0, sort_by: "random" }),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
    assert.throws(
      () => resolveCall(registry, "SEARCH", { q: "x", n: 1000 }),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
  });
});

// ── Routing: every BT6 tool reaches the browser transport ───────────────────

describe("BT6 — every migrated tool routes to the browser transport", () => {
  const CALLS: Array<[string, Record<string, unknown>, string, unknown]> = [
    [
      "crunchyroll_search",
      { query: "frieren" },
      "SEARCH",
      { data: [{ type: "series", count: 1, items: [{ type: "series", id: "S1", series_metadata: { title: "T", description: "D" } }] }] },
    ],
    ["crunchyroll_get_series", { series_id: "S1" }, "GET_SERIES", { data: [{ id: "S1", title: "T" }] }],
    ["crunchyroll_get_seasons", { series_id: "S1" }, "GET_SEASONS", { data: [{ id: "SE1", title: "S" }] }],
    ["crunchyroll_get_episodes", { season_id: "SE1" }, "GET_EPISODES", { data: [{ id: "E1", title: "E" }] }],
    ["crunchyroll_get_episode", { episode_id: "E1" }, "GET_EPISODE", { data: [{ id: "E1", title: "E" }] }],
    ["crunchyroll_get_simulcast_seasons", {}, "GET_SIMULCAST_SEASONS", { data: [{ id: "winter", localization: { title: "Winter" } }] }],
    [
      "crunchyroll_browse",
      {},
      "BROWSE",
      { data: [{ type: "series", id: "B1", series_metadata: { title: "BT", description: "BD" } }] },
    ],
  ];

  for (const [tool, args, operation, payload] of CALLS) {
    test(`${tool} → ${operation} → browser transport`, async () => {
      const h = harness(payload);
      const result = await h.gateway.callTool(tool, args);

      assert.equal(h.backend.calls.length, 1, "exactly one transport call");
      assert.equal(String(h.backend.calls[0].descriptor.id), operation);
      assert.ok(result !== undefined && result !== null);
    });
  }

  test("a browser failure surfaces, and no second path is tried", async () => {
    const backend = new FakeTransportBackend({ failWith: new TransportError("BROWSER_UNAVAILABLE") });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const gateway = createContentGateway(createTransportDispatcher(registry, backend), registry);

    for (const [tool, args] of CALLS.map(([t, a]) => [t, a] as const)) {
      await assert.rejects(
        gateway.callTool(tool, args),
        (e: unknown) => e instanceof TransportError && e.kind === "BROWSER_UNAVAILABLE",
        tool
      );
    }
    assert.equal(backend.calls.length, CALLS.length, "one attempt each, no retries");
  });
});

// ── The account boundary does not move ──────────────────────────────────────

describe("BT6 — account reads and mutations stay refused", () => {
  for (const [tool, args] of [
    ["crunchyroll_get_similar", { series_id: "S1" }],
    ["crunchyroll_get_recommendations", {}],
    ["crunchyroll_get_watchlist", {}],
    ["crunchyroll_get_history", {}],
    ["crunchyroll_continue_watching", {}],
    ["crunchyroll_get_playheads", { content_ids: ["A"] }],
    ["crunchyroll_get_subscription", {}],
    ["crunchyroll_add_to_watchlist", { content_id: "A" }],
    ["crunchyroll_remove_from_watchlist", { content_id: "A" }],
    ["crunchyroll_update_playhead", { content_id: "A", playhead: 1 }],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`${tool} is still OPERATION_NOT_MIGRATED, with zero transport calls`, async () => {
      const h = harness({});
      await assert.rejects(
        h.gateway.callTool(tool, args),
        (e: unknown) => e instanceof TransportError && e.kind === "OPERATION_NOT_MIGRATED"
      );
      assert.equal(h.backend.calls.length, 0);
    });
  }

  test("GET_SIMILAR is absent because its path carries an account id", () => {
    // Recorded as evidence for the classification, from the legacy source.
    const api = readFileSync(join(SRC, "api.ts"), "utf-8");
    const similar = api.slice(api.indexOf("export async function getSimilar"));
    assert.match(similar.slice(0, 600), /account_id/, "the path interpolates account_id");
    assert.match(similar.slice(0, 600), /similar_to/);
  });
});
