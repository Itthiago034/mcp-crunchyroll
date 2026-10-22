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

import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { browserProfileDir } from "./browser-profile.js";

const MARKER_VERSION = 1;

/** Next to the dedicated profile, never inside it. */
export function sessionEligibilityPath(profileDir: string = browserProfileDir()): string {
  return join(dirname(profileDir), "silent-reauth-eligible.json");
}

export interface SessionEligibilityStore {
  isEligible(): Promise<boolean>;
  record(): Promise<void>;
  clear(): Promise<void>;
}

export function createSessionEligibilityStore(
  path: string = sessionEligibilityPath(),
  now: () => number = Date.now,
): SessionEligibilityStore {
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

    async record() {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      // `wx` refuses to follow or reuse anything already at the temporary path.
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: MARKER_VERSION, established_at: now() }));
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
    },

    async clear() {
      // `rm` removes a symlink itself, never its target.
      await rm(path, { force: true });
    },
  };
}
