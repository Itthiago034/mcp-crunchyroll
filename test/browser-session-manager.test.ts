import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
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

  test("stop closes Chromium through CDP without signals and preserves the profile", async () => {
    const { manager, spawner, connector, profileDir } = wireFakes();
    await manager.start();
    await manager.stop();
    assert.equal(manager.state(), "STOPPED");
    assert.equal(connector.connections[0].calls.filter((call) => call.method === "Browser.close").length, 1);
    assert.equal(spawner.launches[0].terminationRequested, false);
    assert.equal(spawner.launches[0].forceKilled, false);
    assert.equal(statSync(profileDir).mode & 0o777, 0o700, "the profile survives stop");
  });

  test("a close acknowledgement does not stop the manager before the child exits", async () => {
    const { manager, spawner, clock } = wireFakes({ ignoreBrowserClose: true, cdpCommandTimeoutMs: 100 });
    await manager.start();
    const stopping = manager.stop();
    await clock.advance(99);
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(spawner.launches[0].terminationRequested, false);
    await spawner.launches[0].emitExit(0, null);
    await stopping;
    assert.equal(manager.state(), "STOPPED");
    assert.equal(spawner.launches[0].terminationRequested, false);
    await clock.drain();
    assert.equal(spawner.launches[0].forceKilled, false);
  });

  for (const options of [{ ignoreBrowserClose: true }, { failBrowserClose: true }]) {
    test(`stop falls back to SIGTERM after the CDP deadline (${Object.keys(options)[0]})`, async () => {
      const { manager, spawner, clock } = wireFakes({ ...options, cdpCommandTimeoutMs: 100 });
      await manager.start();
      const stopping = manager.stop();
      await clock.advance(99);
      assert.equal(spawner.launches[0].terminationRequested, false);
      await clock.advance(1);
      await stopping;
      assert.equal(spawner.launches[0].terminationRequested, true);
      assert.equal(spawner.launches[0].forceKilled, false);
    });
  }

  test("stop escalates to force kill only after CDP close and SIGTERM deadlines", async () => {
    const { manager, spawner, clock } = wireFakes({ ignoreBrowserClose: true, ignoreSigterm: true, cdpCommandTimeoutMs: 100 });
    await manager.start();
    const stopping = manager.stop();
    await clock.advance(100);
    assert.equal(spawner.launches[0].terminationRequested, true);
    assert.equal(spawner.launches[0].forceKilled, false);
    await clock.advance(99);
    assert.equal(spawner.launches[0].forceKilled, false);
    await clock.advance(1);
    await stopping;
    assert.equal(spawner.launches[0].forceKilled, true);
  });

  test("the manager exposes only lifecycle verbs", () => {
    const { manager } = wireFakes();
    // BT4 adds exactly ONE narrow verb: openResponseInterception. It returns a
    // closed channel (paused notification, bounded body read, continue, close)
    // and is NOT a generic CDP surface — there is still no `send`, no method
    // string, no evaluate and no cookie access on this object.
    //
    // BT4-R1 adds `connectionGeneration`: read-only evidence of connection
    // identity. It answers with a number and grants no capability at all.
    // BT5 adds `openApiExecutionChannel`: one more CLOSED channel, not a
    // generic surface. It runs one frozen function with structured arguments
    // on the managed Crunchyroll page and exposes no method string.
    // `reloadManagedPage` navigates the existing managed page back to the
    // fixed composition-time URL so an expired bearer can be re-minted; the
    // caller supplies no URL, method or argument.
    assert.deepEqual(Object.keys(manager).sort(), [
      "connectionGeneration",
      "ensureManagedPage",
      "managedPageId",
      "onLifecycleEvent",
      "onStateChange",
      "openApiExecutionChannel",
      "openResponseInterception",
      "openWatchPage",
      "reloadManagedPage",
      "restart",
      "start",
      "state",
      "stop",
    ]);
    for (const forbidden of ["send", "evaluate", "cookies", "navigate", "cdp"]) {
      assert.equal(
        (manager as unknown as Record<string, unknown>)[forbidden],
        undefined,
        `the manager must not expose ${forbidden}`
      );
    }
  });

  test("BT4-R1: the connection generation is undefined until a connection is live", async () => {
    const { manager } = wireFakes();
    assert.equal(manager.connectionGeneration(), undefined, "nothing is live yet");

    await manager.start();
    const live = manager.connectionGeneration();
    assert.equal(typeof live, "number");
    assert.ok((live as number) > 0, "a live connection has a positive generation");

    await manager.stop();
    assert.equal(manager.connectionGeneration(), undefined, "stopped means no generation");
  });

  test("BT4-R1: a reconnect produces a NEW generation, never the old one", async () => {
    const { manager, connector, clock } = wireFakes();
    await manager.start();
    const before = manager.connectionGeneration();

    connector.connections[0].emitClose();
    await clock.drain();

    assert.equal(manager.state(), "BROWSER_READY");
    const after = manager.connectionGeneration();
    assert.notEqual(after, before, "material observed on the old connection must not match");
    assert.equal(typeof after, "number");
  });

  test("createRealBrowserSessionSeams returns all production seams", () => {
    const seams = createRealBrowserSessionSeams(10_000);
    assert.equal(typeof seams.spawner.spawn, "function");
    assert.equal(typeof seams.clock.now, "function");
    assert.equal(typeof seams.clock.sleep, "function");
    assert.equal(typeof seams.clock.setTimeout, "function");
    assert.equal(typeof seams.connector.connect, "function");
    assert.equal("argv" in seams.processInspector, false);
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

describe("BT2 session manager — CDP disconnect and reconnect", () => {
  test("a close immediately after connect prevents BROWSER_READY", async () => {
    const { manager } = wireFakes({ closeImmediatelyAfterConnect: true });
    await assert.rejects(
      () => manager.start(),
      (error: unknown) => error instanceof BrowserLifecycleError,
    );
    assert.notEqual(manager.state(), "BROWSER_READY");
  });

  test("a close after Browser.getVersion but before readiness prevents BROWSER_READY", async () => {
    const { manager } = wireFakes({ closeAfterHandshake: true });
    await assert.rejects(
      () => manager.start(),
      (error: unknown) => error instanceof BrowserLifecycleError,
    );
    assert.notEqual(manager.state(), "BROWSER_READY");
  });

  test("a CDP close moves BROWSER_READY → DEGRADED immediately", async () => {
    const { manager, connector } = wireFakes();
    await manager.start();
    connector.connections[0].emitClose();
    assert.equal(manager.state(), "DEGRADED");
  });

  test("the first reconnect succeeds and does NOT spawn a second browser", async () => {
    const { manager, connector, spawner, clock } = wireFakes();
    await manager.start();
    connector.connections[0].emitClose();
    await clock.drain();
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(spawner.launches.length, 1, "a dropped socket must not start a second browser");
    assert.equal(connector.connections.length, 2, "exactly one reconnect");
  });

  test("transient reconnect failures follow the exact backoff, then succeed", async () => {
    const { manager, connector, spawner, clock } = wireFakes({ failReconnects: 2 });
    await manager.start();
    connector.connections[0].emitClose();
    await clock.drain();
    assert.deepEqual(clock.sleeps, [250, 500]);
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(spawner.launches.length, 1);
  });

  test("exhausted reconnects end in STOPPED with RECOVERY_EXHAUSTED", async () => {
    const { manager, connector, spawner, clock, events } = wireFakes({
      failReconnects: Infinity,
    });
    await manager.start();
    connector.connections[0].emitClose();
    await clock.drain();
    assert.equal(manager.state(), "STOPPED");
    assert.deepEqual(clock.sleeps, [250, 500, 1000], "bounded, no infinite loop");
    assert.ok(events.some((event) => event.type === "recovery.exhausted"));
    assert.equal(spawner.launches.length, 1, "never escalates into spawning a browser");
  });

  test("duplicate close paths produce one DEGRADED transition and reconnect loop", async () => {
    const { manager, connector, clock, transitions } = wireFakes();
    await manager.start();
    connector.connections[0].emitClose();
    connector.connections[0].emitHistoricalClose();
    await clock.drain();
    assert.equal(
      transitions.filter(([, to]) => to === "DEGRADED").length,
      1,
    );
    assert.equal(connector.connections.length, 2);
  });

  test("a stale old-generation close cannot disrupt the active replacement", async () => {
    const { manager, connector, clock } = wireFakes();
    await manager.start();
    const oldConnection = connector.connections[0];
    oldConnection.emitClose();
    await clock.drain();
    assert.equal(manager.state(), "BROWSER_READY");
    oldConnection.emitHistoricalClose();
    await clock.drain();
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(connector.connections.length, 2);
  });

  test("a CDP close during manager stop starts no recovery", async () => {
    const { manager, connector, clock } = wireFakes();
    await manager.start();
    const stopping = manager.stop();
    connector.connections[0].emitClose();
    await clock.drain();
    await stopping;
    assert.equal(manager.state(), "STOPPED");
    assert.equal(connector.connections.length, 1, "no reconnect attempted during stop");
  });
});

describe("BT2 session manager — managed page", () => {
  const createCalls = (connection: {
    calls: Array<{ method: string; params?: Record<string, unknown> }>;
  }) => connection.calls.filter((call) => call.method === "Target.createTarget");

  test("no managed page exists until it is requested", async () => {
    const { manager } = wireFakes();
    await manager.start();
    assert.equal(manager.managedPageId(), undefined, "lazy: MCP startup must not open a page");
  });

  test("ensureManagedPage creates one page and is idempotent", async () => {
    const { manager, connector } = wireFakes();
    await manager.start();
    const first = await manager.ensureManagedPage();
    const second = await manager.ensureManagedPage();
    assert.equal(first, second);
    assert.equal(createCalls(connector.connections[0]).length, 1);
  });

  test("the page is created at the configured origin and takes no argument", async () => {
    const { manager, connector } = wireFakes({ initialPageUrl: "http://127.0.0.1:9/ok" });
    await manager.start();
    await manager.ensureManagedPage();
    const create = createCalls(connector.connections[0])[0];
    assert.equal(create.params?.url, "http://127.0.0.1:9/ok");
    assert.equal(manager.ensureManagedPage.length, 0, "no caller-supplied URL parameter exists");
  });

  test("an existing page on the managed origin is reused instead of opening another tab", async () => {
    const { manager, connector } = wireFakes({
      initialPageUrl: "http://127.0.0.1:9/login",
      watchPageBaseUrl: "http://127.0.0.1:9/watch/",
    });
    await manager.start();
    connector.connections[0].targetInfos = [
      { type: "page", targetId: "playing", url: "http://127.0.0.1:9/watch/GE1", attached: false },
      { type: "page", targetId: "elsewhere", url: "http://other.invalid/", attached: false },
      { type: "service_worker", targetId: "sw", url: "http://127.0.0.1:9/sw.js", attached: false },
      { type: "page", targetId: "left-behind", url: "http://127.0.0.1:9/discover", attached: false },
    ];
    assert.equal(await manager.ensureManagedPage(), "left-behind");
    assert.equal(createCalls(connector.connections[0]).length, 0, "no new tab was opened");
  });

  test("reloadManagedPage reloads the existing managed page and takes no URL", async () => {
    const { manager, connector } = wireFakes({ initialPageUrl: "http://127.0.0.1:9/ok" });
    await manager.start();
    await manager.reloadManagedPage();
    const reloadsOf = () => connector.connections[0].calls.filter((call) => call.method === "Page.reload");
    assert.equal(reloadsOf().length, 0, "no page yet: nothing to reload and none is created");
    assert.equal(manager.managedPageId(), undefined);

    await manager.ensureManagedPage();
    await manager.reloadManagedPage();
    assert.equal(reloadsOf().length, 1);
    assert.equal(
      connector.connections[0].calls.filter((call) => call.method === "Page.navigate").length,
      0,
      "a reload never navigates to the login URL"
    );
    assert.equal(manager.reloadManagedPage.length, 0, "no caller-supplied URL parameter exists");
  });

  test("openWatchPage opens one focused tab at the fixed prefix and refuses anything but an id", async () => {
    const { manager, connector } = wireFakes({ watchPageBaseUrl: "http://127.0.0.1:9/watch/" });
    await manager.start();
    for (const bad of ["", "g8dhv78zm", "../login", "G8DHV78ZM/x", "https://evil.example/", "A".repeat(33)]) {
      await assert.rejects(manager.openWatchPage(bad), BrowserLifecycleError, bad);
    }
    await manager.openWatchPage("GRVN8MNQY");
    const calls = connector.connections[0].calls;
    const creates = calls.filter((call) => call.method === "Target.createTarget");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].params?.url, "http://127.0.0.1:9/watch/GRVN8MNQY");
    assert.equal(calls.filter((call) => call.method === "Target.activateTarget").length, 1);
    assert.equal(manager.managedPageId(), undefined, "the playback tab is not the managed page");
  });

  test("openWatchPage reuses an existing playback tab instead of stacking tabs", async () => {
    const { manager, connector } = wireFakes({ watchPageBaseUrl: "http://127.0.0.1:9/watch/" });
    await manager.start();
    connector.connections[0].targetInfos = [
      { type: "page", targetId: "home", url: "http://127.0.0.1:9/discover", attached: false },
      { type: "page", targetId: "playing", url: "http://127.0.0.1:9/watch/GOLD/slug", attached: false },
    ];
    await manager.openWatchPage("GNEW");
    const calls = connector.connections[0].calls;
    assert.equal(calls.filter((call) => call.method === "Target.createTarget").length, 0);
    const navigation = calls.find((call) => call.method === "Page.navigate");
    assert.equal(navigation?.params?.url, "http://127.0.0.1:9/watch/GNEW");
    assert.deepEqual(
      calls.filter((call) => call.method === "Target.activateTarget").map((call) => call.params?.targetId),
      ["playing"]
    );
  });

  test("openWatchPage is unavailable without a configured prefix", async () => {
    const { manager } = wireFakes();
    await manager.start();
    await assert.rejects(manager.openWatchPage("GRVN8MNQY"), BrowserLifecycleError);
  });

  test("a destroyed page is AUTOMATICALLY recreated exactly once", async () => {
    const { manager, connector, clock } = wireFakes();
    await manager.start();
    const first = await manager.ensureManagedPage();
    connector.connections[0].emitEvent("Target.targetDestroyed", { targetId: first });
    await clock.drain();
    assert.equal(createCalls(connector.connections[0]).length, 2, "auto-recreated");
    const second = manager.managedPageId();
    assert.ok(second);
    assert.notEqual(second, first);
  });

  test("duplicate destroy events recreate only one page", async () => {
    const { manager, connector, clock } = wireFakes();
    await manager.start();
    const first = await manager.ensureManagedPage();
    connector.connections[0].emitEvent("Target.targetDestroyed", { targetId: first });
    connector.connections[0].emitEvent("Target.targetDestroyed", { targetId: first });
    await clock.drain();
    assert.equal(createCalls(connector.connections[0]).length, 2, "single-flight recreation");
  });

  test("a destroy event for an unrelated target is ignored", async () => {
    const { manager, connector, clock } = wireFakes();
    await manager.start();
    const first = await manager.ensureManagedPage();
    connector.connections[0].emitEvent("Target.targetDestroyed", { targetId: "someone-else" });
    await clock.drain();
    assert.equal(manager.managedPageId(), first);
    assert.equal(createCalls(connector.connections[0]).length, 1);
  });

  test("the page is NOT recreated during stop", async () => {
    const { manager, connector, clock } = wireFakes();
    await manager.start();
    const first = await manager.ensureManagedPage();
    const stopping = manager.stop();
    connector.connections[0].emitEvent("Target.targetDestroyed", { targetId: first });
    await clock.drain();
    await stopping;
    assert.equal(createCalls(connector.connections[0]).length, 1, "no recreation during shutdown");
    assert.equal(manager.managedPageId(), undefined);
  });

  test("stopping invalidates the managed page reference", async () => {
    const { manager } = wireFakes();
    await manager.start();
    await manager.ensureManagedPage();
    await manager.stop();
    assert.equal(manager.managedPageId(), undefined);
  });

  test("ensureManagedPage fails when the browser is not ready", async () => {
    const { manager } = wireFakes();
    await assert.rejects(
      () => manager.ensureManagedPage(),
      (error: unknown) =>
        error instanceof BrowserLifecycleError && error.kind === "BROWSER_UNAVAILABLE",
    );
  });
});

describe("BT2 session manager — owned-browser reuse and orphans", () => {
  test("distinct exact launcher and runtime identities adopt successfully", async () => {
    const { manager, spawner } = wireFakes({
      existingOwnedBrowser: "valid-distinct-executables",
    });
    await manager.start();
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(spawner.launches.length, 0, "distinct identities alone do not reject adoption");
  });

  test("a launcher mismatch rejects adoption even when runtime identity matches", async () => {
    const { manager, spawner, processInspector } = wireFakes({
      existingOwnedBrowser: "launcher-mismatch",
    });
    await manager.start();
    assert.equal(spawner.launches.length, 1);
    assert.equal("signalIfIdentityMatches" in processInspector, false);
  });

  test("a runtime mismatch rejects adoption even when launcher identity matches", async () => {
    const { manager, spawner } = wireFakes({
      existingOwnedBrowser: "runtime-mismatch",
    });
    await manager.start();
    assert.equal(spawner.launches.length, 1);
  });

  test("all thirteen valid checks adopt with zero spawn", async () => {
    const { manager, spawner } = wireFakes({ existingOwnedBrowser: "valid" });
    await manager.start();
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(spawner.launches.length, 0, "adoption, not launch");
    assert.equal(manager.managedPageId(), undefined, "never adopts an orphan tab");
  });

  test("a valid SingletonLock adopts even when Brave rewrites cmdline boundaries", async () => {
    const { manager, spawner } = wireFakes({
      existingOwnedBrowser: "singleton-valid-rewritten-cmdline",
    });
    await manager.start();
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(spawner.launches.length, 0, "exact profile-to-retained-pid binding adopts");
  });

  test("a fresh launch accepts an exact SingletonLock without runtime argv boundaries", async () => {
    const { manager } = wireFakes({ runtimeCmdlineRewritten: true });
    await manager.start();
    assert.equal(manager.state(), "BROWSER_READY");
  });

  for (const [label, fixture] of [
    ["stale PID", "stale-pid"],
    ["record profile mismatch", "record-profile-mismatch"],
    ["missing SingletonLock", "singleton-missing"],
    ["regular-file SingletonLock", "singleton-regular-file"],
    ["SingletonLock hostname mismatch", "singleton-wrong-hostname"],
    ["SingletonLock pid mismatch", "singleton-wrong-pid"],
    ["canonical executable mismatch", "canonical-executable-mismatch"],
    ["start-time mismatch", "starttime-mismatch"],
    ["malformed endpoint", "bad-endpoint"],
    ["failed Browser.getVersion", "handshake-fails"],
  ] as const) {
    test(`${label} rejects adoption, launches fresh and signals no pid`, async () => {
      const { manager, spawner, processInspector } = wireFakes({
        existingOwnedBrowser: fixture,
      });
      await manager.start();
      assert.equal(spawner.launches.length, 1);
      assert.equal("signalIfIdentityMatches" in processInspector, false);
    });
  }

  test("a symlink launcher adopts when canonical executable identity matches", async () => {
    const { manager, spawner } = wireFakes({
      existingOwnedBrowser: "valid-symlink-executable",
    });
    await manager.start();
    assert.equal(manager.state(), "BROWSER_READY");
    assert.equal(spawner.launches.length, 0);
  });

  test("an adopted process disappearance is unknown exit and never relaunches", async () => {
    const { manager, spawner, processInspector, clock, events } = wireFakes({
      existingOwnedBrowser: "valid",
    });
    await manager.start();
    processInspector.setStartTime(processInspector.adoptedPid, null);
    await clock.advance(250);
    assert.equal(manager.state(), "STOPPED");
    assert.equal(spawner.launches.length, 0, "no silent crash-style relaunch");
    assert.ok(events.some((event) =>
      event.type === "exit.classified" &&
      event.classification === "ADOPTED_EXIT_UNKNOWN"));
  });

  test("adopted stop sends Browser.close once and no OS signal API exists", async () => {
    const { manager, connector, processInspector, spawner, clock } = wireFakes({
      existingOwnedBrowser: "valid",
      adoptedExitsOnClose: true,
    });
    await manager.start();
    const stopping = manager.stop();
    await clock.drain();
    await stopping;
    assert.equal(
      connector.connections[0].calls.filter((call) => call.method === "Browser.close").length,
      1,
    );
    assert.equal("signalIfIdentityMatches" in processInspector, false);
    assert.equal(spawner.launches.length, 0);
  });

  test("adopted disappearance within the deadline clears metadata and preserves profile", async () => {
    const { manager, profileDir, clock } = wireFakes({
      existingOwnedBrowser: "valid",
      adoptedExitsOnClose: true,
    });
    await manager.start();
    const stopping = manager.stop();
    await clock.drain();
    await stopping;
    assert.equal(manager.state(), "STOPPED");
    assert.equal(existsSync(join(profileDir, ".mcp-browser-owner.json")), false);
    assert.equal(existsSync(join(profileDir, "DevToolsActivePort")), false);
    assert.equal(statSync(profileDir).mode & 0o777, 0o700);
  });

  test("adopted stop timeout sends no signal and preserves ownership/profile", async () => {
    const { manager, profileDir, clock, processInspector } = wireFakes({
      existingOwnedBrowser: "valid",
      cdpCommandTimeoutMs: 100,
    });
    await manager.start();
    const stopping = manager.stop();
    await clock.advance(100);
    await assert.rejects(
      () => stopping,
      (error: unknown) =>
        error instanceof BrowserLifecycleError && error.kind === "BROWSER_STOP_TIMEOUT",
    );
    assert.equal(manager.state(), "STOPPED");
    assert.equal(existsSync(join(profileDir, ".mcp-browser-owner.json")), true);
    assert.equal(existsSync(join(profileDir, "DevToolsActivePort")), true);
    assert.equal(statSync(profileDir).mode & 0o777, 0o700);
    assert.equal("signalIfIdentityMatches" in processInspector, false);
  });

  test("explicit start after stop timeout performs complete validation again", async () => {
    const { manager, spawner, processInspector, clock } = wireFakes({
      existingOwnedBrowser: "valid",
      cdpCommandTimeoutMs: 100,
    });
    await manager.start();
    const firstInspectionCount = processInspector.inspectionCalls.length;
    const stopping = manager.stop();
    await clock.advance(100);
    await assert.rejects(() => stopping);
    processInspector.setStartTime(processInspector.adoptedPid, 9_999_999);
    await manager.start();
    assert.ok(processInspector.inspectionCalls.length > firstInspectionCount);
    assert.equal(spawner.launches.length, 1, "invalid former owner causes fresh launch");
  });

  test("identity change during adopted stop completes conservatively without OS signal", async () => {
    const { manager, processInspector, profileDir, clock } = wireFakes({
      existingOwnedBrowser: "valid",
    });
    await manager.start();
    const stopping = manager.stop();
    processInspector.setStartTime(processInspector.adoptedPid, 9_999_999);
    await clock.advance(250);
    await stopping;
    assert.equal(manager.state(), "STOPPED");
    assert.equal(existsSync(join(profileDir, ".mcp-browser-owner.json")), false);
  });

  test("a fresh launch records distinct launcher and post-handshake runtime identities", async () => {
    const { manager, profileDir, processInspector } = wireFakes({
      distinctRuntimeExecutable: true,
    });
    await manager.start();
    const path = join(profileDir, ".mcp-browser-owner.json");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      profile: string;
      launcherExecutable: string;
      runtimeExecutable: string;
      startTimeTicks: number;
      executable?: string;
    };
    assert.equal(record.profile, realpathSync(profileDir));
    assert.equal(record.launcherExecutable, processInspector.canonicalLauncherExecutable);
    assert.equal(record.runtimeExecutable, processInspector.canonicalRuntimeExecutable);
    assert.equal("executable" in record, false, "the ambiguous field is absent");
    assert.equal(typeof record.startTimeTicks, "number");
  });

  test("spawned stop clears ownership record and preserves profile", async () => {
    const { manager, profileDir } = wireFakes();
    await manager.start();
    await manager.stop();
    assert.equal(existsSync(join(profileDir, ".mcp-browser-owner.json")), false);
    assert.equal(statSync(profileDir).mode & 0o777, 0o700);
  });
});
