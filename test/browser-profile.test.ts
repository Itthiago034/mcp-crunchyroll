import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { DEFAULT_BROWSER_SESSION_CONFIG } from "../src/transport/browser-lifecycle-types.js";
import type { ProcessIdentityInspector } from "../src/transport/browser-lifecycle-types.js";
import {
  browserProfileDir,
  ensureBrowserProfile,
  resolveBrowserExecutable,
} from "../src/transport/browser-profile.js";
import * as browserProfile from "../src/transport/browser-profile.js";

const profileApi = browserProfile as typeof browserProfile & {
  readDevToolsEndpoint(dir?: string): Promise<{
    port: number;
    browserPath: string;
    webSocketDebuggerUrl: string;
  }>;
  clearStaleEndpoint(dir?: string): Promise<void>;
};

const ownerApi = browserProfile as typeof browserProfile & {
  ownershipRecordPath(dir?: string): string;
  writeOwnershipRecord(record: unknown, dir?: string): Promise<void>;
  readOwnershipRecord(dir?: string): Promise<unknown>;
  clearOwnershipRecord(dir?: string): Promise<void>;
  canonicalizeProfilePath(dir: string): string;
  canonicalizeExecutablePath(path: string): string;
  createProcessIdentityInspector(): ProcessIdentityInspector;
  profileSingletonMatchesPid(
    canonicalProfile: string,
    pid: number,
    hostname: string,
    reader?: {
      lstat(path: string): { isSymbolicLink(): boolean };
      readlink(path: string): string;
    },
  ): boolean;
};

function withProfile(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), "bt2-endpoint-"));
    const dir = join(base, "browser-profile");
    mkdirSync(dir);
    chmodSync(dir, 0o700);
    try {
      await fn(dir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
}

describe("BT2 lifecycle foundation", () => {
  test("lifecycle errors carry a kind and a fixed secret-free message", () => {
    const error = new BrowserLifecycleError("PROFILE_INSECURE", "mode");
    assert.equal(error.name, "BrowserLifecycleError");
    assert.equal(error.kind, "PROFILE_INSECURE");
    assert.equal(error.message, "Managed browser profile has unsafe permissions");
    assert.equal(error.detail, "mode");
  });

  test("every error kind has a fixed message and none leaks a path", () => {
    const kinds = [
      "BROWSER_UNAVAILABLE",
      "BROWSER_DISCONNECTED",
      "BROWSER_EXECUTABLE_NOT_FOUND",
      "PROFILE_INSECURE",
      "ENDPOINT_UNAVAILABLE",
      "ENDPOINT_MALFORMED",
      "OWNERSHIP_INVALID",
      "LAUNCH_TIMEOUT",
      "RECOVERY_EXHAUSTED",
      "BROWSER_STOP_TIMEOUT",
    ] as const;

    for (const kind of kinds) {
      const error = new BrowserLifecycleError(kind);
      assert.ok(error.message.length > 0, kind);
      assert.ok(!error.message.includes("/"), `${kind} message must not contain a path`);
    }
  });

  test("the default session config is visible, bounded and frozen", () => {
    const config = DEFAULT_BROWSER_SESSION_CONFIG;
    assert.equal(config.launchMode, "visible", "production default is a visible browser");
    assert.equal(config.maxRecoveryAttempts, 3);
    assert.deepEqual([...config.backoffMs], [250, 500, 1000]);
    assert.equal(config.launchDeadlineMs, 30_000);
    assert.equal(config.cdpCommandTimeoutMs, 10_000);
    assert.equal(config.initialPageUrl, "about:blank", "production never starts on a remote origin");
    assert.throws(() => {
      (config as { launchMode: string }).launchMode = "headless";
    }, TypeError);
  });
});

describe("BT2 dedicated browser profile", () => {
  test("the profile lives under the project's hardened state root", () => {
    const dir = browserProfileDir();
    assert.ok(dir.endsWith("/.strider/crunchyroll/browser-profile"), dir);
    assert.ok(!dir.startsWith(tmpdir()), "never a shared temp location");
  });

  test("a new profile directory is created 0700", async () => {
    const base = mkdtempSync(join(tmpdir(), "bt2-profile-"));
    const dir = join(base, "browser-profile");
    try {
      await ensureBrowserProfile(dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an existing profile with group/other bits is REFUSED, not repaired", async () => {
    const base = mkdtempSync(join(tmpdir(), "bt2-profile-"));
    const dir = join(base, "browser-profile");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    try {
      await assert.rejects(
        () => ensureBrowserProfile(dir),
        (error: unknown) =>
          error instanceof BrowserLifecycleError && error.kind === "PROFILE_INSECURE",
      );
      assert.equal(statSync(dir).mode & 0o777, 0o755, "never silently chmod-ed");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("ensureBrowserProfile is idempotent across manager restarts", async () => {
    const base = mkdtempSync(join(tmpdir(), "bt2-profile-"));
    const dir = join(base, "browser-profile");
    try {
      await ensureBrowserProfile(dir);
      await ensureBrowserProfile(dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the executable override must be an existing executable file", () => {
    assert.throws(
      () => resolveBrowserExecutable({ CRUNCHYROLL_BROWSER_EXECUTABLE: "/nonexistent/browser" }),
      (error: unknown) =>
        error instanceof BrowserLifecycleError &&
        error.kind === "BROWSER_EXECUTABLE_NOT_FOUND",
    );
  });

  test("a relative executable override is refused", () => {
    assert.throws(
      () => resolveBrowserExecutable({ CRUNCHYROLL_BROWSER_EXECUTABLE: "chromium" }),
      (error: unknown) =>
        error instanceof BrowserLifecycleError &&
        error.kind === "BROWSER_EXECUTABLE_NOT_FOUND",
    );
  });
});

describe("BT2 DevTools endpoint discovery", () => {
  test("a well-formed endpoint file yields a loopback ws URL", withProfile(async (dir) => {
    writeFileSync(join(dir, "DevToolsActivePort"), "45231\n/devtools/browser/abc-123\n");
    const endpoint = await profileApi.readDevToolsEndpoint(dir);
    assert.equal(endpoint.port, 45231);
    assert.equal(endpoint.browserPath, "/devtools/browser/abc-123");
    assert.equal(
      endpoint.webSocketDebuggerUrl,
      "ws://127.0.0.1:45231/devtools/browser/abc-123",
    );
  }));

  test("the host is pinned to loopback and never read from the file", withProfile(async (dir) => {
    writeFileSync(join(dir, "DevToolsActivePort"), "45231\n/devtools/browser/x\n");
    const endpoint = await profileApi.readDevToolsEndpoint(dir);
    assert.ok(
      endpoint.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:"),
      endpoint.webSocketDebuggerUrl,
    );
  }));

  test("a missing endpoint file is ENDPOINT_UNAVAILABLE", withProfile(async (dir) => {
    await assert.rejects(
      () => profileApi.readDevToolsEndpoint(dir),
      (error: unknown) =>
        error instanceof BrowserLifecycleError && error.kind === "ENDPOINT_UNAVAILABLE",
    );
  }));

  for (const [label, contents] of [
    ["non-numeric port", "not-a-port\n/devtools/browser/x\n"],
    ["port zero", "0\n/devtools/browser/x\n"],
    ["port above range", "70000\n/devtools/browser/x\n"],
    ["missing path line", "45231\n"],
    ["path not starting with a slash", "45231\ndevtools/browser/x\n"],
    ["empty file", ""],
  ] as const) {
    test(`a malformed endpoint file (${label}) is ENDPOINT_MALFORMED`, withProfile(async (dir) => {
      writeFileSync(join(dir, "DevToolsActivePort"), contents);
      await assert.rejects(
        () => profileApi.readDevToolsEndpoint(dir),
        (error: unknown) =>
          error instanceof BrowserLifecycleError && error.kind === "ENDPOINT_MALFORMED",
      );
    }));
  }

  test("clearStaleEndpoint removes the file but preserves the profile", withProfile(async (dir) => {
    writeFileSync(join(dir, "DevToolsActivePort"), "45231\n/devtools/browser/x\n");
    await profileApi.clearStaleEndpoint(dir);
    await assert.rejects(() => profileApi.readDevToolsEndpoint(dir));
    assert.equal(statSync(dir).mode & 0o777, 0o700, "the profile directory survives");
  }));
});

describe("BT2 ownership record", () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    pid: process.pid,
    launcherExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    profile: "/x",
    startTimeTicks: 1234,
    ...overrides,
  });

  test("the record is written 0600 inside the managed profile", withProfile(async (dir) => {
    await ownerApi.writeOwnershipRecord(record({ profile: dir }), dir);
    const path = ownerApi.ownershipRecordPath(dir);
    assert.ok(path.endsWith("/.mcp-browser-owner.json"));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }));

  test("a missing record reads as null, not an error", withProfile(async (dir) => {
    assert.equal(await ownerApi.readOwnershipRecord(dir), null);
  }));

  test("a structurally invalid record is OWNERSHIP_INVALID", withProfile(async (dir) => {
    writeFileSync(ownerApi.ownershipRecordPath(dir), JSON.stringify({ version: 99 }), {
      mode: 0o600,
    });
    await assert.rejects(
      () => ownerApi.readOwnershipRecord(dir),
      (error: unknown) =>
        error instanceof BrowserLifecycleError && error.kind === "OWNERSHIP_INVALID",
    );
  }));

  test("the old executable-only version 1 schema fails closed", withProfile(async (dir) => {
    writeFileSync(ownerApi.ownershipRecordPath(dir), JSON.stringify({
      version: 1,
      pid: process.pid,
      executable: process.execPath,
      profile: dir,
      startTimeTicks: 1234,
    }), { mode: 0o600 });
    await assert.rejects(
      () => ownerApi.readOwnershipRecord(dir),
      (error: unknown) =>
        error instanceof BrowserLifecycleError && error.kind === "OWNERSHIP_INVALID",
    );
  }));

  test("a world-readable record is OWNERSHIP_INVALID", withProfile(async (dir) => {
    await ownerApi.writeOwnershipRecord(record({ profile: dir }), dir);
    chmodSync(ownerApi.ownershipRecordPath(dir), 0o644);
    await assert.rejects(
      () => ownerApi.readOwnershipRecord(dir),
      (error: unknown) =>
        error instanceof BrowserLifecycleError && error.kind === "OWNERSHIP_INVALID",
    );
  }));

  test("the record contains no credential material", withProfile(async (dir) => {
    await ownerApi.writeOwnershipRecord(record({ profile: dir }), dir);
    const raw = readFileSync(ownerApi.ownershipRecordPath(dir), "utf8").toLowerCase();
    for (const forbidden of ["cookie", "bearer", "token", "authorization", "password"]) {
      assert.ok(!raw.includes(forbidden), `record must not contain ${forbidden}`);
    }
  }));

  test("canonical profile and executable helpers use physical identity", withProfile((dir) => {
    assert.equal(ownerApi.canonicalizeProfilePath(dir), realpathSync(dir));
    assert.equal(ownerApi.canonicalizeExecutablePath(process.execPath), realpathSync(process.execPath));
  }));

  test("the real inspector reads this live process on Linux", () => {
    if (process.platform !== "linux") return;
    const inspector = ownerApi.createProcessIdentityInspector();
    assert.equal(inspector.executable(process.pid), realpathSync(process.execPath));
    assert.equal(typeof inspector.startTimeTicks(process.pid), "number");
    assert.equal("argv" in inspector, false, "rewritten cmdline is not an ownership seam");
  });

  test("the real inspector fails closed for a dead pid", () => {
    const inspector = ownerApi.createProcessIdentityInspector();
    assert.equal(inspector.startTimeTicks(2 ** 30), null);
    assert.equal(inspector.executable(2 ** 30), null);
  });

  test("clearOwnershipRecord removes the record and preserves the profile", withProfile(async (dir) => {
    await ownerApi.writeOwnershipRecord(record({ profile: dir }), dir);
    await ownerApi.clearOwnershipRecord(dir);
    assert.equal(await ownerApi.readOwnershipRecord(dir), null);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }));
});

describe("BT2 ProcessSingleton profile binding", () => {
  test("an exact SingletonLock symlink binds the profile to the retained pid", withProfile((dir) => {
    symlinkSync("test-host-12345", join(dir, "SingletonLock"));
    assert.equal(ownerApi.profileSingletonMatchesPid(dir, 12_345, "test-host"), true);
  }));

  test("a hostname containing multiple hyphens is compared without parsing", withProfile((dir) => {
    symlinkSync("my-test-host-name-424242", join(dir, "SingletonLock"));
    assert.equal(
      ownerApi.profileSingletonMatchesPid(dir, 424_242, "my-test-host-name"),
      true,
    );
  }));

  test("a missing SingletonLock fails closed", withProfile((dir) => {
    assert.equal(ownerApi.profileSingletonMatchesPid(dir, 123, "host-a"), false);
  }));

  test("a regular SingletonLock file fails closed", withProfile((dir) => {
    writeFileSync(join(dir, "SingletonLock"), "host-a-123");
    assert.equal(ownerApi.profileSingletonMatchesPid(dir, 123, "host-a"), false);
  }));

  test("a SingletonLock directory fails closed", withProfile((dir) => {
    mkdirSync(join(dir, "SingletonLock"));
    assert.equal(ownerApi.profileSingletonMatchesPid(dir, 123, "host-a"), false);
  }));

  for (const [label, target] of [
    ["wrong hostname", "host-b-123"],
    ["wrong pid", "host-a-456"],
    ["extra prefix", "evil-host-a-123"],
    ["extra suffix", "host-a-123-extra"],
    ["partial pid", "host-a-123"],
  ] as const) {
    test(`${label} in SingletonLock fails exact binding`, withProfile((dir) => {
      symlinkSync(target, join(dir, "SingletonLock"));
      const expectedPid = label === "partial pid" ? 12_345 : 123;
      assert.equal(ownerApi.profileSingletonMatchesPid(dir, expectedPid, "host-a"), false);
    }));
  }

  test("an empty readlink result fails closed", withProfile((dir) => {
    assert.equal(ownerApi.profileSingletonMatchesPid(dir, 123, "host-a", {
      lstat: () => ({ isSymbolicLink: () => true }),
      readlink: () => "",
    }), false);
  }));

  test("a readlink failure fails closed", withProfile((dir) => {
    assert.equal(ownerApi.profileSingletonMatchesPid(dir, 123, "host-a", {
      lstat: () => ({ isSymbolicLink: () => true }),
      readlink: () => { throw new Error("synthetic readlink failure"); },
    }), false);
  }));
});
