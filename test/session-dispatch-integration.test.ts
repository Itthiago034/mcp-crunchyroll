// Adversarial audit: the "nothing was dispatched" proof, through the REAL
// registry → dispatcher → backend → authority chain, composed exactly as the
// composition root does it (the dispatch probe rides an AsyncLocalStorage and
// is set by the backend's channel opener). Synthetic material only.

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, test } from "node:test";
import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import type { ApiExecutionChannel, ApiExecutionRequest } from "../src/transport/browser-lifecycle-types.js";
import { createBrowserApiBackend } from "../src/transport/browser-api-backend.js";
import { createContentGateway } from "../src/transport/content-gateway.js";
import { createTransportDispatcher } from "../src/transport/dispatcher.js";
import { createOperationRegistry, PRODUCTION_OPERATIONS } from "../src/transport/operation-registry.js";
import { callWithSession, createSessionRecovery, type DispatchProbe } from "../src/transport/session-recovery.js";
import { TransportError } from "../src/transport/transport-error.js";

const BEARER = "SYNTHETIC-BEARER-dispatch-audit";

function compose(options: { install?: boolean; respond?: (input: ApiExecutionRequest) => unknown } = {}) {
  const authority = createAuthContextAuthority();
  const install = () => {
    const writer = authority.asWriter();
    writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", {
      accessToken: BEARER,
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
      accountId: "SYNTHETIC-ACCOUNT",
    });
  };
  if (options.install) install();
  const requests: ApiExecutionRequest[] = [];
  let opens = 0;
  const dispatchScope = new AsyncLocalStorage<DispatchProbe>();
  const channel: ApiExecutionChannel = {
    connectionGeneration: 1,
    async request(input) {
      requests.push(input);
      return (options.respond?.(input) ?? {
        status: 204,
        contentType: "",
        body: "",
        truncated: false,
      }) as never;
    },
    async close() {},
  };
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const backend = createBrowserApiBackend({
    // Exactly the composition root's opener.
    openChannel: async () => {
      const probe = dispatchScope.getStore();
      if (probe) probe.dispatched = true;
      opens += 1;
      return channel;
    },
    reader: authority.asReader(),
  });
  const gateway = createContentGateway(createTransportDispatcher(registry, backend), registry);
  let silentAttempts = 0;
  const recovery = createSessionRecovery({
    usable: () => authority.hasUsableRecord(),
    diagnostics: () => authority.diagnostics(),
    authState: () => (authority.hasUsableRecord() ? "PROFILE_READY" : "LOGIN_REQUIRED"),
    eligibleForColdStart: async () => true,
    establishSilently: async () => {
      silentAttempts += 1;
      install();
      return true;
    },
    now: () => Date.now(),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
  });
  const call = (name: string, args: Record<string, unknown>) =>
    callWithSession(
      recovery,
      (probe) => dispatchScope.run(probe, () => gateway.callTool(name, args)),
      (error) => error instanceof TransportError && error.kind === "AUTH_NOT_READY",
    );
  return { authority, gateway, dispatchScope, call, requests, get opens() { return opens; }, get silentAttempts() { return silentAttempts; } };
}

describe("audit — dispatch proof through the real transport chain", () => {
  test("without a usable session the backend refuses BEFORE opening a channel (probe stays false)", async () => {
    const c = compose();
    const probe: DispatchProbe = { dispatched: false };
    await assert.rejects(
      c.dispatchScope.run(probe, () => c.gateway.callTool("crunchyroll_add_to_watchlist", { content_id: "GABC" })),
      (e: unknown) => e instanceof TransportError && e.kind === "AUTH_NOT_READY",
    );
    assert.equal(probe.dispatched, false);
    assert.equal(c.opens, 0);
    assert.equal(c.requests.length, 0);
  });

  test("with a usable session the probe is set before the request leaves", async () => {
    const c = compose({ install: true });
    const probe: DispatchProbe = { dispatched: false };
    await c.dispatchScope.run(probe, () => c.gateway.callTool("crunchyroll_add_to_watchlist", { content_id: "GABC" }));
    assert.equal(probe.dispatched, true);
    assert.equal(c.requests.length, 1);
  });

  test("cold start mutation: one silent establishment, exactly ONE provider write", async () => {
    const c = compose();
    await c.call("crunchyroll_add_to_watchlist", { content_id: "GABC" });
    assert.equal(c.silentAttempts, 1);
    assert.equal(c.requests.length, 1, "the write is sent once");
    assert.equal(c.requests[0].method, "POST");
  });

  test("concurrent cold-start mutations: one establishment, one write each, no duplicates", async () => {
    const c = compose();
    await Promise.all([
      c.call("crunchyroll_add_to_watchlist", { content_id: "GAAA" }),
      c.call("crunchyroll_add_to_watchlist", { content_id: "GBBB" }),
      c.call("crunchyroll_remove_from_watchlist", { content_id: "GCCC" }),
    ]);
    assert.equal(c.silentAttempts, 1);
    assert.equal(c.requests.length, 3);
    assert.equal(new Set(c.requests.map((r) => `${r.method} ${r.url} ${r.body?.text ?? ""}`)).size, 3, "three distinct writes");
  });

  test("a write whose outcome becomes uncertain after dispatch is never repeated", async () => {
    const c = compose({
      install: true,
      respond: () => { throw new Error("connection lost after dispatch"); },
    });
    await assert.rejects(c.call("crunchyroll_add_to_watchlist", { content_id: "GABC" }));
    assert.equal(c.requests.length, 1);
    assert.equal(c.silentAttempts, 0);
  });

  test("concurrent probes never bleed into each other (one store per call)", async () => {
    const c = compose({ install: true });
    const a: DispatchProbe = { dispatched: false };
    const b: DispatchProbe = { dispatched: false };
    const unauth = compose();
    await Promise.all([
      c.dispatchScope.run(a, () => c.gateway.callTool("crunchyroll_add_to_watchlist", { content_id: "GA" })),
      unauth.dispatchScope.run(b, () => unauth.gateway.callTool("crunchyroll_add_to_watchlist", { content_id: "GB" })).catch(() => undefined),
    ]);
    assert.equal(a.dispatched, true);
    assert.equal(b.dispatched, false);
  });

  test("the bearer never appears in a structured session error", async () => {
    const c = compose({ install: true });
    c.authority.asWriter().invalidate("LOGOUT");
    const error = await c.call("crunchyroll_get_history", { n: 1 }).catch((e: unknown) => e);
    assert.equal(JSON.stringify(error).includes(BEARER), false);
    assert.equal(String((error as Error).message).includes(BEARER), false);
  });
});

describe("audit — classification against the REAL authority", () => {
  function realRecovery(now: () => number) {
    const authority = createAuthContextAuthority({ now });
    let attempts = 0;
    const recovery = createSessionRecovery({
      usable: () => authority.hasUsableRecord(),
      diagnostics: () => authority.diagnostics(),
      authState: () => "LOGIN_REQUIRED",
      eligibleForColdStart: async () => false,
      establishSilently: async () => { attempts += 1; return false; },
      now,
      schedule: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
    });
    const install = () => {
      const writer = authority.asWriter();
      writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", {
        accessToken: BEARER, tokenType: "Bearer", expiresAt: now() + 60_000, accountId: "SYNTHETIC-ACCOUNT",
      });
    };
    return { authority, recovery, install, get attempts() { return attempts; } };
  }

  test("fresh, usable, expired, logged out and revoked map to the expected states", () => {
    let time = 1_000_000;
    const r = realRecovery(() => time);
    assert.equal(r.recovery.classify(), "NEVER_ESTABLISHED");
    r.install();
    assert.equal(r.recovery.classify(), "USABLE");
    time += 61_000;
    assert.equal(r.recovery.classify(), "EXPIRED", "READY but past expiry");
    r.authority.asWriter().invalidate("LOGOUT");
    assert.equal(r.recovery.classify(), "LOGGED_OUT");

    const revoked = realRecovery(() => time);
    revoked.install();
    revoked.authority.asWriter().invalidate("INVALID_GRANT");
    assert.equal(revoked.recovery.classify(), "REVOKED");
  });

  test("after a real logout no silent attempt runs, even if a marker were present", async () => {
    const r = realRecovery(() => Date.now());
    r.install();
    r.authority.asWriter().invalidate("LOGOUT");
    const outcome = await r.recovery.ensureSession();
    assert.deepEqual(outcome, { ok: false, code: "LOGGED_OUT", from: "LOGGED_OUT" });
    assert.equal(r.attempts, 0);
  });
});
