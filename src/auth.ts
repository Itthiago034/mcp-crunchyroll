import type { Stats } from "node:fs";
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
  /**
   * Names of unknown top-level fields that were tolerated on read (design
   * GATE-B-DESIGN.md §8: "Campo desconhecido | Tolerado + unknown_fields no
   * diagnóstico"). Never contains secret values — field names only.
   * @internal populated by validateTokenData
   */
  unknown_fields?: string[];
}

export interface SessionInfo {
  email?: string;
  username?: string;
  account_id?: string;
  saved_at?: string;
  /**
   * Names of unknown top-level fields that were tolerated on read (design
   * GATE-B-DESIGN.md §8: "Campo desconhecido | Tolerado + unknown_fields no
   * diagnóstico"). Never contains secret values — field names only.
   * @internal populated by validateSessionInfo
   */
  unknown_fields?: string[];
}

/** Filesystem-layer errors surfaced by the hardened storage primitives. */
export class StorageError extends Error {
  constructor(
    public readonly state: "INSECURE_DIR" | "INSECURE_OWNER" | "FILESYSTEM_ERROR" | "CORRUPT_SESSION",
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "StorageError";
  }
}

// ---------------------------------------------------------------------------
// Gate B3 — persisted-data schema validation (pure functions, no I/O)
// ---------------------------------------------------------------------------
// Structural (atemporal) validation of the documents read from / written to
// the hardened store. Design rules (GATE-B-DESIGN.md, section 8):
//   - expires_at is validated by MAGNITUDE only (1e12 <= v <= 1e16);
//     a structurally valid but time-expired token is NOT corruption.
//   - unknown fields are tolerated AND reported in unknown_fields
//     (design §8: "Campo desconhecido | Tolerado + unknown_fields no
//     diagnóstico"); field names only, never secret values.
//   - legacy documents without version remain readable (no version field is
//     required).
//   - missing required field / wrong type / absurd timestamp = CORRUPT_SESSION
//     with a diagnostic detail (no secret values echoed).
//   - Corrupted documents are never silently treated as "not logged in".

/** expires_at magnitude contract (timestamp ms). */
const EXPIRES_AT_MIN = 1e12;
const EXPIRES_AT_MAX = 1e16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  doc: Record<string, unknown>,
  field: string
): string | null {
  const v = doc[field];
  if (typeof v !== "string") return null;
  if (v.trim().length === 0) return null;
  return v;
}

/**
 * Pure structural validator for a tokens.json document. Throws
 * StorageError("CORRUPT_SESSION", ...) on any structural problem; returns a
 * properly typed TokenData on success. Unknown fields are tolerated.
 */
export function validateTokenData(value: unknown): TokenData {
  if (!isPlainObject(value)) {
    throw new StorageError(
      "CORRUPT_SESSION",
      `tokens.json is not a JSON object (top-level type: ${value === null ? "null" : typeof value})`
    );
  }

  const access_token = requireString(value, "access_token");
  if (access_token === null) {
    throw new StorageError("CORRUPT_SESSION", `tokens.json missing or invalid required field: access_token`);
  }

  const refresh_token = requireString(value, "refresh_token");
  if (refresh_token === null) {
    throw new StorageError("CORRUPT_SESSION", `tokens.json missing or invalid required field: refresh_token`);
  }

  const expiresRaw = value["expires_at"];
  if (typeof expiresRaw !== "number" || !Number.isFinite(expiresRaw)) {
    throw new StorageError(
      "CORRUPT_SESSION",
      `tokens.json missing or invalid required field: expires_at (got ${expiresRaw === undefined ? "nothing" : typeof expiresRaw})`
    );
  }
  if (expiresRaw < EXPIRES_AT_MIN || expiresRaw > EXPIRES_AT_MAX) {
    throw new StorageError(
      "CORRUPT_SESSION",
      `tokens.json expires_at is outside the contracted magnitude range (1e12..1e16): ${String(expiresRaw)}`
    );
  }

  const token_type = requireString(value, "token_type");
  if (token_type === null) {
    throw new StorageError("CORRUPT_SESSION", `tokens.json missing or invalid required field: token_type`);
  }

  const account_id = requireString(value, "account_id");
  if (account_id === null) {
    throw new StorageError("CORRUPT_SESSION", `tokens.json missing or invalid required field: account_id`);
  }

  if ("profile_id" in value) {
    const profile_id = value["profile_id"];
    if (typeof profile_id !== "string" || profile_id.trim().length === 0) {
      throw new StorageError("CORRUPT_SESSION", `tokens.json optional field profile_id has the wrong type or is empty`);
    }
  }

  // Unknown fields: tolerated and reported by name only (design §8:
  // "Campo desconhecido | Tolerado + unknown_fields no diagnóstico").
  const unknown_fields = unknownFieldNames(value, KNOWN_TOKEN_FIELDS);

  return {
    access_token,
    refresh_token,
    expires_at: expiresRaw,
    token_type,
    account_id,
    ...("profile_id" in value ? { profile_id: value["profile_id"] as string } : {}),
    ...(unknown_fields ? { unknown_fields } : {}),
  };
}

/** Known top-level tokens.json fields — unknown-field detection uses this list. */
const KNOWN_TOKEN_FIELDS = new Set([
  "access_token",
  "refresh_token",
  "expires_at",
  "token_type",
  "account_id",
  "profile_id",
]);

// ISO-8601 profile for saved_at (B3-FIX-1): the design says "ISO-8601
// parseável" without a sub-profile, so the policy is the minimal set
// compatible with the values actually produced by new Date().toISOString()
// (YYYY-MM-DDTHH:mm:ss.sssZ). The format is enforced by a strict regex —
// Date.parse() alone is NOT used, because it accepts runtime-dependent
// non-ISO formats (e.g. "August 14, 2026", "Thu, 14 Aug 2026 12:00:00 GMT").
//
// Accepted:
//   YYYY-MM-DDTHH:mm:ss[.fff]Z                     canonical with UTC Z
//   YYYY-MM-DDTHH:mm:ss[.fff]±HH:MM                canonical with offset
// Rejected (everything else, including Date.parse conveniences):
//   date-only, time-only, non-ISO English/RFC/numeric-looking strings.
// Offset is permitted because it is valid ISO-8601 and remains a full
// timestamp; Z is NOT forced (the design does not say "UTC only").
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Strict ISO-8601 timestamp validator for saved_at. */
function isStrictIso8601Timestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!ISO8601_RE.test(value)) return false;
  // Sanity ranges (calendar-plausible components, not temporal validity).
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (year < 1970 || year > 2999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 60) return false; // leap second tolerance
  const rest = value.slice(19);
  if (rest.startsWith(".")) {
    // fractional digits then timezone: already guaranteed by the regex.
  }
  // Date.parse sanity: any regex-passing value must also parse finitely.
  return Number.isFinite(Date.parse(value));
}

/**
 * Pure structural validator for a session.json document. Throws
 * StorageError("CORRUPT_SESSION", ...) on any structural problem; returns a
 * properly typed SessionInfo on success. Unknown fields are tolerated.
 */
export function validateSessionInfo(value: unknown): SessionInfo {
  if (!isPlainObject(value)) {
    throw new StorageError(
      "CORRUPT_SESSION",
      `session.json is not a JSON object (top-level type: ${value === null ? "null" : typeof value})`
    );
  }

  const out: SessionInfo = {};

  if ("email" in value) {
    const email = value["email"];
    if (typeof email !== "string" || !email.includes("@")) {
      throw new StorageError("CORRUPT_SESSION", `session.json optional field email has the wrong type or format (missing @)`);
    }
    out.email = email;
  }

  if ("username" in value) {
    const username = value["username"];
    if (typeof username !== "string" || username.trim().length === 0) {
      throw new StorageError("CORRUPT_SESSION", `session.json optional field username has the wrong type or is empty`);
    }
    out.username = username;
  }

  if ("account_id" in value) {
    const account_id = value["account_id"];
    if (typeof account_id !== "string" || account_id.trim().length === 0) {
      throw new StorageError("CORRUPT_SESSION", `session.json optional field account_id has the wrong type or is empty`);
    }
    out.account_id = account_id;
  }

  if ("saved_at" in value) {
    const saved_at = value["saved_at"];
    if (typeof saved_at !== "string") {
      throw new StorageError("CORRUPT_SESSION", `session.json optional field saved_at has the wrong type`);
    }
    if (!isStrictIso8601Timestamp(saved_at)) {
      throw new StorageError("CORRUPT_SESSION", `session.json optional field saved_at is not a strict ISO-8601 timestamp (accepted profile: YYYY-MM-DDTHH:mm:ss[.fff]Z or YYYY-MM-DDTHH:mm:ss[.fff]±HH:MM)`);
    }
    out.saved_at = saved_at;
  }

  // Unknown fields: tolerated and reported by name only (design §8:
  // "Campo desconhecido | Tolerado + unknown_fields no diagnóstico").
  out.unknown_fields = unknownFieldNames(value, KNOWN_SESSION_FIELDS);

  return out;
}

/** Known top-level session.json fields — unknown-field detection uses this list. */
const KNOWN_SESSION_FIELDS = new Set([
  "email",
  "username",
  "account_id",
  "saved_at",
]);

/**
 * Field names present in the document that are not part of the known schema.
 * Never contains values — names only (secrets must never be echoed in the
 * unknown_fields diagnostic).
 */
function unknownFieldNames(
  doc: Record<string, unknown>,
  known: Set<string>
): string[] | undefined {
  const names = Object.keys(doc).filter((key) => !known.has(key));
  if (names.length === 0) return undefined;
  return names;
}

/** Mode constants — kept private to avoid exposing absolute paths. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const GROUP_OTHER_MASK = 0o077;

// ---------------------------------------------------------------------------
// Internal test-only hooks
// ---------------------------------------------------------------------------
// Test-only dependency injection so the real production algorithm — flag
// composition, ancestor validation, open/read paths — can be exercised end to
// end without re-implementing it inside the tests. Not exported, never used by
// production call sites, and only ever driven by the test suite.
interface TestHooks {
  /** Force the flag composition to skip O_NOFOLLOW even when the runtime has it. */
  forceNoO_NOFOLLOW?: boolean;
  /** Override the lstat used by ancestor validation (tests inject failures). */
  overrideLstat?: (p: string) => Promise<Stats>;
  /** Override the stat used by assertSecureDir (tests inject divergent uid/mode). */
  overrideStat?: (p: string) => Promise<Stats>;
  /** Override the temp filename chosen by atomicWriteJson (deterministic collision tests). */
  overrideTempName?: string;
  /** Test-only observer called with the exact flags handed to fs.open. */
  observeOpenFlags?: (flags: number) => void;
}
let testHooks: TestHooks = {};

// ---------------------------------------------------------------------------
// Test seam — not part of the production API
// ---------------------------------------------------------------------------
// The functions below exist exclusively so the test suite can drive the REAL
// production paths (flag composition, ancestor validation, stat injection).
// They are named with a `__` test-only prefix and are NOT used by any
// production call site; proof that they never reach the published artifact is
// asserted by the bundle-surface test in test/storage.test.ts (no `__`
// symbol appears in dist/index.js). New hooks belong here only, never in the
// normal export region.

/** @internal test-only. Resets injected hooks between tests. */
export function __resetTestHooks(): void {
  testHooks = {};
}

/**
 * @internal test-only.
 * Override the stat used by assertSecureDir so it observes an injected uid.
 * The stat result for any other path stays real (production stat) — the test
 * only re-tags the reported ownership of the controlled directories, keeping
 * the mode/mtime/size from the actual filesystem.
 */
export async function __setInsecureOwnerHook(fakeUid: number): Promise<void> {
  const parent = parentConfigDir();
  const child = getConfigDir();
  const realStat = fs.stat;
  testHooks.overrideStat = async (p: string) => {
    if (p === parent || p === child) {
      const base = await realStat(p);
      // Clone the real stat but re-tag ownership; mode bits stay untouched.
      const result = Object.assign(base, { uid: fakeUid });
      return result;
    }
    return realStat(p);
  };
}

/**
 * @internal test-only.
 * Force atomicWriteJson to choose a fixed temp filename (inside the config
 * dir) on the next exclusive open. Combined with a pre-created file of the
 * same name, this drives the real production EEXIST path without the test
 * reimplementing the collision logic.
 */
export function __setTempNameHook(name: string): void {
  if (name !== basename(name) || name.includes("/")) {
    throw new Error("__setTempNameHook only accepts a bare filename");
  }
  testHooks.overrideTempName = name;
}

/**
 * @internal test-only.
 * Register an observer for the flags handed to fs.open by the production
 * openExclusive()/readCredentialFile() paths. The test asserts which O_NOFOLLOW
 * branch was actually executed instead of guessing from outcome alone.
 */
export function __observeOpenFlags(fn: (flags: number) => void): void {
  testHooks.observeOpenFlags = fn;
}

/**
 * @internal test-only.
 * Force the production flag composition to build its flags WITHOUT O_NOFOLLOW
 * even on runtimes that expose it — driving the REAL fallback branch that the
 * production path takes when O_NOFOLLOW is unavailable (POSIX-lstat chain).
 */
export function __forceNoO_NOFOLLOW(): void {
  testHooks.forceNoO_NOFOLLOW = true;
}

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
 * it; on non-POSIX platforms the fallback is the lstat-based symlink chain
 * validation implemented below.
 */
export function hasOnofollow(): boolean {
  return typeof (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW === "number";
}

/**
 * Validate, with lstat (never stat), that none of the controlled components of
 * the config path — ~/.strider and ~/.strider/crunchyroll — is a symlink.
 *
 * Contract:
 * - A missing final component (e.g. the crunchyroll dir itself is absent) does
 *   NOT stop the validation of its parents: a symlink at ~/.strider must be
 *   rejected even when the target path does not exist yet.
 * - A symlink anywhere in the controlled chain → INSECURE_DIR.
 * - Uncontrolled ancestors above ~/.strider are outside this boundary and are
 *   not traversed.
 */
export async function validateControlledAncestors(targetPath: string): Promise<void> {
  const parent = parentConfigDir();
  const child = getConfigDir();

  const controlled = [parent, child];
  // When the caller is a deeper path (a credential file inside the dir),
  // the dir itself is the relevant component; include both anyway so the
  // file-level check also covers a dir-component symlink.
  for (const dir of controlled) {
    const lstat = testHooks.overrideLstat ?? fs.lstat;
    let s;
    try {
      s = await lstat(dir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") continue; // missing — validated when created
      throw new StorageError(
        "FILESYSTEM_ERROR",
        `filesystem error while validating config ancestor ${basename(dir)}`,
        e
      );
    }
    if (s.isSymbolicLink()) {
      throw new StorageError(
        "INSECURE_DIR",
        `config ancestor ${basename(dir)} is a symlink; refusing to use it`
      );
    }
  }
  void targetPath;
}

/**
 * Validation of an EXISTING config directory without creation or repair.
 *
 * Checks ~/.strider and ~/.strider/crunchyroll with lstat (never stat, never
 * following symlinks) and confirms, for each existing component:
 * - not a symlink;
 * - is a directory;
 * - no group/other bits are set (0700 contract);
 * - owner equals the effective UID of this process, where exposed.
 *
 * No mkdir, no chmod — this primitive only OBSERVES.
 *
 * Semantics:
 * - missing component → "absence" (return undefined, do not treat as error);
 * - symlink        → StorageError(INSECURE_DIR);
 * - insecure mode  → StorageError(INSECURE_DIR);
 * - divergent owner→ StorageError(INSECURE_OWNER);
 * - other FS error → StorageError(FILESYSTEM_ERROR);
 *
 * Used by the hardened READ paths (never by the write/creation paths, which
 * enforce these properties through ensureConfigDir + assertWritablePath).
 */
export async function validateExistingConfigDir(): Promise<void> {
  const components = [parentConfigDir(), getConfigDir()];
  const lstat = testHooks.overrideLstat ?? fs.lstat;
  const stat = testHooks.overrideStat ?? fs.stat;

  for (const dir of components) {
    let linkStat: Stats;
    try {
      linkStat = await lstat(dir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Missing — absence is a legitimate state on read paths; do not create.
      if (e.code === "ENOENT") continue;
      throw new StorageError(
        "FILESYSTEM_ERROR",
        `filesystem error while validating config directory ${basename(dir)}`,
        e
      );
    }

    if (linkStat.isSymbolicLink()) {
      throw new StorageError(
        "INSECURE_DIR",
        `config directory ${basename(dir)} is a symlink; refusing to read from it`
      );
    }
    if (!linkStat.isDirectory()) {
      throw new StorageError(
        "INSECURE_DIR",
        `config directory ${basename(dir)} is not a directory; refusing to read from it`
      );
    }
    if (linkStat.mode & GROUP_OTHER_MASK) {
      throw new StorageError(
        "INSECURE_DIR",
        `config directory ${basename(dir)} has group/other permission bits set; refusing to read from it`
      );
    }
    // uid check: stat (ownership is unaffected by symlink-following concerns
    // once lstat confirmed the path is not a symlink), with test injection.
    const s = await stat(dir);
    const effectiveUid: number | undefined = process.getuid?.();
    if (effectiveUid !== undefined && s.uid !== effectiveUid) {
      throw new StorageError(
        "INSECURE_OWNER",
        `config directory ${basename(dir)} is owned by a different UID (${s.uid}) than this process (${effectiveUid}); refusing to read from it`
      );
    }
  }
}

/**
 * Verify a directory that will hold sensitive files: mode must have no
 * group/other bits, and the owner must be the effective UID of this process
 * where the OS exposes it. Never silently fixes an insecure directory.
 */
async function assertSecureDir(dir: string): Promise<void> {
  const stat = await (testHooks.overrideStat ?? fs.stat)(dir);

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
 *   (defense in depth; the umask can only REMOVE bits, so the explicit
 *   chmod(0700) normalizes the final mode to the contracted value).
 * - Existing directories: validated with lstat first (refuse symlinks), then
 *   mode + owner; an insecure directory is REFUSED, never silently repaired.
 * - Creation/verification only — reads never call this function.
 */
export async function ensureConfigDir(): Promise<void> {
  const dirs = [parentConfigDir(), getConfigDir()];
  for (const dir of dirs) {
    const lstat = testHooks.overrideLstat ?? fs.lstat;
    let existedStat: Stats | undefined;
    try {
      existedStat = await lstat(dir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw new StorageError("FILESYSTEM_ERROR", `filesystem error while accessing config directory`, e);
      }
    }

    if (existedStat) {
      // Existing component — lstat-based contract enforcement, never fix.
      if (existedStat.isSymbolicLink()) {
        throw new StorageError(
          "INSECURE_DIR",
          `${basename(dir)} is a symlink; refusing to use it`
        );
      }
      if (!existedStat.isDirectory()) {
        throw new StorageError(
          "INSECURE_DIR",
          `${basename(dir)} exists but is not a directory; refusing to use it`
        );
      }
      await assertSecureDir(dir);
      continue;
    }

    // Does not exist — create with restrictive mode and chmod explicitly.
    try {
      await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    } catch (mkdirErr) {
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while creating config directory`, mkdirErr);
    }
    // Explicit chmod: the umask can only REMOVE bits from a requested mode
    // (it never grants group/other bits to a freshly created DIR_MODE), so
    // chmod(0700) normalizes the final mode to the contracted value.
    try {
      await fs.chmod(dir, DIR_MODE);
    } catch (chmodErr) {
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while setting config directory mode`, chmodErr);
    }
    // Re-verify the created directory (owner + mode).
    await assertSecureDir(dir);
    // Symlink race on the freshly created path (TOCTOU residual documented).
    try {
      const post = await lstat(dir);
      if (post.isSymbolicLink()) {
        throw new StorageError(
          "INSECURE_DIR",
          `config directory path became a symlink after creation; refusing to use it`
        );
      }
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError("FILESYSTEM_ERROR", `filesystem error while re-validating config directory`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic write primitive
// ---------------------------------------------------------------------------

/**
 * Build the exclusive-open flags strictly from runtime constants — never a
 * hardcoded POSIX numeric literal. O_NOFOLLOW is combined only when the
 * runtime exposes it, and only when a test hook does not force it off.
 */
function exclusiveOpenFlags(): number {
  let flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  if (!testHooks.forceNoO_NOFOLLOW && hasOnofollow()) {
    flags |= (constants as { O_NOFOLLOW: number }).O_NOFOLLOW;
  }
  return flags;
}

/**
 * Open a path with O_WRONLY|O_CREAT|O_EXCL plus restrictive mode. When
 * O_NOFOLLOW is part of the flags, the open fails with ELOOP if the target is
 * a symlink; otherwise we rely on the pre-open lstat validation of the
 * ancestor chain.
 */
async function openExclusive(target: string): Promise<FileHandle> {
  const flags = exclusiveOpenFlags();
  testHooks.observeOpenFlags?.(flags);
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
  // Test-only hook: force a deterministic temp name so the suite can pre-create
  // a colliding path and drive the real exclusive-open EEXIST path.
  const tempName =
    testHooks.overrideTempName ??
    `${TEMP_PREFIX}${basename(targetPath, ".json")}-${Date.now()}-${randomBytes(8).toString("hex")}.tmp`;
  const tempPath = join(configDir, tempName);

  let handle: FileHandle | undefined;
  let tempCreated = false;
  try {
    // 3. exclusive create with restrictive mode (and O_NOFOLLOW when composed).
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
      if (e.code === "EEXIST") {
        throw new StorageError(
          "FILESYSTEM_ERROR",
          `exclusive open failed because the path already exists`,
          e
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
 * Pre-write validation for a credential file: refuse if any controlled
 * ancestor is a symlink (lstat), and refuse if the final path itself is a
 * symlink. O_NOFOLLOW on the exclusive open protects the final component at
 * open time; the ancestor lstat validation is independent and always runs.
 */
async function assertWritablePath(filePath: string): Promise<void> {
  await validateControlledAncestors(filePath);

  // The final target itself must never be a symlink regardless of O_NOFOLLOW:
  // a pre-existing symlink at the credential path must be refused even when
  // the temp open (which targets a fresh name next to it) succeeds.
  try {
    const targetStat = await fs.lstat(filePath);
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
    // ENOENT — final path does not exist yet; the ancestor validation above
    // already covered the controlled components.
  }
}

// ---------------------------------------------------------------------------
// Hardened read primitive
// ---------------------------------------------------------------------------

interface ReadResult {
  handle: FileHandle;
  data: Buffer;
}

/**
 * Read a credential file without following symlinks and without creating any
 * directory: controlled ancestors validated with lstat, open with
 * O_RDONLY|O_NOFOLLOW (when available) so the descriptor itself refuses a
 * symlink at open time, and the opened descriptor is then re-validated with
 * stat() (regular file, owner, mode contract) — a pre-open lstat alone is a
 * TOCTOU window; the descriptor is the source of truth.
 *
 * ENOENT (any component) → null ("absence", unchanged contract).
 * Anything insecure or structurally broken → StorageError; never silently
 * downgraded to "no file".
 */
async function readCredentialFile(filePath: string): Promise<ReadResult | null> {
  // 1. validate the EXISTING config directories (read-only contract: no
  //    mkdir, no chmod, no repair). Missing components are "absence"; an
  //    existing but insecure dir is a hard StorageError.
  try {
    await validateExistingConfigDir();
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      "FILESYSTEM_ERROR",
      `filesystem error while validating existing config directories`,
      err
    );
  }

  // 2. pre-open lstat of the final path: missing → absence.
  let preStat: Stats;
  try {
    preStat = await fs.lstat(filePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new StorageError("FILESYSTEM_ERROR", `filesystem error while validating storage target`, e);
  }
  if (preStat.isSymbolicLink()) {
    throw new StorageError(
      "INSECURE_DIR",
      `storage target path is a symlink; refusing to read through it`
    );
  }

  // Non-regular targets (FIFO, device, socket, directory) are rejected BEFORE
  // opening: an O_RDONLY open on a FIFO with no writer blocks indefinitely —
  // never let the store become a denial-of-service surface. The opened
  // descriptor is still re-validated afterwards (the lstat pre-check is a
  // TOCTOU window).
  if (!preStat.isFile()) {
    throw new StorageError(
      "INSECURE_DIR",
      `storage target is not a regular file; refusing to open it`
    );
  }

  // 3. open without following symlinks (descriptor-level protection).
  let handle: FileHandle;
  try {
    const flags = hasOnofollow() && !testHooks.forceNoO_NOFOLLOW
      ? (constants.O_RDONLY | (constants as { O_NOFOLLOW: number }).O_NOFOLLOW)
      : constants.O_RDONLY;
    testHooks.observeOpenFlags?.(flags);
    handle = await fs.open(filePath, flags);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    if (e.code === "ELOOP") {
      throw new StorageError(
        "INSECURE_DIR",
        `storage target path is a symlink; refusing to read through it`
      );
    }
    throw new StorageError("FILESYSTEM_ERROR", `filesystem error while opening credential file`, e);
  }

  // 4. validate the REAL descriptor: regular file, owner, mode contract.
  let stat: Stats;
  try {
    stat = await handle.stat();
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw new StorageError("FILESYSTEM_ERROR", `filesystem error while validating opened credential file`, err);
  }

  if (!stat.isFile()) {
    await handle.close().catch(() => undefined);
    throw new StorageError(
      "INSECURE_DIR",
      `storage target is not a regular file; refusing to read it`
    );
  }

  const effectiveUid: number | undefined = process.getuid?.();
  if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
    await handle.close().catch(() => undefined);
    throw new StorageError(
      "INSECURE_OWNER",
      `credential file is owned by a different UID (${stat.uid}) than this process (${effectiveUid}); refusing to read it`
    );
  }

  if (stat.mode & GROUP_OTHER_MASK) {
    await handle.close().catch(() => undefined);
    throw new StorageError(
      "INSECURE_DIR",
      `credential file has group/other permission bits set; refusing to read it`
    );
  }

  // 5. read by the validated descriptor and close.
  try {
    const data = await handle.readFile();
    return { handle, data };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw new StorageError("FILESYSTEM_ERROR", `filesystem error while reading credential file`, err);
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API (exports preserved — compatibility with the rest of the project)
// ---------------------------------------------------------------------------

export async function saveTokens(tokens: TokenData): Promise<void> {
  // Gate B3: validate BEFORE serializing — writing invalid data would persist
  // corruption even when the storage primitives themselves are sound.
  validateTokenData(tokens);
  await ensureConfigDir();
  await assertWritablePath(tokenFilePath());
  await atomicWriteJson(tokenFilePath(), tokens);
}

/**
 * Load saved tokens with hardened reads: no directories are created, symlinks
 * and insecure storage are refused structurally, and a genuinely missing file
 * stays "absence" (null).
 */
export async function loadTokens(): Promise<TokenData | null> {
  const result = await readCredentialFile(tokenFilePath());
  if (!result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data.toString("utf-8"));
  } catch {
    // JSON.truncated/malformed → explicit corruption, never silent null.
    throw new StorageError(
      "CORRUPT_SESSION",
      `tokens.json is not valid JSON (malformed or truncated)`
    );
  }
  return validateTokenData(parsed);
}

export async function saveSessionInfo(info: SessionInfo): Promise<void> {
  // Gate B3: validate BEFORE serializing (same rationale as saveTokens).
  // The injected saved_at is ISO-8601 by construction, but the rest of the
  // input is validated exactly as a persisted document would be.
  validateSessionInfo({ ...info, saved_at: new Date().toISOString() });
  await ensureConfigDir();
  await assertWritablePath(sessionFilePath());
  await atomicWriteJson(sessionFilePath(), { ...info, saved_at: new Date().toISOString() });
}

/**
 * Load saved session info with the same hardened-read invariants as loadTokens.
 */
export async function loadSessionInfo(): Promise<SessionInfo | null> {
  const result = await readCredentialFile(sessionFilePath());
  if (!result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data.toString("utf-8"));
  } catch {
    // JSON malformed/truncated → explicit corruption, never silent null.
    throw new StorageError(
      "CORRUPT_SESSION",
      `session.json is not valid JSON (malformed or truncated)`
    );
  }
  return validateSessionInfo(parsed);
}

/**
 * Clear persisted auth data. Best-effort removal with idempotent absence —
 * the pre-B2 semantics, preserved for this subgate. Structured logout
 * semantics (PARTIAL, structured results) remain out of scope (B5).
 */
export async function clearAuthData(): Promise<void> {
  await Promise.allSettled([fs.unlink(tokenFilePath()), fs.unlink(sessionFilePath())]);
}

/**
 * Report whether saved tokens exist. A genuinely missing file is `false`; an
 * insecure or structurally broken store is a STORAGE error that must NEVER be
 * silently converted into `false` (that would let an attacker hide the
 * presence of their own planted credential file by making the real one
 * unreadable).
 */
export async function hasSavedTokens(): Promise<boolean> {
  // No opening, no creating. The same security contract as the read path
  // applies here: an insecure store must error, never silently become `false`.
  // Missing components stay "absence" (false); existing dirs are validated
  // read-only (lstat — no symlink, is directory, mode + owner contract).
  try {
    await validateExistingConfigDir();
    const stat = await fs.lstat(tokenFilePath());
    // Symlinks are caught first — lstat.isSymbolicLink() is true while
    // isFile() would also be false; the specific error matters.
    if (stat.isSymbolicLink()) {
      throw new StorageError(
        "INSECURE_DIR",
        `token path is a symlink; refusing to report presence`
      );
    }
    if (!stat.isFile()) {
      throw new StorageError(
        "INSECURE_DIR",
        `token path exists but is not a regular file; refusing to report presence`
      );
    }
    if (stat.mode & GROUP_OTHER_MASK) {
      throw new StorageError(
        "INSECURE_DIR",
        `token file has group/other permission bits set; refusing to report presence`
      );
    }
    const effectiveUid: number | undefined = process.getuid?.();
    if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
      throw new StorageError(
        "INSECURE_OWNER",
        `token file is owned by a different UID (${stat.uid}) than this process (${effectiveUid}); refusing to report presence`
      );
    }
    return true;
  } catch (err) {
    if (err instanceof StorageError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return false;
    throw new StorageError("FILESYSTEM_ERROR", `filesystem error while checking saved tokens`, e);
  }
}

export function isTokenExpired(tokens: TokenData): boolean {
  return Date.now() >= tokens.expires_at - 60_000; // 1 min buffer
}
