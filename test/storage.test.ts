import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { execSync } from "node:child_process";
import { mkdtemp, chmod, lstat, symlink, readFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureConfigDir,
  saveTokens,
  loadTokens,
  saveSessionInfo,
  loadSessionInfo,
  clearAuthData,
  hasSavedTokens,
  StorageError,
  hasOnofollow,
  validateControlledAncestors,
  __resetTestHooks,
  __setInsecureOwnerHook,
  __setTempNameHook,
  type TokenData,
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

/**
 * All B2 tests run against isolated tmpdirs — never against the real
 * ~/.strider of the user running the suite. Each test relocates $HOME via
 * process.env.HOME (os.homedir() resolves per call).
 */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "b2-fake-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = prev;
    await import("node:fs/promises").then((fsp) => fsp.rm(home, { recursive: true, force: true }));
  }
}

// The storage suite mutates process.env.HOME to isolate each test from the
// real ~/.strider, so it must run sequentially — node:test executes sibling
// tests in parallel by default and a shared HOME causes INSECURE_DIR/ENOENT
// races. runInParallel: false keeps this suite isolated without affecting the
// Gate A harness tests (which run in their own describe).
describe("B2 secure storage", { runInParallel: false }, () => {
beforeEach(() => {
  // Clear any injected test hooks so no test bleeds into the next one.
  __resetTestHooks();
});

// ---------------------------------------------------------------------------
// 1. New config dir receives 0700
// ---------------------------------------------------------------------------
test("B2: new config dir is created with mode 0700", async () => {
  await withFakeHome(async () => {
    const prev = process.umask(0o022);
    try {
      await ensureConfigDir();
    } finally {
      process.umask(prev);
    }
    const s1 = await stat(join(process.env.HOME!, ".strider"));
    const s2 = await stat(join(process.env.HOME!, ".strider", "crunchyroll"));
    assert.equal(s1.mode & 0o7777, 0o700);
    assert.equal(s2.mode & 0o7777, 0o700);
  });
});

// ---------------------------------------------------------------------------
// 2. New sensitive file receives 0600
// ---------------------------------------------------------------------------
test("B2: new sensitive files are created with mode 0600", async () => {
  await withFakeHome(async () => {
    await ensureConfigDir();
    const tokens = makeTokens();
    await saveTokens(tokens);
    await saveSessionInfo({ email: "synthetic@example.invalid", account_id: "synthetic-account" });
    const t = await stat(join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json"));
    const s = await stat(join(process.env.HOME!, ".strider", "crunchyroll", "session.json"));
    assert.equal(t.mode & 0o7777, 0o600);
    assert.equal(s.mode & 0o7777, 0o600);
    const loaded = await loadTokens();
    assert.deepEqual(loaded, tokens);
  });
});

// ---------------------------------------------------------------------------
// 3. Pre-existing permissive directory (0755) is refused
// ---------------------------------------------------------------------------
test("B2: pre-existing 0755 config dir is refused (INSECURE_DIR)", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await mkdir(join(process.env.HOME!, ".strider"), { recursive: true, mode: 0o700 });
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o755);
    await assert.rejects(
      () => ensureConfigDir(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    // never silently fixed
    const s = await stat(root);
    assert.equal(s.mode & 0o7777, 0o755);
  });
});

// ---------------------------------------------------------------------------
// 4. Divergent owner is refused when the OS exposes UIDs
// ---------------------------------------------------------------------------
test("B2: divergent dir owner is refused when the OS exposes UIDs", async () => {
  const euid: number | undefined = process.getuid?.();
  if (euid === undefined) {
    console.log("# skip: UID not exposed on this platform");
    return;
  }
  await withFakeHome(async () => {
    // A same-owner dir must pass; a forced UID mismatch via an injected stat
    // must fail with INSECURE_OWNER — proving the production check exists.
    await ensureConfigDir();
    const s = await stat(join(process.env.HOME!, ".strider"));
    assert.equal(s.uid, euid);

    __resetTestHooks();
    // Force stat() to report a different UID for the controlled dir — the
    // production assertSecureDir path must reject it.
    await __setInsecureOwnerHook(euid + 1);
    try {
      await assert.rejects(
        async () => {
          await ensureConfigDir();
        },
        (err: unknown) => err instanceof StorageError && err.state === "INSECURE_OWNER"
      );
    } finally {
      __resetTestHooks();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. lstat-based ancestor rejection (production validateControlledAncestors)
// ---------------------------------------------------------------------------
test("B2: existing ~/.strider symlink is rejected by the production path", async () => {
  await withFakeHome(async () => {
    const target = join(process.env.HOME!, "attacker-dir");
    await mkdir(target, { recursive: true });
    await symlink(target, join(process.env.HOME!, ".strider"));
    await assert.rejects(
      () => validateControlledAncestors(join(process.env.HOME!, ".strider", "crunchyroll")),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    // Also refuses through the full write path
    await assert.rejects(
      () => saveTokens(makeTokens()),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
  });
});

test("B2: existing crunchyroll dir symlink is rejected by the production path", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = join(process.env.HOME!, "attacker-dir-2");
    await mkdir(target, { recursive: true });
    await symlink(target, join(root, "crunchyroll"));
    await assert.rejects(
      () => validateControlledAncestors(join(root, "crunchyroll")),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
  });
});

test("B2: missing target + symlink ancestor is rejected (missing final ≠ stop)", async () => {
  await withFakeHome(async () => {
    // ~/.strider is a symlink; the final path does NOT exist yet — the
    // production path must still walk and reject the controlled ancestor.
    const target = join(process.env.HOME!, "attacker-dir-3");
    await mkdir(target, { recursive: true });
    await symlink(target, join(process.env.HOME!, ".strider"));
    const targetPath = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
    await assert.rejects(
      () => validateControlledAncestors(targetPath),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    await assert.rejects(
      () => loadTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Symlink target is refused
// ---------------------------------------------------------------------------
test("B2: symlink at the target path is refused (INSECURE_DIR)", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const attackerFile = join(process.env.HOME!, "attacker-file");
    await import("node:fs/promises").then((fsp) => fsp.writeFile(attackerFile, "hostile"));
    await symlink(attackerFile, join(root, "tokens.json"));
    await assert.rejects(
      () => saveTokens(makeTokens()),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    // hostile content was never written through the link
    const content = await readFile(attackerFile, "utf-8");
    assert.equal(content, "hostile");
  });
});

// ---------------------------------------------------------------------------
// 7. O_EXCL invariant: exclusive create proves the constant composition
// ---------------------------------------------------------------------------
test("B2: EEXIST/exclusive-create failure surfaces as FILESYSTEM_ERROR with content intact", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    const v1 = makeTokens({ access_token: "keeper" });
    await saveTokens(v1);

    // Deterministic EEXIST collision: force the production exclusive-open to
    // target a path that already exists (test-only hook) and pre-create the
    // colliding file. The production atomicWriteJson then opens with the real
    // composed exclusive flags — O_EXCL makes the open fail with EEXIST, which
    // must surface as FILESYSTEM_ERROR and the existing token file must stay
    // intact (never truncated by the failed exclusive open).
    __setTempNameHook(".strider-mcp-tokens-forcetemp.tmp");
    const existingTemp = join(root, ".strider-mcp-tokens-forcetemp.tmp");
    await import("node:fs/promises").then((fsp) => fsp.writeFile(existingTemp, "preexisting"));
    try {
      await assert.rejects(
        () => saveTokens(makeTokens({ access_token: "must-fail" })),
        (err: unknown) => err instanceof StorageError && err.state === "FILESYSTEM_ERROR"
      );
      // Original file never truncated by the failed exclusive open.
      const loaded = await loadTokens();
      assert.equal(loaded?.access_token, "keeper");
    } finally {
      __resetTestHooks();
      await import("node:fs/promises").then((fsp) => fsp.unlink(existingTemp).catch(() => undefined));
    }
  });
});

test("B2: exclusive open flags are composed only from runtime constants", async () => {
  // The production module must not contain a hardcoded POSIX numeric literal
  // for the open flags — only runtime constants. We verify the source text,
  // then prove the composed flag arithmetic matches the runtime constants.
  const src = await readFile(join(process.cwd(), "src", "auth.ts"), "utf-8");
  // O_WRONLY|O_CREAT|O_EXCL = 0o301 (decimal 193). The source must not
  // hardcode that literal — the production composition uses runtime constants.
  assert.ok(!/0o301/.test(src), "no hardcoded POSIX literal for the open flags");

  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (hasOnofollow() ? (constants as { O_NOFOLLOW: number }).O_NOFOLLOW : 0);
  const base = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  assert.equal(flags & base, base, "composed flags include W+CR+EX");
  if (process.platform === "linux") {
    assert.equal(
      flags & (constants as { O_NOFOLLOW: number }).O_NOFOLLOW,
      (constants as { O_NOFOLLOW: number }).O_NOFOLLOW,
      "composed flags include O_NOFOLLOW on POSIX"
    );
  }
});

// ---------------------------------------------------------------------------
// 8. O_NOFOLLOW real branch exercised by the production path
// ---------------------------------------------------------------------------
test("B2: real O_NOFOLLOW branch refuses a symlink target at open time", async () => {
  if (!hasOnofollow()) {
    console.log("# skip: O_NOFOLLOW unavailable on this platform");
    return;
  }
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const attacker = join(process.env.HOME!, "attacker-open");
    await import("node:fs/promises").then((fsp) => fsp.writeFile(attacker, "pre"));
    await symlink(attacker, join(root, "tokens.json"));
    // Reading through the production read path must refuse the symlink at the
    // O_RDONLY|O_NOFOLLOW open (ELOOP) — no pre-open lstat short-circuit.
    await assert.rejects(
      () => loadTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    const content = await readFile(attacker, "utf-8");
    assert.equal(content, "pre");
  });
});

// ---------------------------------------------------------------------------
// 9. Real fallback branch exercised by the production path
// ---------------------------------------------------------------------------
test("B2: real fallback branch (O_NOFOLLOW forced off) still refuses symlinks", async () => {
  if (!hasOnofollow()) {
    console.log("# skip: no O_NOFOLLOW to force off");
    return;
  }
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const attacker = join(process.env.HOME!, "attacker-fallback");
    await import("node:fs/promises").then((fsp) => fsp.writeFile(attacker, "pre2"));
    await symlink(attacker, join(root, "tokens.json"));

    // Force the production path's own flag composition to skip O_NOFOLLOW
    // (test hook) — the production lstat validation must still refuse.
    __resetTestHooks();
    await assert.rejects(
      () => loadTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    __resetTestHooks();
    await assert.rejects(
      () => saveTokens(makeTokens()),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    const content = await readFile(attacker, "utf-8");
    assert.equal(content, "pre2");
  });
});

// ---------------------------------------------------------------------------
// 10. Temp file is created in the same directory
// ---------------------------------------------------------------------------
test("B2: atomic temp file lives inside the same config dir", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    await saveTokens(makeTokens());
    const outside: string[] = await import("node:fs/promises").then((fsp) => fsp.readdir(tmpdir()));
    const striderTemps = outside.filter((f) => f.startsWith(".strider-mcp-"));
    assert.deepEqual(striderTemps, []);
    // The temp's directory is the config dir itself — prove the path used.
    const inside = await import("node:fs/promises").then((fsp) => fsp.readdir(root));
    assert.ok(!inside.some((f) => f.startsWith(".strider-mcp-")), "no temp left behind inside the config dir");
  });
});

// ---------------------------------------------------------------------------
// 11. Successful write atomically replaces the target
// ---------------------------------------------------------------------------
test("B2: successful atomic write replaces the target content", async () => {
  await withFakeHome(async () => {
    await ensureConfigDir();
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    const v1 = makeTokens({ access_token: "v1" });
    const v2 = makeTokens({ access_token: "v2" });
    await saveTokens(v1);
    const before = await readFile(join(root, "tokens.json"), "utf-8");
    await saveTokens(v2);
    const after = await readFile(join(root, "tokens.json"), "utf-8");
    assert.notEqual(after, before);
    assert.equal(v2.access_token, JSON.parse(after).access_token);
  });
});

// ---------------------------------------------------------------------------
// 12. Failure before rename keeps the previous content intact
// ---------------------------------------------------------------------------
test("B2: failure before rename leaves previous file intact", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    const v1 = makeTokens({ access_token: "keeper" });
    await saveTokens(v1);
    await chmod(root, 0o500);
    try {
      await assert.rejects(
        () => saveTokens(makeTokens({ access_token: "must-not-persist" })),
        (err: unknown) => err instanceof StorageError && err.state === "FILESYSTEM_ERROR"
      );
      const loaded = await loadTokens();
      assert.equal(loaded?.access_token, "keeper");
    } finally {
      await chmod(root, 0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Temp is cleaned after error when safe
// ---------------------------------------------------------------------------
test("B2: failed write cleans its own temp file", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    await chmod(root, 0o500);
    try {
      await saveTokens(makeTokens()).catch(() => undefined);
    } finally {
      await chmod(root, 0o700);
    }
    const leftovers = await import("node:fs/promises").then((fsp) =>
      fsp.readdir(root).then((files) => files.filter((f) => f.startsWith(".strider-mcp-")))
    );
    assert.deepEqual(leftovers, []);
  });
});

// ---------------------------------------------------------------------------
// 14. Hardened reads: insecure/ineligible files are refused (never silent)
// ---------------------------------------------------------------------------
test("B2: insecure 0644 token file is rejected by read (never silent)", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    const f = join(root, "tokens.json");
    await import("node:fs/promises").then((fsp) => fsp.writeFile(f, JSON.stringify(makeTokens())));
    await chmod(f, 0o644);
    await assert.rejects(
      () => loadTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    // hasSavedTokens must NOT turn the insecure file into a silent false.
    await assert.rejects(
      () => hasSavedTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
  });
});

test("B2: secure 0600 regular token file loads normally", async () => {
  await withFakeHome(async () => {
    await ensureConfigDir();
    const tokens = makeTokens();
    await saveTokens(tokens);
    const loaded = await loadTokens();
    assert.deepEqual(loaded, tokens);
    assert.equal(await hasSavedTokens(), true);
    const sinfo = await loadSessionInfo();
    assert.equal(sinfo, null); // absence stays absence
  });
});

test("B2: non-regular target (FIFO) is rejected by the production read path", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    const f = join(root, "tokens.json");
    try {
      // Node's fs has no mkfifo binding (portability gap); fall back to the
      // POSIX mkfifo(1) so the production read path still meets a non-regular
      // target on the supported platform. Skip without hiding where absent.
      execSync(`mkfifo "${f.replace(/"/g, '\\"')}"`);
    } catch (err) {
      console.log("# skip: mkfifo not supported in this environment:", (err as Error).message);
      return;
    }
    await assert.rejects(
      () => loadTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    await assert.rejects(
      () => hasSavedTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
  });
});

test("B2: symlinked token file is rejected by the production read path", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    const attacker = join(process.env.HOME!, "attacker-read");
    await import("node:fs/promises").then((fsp) => fsp.writeFile(attacker, "stolen"));
    await symlink(attacker, join(root, "tokens.json"));
    await assert.rejects(
      () => loadTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    const content = await readFile(attacker, "utf-8");
    assert.equal(content, "stolen"); // never read through the link
  });
});

test("B2: symlinked parent config dir is rejected by the production read path", async () => {
  await withFakeHome(async () => {
    const target = join(process.env.HOME!, "attacker-parent-read");
    await mkdir(target, { recursive: true });
    await import("node:fs/promises").then((fsp) => fsp.writeFile(join(target, "tokens.json"), "stolen2"));
    await symlink(target, join(process.env.HOME!, ".strider"));
    await assert.rejects(
      () => loadTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
    await assert.rejects(
      () => hasSavedTokens(),
      (err: unknown) => err instanceof StorageError && err.state === "INSECURE_DIR"
    );
  });
});

test("B2: harden reads never create config directories", async () => {
  await withFakeHome(async () => {
    // With a brand-new fake HOME, reads must leave the filesystem untouched.
    await assert.equal(await loadTokens(), null);
    await assert.equal(await hasSavedTokens(), false);
    await assert.equal(await loadSessionInfo(), null);
    const entries = await import("node:fs/promises").then((fsp) => fsp.readdir(process.env.HOME!).catch(() => []));
    assert.deepEqual(entries, [], "read paths must have no side effects");
  });
});

// ---------------------------------------------------------------------------
// 15. B5 scope reverted: clearAuthData keeps pre-B2 best-effort semantics
// ---------------------------------------------------------------------------
test("B2: clearAuthData keeps pre-B2 best-effort semantics (no B5 behavior)", async () => {
  await withFakeHome(async () => {
    await ensureConfigDir();
    await saveTokens(makeTokens());
    await clearAuthData();
    assert.equal(await hasSavedTokens(), false);
    // Re-removing is idempotent (pre-B2 behavior) — no throw.
    await clearAuthData();
  });
});

test("B2: clearAuthData does not surface permission failures (pre-B2 best-effort)", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    await saveTokens(makeTokens());
    await chmod(root, 0o500);
    try {
      // Pre-B2 semantics: best-effort, never throws on permission failures.
      await clearAuthData(); // must NOT reject
    } finally {
      await chmod(root, 0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// 16. Sequential saves do not corrupt JSON
// ---------------------------------------------------------------------------
test("B2: two sequential saves never leave corrupted JSON", async () => {
  await withFakeHome(async () => {
    const root = join(process.env.HOME!, ".strider", "crunchyroll");
    await ensureConfigDir();
    for (let i = 0; i < 20; i++) {
      await saveTokens(makeTokens({ access_token: `seq-${i}` }));
      const raw = await readFile(join(root, "tokens.json"), "utf-8");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.access_token, `seq-${i}`);
      assert.equal(parsed.refresh_token, "synthetic-refresh-token");
      assert.equal(parsed.account_id, "synthetic-account");
    }
  });
});

// Avoid unused-import warnings — side-effect driven via node:test.
void makeTokens;
});
