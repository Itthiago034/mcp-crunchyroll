// LIVE-COMPAT-01 — search/browse metadata shape compatibility.
//
// Deterministic and offline: no real Crunchyroll network, no credentials.
// Each test installs its own globalThis.fetch stub and runs against an
// isolated temporary HOME holding a synthetic, non-expired token so the
// production getValidToken() path is satisfied without a refresh.
//
// These tests exercise the REAL production searchAnime() and browse(), so
// they pin actual parser behaviour rather than re-implementing it.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TokenData } from "../src/auth.js";
import { searchAnime, browse } from "../src/api.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/live-search-shape.json"), "utf-8")
) as {
  live: { search: unknown; browse: unknown };
  legacy: { search: unknown; browse: unknown };
  legacyEmptyTitle: { search: unknown };
};

// ── Harness ─────────────────────────────────────────────────────────────────

function syntheticTokens(): TokenData {
  return {
    access_token: "bt0-synthetic-access-token",
    refresh_token: "bt0-synthetic-refresh-token",
    expires_at: Date.now() + 7_200_000, // comfortably unexpired: no refresh path
    token_type: "Bearer",
    account_id: "bt0-synthetic-account-id",
  };
}

function setupIsolatedHome(): string {
  const tmpHome = mkdtempSync(join(tmpdir(), "bt0-home-"));
  const striderDir = join(tmpHome, ".strider");
  const configDir = join(striderDir, "crunchyroll");
  mkdirSync(configDir, { recursive: true });
  chmodSync(striderDir, 0o700);
  chmodSync(configDir, 0o700);
  writeFileSync(join(configDir, "tokens.json"), JSON.stringify(syntheticTokens()));
  chmodSync(join(configDir, "tokens.json"), 0o600);
  return tmpHome;
}

let originalFetch: typeof fetch;
let originalHome: string | undefined;
let tmpHome: string | null = null;

function arrange(payload: unknown, expectedPathFragment: string): void {
  originalFetch = globalThis.fetch;
  originalHome = process.env.HOME;
  tmpHome = setupIsolatedHome();
  process.env.HOME = tmpHome;

  (globalThis as { fetch: unknown }).fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    assert.ok(
      url.includes(expectedPathFragment),
      `unexpected fetch URL in an offline test: ${url}`
    );
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  if (originalFetch) (globalThis as { fetch: unknown }).fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (tmpHome) {
    rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  }
});

// ── LIVE-COMPAT-01: the live shape ──────────────────────────────────────────

describe("LIVE-COMPAT-01 — live discover metadata shape", () => {
  test("search parses items carrying series_metadata instead of dropping them", async () => {
    arrange(FIXTURE.live.search, "/content/v2/discover/search");

    const results = await searchAnime("synthetic");

    assert.equal(
      results.length,
      2,
      "live items expose series_metadata / movie_listing_metadata; the parser must not skip them"
    );

    const series = results.find((r) => r.id === "GT00000001");
    assert.ok(series, "series item must survive parsing");
    assert.equal(series.title, "Synthetic Live Series", "title comes from the item level in the live shape");
    assert.equal(series.type, "series");
    assert.ok(series.description.length > 0, "description must be populated, not empty");

    const movie = results.find((r) => r.id === "GM00000002");
    assert.ok(movie, "movie_listing item must survive parsing");
    assert.equal(movie.title, "Synthetic Live Movie", "movie titles use the same item-level contract");
  });

  test("browse resolves real titles for items carrying series_metadata", async () => {
    arrange(FIXTURE.live.browse, "/content/v2/discover/browse");

    const items = await browse();

    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(
      item.title,
      "Synthetic Live Series",
      "browse must not degrade the title to the raw id when metadata is in the live shape"
    );
    assert.notEqual(item.title, item.id, "falling back to the id is the defect, not the contract");
    assert.equal(item.series_launch_year, 2024, "series extras come from series_metadata in the live shape");
    assert.ok((item.description ?? "").length > 0, "description must be populated");
  });
});

// ── Legacy shape must keep working ──────────────────────────────────────────

describe("LIVE-COMPAT-01 — legacy shape preserved", () => {
  test("search still parses the legacy series_meta shape", async () => {
    arrange(FIXTURE.legacy.search, "/content/v2/discover/search");

    const results = await searchAnime("synthetic");

    assert.equal(results.length, 1, "legacy items must not regress");
    assert.equal(results[0].title, "Synthetic Legacy Series", "legacy titles are nested in series_meta");
    assert.equal(results[0].id, "GT00000009");
  });

  test("browse still parses the legacy series_meta shape", async () => {
    arrange(FIXTURE.legacy.browse, "/content/v2/discover/browse");

    const items = await browse();

    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Synthetic Legacy Series", "legacy titles are nested in series_meta");
    assert.equal(items[0].series_launch_year, 2019, "legacy series extras stay readable");
  });

  // Pre-BT0, search included an item because a legacy metadata OBJECT existed,
  // independently of the title value. Inclusion must not become conditional on
  // the title being truthy.
  test("search keeps a legacy item whose metadata title is an empty string", async () => {
    arrange(FIXTURE.legacyEmptyTitle.search, "/content/v2/discover/search");

    const results = await searchAnime("synthetic");

    assert.equal(
      results.length,
      1,
      "a legacy metadata object with an empty title was included before BT0 and must remain included"
    );
    assert.equal(results[0].id, "GTLEGACY01");
    assert.equal(results[0].title, "", "the empty title is preserved verbatim, not substituted");
  });
});
