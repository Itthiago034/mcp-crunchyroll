import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { DEFAULT_BROWSER_SESSION_CONFIG } from "../src/transport/browser-lifecycle-types.js";

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
