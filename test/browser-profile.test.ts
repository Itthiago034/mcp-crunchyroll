import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { DEFAULT_BROWSER_SESSION_CONFIG } from "../src/transport/browser-lifecycle-types.js";
import {
  browserProfileDir,
  ensureBrowserProfile,
  resolveBrowserExecutable,
} from "../src/transport/browser-profile.js";

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
