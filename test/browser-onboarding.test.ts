import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { prepareManualBrowser, OnboardingBlocked } from "../scripts/onboard-browser.js";
import { CRUNCHYROLL_LOGIN_URL } from "../src/transport/browser-auth.js";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";

const desktop = { DISPLAY: ":42", CRUNCHYROLL_BROWSER_EXECUTABLE: process.execPath };
const execFileAsync = promisify(execFile);

test("manual onboarding prepares a private profile, fixed login and no debugging port", async () => {
  const base = await mkdtemp(join(tmpdir(), "mcp-onboarding-test-"));
  const profile = join(base, "profile");
  try {
    const plan = await prepareManualBrowser(profile, desktop, "linux");
    assert.equal(plan.executable, process.execPath);
    assert.equal((await lstat(profile)).mode & 0o777, 0o700);
    assert.ok(plan.args.includes(`--user-data-dir=${profile}`));
    assert.equal(plan.args.at(-1), CRUNCHYROLL_LOGIN_URL);
    assert.ok(plan.args.every((arg) => !/remote-debugging|headless|no-sandbox|AutomationControlled/.test(arg)));
    assert.equal(plan.args.filter((arg) => arg.startsWith("--user-data-dir=")).length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a profile lock, including a dangling symlink, is refused and left intact", async () => {
  const profile = await mkdtemp(join(tmpdir(), "mcp-onboarding-test-"));
  const lock = join(profile, "SingletonLock");
  try {
    await symlink("synthetic-host-999999", lock);
    await assert.rejects(prepareManualBrowser(profile, desktop, "linux"),
      (error: unknown) => error instanceof OnboardingBlocked && error.reason === "profile_in_use");
    assert.equal(await readlink(lock), "synthetic-host-999999");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("an insecure profile is refused rather than silently repaired", async () => {
  const profile = await mkdtemp(join(tmpdir(), "mcp-onboarding-test-"));
  try {
    await chmod(profile, 0o755);
    await assert.rejects(prepareManualBrowser(profile, desktop, "linux"),
      (error: unknown) => error instanceof BrowserLifecycleError && error.kind === "PROFILE_INSECURE");
    assert.equal((await lstat(profile)).mode & 0o777, 0o755);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("missing desktop is rejected before creating or inspecting a profile", async () => {
  const base = await mkdtemp(join(tmpdir(), "mcp-onboarding-test-"));
  const profile = join(base, "not-created");
  try {
    await assert.rejects(prepareManualBrowser(profile, {}, "linux"),
      (error: unknown) => error instanceof OnboardingBlocked && error.reason === "display_unavailable");
    await assert.rejects(lstat(profile), { code: "ENOENT" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the real CLI refuses supplied arguments without echoing their values", async () => {
  const secret = "SYNTHETIC-LOGIN-SECRET-MUST-NOT-BE-ECHOED";
  await assert.rejects(execFileAsync(process.execPath,
    ["--import", "tsx", "scripts/onboard-browser.ts", secret]), (error: unknown) => {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    assert.equal(result.code, 2);
    assert.match(result.stderr ?? "", /não aceita argumentos/);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
    return true;
  });
});

test("the real CLI reports a missing desktop without opening a browser", async () => {
  await assert.rejects(execFileAsync(process.execPath,
    ["--import", "tsx", "scripts/onboard-browser.ts"],
    { env: { PATH: process.env.PATH, DISPLAY: "", WAYLAND_DISPLAY: "" } }), (error: unknown) => {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    assert.equal(result.code, 2);
    assert.match(result.stderr ?? "", /sessão gráfica/);
    assert.equal(result.stdout, "");
    return true;
  });
});
