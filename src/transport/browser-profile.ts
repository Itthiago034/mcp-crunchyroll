import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BrowserLifecycleError } from "./browser-lifecycle-error.js";

const EXECUTABLE_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "brave-browser",
  "brave",
] as const;

export function browserProfileDir(): string {
  return join(homedir(), ".strider", "crunchyroll", "browser-profile");
}

function assertSecureProfile(dir: string): void {
  let info;
  try {
    info = lstatSync(dir);
  } catch {
    throw new BrowserLifecycleError("PROFILE_INSECURE", "missing");
  }

  const currentUid = process.getuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    (currentUid !== undefined && info.uid !== currentUid)
  ) {
    throw new BrowserLifecycleError("PROFILE_INSECURE", "metadata");
  }
}

export async function ensureBrowserProfile(dir = browserProfileDir()): Promise<void> {
  try {
    lstatSync(dir);
    assertSecureProfile(dir);
    return;
  } catch (error) {
    if (error instanceof BrowserLifecycleError) throw error;
  }

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    throw new BrowserLifecycleError("PROFILE_INSECURE", "create");
  }
  assertSecureProfile(dir);
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
}

export function resolveBrowserExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CRUNCHYROLL_BROWSER_EXECUTABLE;
  if (override !== undefined) {
    if (isAbsolute(override) && isExecutableFile(override)) return override;
    throw new BrowserLifecycleError("BROWSER_EXECUTABLE_NOT_FOUND", "override");
  }

  const pathEntries = (env.PATH ?? "").split(":").filter(Boolean);
  for (const candidate of EXECUTABLE_CANDIDATES) {
    for (const entry of pathEntries) {
      const executable = join(entry, candidate);
      if (isExecutableFile(executable)) return executable;
    }
  }
  throw new BrowserLifecycleError("BROWSER_EXECUTABLE_NOT_FOUND");
}
