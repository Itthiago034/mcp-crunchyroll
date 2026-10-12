import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEpisodes, parseSeasons } from "../src/catalog-domain.js";
import { parseHistory } from "../src/account-domain.js";

const VERSIONS = [
  { audio_locale: "ja-JP", guid: "GE1JAJP", original: true, media_guid: "M1", roles: ["main"], season_guid: "S1" },
  { audio_locale: "pt-BR", guid: "GE1PTBR", original: false, media_guid: "M2", roles: ["dub"], season_guid: "S2" },
];

describe("season and episode lists are compact enough for small agents", () => {
  test("episodes keep identity, numbering, locales and versions, and drop images", () => {
    const { count, episodes } = parseEpisodes({
      data: [{
        id: "GE1ENUS", title: "Ep", episode_number: 12, episode: "12", season_number: 2,
        next_episode_id: "GE2ENUS", is_premium_only: true, availability_status: "available",
        images: { thumbnail: [[{ source: "https://example.invalid/x.png" }]] },
        maturity_ratings: ["14"], description: "long text", versions: VERSIONS,
      }],
    });
    assert.equal(count, 1);
    assert.deepEqual(episodes[0], {
      id: "GE1ENUS", title: "Ep", season_number: 2, episode: "12", episode_number: 12,
      is_premium_only: true, availability_status: "available", next_episode_id: "GE2ENUS",
      original_audio: "ja-JP",
      audio_versions: { "ja-JP": "GE1JAJP", "pt-BR": "GE1PTBR" },
    });
  });

  test("seasons keep number, title, episode count and versions", () => {
    const { seasons } = parseSeasons({
      data: [{ id: "GS1", title: "Clevatess II", season_number: 2, number_of_episodes: 13,
        images: {}, keywords: ["a"], versions: VERSIONS }],
    });
    const season = seasons[0] as Record<string, unknown>;
    assert.equal(season.title, "Clevatess II");
    assert.equal(season.number_of_episodes, 13);
    assert.equal("images" in season, false);
    assert.equal("keywords" in season, false);
    assert.deepEqual(season.audio_versions, { "ja-JP": "GE1JAJP", "pt-BR": "GE1PTBR" });
    assert.equal("versions" in season, false);
  });
});

describe("history is compact enough for small agents", () => {
  test("items keep resume data and episode identity, and drop the panel's bulk", () => {
    const { count, items } = parseHistory({
      data: [{
        id: "GE1PTBR", date_played: "2026-10-12T21:05:17Z", parent_id: "G8", parent_type: "series",
        playhead: 432, fully_watched: false,
        panel: {
          title: "Ep 12", type: "episode", images: { thumbnail: [[{ source: "x" }]] }, description: "long",
          episode_metadata: {
            series_title: "Clevatess", season_title: "Clevatess II", season_number: 2, episode_number: 12,
            maturity_ratings: ["14"], content_descriptors: ["a"], versions: VERSIONS,
          },
        },
      }],
    });
    assert.equal(count, 1);
    assert.deepEqual(items[0], {
      id: "GE1PTBR", date_played: "2026-10-12T21:05:17Z", parent_id: "G8", parent_type: "series",
      playhead: 432, fully_watched: false, title: "Ep 12", type: "episode",
      episode_metadata: {
        series_title: "Clevatess", season_title: "Clevatess II", season_number: 2, episode_number: 12,
        original_audio: "ja-JP",
        audio_versions: { "ja-JP": "GE1JAJP", "pt-BR": "GE1PTBR" },
      },
    });
  });
});

describe("response caps", () => {
  test("only the whole-season episode list raises the default response cap", async () => {
    const { PRODUCTION_OPERATIONS } = await import("../src/transport/operation-registry.js");
    const raised = PRODUCTION_OPERATIONS.filter((op) => op.maxResponseBytes !== undefined);
    assert.deepEqual(raised.map((op) => [String(op.id), op.maxResponseBytes]), [["GET_EPISODES", 4 * 1024 * 1024]]);
  });

  test("the registry keeps a declared cap and refuses an absurd one", async () => {
    const { createOperationRegistry, PRODUCTION_OPERATIONS } = await import("../src/transport/operation-registry.js");
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    assert.equal(registry.get("GET_EPISODES" as never)?.maxResponseBytes, 4 * 1024 * 1024);
    const episodes = PRODUCTION_OPERATIONS.find((op) => String(op.id) === "GET_EPISODES")!;
    assert.throws(() => createOperationRegistry([{ ...episodes, maxResponseBytes: 1e12 }]));
  });
});

describe("get_episodes episode_number filter", () => {
  test("returns only the requested episode and the season size; refuses a non-integer", async () => {
    const { createContentGateway } = await import("../src/transport/content-gateway.js");
    const { createTransportDispatcher } = await import("../src/transport/dispatcher.js");
    const { createOperationRegistry, PRODUCTION_OPERATIONS } = await import("../src/transport/operation-registry.js");
    const { FakeTransportBackend } = await import("./_fake-backend.js");
    const json = { data: [1, 2, 3].map((n) => ({ id: `GE${n}`, title: `E${n}`, episode_number: n })) };
    const backend = new FakeTransportBackend({ result: { status: 200, contentType: "application/json", json } as never });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const gateway = createContentGateway(createTransportDispatcher(registry, backend), registry);
    assert.deepEqual(await gateway.callTool("crunchyroll_get_episodes", { season_id: "GS1", episode_number: 2 }), {
      count: 1, season_episode_count: 3, episodes: [{ id: "GE2", title: "E2", episode_number: 2 }],
    });
    assert.equal(((await gateway.callTool("crunchyroll_get_episodes", { season_id: "GS1" })) as { count: number }).count, 3);
    await assert.rejects(gateway.callTool("crunchyroll_get_episodes", { season_id: "GS1", episode_number: "2" }));
  });
});
