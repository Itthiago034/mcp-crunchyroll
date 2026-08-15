import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { describe, test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { createRealBrowserSessionSeams } from "../src/transport/browser-session-manager.js";
import { wireFakes } from "./_fake-browser-seams.js";

describe("BT2 session manager — start and stop", () => {
  test("the initial state is STOPPED", () => {
    const { manager } = wireFakes();
    assert.equal(manager.state(), "STOPPED");
  });

  test("start moves STOPPED → BROWSER_STARTING → BROWSER_READY", async () => {
    const { manager, transitions } = wireFakes();
    await manager.start();
    assert.deepEqual(transitions, [
      ["STOPPED", "BROWSER_STARTING"],
      ["BROWSER_STARTING", "BROWSER_READY"],
    ]);
    assert.equal(manager.state(), "BROWSER_READY");
  });

  test("the spawn vector is internal, loopback, ephemeral and sandboxed", async () => {
    const { manager, spawner } = wireFakes();
    await manager.start();
    const args = spawner.launches[0].args;
    assert.ok(args.includes("--remote-debugging-port=0"), "ephemeral port");
    assert.equal(args.filter((arg) => arg.startsWith("--remote-debugging-port=")).length, 1);
    assert.ok(args.some((arg) => arg.startsWith("--user-data-dir=")));
    assert.ok(args.includes("--disable-background-networking"));
    assert.ok(args.includes("--disable-background-mode"));
    assert.ok(!args.some((arg) => arg.includes("--no-sandbox")), "sandbox stays enabled");
    assert.ok(!args.some((arg) => arg.includes("0.0.0.0")), "never binds beyond loopback");
  });

  test("headless differs from visible ONLY by --headless=new", async () => {
    const visible = wireFakes({ launchMode: "visible" });
    await visible.manager.start();
    const headless = wireFakes({ launchMode: "headless" });
    await headless.manager.start();
    const visibleArgs = visible.spawner.launches[0].args;
    const headlessArgs = headless.spawner.launches[0].args;
    const modeOnly = (args: readonly string[]) =>
      args.filter((arg) => !arg.startsWith("--user-data-dir="));
    assert.deepEqual(
      modeOnly(headlessArgs).filter((arg) => !modeOnly(visibleArgs).includes(arg)),
      ["--headless=new"],
    );
    assert.deepEqual(
      modeOnly(visibleArgs).filter((arg) => !modeOnly(headlessArgs).includes(arg)),
      [],
    );
    for (const common of ["--disable-background-mode", "--disable-background-networking"]) {
      assert.ok(visibleArgs.includes(common), `visible must keep ${common}`);
      assert.ok(headlessArgs.includes(common), `headless must keep ${common}`);
    }
  });

  test("concurrent start spawns exactly one browser", async () => {
    const { manager, spawner } = wireFakes();
    await Promise.all([manager.start(), manager.start(), manager.start()]);
    assert.equal(spawner.launches.length, 1, "single-flight");
    assert.equal(manager.state(), "BROWSER_READY");
  });

  test("a shared launch failure reaches every waiter and spawns once", async () => {
    const { manager, spawner } = wireFakes({ failLaunch: true });
    const results = await Promise.allSettled([manager.start(), manager.start()]);
    assert.equal(spawner.launches.length, 1, "no hidden second launch");
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.ok((result as PromiseRejectedResult).reason instanceof BrowserLifecycleError);
    }
    assert.equal(manager.state(), "STOPPED");
  });

  test("a child that exits before readiness fails as BROWSER_UNAVAILABLE", async () => {
    const { manager, spawner } = wireFakes({ exitBeforeReady: true });
    await assert.rejects(
      () => manager.start(),
      (error: unknown) =>
        error instanceof BrowserLifecycleError && error.kind === "BROWSER_UNAVAILABLE",
    );
    assert.equal(manager.state(), "STOPPED");
    assert.equal(spawner.launches.length, 1);
  });

  test("start is bounded by the launch deadline", async () => {
    const { manager, clock } = wireFakes({ neverReady: true, launchDeadlineMs: 1_000 });
    const started = manager.start();
    await clock.advance(1_000);
    await assert.rejects(
      () => started,
      (error: unknown) =>
        error instanceof BrowserLifecycleError && error.kind === "LAUNCH_TIMEOUT",
    );
  });

  test("stop terminates only the owned process, gracefully first", async () => {
    const { manager, spawner, profileDir } = wireFakes();
    await manager.start();
    await manager.stop();
    assert.equal(manager.state(), "STOPPED");
    assert.equal(spawner.launches[0].terminationRequested, true);
    assert.equal(spawner.launches[0].forceKilled, false, "graceful first");
    assert.equal(statSync(profileDir).mode & 0o777, 0o700, "the profile survives stop");
  });

  test("stop escalates to force kill only when the child ignores SIGTERM", async () => {
    const { manager, spawner, clock } = wireFakes({ ignoreSigterm: true });
    await manager.start();
    const stopping = manager.stop();
    await clock.drain();
    await stopping;
    assert.equal(spawner.launches[0].forceKilled, true);
  });

  test("the manager exposes only lifecycle verbs", () => {
    const { manager } = wireFakes();
    assert.deepEqual(Object.keys(manager).sort(), [
      "ensureManagedPage",
      "managedPageId",
      "onLifecycleEvent",
      "onStateChange",
      "restart",
      "start",
      "state",
      "stop",
    ]);
  });

  test("createRealBrowserSessionSeams returns all production seams", () => {
    const seams = createRealBrowserSessionSeams(10_000);
    assert.equal(typeof seams.spawner.spawn, "function");
    assert.equal(typeof seams.clock.now, "function");
    assert.equal(typeof seams.clock.sleep, "function");
    assert.equal(typeof seams.clock.setTimeout, "function");
    assert.equal(typeof seams.connector.connect, "function");
    assert.equal(typeof seams.processInspector.argv, "function");
    assert.equal(typeof seams.processInspector.startTimeTicks, "function");
  });
});

describe("BT2 session manager — exit classification and process recovery", () => {
  test("a user closing the browser (exit 0) stops WITHOUT relaunching", async () => {
    const { manager, spawner } = wireFakes();
    await manager.start();
    await spawner.launches[0].emitExit(0, null);
    assert.equal(manager.state(), "STOPPED");
    assert.equal(spawner.launches.length, 1, "never spawn a window over the user's intent");
  });

  test("after a user close, an explicit start is required and works", async () => {
    const { manager, spawner } = wireFakes();
    await manager.start();
    await spawner.launches[0].emitExit(0, null);
    await manager.start();
    assert.equal(spawner.launches.length, 2);
    assert.equal(manager.state(), "BROWSER_READY");
  });

  test("a crash (non-zero exit) triggers bounded relaunch and recovers", async () => {
    const { manager, spawner, clock } = wireFakes();
    await manager.start();
    await spawner.launches[0].emitExit(1, null);
    await clock.drain();
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(spawner.launches.length, 2, "exactly one recovery launch");
  });

  test("a crash by signal is also treated as a crash", async () => {
    const { manager, spawner, clock } = wireFakes();
    await manager.start();
    await spawner.launches[0].emitExit(null, "SIGSEGV");
    await clock.drain();
    assert.equal(spawner.launches.length, 2);
  });

  test("relaunch is bounded and never loops forever", async () => {
    const { manager, spawner, clock } = wireFakes({ alwaysCrash: true });
    await manager.start();
    await spawner.launches[0].emitExit(1, null);
    await clock.drain();
    assert.equal(spawner.launches.length, 4, "initial launch plus maxRecoveryAttempts");
    assert.equal(manager.state(), "STOPPED");
  });

  test("relaunch exhaustion emits RECOVERY_EXHAUSTED", async () => {
    const { manager, spawner, clock, events } = wireFakes({ alwaysCrash: true });
    await manager.start();
    await spawner.launches[0].emitExit(1, null);
    await clock.drain();
    assert.ok(events.some((event) => event.type === "recovery.exhausted"));
  });

  test("backoff follows the frozen schedule", async () => {
    const { manager, spawner, clock } = wireFakes({ alwaysCrash: true });
    await manager.start();
    await spawner.launches[0].emitExit(1, null);
    await clock.drain();
    assert.deepEqual(clock.sleeps, [250, 500, 1000]);
  });

  test("a manager-requested stop is never classified as a crash", async () => {
    const { manager, spawner, clock } = wireFakes();
    await manager.start();
    await manager.stop();
    await clock.drain();
    assert.equal(spawner.launches.length, 1, "stop must not trigger recovery");
    assert.equal(manager.state(), "STOPPED");
  });
});
