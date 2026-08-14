import { constants, promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import { homedir } from "os";
import { join, basename } from "path";
import { randomBytes } from "crypto";

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp ms
  token_type: string;
  account_id: string;
  profile_id?: string;
}

export interface SessionInfo {
  email?: string;
  username?: string;
  account_id?: string;
  saved_at?: string;
}

/** Filesystem-layer errors surfaced by the hardened storage primitives. */
export class StorageError extends Error {
  constructor(
    public readonly state: "INSECURE_DIR" | "INSECURE_OWNER" | "FILESYSTEM_ERROR",
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** Mode constants — kept private to avoid exposing absolute paths. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const GROUP_OTHER_MASK = 0o077;

// ---------------------------------------------------------------------------
// Directory contract
// ---------------------------------------------------------------------------

export function getConfigDir(): string {
  return join(homedir(), ".strider", "crunchyroll");
}

function parentConfigDir(): string {
  return join(homedir(), ".strider");
}

// Paths are recomputed per call (never cached at import time) so that
// consumers who relocate the config dir — or tests that relocate $HOME —
// always resolve against the current homedir.
function tokenFilePath(): string {
  return join(getConfigDir(), "tokens.json");
}
function sessionFilePath(): string {
  return join(getConfigDir(), "session.json");
}

const TEMP_PREFIX = ".strider-mcp-";

/**
 * Check whether `fs.constants.O_NOFOLLOW` is available. POSIX runtimes expose
 * it; on non-POSIX platforms (e.g. some older Windows builds) the fallback is
 * the lstat-based symlink chain validation implemented below.
 */
export function hasOnofollow(): boolean {
  return typeof (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW === "number";
}

/**
 * Recursively validate, bottom-up, that no component of the given path is a
 * symlink. Returns the chain of lstat results. A TOCTOU residual remains — it
 * is impossible to eliminate all path-component races using only portable
 * Node.js primitives; O_NOFOLLOW on the target open narrows the window for the
 * final component, but a race between lstat and open/rename is not fully
 * closed. This is documented, not claimed away.
 */
async function lstatChain(targetPath: string): Promise<string[]> {
  const symlinks: string[] = [];
  // Walk upward: start at the target, then each ancestor until the root.
  let current = targetPath;
  // Protect against runaway loops with a bounded depth based on path segments.
  const depthLimit = current.split("/").length + 8;
  let depth = 0;
  while (depth < depthLimit) {
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") break; // missing component — not a symlink
      throw e;
    }
    if (stat.isSymbolicLink()) symlinks.push(current);
    const parent = join(current, "..");
    if (parent === current) break; // reached filesystem root
    current = parent;
    depth++;
  }
  return symlinks;
}

/**
 * Verify a directory that will hold sensitive files: mode must be at most
 * DIR_MODE (no group/other bits), and the owner must be the effective UID of
 * this process where the OS exposes it. Never silently fixes an insecure
 * directory — the operator decides.
 */
async function assertSecureDir(dir: string): Promise<void> {
  const stat = await fs.stat(dir);

  if (stat.mode & GROUP_OTHER_MASK) {
    throw new StorageError(
      "INSECURE_DIR",
      `config directory has group/other permission bits set; refusing to use or modify it`
    );
  }

  // UID verification: only meaningful when the runtime can report ownership.
  const effectiveUid: number | undefined = process.getuid?.();
  if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
    throw new StorageError(
      "INSECURE_OWNER",
      `config directory is owned by a different UID (${stat.uid}) than this process (${effectiveUid}); refusing to use it`
    );
  }
}

/**
 * Hardened directory creation/verification for ~/.strider and its subdirectory.
 * - New directories: created with DIR_MODE, followed by an explicit chmod
 *   (defense in depth; the umask may have widened the initial mode).
 * - Existing directories: validated against the contract; an insecure
 *   directory is REFUSED, never silently repaired.
 */
export async function ensureConfigDir(): Promise<void> {
  const dirs = [parentConfigDir(), getConfigDir()];
  for (const dir of dirs) {
    try {
      const stat = await fs.stat(dir);
      // Existing directory — enforce the contract, never fix silently.
      if (!stat.isDirectory()) {
        throw new StorageError(
          "INSECURE_DIR",
          `${basename(dir)} exists but is not a directory; refusing to use it`
        );
      }
      await assertSecureDir(dir);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw new StorageError("FILESYSTEM_ERROR", `filesystem error while accessing config directory`, e);
      }
      // Does not exist — create with restrictive mode and chmod explicitly.
      try {
        await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
      } catch (mkdirErr) {
        throw new StorageError("FILESYSTEM_ERROR", `filesystem error while creating config directory`, mkdirErr);
      }
      // Explicit chmod: mkdir mode may have been widened by the umask.
      try {
        await fs.chmod(dir, DIR_MODE);
      } catch (chmodErr) {
        throw new StorageError("FILESYSTEM_ERROR", `filesystem error while setting config directory mode`, chmodErr);
      }
      // Re-verify the created directory (owner + mode), including the fresh
      // symlink-chain check on the path we are about to write into.
      await assertSecureDir(dir);
      const symlinks = await lstatChain(dir);
      if (symlinks.length > 0) {
        throw new StorageError(
          "INSECURE_DIR",
          `config directory path contains an unexpected symlink; refusing to use it`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic write primitive
// ---------------------------------------------------------------------------

/**
 * Open a path with O_EXCL-ish semantics ("wx") plus restrictive mode. When
 * O_NOFOLLOW is available it is combined so the open fails with ELOOP if the
 * target is a symlink; otherwise we rely on the pre-open lstat chain.
 */
async function openExclusive(target: string): Promise<FileHandle> {
  // "wx" = O_WRONLY | O_CREAT | O_EXCL = 0o1101; combined with O_NOFOLLOW
  // (0o200000) when the runtime exposes it so the open fails with ELOOP if the
  // target is a symlink, before any data is written.
  const flags = hasOnofollow()
    ? ((constants as { O_NOFOLLOW: number }).O_NOFOLLOW | 0o1101)
    : 0o1101;
  return fs.open(target, flags, FILE_MODE);
}

/**
 * Write `value` atomically: serialize → same-directory temp → exclusive open
 * with 0o600 → full write → file fsync → close → rename over the target.
 *
 * On failure before rename the previous file stays intact; the temp file is
 * removed in `finally` whenever it is safe to do so. Errors such as ENOSPC,
 * EACCES and EROFS propagate structurally and are never masked.
 *
 * Directory fsync is deliberately NOT implemented in this subgate.
 */
export async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  // 1. serialize — malformed input surfaces as a plain serialization error,
  //    leaving both the old target and any cleanup semantics untouched.
  const content = JSON.stringify(value, null, 2) + "\n";

  const configDir = join(targetPath, "..");

  // 2. temp file inside the same config dir (same filesystem, same owner).
  const tempName = `${TEMP_PREFIX}${basename(targetPath, ".json")}-${Date.now()}-${randomBytes(8).toString("hex")}.tmp`;
  const tempPath = join(configDir, tempName);

  let handle: FileHandle | undefined;
  let tempCreated = false;
  try {
    // 3. exclusive create with restrictive mode (and O_NOFOLLOW when present).
    try {
      handle = await openExclusive(tempPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ELOOP") {
        throw new StorageError(
          "INSECURE_DIR",
          `storage target path is a symlink; refusing to write through it`
        );
      }
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while creating temp storage file`, e);
    }
    tempCreated = true;

    // 4. write complete content.
    try {
      await handle.writeFile(content, { encoding: "utf-8" });
    } catch (err) {
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while writing temp storage file`, err);
    }

    // 5. fsync the file (prevents crash-induced partial persistence).
    try {
      await handle.sync();
    } catch (err) {
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while syncing temp storage file`, err);
    }

    // 6. close before rename.
    await handle.close();
    handle = undefined;

    // 7. atomic rename over the target.
    try {
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EXDEV") {
        // Cross-device rename would indicate the temp drifted filesystems —
        // should be impossible since temp lives next to the target.
        throw new StorageError("FILESYSTEM_ERROR", `cross-device rename not supported for atomic storage write`, e);
      }
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while finalizing atomic storage write`, e);
    }
    tempCreated = false; // ownership transferred to the target; nothing to clean.
  } finally {
    if (handle) {
      // Best-effort close on the failure path; ignore errors to let the
      // original error propagate.
      await handle.close().catch(() => undefined);
    }
    // 9. remove the temp file when it still exists and it is safe (our own
    //    prefix only, never a broad glob; a concurrent writer using our own
    //    prefix in a way that races rename would be our own process).
    if (tempCreated) {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  }
}

/**
 * Pre-write symlink validation for the target file: refuse if the final path
 * is a symlink. Combined with O_NOFOLLOW on the temp open, this covers both
 * the explicit-check branch and the constant-available branch; on platforms
 * without O_NOFOLLOW the lstat chain is the only defense and is documented as
 * such.
 */
async function assertNotSymlink(targetPath: string): Promise<void> {
  // The final target itself must never be a symlink, regardless of whether the
  // runtime exposes O_NOFOLLOW: that flag only protects the exclusive temp
  // open, not a pre-existing symlink sitting at the credential file path.
  try {
    const targetStat = await fs.lstat(targetPath);
    if (targetStat.isSymbolicLink()) {
      throw new StorageError(
        "INSECURE_DIR",
        `storage target path is a symlink; refusing to write through it`
      );
    }
  } catch (err) {
    if (err instanceof StorageError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while validating storage target`, e);
    }
    // ENOENT — target does not exist yet; validate the ancestor chain when
    // O_NOFOLLOW is unavailable, since the temp-file defense cannot cover it.
    if (!hasOnofollow()) {
      const symlinks = await lstatChain(targetPath);
      if (symlinks.length > 0) {
        throw new StorageError(
          "INSECURE_DIR",
          `storage target path contains a symlink and O_NOFOLLOW is unavailable; refusing to write`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API (exports preserved — compatibility with the rest of the project)
// ---------------------------------------------------------------------------

export async function saveTokens(tokens: TokenData): Promise<void> {
  await ensureConfigDir();
  await assertNotSymlink(tokenFilePath());
  await atomicWriteJson(tokenFilePath(), tokens);
}

export async function loadTokens(): Promise<TokenData | null> {
  try {
    const data = await fs.readFile(tokenFilePath(), "utf-8");
    return JSON.parse(data) as TokenData;
  } catch {
    return null;
  }
}

export async function saveSessionInfo(info: SessionInfo): Promise<void> {
  await ensureConfigDir();
  await assertNotSymlink(sessionFilePath());
  await atomicWriteJson(sessionFilePath(), { ...info, saved_at: new Date().toISOString() });
}

export async function loadSessionInfo(): Promise<SessionInfo | null> {
  try {
    const data = await fs.readFile(sessionFilePath(), "utf-8");
    return JSON.parse(data) as SessionInfo;
  } catch {
    return null;
  }
}

/**
 * Clear persisted auth data. Removal failures surface as a structured
 * StorageError (EACCES/EROFS are never masked as success); this is a
 * deliberate behavioral change over the previous best-effort variant and is
 * required for reliable logout semantics.
 */
export async function clearAuthData(): Promise<void> {
  const targets = [tokenFilePath(), sessionFilePath()];
  for (const target of targets) {
    try {
      await fs.unlink(target);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Absence is idempotent success.
      if (e.code === "ENOENT") continue;
      if (e.code === "EACCES" || e.code === "EROFS" || e.code === "EPERM") {
        throw new StorageError("FILESYSTEM_ERROR", `filesystem error while removing ${basename(target)}`, e);
      }
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while removing ${basename(target)}`, e);
    }
  }
}

export async function hasSavedTokens(): Promise<boolean> {
  try {
    await fs.access(tokenFilePath());
    return true;
  } catch {
    return false;
  }
}

export function isTokenExpired(tokens: TokenData): boolean {
  return Date.now() >= tokens.expires_at - 60_000; // 1 min buffer
}
