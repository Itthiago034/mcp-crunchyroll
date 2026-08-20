// LIVE-COMPAT-01 — search/browse metadata shape compatibility.
//
// Deterministic and offline: no network, no credentials, no HOME.
//
// BT6 moved these operations to the browser transport, so the parser they
// exercise moved with them: the assertions below are UNCHANGED and now run
// against `parseSearch` / `parseBrowse` in the domain module, which own the
// one LIVE-COMPAT-01 normalizer. Driving the parser directly is also what the
// production path now does — the transport hands it exactly this JSON.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSearch, parseBrowse } from "../src/catalog-domain.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/live-search-shape.json"), "utf-8")
) as {
  live: { search: unknown; browse: unknown };
  legacy: { search: unknown; browse: unknown };
  legacyEmptyTitle: { search: unknown };
  unknownShape: { search: unknown };
};

// ── LIVE-COMPAT-01: the live shape ──────────────────────────────────────────

describe("LIVE-COMPAT-01 — live discover metadata shape", () => {
  test("search parses items carrying series_metadata instead of dropping them", () => {
    const { results } = parseSearch(FIXTURE.live.search);

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

  test("browse resolves real titles for items carrying series_metadata", () => {
    const { items } = parseBrowse(FIXTURE.live.browse);

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
  test("search still parses the legacy series_meta shape", () => {
    const { results } = parseSearch(FIXTURE.legacy.search);

    assert.equal(results.length, 1, "legacy items must not regress");
    assert.equal(results[0].title, "Synthetic Legacy Series", "legacy titles are nested in series_meta");
    assert.equal(results[0].id, "GT00000009");
  });

  test("browse still parses the legacy series_meta shape", () => {
    const { items } = parseBrowse(FIXTURE.legacy.browse);

    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Synthetic Legacy Series", "legacy titles are nested in series_meta");
    assert.equal(items[0].series_launch_year, 2019, "legacy series extras stay readable");
  });

  // Pre-BT0, search included an item because a legacy metadata OBJECT existed,
  // independently of the title value. Inclusion must not become conditional on
  // the title being truthy.
  test("search keeps a legacy item whose metadata title is an empty string", () => {
    const { results } = parseSearch(FIXTURE.legacyEmptyTitle.search);

    assert.equal(
      results.length,
      1,
      "a legacy metadata object with an empty title was included before BT0 and must remain included"
    );
    assert.equal(results[0].id, "GTLEGACY01");
    assert.equal(results[0].title, "", "the empty title is preserved verbatim, not substituted");
  });
});

// Recognition must key on the four known metadata shapes. A title is data
// carried BY a recognized item, never the discriminator that makes an item
// recognized — accepting title-only items would widen the input contract
// beyond what BT0 is authorized to parse.
describe("LIVE-COMPAT-01 — unrecognized shapes stay excluded", () => {
  test("search excludes an item carrying only an item-level title and no metadata", () => {
    const { results } = parseSearch(FIXTURE.unknownShape.search);

    const ids = results.map((r) => r.id);
    assert.ok(
      !ids.includes("UNKNOWN01"),
      `an item with no recognized metadata shape must not be returned; got ids ${JSON.stringify(ids)}`
    );
    assert.deepEqual(
      ids,
      ["GT00000001"],
      "only the item carrying a recognized metadata shape survives"
    );
  });
});
