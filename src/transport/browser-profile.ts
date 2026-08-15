import {
  accessSync,
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserLifecycleError } from "./browser-lifecycle-error.js";
import type {
  BrowserOwnershipRecord,
  DevToolsEndpoint,
  ProcessIdentityInspector,
} from "./browser-lifecycle-types.js";

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

export async function readDevToolsEndpoint(
  dir = browserProfileDir(),
): Promise<DevToolsEndpoint> {
  let contents: string;
  try {
    contents = readFileSync(join(dir, "DevToolsActivePort"), "utf8");
  } catch {
    throw new BrowserLifecycleError("ENDPOINT_UNAVAILABLE");
  }

  const lines = contents.split(/\r?\n/);
  const portText = lines[0];
  const browserPath = lines[1];
  const port = Number(portText);
  if (
    !/^\d+$/.test(portText ?? "") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !browserPath ||
    !browserPath.startsWith("/")
  ) {
    throw new BrowserLifecycleError("ENDPOINT_MALFORMED");
  }

  return Object.freeze({
    port,
    browserPath,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}${browserPath}`,
  });
}

export async function clearStaleEndpoint(dir = browserProfileDir()): Promise<void> {
  try {
    unlinkSync(join(dir, "DevToolsActivePort"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function canonicalizeProfilePath(dir: string): string {
  try { return realpathSync(dir); }
  catch { throw new BrowserLifecycleError("OWNERSHIP_INVALID", "profile-canonical"); }
}

export function canonicalizeExecutablePath(executablePath: string): string {
  try { return realpathSync(executablePath); }
  catch { throw new BrowserLifecycleError("OWNERSHIP_INVALID", "executable-canonical"); }
}

export function ownershipRecordPath(dir = browserProfileDir()): string {
  return join(dir, ".mcp-browser-owner.json");
}

function ownershipInvalid(detail: string): BrowserLifecycleError {
  return new BrowserLifecycleError("OWNERSHIP_INVALID", detail);
}

function isOwnershipRecord(value: unknown): value is BrowserOwnershipRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record.version === 1 &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.executable === "string" &&
    record.executable.length > 0 &&
    isAbsolute(record.executable) &&
    typeof record.profile === "string" &&
    record.profile.length > 0 &&
    isAbsolute(record.profile) &&
    typeof record.startTimeTicks === "number" &&
    Number.isSafeInteger(record.startTimeTicks) &&
    record.startTimeTicks >= 0
  );
}

export async function writeOwnershipRecord(
  record: BrowserOwnershipRecord,
  dir = browserProfileDir(),
): Promise<void> {
  if (!isOwnershipRecord(record)) throw ownershipInvalid("schema");
  const target = ownershipRecordPath(dir);
  const temporary = join(dir, `.mcp-browser-owner.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, JSON.stringify(record), "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* descriptor already closed */ }
    }
    try { unlinkSync(temporary); } catch { /* only this unique temp is cleaned */ }
    throw ownershipInvalid("write");
  }
}

export async function readOwnershipRecord(
  dir = browserProfileDir(),
): Promise<BrowserOwnershipRecord | null> {
  const path = ownershipRecordPath(dir);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw ownershipInvalid("stat");
  }
  const currentUid = process.getuid?.();
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o600 ||
    (currentUid !== undefined && info.uid !== currentUid)
  ) throw ownershipInvalid("metadata");

  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw ownershipInvalid("json"); }
  if (!isOwnershipRecord(parsed)) throw ownershipInvalid("schema");
  return Object.freeze(parsed);
}

export async function clearOwnershipRecord(dir = browserProfileDir()): Promise<void> {
  try { unlinkSync(ownershipRecordPath(dir)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readStartTimeTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fieldsFromState = stat.slice(closeParen + 1).trim().split(/\s+/);
    const value = Number(fieldsFromState[19]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function createProcessIdentityInspector(): ProcessIdentityInspector {
  return {
    isAlive(pid) {
      try {
        // Signal 0 probes existence/permission without delivery to the target.
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    executable(pid) {
      try { return realpathSync(readlinkSync(`/proc/${pid}/exe`)); }
      catch { return null; }
    },
    startTimeTicks: readStartTimeTicks,
    argv(pid) {
      try {
        const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (parts.at(-1) === "") parts.pop();
        return parts.length > 0 && parts.every((part) => part.length > 0) ? parts : null;
      } catch {
        return null;
      }
    },
    canonicalPath(path) {
      try { return realpathSync(path); }
      catch { return null; }
    },
  };
}
