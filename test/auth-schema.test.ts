import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import {
  loadTokens,
  loadSessionInfo,
  saveTokens,
  saveSessionInfo,
  hasSavedTokens,
  StorageError,
  validateTokenData,
  validateSessionInfo,
  ensureConfigDir,
  __resetTestHooks,
  __setInsecureOwnerHook,
  type TokenData,
  type SessionInfo,
} from "../src/auth.js";

function makeTokens(overrides: Partial<TokenData> = {}): TokenData {
  return {
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-token",
    expires_at: Date.now() + 3_600_000,
    token_type: "Bearer",
    account_id: "synthetic-account",
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    email: "user@example.com",
    username: "synthetic-user",
    account_id: "synthetic-account",
    saved_at: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * All B3 tests run against isolated tmpdirs — never against the real
 * ~/.strider of the user running the suite. Each test relocates $HOME via
 * process.env.HOME (os.homedir() resolves per call).
 */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "b3-fake-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = prev;
    await import("node:fs/promises").then((fsp) => fsp.rm(home, { recursive: true, force: true }));
  }
}

// Tests run sequentially — the HOME relocation trick is shared state, and
// node:test executes sibling tests in parallel by default.
describe("B3: persisted auth schema validation", { runInParallel: false }, () => {
  beforeEach(() => {
    __resetTestHooks();
  });

  // ---------------------------------------------------------------------------
  // Unit-level evidence: the pure validators classify every structural case
  // ---------------------------------------------------------------------------

  // 1. valid token document is accepted
  test("B3: structurally valid token document is accepted", () => {
    const t = validateTokenData(makeTokens());
    assert.equal(t.access_token, "synthetic-access-token");
    assert.equal(t.token_type, "Bearer");
  });

  // 2. expired-but-structurally-valid token stays VALID (not corruption)
  test("B3: expired token (plausible timestamp) is NOT corruption", () => {
    const t = validateTokenData(makeTokens({ expires_at: 1_700_000_000_000 }));
    assert.equal(t.expires_at, 1_700_000_000_000);
  });

  // 3. malformed JSON is classified by the load path (production test below)
  // — unit side: an object parsed fine but structurally wrong is covered here.

  // 4. top-level null is rejected
  test("B3: top-level null is rejected", () => {
    assert.throws(
      () => validateTokenData(null),
      (err: unknown) =>
        err instanceof StorageError &&
        err.state === "CORRUPT_SESSION" &&
        /not a JSON object/.test(err.message)
    );
  });

  // 5. top-level array is rejected
  test("B3: top-level array is rejected", () => {
    assert.throws(
      () => validateTokenData([]),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 6. string/number/bool top-level primitives are rejected
  test("B3: top-level string/number/bool primitives are rejected", async () => {
    for (const bad of ["not json", 42, true]) {
      assert.throws(
        () => validateTokenData(bad),
        (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
      );
    }
  });

  // 7. access_token missing
  test("B3: access_token absent → CORRUPT_SESSION", () => {
    const { access_token: _at, ...rest } = makeTokens();
    assert.throws(
      () => validateTokenData(rest),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 8. access_token wrong type
  test("B3: access_token with wrong type (number/array/empty) → CORRUPT_SESSION", () => {
    const bad = [
      makeTokens({ access_token: 123 as never }),
      makeTokens({ access_token: "" as never }),
      makeTokens({ access_token: [] as never }),
    ];
    for (const doc of bad) {
      assert.throws(
        () => validateTokenData(doc),
        (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
      );
    }
  });

  // 9. refresh_token missing
  test("B3: refresh_token absent → CORRUPT_SESSION", () => {
    const { refresh_token: _rt, ...rest } = makeTokens();
    assert.throws(
      () => validateTokenData(rest),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 10. refresh_token wrong type
  test("B3: refresh_token with wrong type → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateTokenData(makeTokens({ refresh_token: 0 as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 11. expires_at missing
  test("B3: expires_at absent → CORRUPT_SESSION", () => {
    const { expires_at: _ea, ...rest } = makeTokens();
    assert.throws(
      () => validateTokenData(rest),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 12. expires_at string
  test("B3: expires_at as string (e.g. 'tomorrow') → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateTokenData(makeTokens({ expires_at: "tomorrow" as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 13. expires_at NaN/Infinity (exercised directly on the validator)
  test("B3: expires_at NaN/Infinity → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateTokenData(makeTokens({ expires_at: NaN as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
    assert.throws(
      () => validateTokenData(makeTokens({ expires_at: Infinity as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 14. expires_at below the contracted magnitude
  test("B3: expires_at below 1e12 → CORRUPT_SESSION (structural, not temporal)", () => {
    assert.throws(
      () => validateTokenData(makeTokens({ expires_at: 999_999_999 })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
    // Zero and negatives are also structural nonsense.
    assert.throws(
      () => validateTokenData(makeTokens({ expires_at: 0 })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 15. expires_at above the contracted magnitude
  test("B3: expires_at above 1e16 → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateTokenData(makeTokens({ expires_at: 1e17 })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 16. token_type absent/wrong type
  test("B3: token_type absent or wrong type → CORRUPT_SESSION", () => {
    const missing = makeTokens();
    delete (missing as Record<string, unknown>).token_type;
    assert.throws(
      () => validateTokenData(missing),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
    assert.throws(
      () => validateTokenData(makeTokens({ token_type: null as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 17. account_id absent/wrong type
  test("B3: account_id absent or wrong type → CORRUPT_SESSION", () => {
    const missing = makeTokens();
    delete (missing as Record<string, unknown>).account_id;
    assert.throws(
      () => validateTokenData(missing),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
    assert.throws(
      () => validateTokenData(makeTokens({ account_id: {} as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 18. profile_id absent is allowed (optional)
  test("B3: profile_id absent is permitted (optional field)", () => {
    const { profile_id: _pid, ...rest } = makeTokens();
    const t = validateTokenData(rest);
    assert.equal(t.profile_id, undefined);
  });

  // 19. profile_id present with wrong type is rejected
  test("B3: profile_id with wrong type → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateTokenData(makeTokens({ profile_id: 42 as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
    assert.throws(
      () => validateTokenData(makeTokens({ profile_id: [] as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 20. valid session document is accepted
  test("B3: structurally valid session document is accepted", () => {
    const s = validateSessionInfo(makeSession());
    assert.equal(s.email, "user@example.com");
    assert.equal(s.saved_at, "2026-08-14T12:00:00.000Z");
  });

  // 21. session malformed JSON → classified by the load path (production tests below)

  // 22. session field with wrong type is rejected
  test("B3: session fields with wrong types → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateSessionInfo(makeSession({ email: 123 as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
    assert.throws(
      () => validateSessionInfo(makeSession({ username: "" as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
    assert.throws(
      () => validateSessionInfo(makeSession({ account_id: 1 as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
    assert.throws(
      () => validateSessionInfo(makeSession({ saved_at: 42 as never })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  test("B3: session email without '@' is rejected", () => {
    assert.throws(
      () => validateSessionInfo(makeSession({ email: "not-an-email" })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  test("B3-FIX-1: saved_at canonical ISO-8601 (UTC Z) is accepted", () => {
    const s = validateSessionInfo(
      makeSession({ saved_at: "2026-08-14T18:00:00.000Z" })
    );
    assert.equal(s.saved_at, "2026-08-14T18:00:00.000Z");
  });

  test("B3-FIX-1: saved_at ISO-8601 with explicit offset is accepted (policy: offset permitted)", () => {
    const s = validateSessionInfo(
      makeSession({ saved_at: "2026-08-14T18:00:00-03:00" })
    );
    assert.equal(s.saved_at, "2026-08-14T18:00:00-03:00");
  });

  test("B3-FIX-1: saved_at arbitrary non-ISO string → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateSessionInfo(makeSession({ saved_at: "not-a-timestamp" })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // Date.parse() accepts these English/RFC/numeric-looking formats by
  // runtime convenience; they are NOT strict ISO-8601 and must be rejected.
  test("B3-FIX-1: saved_at Date.parse-compatible non-ISO English date → CORRUPT_SESSION", () => {
    assert.ok(Number.isFinite(Date.parse("August 14, 2026")));
    assert.throws(
      () => validateSessionInfo(makeSession({ saved_at: "August 14, 2026" })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  test("B3-FIX-1: saved_at RFC-style string → CORRUPT_SESSION", () => {
    assert.ok(Number.isFinite(Date.parse("Thu, 14 Aug 2026 12:00:00 GMT")));
    assert.throws(
      () =>
        validateSessionInfo(
          makeSession({ saved_at: "Thu, 14 Aug 2026 12:00:00 GMT" })
        ),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  test("B3-FIX-1: saved_at numeric-looking date string → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateSessionInfo(makeSession({ saved_at: "08/14/2026" })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  test("B3-FIX-1: saved_at date-only (no time part) → CORRUPT_SESSION", () => {
    assert.throws(
      () => validateSessionInfo(makeSession({ saved_at: "2026-08-14" })),
      (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
    );
  });

  // 23. unknown-fields policy (design §8 verbatim: "Campo desconhecido |
  //     Tolerado + unknown_fields no diagnóstico"):
  //     accepted + reported BY NAME in unknown_fields; the typed object
  //     contains only known fields (discarded from the typed view).
  test("B3-FIX-1: unknown fields are tolerated + reported in unknown_fields (names only)", () => {
    const input = {
      ...makeTokens(),
      unknown_field: "present",
      another: 7,
      nested: { x: 1 },
    };
    const t = validateTokenData(input);
    assert.equal(t.access_token, "synthetic-access-token");
    assert.deepEqual(t.unknown_fields?.sort(), ["another", "nested", "unknown_field"]);
    // Known fields remain correctly available (same document, no drift).
    assert.equal(t.expires_at, input.expires_at);
    // The typed object never echoes the unknown values.
    assert.equal("unknown_field" in t, false);
    assert.equal("another" in t, false);
  });

  test("B3-FIX-1: session unknown fields tolerated + reported; no unknown value in the typed object", () => {
    const s = validateSessionInfo({ ...makeSession(), some_extra: "ok" });
    assert.equal(s.email, "user@example.com");
    assert.deepEqual(s.unknown_fields, ["some_extra"]);
    assert.equal("some_extra" in s, false);
  });

  // 24. versioning/legacy policy: no version field required (design:
  //     "Sem versionamento hoje; validar por campos presentes").
  test("B3: legacy documents without a version field are accepted", () => {
    // A document written by the current code has no version; a future
    // format might add one. Both must pass structural validation today.
    const legacy = makeTokens();
    assert.doesNotThrow(() => validateTokenData(legacy));
    const withVersion = { ...makeTokens(), version: 1 } as unknown as TokenData;
    const r = validateTokenData(withVersion);
    // version is an unknown field: tolerated and reported by name only.
    assert.deepEqual(r.unknown_fields, ["version"]);
    assert.equal("version" in r, false);
  });

  // ---------------------------------------------------------------------------
  // Production-path evidence: filesystem → B2 secure read → JSON.parse →
  // B3 schema validation → final outcome
  // ---------------------------------------------------------------------------

  async function plantFile(
    home: string,
    fileName: "tokens.json" | "session.json",
    content: string,
    mode = 0o600
  ): Promise<string> {
    const root = join(home, ".strider", "crunchyroll");
    await mkdir(join(home, ".strider"), { recursive: true, mode: 0o700 });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const f = join(root, fileName);
    await writeFile(f, content, { mode: 0o600 });
    if (mode !== 0o600) await chmod(f, mode);
    return f;
  }

  // 25. absent file stays absence (null), never corruption
  test("B3: absent tokens.json → null (absence), not corruption", async () => {
    await withFakeHome(async () => {
      const result = await loadTokens();
      assert.equal(result, null);
      const session = await loadSessionInfo();
      assert.equal(session, null);
    });
  });

  // 26. StorageError from B2 stays StorageError (never converted to corruption)
  test("B3: B2 security error stays INSECURE_OWNER, never corruption", async () => {
    const euid: number | undefined = process.getuid?.();
    if (euid === undefined) {
      console.log("# skip: UID not exposed on this platform");
      return;
    }
    await withFakeHome(async () => {
      // Directories must exist FIRST — the owner hook re-tags only existing
      // controlled paths (same sequence as the B2 owner-divergence test).
      await plantFile(process.env.HOME!, "tokens.json", JSON.stringify(makeTokens()));
      await __setInsecureOwnerHook(euid + 1);
      try {
        await assert.rejects(
          () => loadTokens(),
          (err: unknown) => err instanceof StorageError && err.state === "INSECURE_OWNER"
        );
      } finally {
        __resetTestHooks();
      }
    });
  });

  // 27. insecure directory is still refused by the B2 layer (B3 never runs)
  test("B3: 0755 config dir is still refused by B2 (read hardening intact)", async () => {
    await withFakeHome(async () => {
      const root = join(process.env.HOME!, ".strider", "crunchyroll");
      await mkdir(join(process.env.HOME!, ".strider"), { recursive: true, mode: 0o700 });
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o755);
      await assert.rejects(
        () => loadTokens(),
        (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
      );
    });
  });

  // 28. 0644 file is still refused by B2 (B3 never runs)
  test("B3: 0644 token file is still refused by B2 (B3 never sees it)", async () => {
    await withFakeHome(async () => {
      await plantFile(process.env.HOME!, "tokens.json", JSON.stringify(makeTokens()));
      const f = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
      await chmod(f, 0o644);
      await assert.rejects(
        () => loadTokens(),
        (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
      );
    });
  });

  // Production: malformed JSON → CORRUPT_SESSION, never silent null
  test("B3 production: malformed (truncated) JSON → CORRUPT_SESSION", async () => {
    await withFakeHome(async () => {
      await plantFile(process.env.HOME!, "tokens.json", '{"access_token":"a","refresh_token":"b"');
      await assert.rejects(
        () => loadTokens(),
        (err: unknown) =>
          err instanceof StorageError &&
          err.state === "CORRUPT_SESSION" &&
          /not valid JSON/.test(err.message)
      );
    });
  });

  test("B3 production: malformed session JSON → CORRUPT_SESSION", async () => {
    await withFakeHome(async () => {
      await plantFile(process.env.HOME!, "session.json", '{"email":');
      await assert.rejects(
        () => loadSessionInfo(),
        (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
      );
    });
  });

  // Production: structurally invalid documents surface CORRUPT_SESSION through
  // the real loadTokens/loadSessionInfo path (not just the validators).
  test("B3 production: top-level null / array / missing field surface CORRUPT_SESSION via loadTokens", async () => {
    await withFakeHome(async () => {
      for (const content of ["null", "[]", "{}"]) {
        await plantFile(process.env.HOME!, "tokens.json", content);
        await assert.rejects(
          () => loadTokens(),
          (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
        );
      }
    });
  });

  test("B3 production: field-type corruption surface CORRUPT_SESSION via loadTokens", async () => {
    await withFakeHome(async () => {
      await plantFile(
        process.env.HOME!,
        "tokens.json",
        JSON.stringify({
          access_token: 123,
          refresh_token: [],
          expires_at: "tomorrow",
          token_type: null,
          account_id: {},
        })
      );
      await assert.rejects(
        () => loadTokens(),
        (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
      );
    });
  });

  test("B3 production: session field-type corruption → CORRUPT_SESSION via loadSessionInfo", async () => {
    await withFakeHome(async () => {
      await plantFile(
        process.env.HOME!,
        "session.json",
        JSON.stringify({ email: 123, username: "", account_id: {}, saved_at: "garbage" })
      );
      await assert.rejects(
        () => loadSessionInfo(),
        (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
      );
    });
  });

  // Production: expired-but-valid document is accepted (VALID + EXPIRED for
  // the B4 state machine to classify — B3 must not call it corruption).
  test("B3 production: expired-but-structurally-valid token is loaded (VALID+EXPIRED semantics)", async () => {
    await withFakeHome(async () => {
      // 1_700_000_000_000 is inside 1e12..1e16 but long in the past.
      await plantFile(
        process.env.HOME!,
        "tokens.json",
        JSON.stringify(makeTokens({ expires_at: 1_700_000_000_000 }))
      );
      const tokens = await loadTokens();
      assert.ok(tokens);
      assert.equal(tokens.expires_at, 1_700_000_000_000);
      assert.equal(tokens.token_type, "Bearer");
    });
  });

  // Production: unknown fields are tolerated + reported by name on load
  // (design §8: "Tolerado + unknown_fields no diagnóstico"). The persisted
  // document keeps them (JSON is written as-is) but the typed object
  // exposes only known fields.
  test("B3-FIX-1 production: unknown fields in the file are tolerated and reported by name", async () => {
    await withFakeHome(async () => {
      await plantFile(
        process.env.HOME!,
        "tokens.json",
        JSON.stringify({ ...makeTokens(), legacy_note: "from an older client" })
      );
      const tokens = await loadTokens();
      assert.ok(tokens);
      assert.equal(tokens.access_token, "synthetic-access-token");
      assert.deepEqual(tokens.unknown_fields, ["legacy_note"]);
      assert.equal("legacy_note" in tokens, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Negative regression (item 14 of the brief)
  // ---------------------------------------------------------------------------

  test("B3 regression: {} is never treated as a valid token", async () => {
    await withFakeHome(async () => {
      await plantFile(process.env.HOME!, "tokens.json", "{}");
      await assert.rejects(
        () => loadTokens(),
        (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
      );
    });
  });

  test("B3 regression: plausible expired token is never auto-classified corrupt", async () => {
    const t = validateTokenData({
      access_token: "synthetic",
      refresh_token: "synthetic",
      expires_at: 1_700_000_000_000,
      token_type: "Bearer",
      account_id: "synthetic",
    });
    assert.equal(t.expires_at, 1_700_000_000_000);
  });

  // ---------------------------------------------------------------------------
  // Write-path: invalid input never serializes into the store (design
  // section 7: "o objeto deve passar pela validação do subgate B3 antes de
  // serializar; serializar dados inválidos persistiria corrupção").
  // ---------------------------------------------------------------------------

  test("B3: saveTokens refuses invalid input instead of persisting corruption", async () => {
    await withFakeHome(async () => {
      await assert.rejects(
        // Missing required refresh_token — must fail before any fs write.
        () => saveTokens({ access_token: "a", expires_at: 1_700_000_000_000, token_type: "Bearer", account_id: "a" } as never),
        (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
      );
      // And no tokens file was created.
      await assert.equal(await hasSavedTokens(), false);
    });
  });

  test("B3: saveSessionInfo refuses invalid input", async () => {
    await withFakeHome(async () => {
      await assert.rejects(
        () => saveSessionInfo({ email: "not-an-email" } as never),
        (err: unknown) => err instanceof StorageError && err.state === "CORRUPT_SESSION"
      );
    });
  });

  // Write-path happy cases must keep working end to end.
  test("B3: valid save→load round trip works end to end", async () => {
    await withFakeHome(async () => {
      await saveTokens(makeTokens());
      const loaded = await loadTokens();
      assert.ok(loaded);
      assert.equal(loaded.access_token, "synthetic-access-token");

      await saveSessionInfo(makeSession());
      const session = await loadSessionInfo();
      assert.ok(session);
      assert.equal(session.email, "user@example.com");
    });
  });

  // hasSavedTokens must NOT validate content: it stays a B2 presence check
  // (it never opens the file, so schema is irrelevant by design).
  test("B3: hasSavedTokens never inspects content (B2 presence contract preserved)", async () => {
    await withFakeHome(async () => {
      // A corrupt-but-secure file still reports presence = true; the
      // corruption only surfaces when the content is actually read.
      await plantFile(process.env.HOME!, "tokens.json", "NOT_JSON_AT_ALL");
      assert.equal(await hasSavedTokens(), true);
    });
  });
});
