import assert from "node:assert/strict";
import { test } from "node:test";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserSubprocessEnvironment } from "../scripts/browser-subprocess-environment.js";

const desktopFixture = {
  DISPLAY: ":42",
  WAYLAND_DISPLAY: "wayland-test",
  XDG_RUNTIME_DIR: "/tmp/desktop-fixture",
  XDG_SESSION_TYPE: "wayland",
  XAUTHORITY: "/tmp/desktop-fixture/xauth",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/desktop-fixture/bus",
  CRUNCHYROLL_BROWSER_EXECUTABLE: "/usr/bin/chromium-fixture",
  CHROME_DEVEL_SANDBOX: "/usr/lib/chromium-fixture/chrome-sandbox",
};

test("the browser environment excludes unrelated secrets and report paths", () => {
  assert.deepEqual(browserSubprocessEnvironment({
    ...desktopFixture,
    API_TOKEN: "synthetic-secret",
    CRUNCHYROLL_LIVE_REPORT_PATH: "/tmp/report.json",
    HTTP_PROXY: "http://synthetic:secret@example.invalid",
  }), desktopFixture);
});

test("unset, empty and shell-function variables are not forwarded", () => {
  assert.deepEqual(browserSubprocessEnvironment({
    DISPLAY: "", WAYLAND_DISPLAY: undefined, XAUTHORITY: "() { synthetic; }",
    XDG_RUNTIME_DIR: "/tmp/desktop-fixture",
  }), { XDG_RUNTIME_DIR: "/tmp/desktop-fixture" });
});

// Start a real SDK subprocess. It emits only presence/match booleans, never
// environment values, and requires no desktop or actual browser in CI.
async function inspectChildEnvironment(env?: Record<string, string>): Promise<Record<string, boolean>> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", `
      const expected = ${JSON.stringify(desktopFixture)};
      const matches = Object.fromEntries(Object.entries(expected).map(
        ([key, value]) => [key, process.env[key] === value]));
      matches.unrelatedSecretPresent = process.env.API_TOKEN !== undefined;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test.environment", params: matches }) + "\\n");
      process.stdin.resume();
    `],
    env,
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const message = new Promise<Record<string, boolean>>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("SDK subprocess timed out")), 10_000);
    transport.onerror = reject;
    transport.onmessage = (value) => {
      if ("method" in value && value.method === "test.environment") {
        resolve(value.params as Record<string, boolean>);
      }
    };
  });
  // Install the rejection handler before starting the process.
  const result = message.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await transport.start();
    const received = await result;
    if ("error" in received) throw received.error;
    return received.value;
  } finally {
    clearTimeout(timer);
    await transport.close();
  }
}

test("real SDK drops desktop variables by default and preserves them with the browser allowlist", async () => {
  const fixture = { ...desktopFixture, API_TOKEN: "synthetic-secret" };
  const previous = Object.fromEntries(Object.keys(fixture).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, fixture);
    const before = await inspectChildEnvironment();
    assert.ok(Object.values(before).every((value) => value === false));

    const after = await inspectChildEnvironment(browserSubprocessEnvironment());
    for (const key of Object.keys(desktopFixture)) assert.equal(after[key], true, key);
    assert.equal(after.unrelatedSecretPresent, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
