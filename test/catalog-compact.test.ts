import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseEpisodes, parseSeasons } from "../src/catalog-domain.js";

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
      versions: [
        { audio_locale: "ja-JP", guid: "GE1JAJP", original: true },
        { audio_locale: "pt-BR", guid: "GE1PTBR", original: false },
      ],
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
    assert.deepEqual((season.versions as unknown[]).length, 2);
  });
});
