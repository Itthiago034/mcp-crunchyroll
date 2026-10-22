// Silent re-establishment through the orchestrator (Crunchyroll MCP 2.0).
//
// Deterministic: every race is a deferred barrier. No browser, no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createAuthOrchestrator, type AuthOrchestratorPorts } from "../src/transport/auth-orchestrator.js";
import type { ObservedAuthMaterial } from "../src/transport/browser-auth.js";

const MATERIAL: ObservedAuthMaterial = Object.freeze({
  accessToken: "SYNTHETIC-ACCESS-silent",
  tokenType: "Bearer",
  expiresAt: 9_999_999_999_999,
  accountId: "SYNTHETIC-ACCOUNT-silent",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

type Observation =
  | { kind: "OBSERVED"; material: ObservedAuthMaterial; connectionGeneration: number }
  | { kind: "TIMED_OUT" }
  | { kind: "CANCELLED" };

function harness() {
  let availability: "READY" | "UNAVAILABLE" = "UNAVAILABLE";
  const events: string[] = [];
  const observeOptions: Array<{ deadlineMs?: number; signal?: AbortSignal } | undefined> = [];
  const observations: Array<ReturnType<typeof deferred<Observation>>> = [];
  let surfaceOpens = 0;
  const ports: AuthOrchestratorPorts = {
    diagnostics: { availability: () => availability, hasProfileId: () => false },
    browser: {
      lifecycleState: () => "BROWSER_READY",
      connectionGeneration: () => 3,
      openLoginSurface: async () => { surfaceOpens += 1; events.push("surface"); },
    },
    producer: {
      establishFromObservedMaterial: async () => {
        events.push("install");
        availability = "READY";
        return { kind: "ESTABLISHED" };
      },
      logout: async () => {
        events.push("producer.logout");
        availability = "UNAVAILABLE";
        return { persistence: { state: "CLEARED" } };
      },
    },
    observer: {
      observeNextAuthMaterial: (options) => {
        events.push("observe");
        observeOptions.push(options);
        const next = deferred<Observation>();
        observations.push(next);
        options?.signal?.addEventListener("abort", () => next.resolve({ kind: "CANCELLED" }), { once: true });
        return next.promise as never;
      },
    },
    eligibility: {
      record: async () => { events.push("eligibility.record"); },
      clear: async () => { events.push("eligibility.clear"); },
    },
  };
  const orchestrator = createAuthOrchestrator(ports);
  const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  return {
    orchestrator,
    events,
    observeOptions,
    observations,
    settle,
    get surfaceOpens() { return surfaceOpens; },
    observe: (index: number, outcome: Observation) => observations[index].resolve(outcome),
  };
}

const observed = (): Observation => ({ kind: "OBSERVED", material: MATERIAL, connectionGeneration: 3 });

describe("orchestrator — establishSilently", () => {
  test("a silent attempt carries its short observation deadline and records eligibility on success", async () => {
    const h = harness();
    const pending = h.orchestrator.establishSilently({ observationDeadlineMs: 30_000 });
    await h.settle();
    assert.equal(h.observeOptions[0]?.deadlineMs, 30_000);
    h.observe(0, observed());
    assert.deepEqual(await pending, { accepted: true });
    assert.deepEqual(h.events, ["surface", "observe", "install", "eligibility.record"]);
  });

  test("an interactive login keeps the default (long) observation deadline", async () => {
    const h = harness();
    const pending = h.orchestrator.login();
    await h.settle();
    assert.equal(h.observeOptions[0]?.deadlineMs, undefined);
    h.observe(0, observed());
    await pending;
  });

  test("a silent attempt that times out installs nothing and records nothing", async () => {
    const h = harness();
    const pending = h.orchestrator.establishSilently({ observationDeadlineMs: 30_000 });
    await h.settle();
    h.observe(0, { kind: "TIMED_OUT" });
    assert.deepEqual(await pending, { accepted: false, reason: "NOT_ESTABLISHED" });
    assert.equal(h.events.includes("install"), false);
    assert.equal(h.events.includes("eligibility.record"), false);
  });

  test("silent attempts never stack: a second joins the first and opens no second surface", async () => {
    const h = harness();
    const a = h.orchestrator.establishSilently({ observationDeadlineMs: 30_000 });
    const b = h.orchestrator.establishSilently({ observationDeadlineMs: 30_000 });
    await h.settle();
    h.observe(0, observed());
    assert.deepEqual(await Promise.all([a, b]), [{ accepted: true }, { accepted: true }]);
    assert.equal(h.surfaceOpens, 1);
  });

  test("a silent attempt joins an interactive login already in flight", async () => {
    const h = harness();
    const interactive = h.orchestrator.login();
    const silent = h.orchestrator.establishSilently({ observationDeadlineMs: 30_000 });
    await h.settle();
    assert.equal(h.observations.length, 1);
    h.observe(0, observed());
    assert.equal((await interactive).accepted, true);
    assert.deepEqual(await silent, { accepted: true });
  });

  test("an interactive login during a failing silent attempt then waits for the human itself", async () => {
    const h = harness();
    const silent = h.orchestrator.establishSilently({ observationDeadlineMs: 30_000 });
    await h.settle();
    const interactive = h.orchestrator.login();
    h.observe(0, { kind: "TIMED_OUT" });
    await silent;
    await h.settle();
    assert.equal(h.observations.length, 2, "a second, interactive observation started");
    assert.equal(h.observeOptions[1]?.deadlineMs, undefined, "with the interactive deadline");
    h.observe(1, observed());
    assert.equal((await interactive).accepted, true);
  });

  test("logout cancels a silent attempt; material arriving afterwards never installs", async () => {
    const h = harness();
    const silent = h.orchestrator.establishSilently({ observationDeadlineMs: 30_000 });
    await h.settle();
    const logout = h.orchestrator.logout();
    const outcome = await silent;
    assert.equal(outcome.accepted, false);
    await logout;
    assert.equal(h.events.includes("install"), false);
    assert.ok(h.events.indexOf("eligibility.clear") < h.events.indexOf("producer.logout"), "eligibility is cleared first");
  });

  test("no silent attempt during logout or after a provider revocation", async () => {
    const h = harness();
    const logout = h.orchestrator.logout();
    assert.deepEqual(await h.orchestrator.establishSilently({ observationDeadlineMs: 1 }), { accepted: false, reason: "LOGGING_OUT" });
    await logout;
    h.orchestrator.signalReauthRequired();
    assert.deepEqual(await h.orchestrator.establishSilently({ observationDeadlineMs: 1 }), { accepted: false, reason: "REAUTH_REQUIRED" });
    assert.equal(h.surfaceOpens, 0);
    await h.settle();
    assert.equal(h.events.filter((e) => e === "eligibility.clear").length, 2, "logout and revocation both clear eligibility");
  });
});
