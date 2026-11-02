// Silent re-establishment eligibility.
//
// A process that starts cold has no bearer, even when the dedicated browser
// profile still holds the human's signed-in session. Whether it may try to
// re-establish that session WITHOUT a human is a question about authorization,
// not about cookies — so it is answered by a fact this server recorded itself,
// never by inspecting the profile's private data.
//
// The marker holds no secret: a version and a timestamp. It is written only
// after a session the human established was installed, removed BEFORE any
// logout work and on a provider revocation, and refused unless it is a regular
// 0600 file owned by this user. Anything unexpected reads as "not eligible".
//
// An explicit logout also leaves a secret-free TOMBSTONE, so the fact "the
// user logged out" survives a process restart (the dedicated browser profile
// itself stays signed in; that is the browser's session, not ours). It is
// removed by the next successful human login and is read synchronously, so a
// permission check can consult it on every step.

import { lstatSync } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { browserProfileDir } from "./browser-profile.js";

const MARKER_VERSION = 1;

/** Next to the dedicated profile, never inside it. */
export function sessionEligibilityPath(profileDir: string = browserProfileDir()): string {
  return join(dirname(profileDir), "silent-reauth-eligible.json");
}

/** The logout tombstone, next to the marker. */
export function loggedOutTombstonePath(markerPath: string): string {
  return join(dirname(markerPath), "logged-out.json");
}

export interface SessionEligibilityStore {
  isEligible(): Promise<boolean>;
  /** A human-authorized session was installed: eligible, and no longer logged out. */
  record(): Promise<void>;
  /** Revocation: no longer eligible. */
  clear(): Promise<void>;
  /** Explicit logout: no longer eligible, and the logout is remembered. */
  recordLogout(): Promise<void>;
  /** Synchronous: was the last explicit state a logout? Fails closed on anything unexpected. */
  loggedOutPersisted(): boolean;
}

/**
 * Fail closed: ANY entry at the tombstone path counts as "logged out". A
 * malformed, loosened or symlinked tombstone must never re-enable control;
 * only the next successful human login removes it.
 */
function anythingAt(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  // `wx` refuses to follow or reuse anything already at the temporary path.
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  try {
    const existing = await lstat(path).catch(() => undefined);
    if (existing && !existing.isFile()) throw new Error("not a regular file");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createSessionEligibilityStore(
  path: string = sessionEligibilityPath(),
  now: () => number = Date.now,
): SessionEligibilityStore {
  const tombstone = loggedOutTombstonePath(path);
  // Every write runs in arrival order, never interleaved. Without this, a
  // login's record() still writing when a logout starts could finish AFTER the
  // logout and recreate the marker and delete the tombstone.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
  // Bumped SYNCHRONOUSLY by every revocation and logout. A record() requested
  // before the bump belongs to a login that was overtaken and is dropped.
  let revision = 0;
  return {
    async isEligible() {
      try {
        const info = await lstat(path);
        if (!info.isFile() || (info.mode & 0o777) !== 0o600) return false;
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
        if (info.size > 256) return false;
        const handle = await open(path, "r");
        let text: string;
        try {
          text = await handle.readFile("utf-8");
        } finally {
          await handle.close();
        }
        const parsed = JSON.parse(text) as { version?: unknown; established_at?: unknown };
        return (
          parsed.version === MARKER_VERSION &&
          typeof parsed.established_at === "number" &&
          Number.isFinite(parsed.established_at)
        );
      } catch {
        return false;
      }
    },

    record() {
      const requestedAt = revision;
      return serial(async () => {
        if (revision !== requestedAt) return; // a logout or revocation came after
        await writePrivate(path, JSON.stringify({ version: MARKER_VERSION, established_at: now() }));
        await rm(tombstone, { force: true });
      });
    },

    clear() {
      revision += 1;
      // `rm` removes a symlink itself, never its target.
      return serial(() => rm(path, { force: true }));
    },

    recordLogout() {
      revision += 1;
      return serial(async () => {
        // Eligibility goes first: even if the tombstone cannot be written, no
        // silent attempt may follow a logout.
        await rm(path, { force: true });
        await writePrivate(tombstone, JSON.stringify({ version: MARKER_VERSION, logged_out_at: now() }));
      });
    },

    loggedOutPersisted: () => anythingAt(tombstone),
  };
}
