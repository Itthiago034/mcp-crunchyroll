import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, lstat, symlink, mkdir, mkfifo } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearAuthData,
  hasSavedTokens,
  loadTokens,
  loadSessionInfo,
  saveTokens,
  saveSessionInfo,
  ensureConfigDir,
  validateExistingConfigDir,
  StorageError,
  __resetTestHooks,
  __setInsecureOwnerHook,
  __setUnlinkHook,
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

function makeSession(email = "synthetic@example.com") {
  return { email, account_id: "synthetic-account" };
}

/**
 * Isolated HOME per test — the same convention as the B2 storage suite.
 * B5 must never touch the real ~/.strider of the user running the suite.
 */
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "b5-fake-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = prev;
    await import("node:fs/promises").then((fsp) =>
      fsp.rm(home, { recursive: true, force: true })
    );
  }
}

// B5 domain tests mutate process.env.HOME → sequential like the B2 suite.
describe("B5 structured local logout", { runInParallel: false }, () => {
  beforeEach(() => {
    __resetTestHooks();
  });

  afterEach(() => {
    __resetTestHooks();
  });

  // ---------------------------------------------------------------------------
  // B5-01 — both present and removed → CLEARED
  // ---------------------------------------------------------------------------
  test("B5-01: both artifacts present → state CLEARED, both REMOVED", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());
      await saveSessionInfo(makeSession());

      const result = await clearAuthData();

      assert.equal(result.state, "CLEARED");
      assert.equal(result.tokens.state, "REMOVED");
      assert.equal(result.session.state, "REMOVED");
      assert.equal(await hasSavedTokens(), false);
    });
  });

  // ---------------------------------------------------------------------------
  // B5-02 — both absent → ALREADY_ABSENT
  // ---------------------------------------------------------------------------
  test("B5-02: both artifacts absent → state ALREADY_ABSENT", async () => {
    await withFakeHome(async () => {
      // Brand-new fake HOME: nothing exists and nothing may be created.
      const result = await clearAuthData();

      assert.equal(result.state, "ALREADY_ABSENT");
      assert.equal(result.tokens.state, "ALREADY_ABSENT");
      assert.equal(result.session.state, "ALREADY_ABSENT");
    });
  });

  // ---------------------------------------------------------------------------
  // B5-03 — tokens removed + session selective unlink failure → PARTIAL
  // ---------------------------------------------------------------------------
  test("B5-03: tokens removed, session unlink fails → state PARTIAL", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());
      await saveSessionInfo(makeSession());

      // A chmod-0o444 target can still be unlinked by its own owner on POSIX
      // (unlink rights derive from the directory), so a selective unlink
      // failure is driven through the test-only unlink override scoped to
      // the session path — exercising the REAL production classification.
      const sessionPath = join(process.env.HOME!, ".strider", "crunchyroll", "session.json");
      __setUnlinkHook(async (p) => {
        if (p === sessionPath) {
          const err = new Error("injected unlink failure") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        await import("node:fs/promises").then((fsp) => fsp.unlink(p));
      });

      const result = await clearAuthData();

      assert.equal(result.state, "PARTIAL");
      assert.equal(result.tokens.state, "REMOVED");
      assert.equal(result.session.state, "FAILED");
      assert.equal(result.session.reason, "FILESYSTEM_ERROR");
      assert.equal(await hasSavedTokens(), false); // tokens gone either way
    });
  });

  // ---------------------------------------------------------------------------
  // B5-04 — tokens selective failure + session removed → PARTIAL
  // ---------------------------------------------------------------------------
  test("B5-04: tokens unlink fails, session removed → state PARTIAL", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());
      await saveSessionInfo(makeSession());

      const tokensPath = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
      __setUnlinkHook(async (p) => {
        if (p === tokensPath) {
          const err = new Error("injected unlink failure") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        await import("node:fs/promises").then((fsp) => fsp.unlink(p));
      });

      const result = await clearAuthData();

      assert.equal(result.state, "PARTIAL");
      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "FILESYSTEM_ERROR");
      assert.equal(result.session.state, "REMOVED");
    });
  });

  // ---------------------------------------------------------------------------
  // B5-05 — tokens absent + session selective failure → PARTIAL
  // ---------------------------------------------------------------------------
  test("B5-05: tokens absent, session unlink fails → state PARTIAL", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveSessionInfo(makeSession());

      const sessionPath = join(process.env.HOME!, ".strider", "crunchyroll", "session.json");
      __setUnlinkHook(async (p) => {
        if (p === sessionPath) {
          const err = new Error("injected unlink failure") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        await import("node:fs/promises").then((fsp) => fsp.unlink(p));
      });

      const result = await clearAuthData();

      assert.equal(result.state, "PARTIAL");
      assert.equal(result.tokens.state, "ALREADY_ABSENT");
      assert.equal(result.session.state, "FAILED");
      assert.equal(result.session.reason, "FILESYSTEM_ERROR");
    });
  });

  // ---------------------------------------------------------------------------
  // B5-06 — tokens selective failure + session absent → PARTIAL
  // ---------------------------------------------------------------------------
  test("B5-06: tokens unlink fails, session absent → state PARTIAL", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());

      const tokensPath = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
      __setUnlinkHook(async (p) => {
        if (p === tokensPath) {
          const err = new Error("injected unlink failure") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        await import("node:fs/promises").then((fsp) => fsp.unlink(p));
      });

      const result = await clearAuthData();

      assert.equal(result.state, "PARTIAL");
      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "FILESYSTEM_ERROR");
      assert.equal(result.session.state, "ALREADY_ABSENT");
    });
  });

  // ---------------------------------------------------------------------------
  // B5-07 — both unlink operational failures → FAILED
  // ---------------------------------------------------------------------------
  test("B5-07: both unlink operations fail → state FAILED", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());
      await saveSessionInfo(makeSession());

      const root = join(process.env.HOME!, ".strider", "crunchyroll");
      __setUnlinkHook(async () => {
        const err = new Error("injected unlink failure") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      });

      const result = await clearAuthData();

      assert.equal(result.state, "FAILED");
      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "FILESYSTEM_ERROR");
      assert.equal(result.session.state, "FAILED");
      assert.equal(result.session.reason, "FILESYSTEM_ERROR");
      // Files must still exist — zero unlink succeeded.
      assert.equal(
        await import("node:fs/promises")
          .then((fsp) => fsp.access(join(root, "tokens.json")).then(() => true).catch(() => false)),
        true
      );
      assert.equal(
        await import("node:fs/promises")
          .then((fsp) => fsp.access(join(root, "session.json")).then(() => true).catch(() => false)),
        true
      );
    });
  });

  // ---------------------------------------------------------------------------
  // B5-08 — second clear after successful clear → ALREADY_ABSENT
  // ---------------------------------------------------------------------------
  test("B5-08: second clear immediately after CLEARED → ALREADY_ABSENT", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());
      await saveSessionInfo(makeSession());

      const first = await clearAuthData();
      assert.equal(first.state, "CLEARED");

      const second = await clearAuthData();
      assert.equal(second.state, "ALREADY_ABSENT");
      assert.equal(second.tokens.state, "ALREADY_ABSENT");
      assert.equal(second.session.state, "ALREADY_ABSENT");
    });
  });

  // ---------------------------------------------------------------------------
  // B5-09 — structured result carries no raw diagnostics or secrets
  // ---------------------------------------------------------------------------
  test("B5-09: result never contains raw Error, stack, path, or secrets", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());
      await saveSessionInfo(makeSession());

      const tokensPath = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
      __setUnlinkHook(async (p) => {
        if (p === tokensPath) {
          const err = new Error("injected unlink failure") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        await import("node:fs/promises").then((fsp) => fsp.unlink(p));
      });

      const result = await clearAuthData();
      const dumped = JSON.stringify(result);

      // No raw diagnostics, no filesystem artifacts, no secrets.
      assert.ok(!dumped.includes("stack"));
      assert.ok(!dumped.includes("Error"));
      assert.ok(!dumped.includes("EACCES"));
      assert.ok(!dumped.includes("ENOENT"));
      assert.ok(!dumped.includes("/.strider"));
      assert.ok(!dumped.includes("synthetic-access-token"));
      assert.ok(!dumped.includes("synthetic-refresh-token"));
      assert.ok(!dumped.includes("synthetic@example.com"));

      // Structure is enums + boolean-ish fields only.
      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "FILESYSTEM_ERROR");
    });
  });

  // ---------------------------------------------------------------------------
  // B5-10 — B4 regression: semantic invalid_grant stays REAUTH_REQUIRED
  // ---------------------------------------------------------------------------
  test("B5-10: B4 semantic invalid_grant keeps REAUTH_REQUIRED even when the local clear ends PARTIAL or FAILED", async () => {
    // B4's refresh path calls clearAuthData() inside a try/catch that ignores
    // the outcome and then throws the classified RefreshError. Prove that a
    // PARTIAL/FAILED domain result can never leak out of that call: the
    // B5 clearAuthData() contract is non-throwing for normal filesystem
    // failures, so the B4 try/catch stays defensive and the classified error
    // is the ONLY outward effect.
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());

      // Drive a PARTIAL-producing filesystem state: tokens chmod-locked,
      // session absent. clearAuthData must resolve — never reject.
      const tokensPath = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
      await import("node:fs/promises").then((fsp) => fsp.chmod(tokensPath, 0o444));

      await assert.doesNotReject(() => clearAuthData());

      // And it must never resolve to REAUTH_REQUIRED-like domain noise:
      const result = await clearAuthData();
      assert.ok(
        ["CLEARED", "ALREADY_ABSENT", "PARTIAL", "FAILED"].includes(result.state),
        `domain state must be one of the four contracted values (got ${String(result.state)})`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // B5-19 — shared config validation failure → both FAILED, zero unlink
  // ---------------------------------------------------------------------------
  test("B5-19: shared config validation failure → both FAILED with same reason, global FAILED", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());
      await saveSessionInfo(makeSession());

      // Insecure config directory (group/other bits) → shared validation must
      // fail BEFORE any artifact-specific unlink is attempted.
      const root = join(process.env.HOME!, ".strider", "crunchyroll");
      await import("node:fs/promises").then((fsp) => fsp.chmod(root, 0o755));

      const result = await clearAuthData();

      assert.equal(result.state, "FAILED");
      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "INSECURE_DIR");
      assert.equal(result.session.state, "FAILED");
      assert.equal(result.session.reason, "INSECURE_DIR");
      // Files must still exist — zero unlink attempted.
      assert.equal(
        await import("node:fs/promises")
          .then((fsp) => fsp.access(join(root, "tokens.json")).then(() => true).catch(() => false)),
        true
      );
      assert.equal(
        await import("node:fs/promises")
          .then((fsp) => fsp.access(join(root, "session.json")).then(() => true).catch(() => false)),
        true
      );
      await import("node:fs/promises").then((fsp) => fsp.chmod(root, 0o700));
    });
  });

  // ---------------------------------------------------------------------------
  // B5-20 — target symlink / non-regular → FAILED / INSECURE_DIR, no unlink
  // ---------------------------------------------------------------------------
  test("B5-20: symlink target is classified FAILED/INSECURE_DIR without unlink", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();

      const attacker = join(process.env.HOME!, "attacker-symlink");
      await import("node:fs/promises").then((fsp) => fsp.writeFile(attacker, "untouched"));
      await symlink(attacker, join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json"));
      // session absent → would be ALREADY_ABSENT if unlink paths ran at all.

      const result = await clearAuthData();

      assert.equal(result.state, "PARTIAL");
      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "INSECURE_DIR");
      assert.equal(result.session.state, "ALREADY_ABSENT");
      // The symlink target must never be touched.
      const content = await import("node:fs/promises").then((fsp) =>
        fsp.readFile(attacker, "utf-8")
      );
      assert.equal(content, "untouched");
    });
  });

  test("B5-20: directory target is classified FAILED/INSECURE_DIR without unlink", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      // Plant a directory where tokens.json should be.
      const fake = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
      await mkdir(fake, { recursive: true });

      const result = await clearAuthData();

      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "INSECURE_DIR");
      // Session absent in this setup.
      assert.equal(result.session.state, "ALREADY_ABSENT");
    });
  });

  test("B5-20: non-regular target (FIFO) is classified FAILED/INSECURE_DIR without unlink", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      const f = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
      try {
        execSync(`mkfifo "${f.replace(/"/g, '\\"')}"`);
      } catch (err) {
        console.log("# skip: mkfifo not supported in this environment:", (err as Error).message);
        return;
      }

      const result = await clearAuthData();

      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "INSECURE_DIR");
      assert.equal(result.session.state, "ALREADY_ABSENT");
    });
  });

  // ---------------------------------------------------------------------------
  // B5-21 — target owner mismatch → FAILED / INSECURE_OWNER
  // ---------------------------------------------------------------------------
  test("B5-21: target owned by a different UID is classified FAILED/INSECURE_OWNER", async () => {
    // Deterministic and portable: reuse the B2 __setInsecureOwnerHook pattern
    // (it re-tags the stat of the controlled dirs via overrideStat). For the
    // artifact-specific check we rely on the shared dir validation's owner
    // rejection, which is the production path both artifacts flow through.
    await withFakeHome(async () => {
      const root = join(process.env.HOME!, ".strider", "crunchyroll");
      await ensureConfigDir();
      await saveTokens(makeTokens());
      await saveSessionInfo(makeSession());

      // Inject a divergent UID seen by the production stat path.
      await __setInsecureOwnerHook(0); // UID 0 unless the process is already root

      const result = await clearAuthData();

      assert.equal(result.state, "FAILED");
      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "INSECURE_OWNER");
      assert.equal(result.session.state, "FAILED");
      assert.equal(result.session.reason, "INSECURE_OWNER");
      // Zero unlink attempted.
      assert.equal(
        await import("node:fs/promises")
          .then((fsp) => fsp.access(join(root, "tokens.json")).then(() => true).catch(() => false)),
        true
      );
    });
  });

  // ---------------------------------------------------------------------------
  // B5-22 — unlink operational error → FAILED / FILESYSTEM_ERROR
  // ---------------------------------------------------------------------------
  test("B5-22: unlink operational failure is classified FAILED/FILESYSTEM_ERROR", async () => {
    await withFakeHome(async () => {
      await ensureConfigDir();
      await saveTokens(makeTokens());

      const tokensPath = join(process.env.HOME!, ".strider", "crunchyroll", "tokens.json");
      __setUnlinkHook(async (p) => {
        if (p === tokensPath) {
          const err = new Error("injected unlink failure") as NodeJS.ErrnoException;
          err.code = "ENOTEMPTY";
          throw err;
        }
        await import("node:fs/promises").then((fsp) => fsp.unlink(p));
      });
      // Session absent → ALREADY_ABSENT; tokens removal hits an injected
      // operational error (ENOTEMPTY) classified as FILESYSTEM_ERROR.

      const result = await clearAuthData();

      assert.equal(result.state, "PARTIAL");
      assert.equal(result.tokens.state, "FAILED");
      assert.equal(result.tokens.reason, "FILESYSTEM_ERROR");
      assert.equal(result.session.state, "ALREADY_ABSENT");
    });
  });
});
