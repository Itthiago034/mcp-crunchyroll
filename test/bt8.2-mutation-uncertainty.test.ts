import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import {
  createBrowserApiBackend,
  CRUNCHYROLL_API_ORIGIN,
} from "../src/transport/browser-api-backend.js";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import type {
  ApiExecutionChannel,
  ApiExecutionRequest,
  ApiExecutionResponse,
} from "../src/transport/browser-lifecycle-types.js";
import { createOperationRegistry, PRODUCTION_OPERATIONS, resolveCall } from "../src/transport/operation-registry.js";
import { TransportError } from "../src/transport/transport-error.js";
import { wireFakes } from "./_fake-browser-seams.js";

const CONTENT_ID = "GY8VEQ95Y";
const ACCOUNT_ID = "BT82-REMEDIATION-ACCOUNT";
const TOKEN = "BT82-REMEDIATION-TOKEN";
const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
const mutationCall = () => resolveCall(registry, "ADD_TO_WATCHLIST", { content_id: CONTENT_ID });
const readCall = () => resolveCall(registry, "GET_WATCHLIST", { n: 20, order: "desc" });

function authority() {
  const value = createAuthContextAuthority();
  const writer = value.asWriter();
  writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", {
    accessToken: TOKEN,
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000,
    accountId: ACCOUNT_ID,
  } as never);
  return value;
}

function backendWith(
  request: (input: ApiExecutionRequest) => Promise<ApiExecutionResponse>,
  auth = authority(),
) {
  const requests: ApiExecutionRequest[] = [];
  const channel: ApiExecutionChannel = {
    connectionGeneration: 1,
    async request(input) {
      requests.push(input);
      return request(input);
    },
    async close() {},
  };
  return {
    auth,
    requests,
    backend: createBrowserApiBackend({
      reader: auth.asReader(),
      openChannel: async () => channel,
      deadlineMs: 100,
    }),
  };
}

function postDispatchError(
  reason: "deadline" | "disconnect" | "page-exception" | "malformed",
): BrowserLifecycleError {
  return new BrowserLifecycleError(
    reason === "disconnect" ? "BROWSER_DISCONNECTED" : "BROWSER_UNAVAILABLE",
    undefined,
    "POSSIBLY_DISPATCHED",
    reason,
  );
}

const REQUEST: ApiExecutionRequest = Object.freeze({
  url: `${CRUNCHYROLL_API_ORIGIN}/content/v2/${ACCOUNT_ID}/watchlist`,
  method: "POST",
  authorization: `Bearer ${TOKEN}`,
  deadlineMs: 25,
  maxBytes: 512 * 1024,
  body: { contentType: "application/json", text: JSON.stringify({ content_id: CONTENT_ID }) },
});

describe("BT8.2 remediation — session manager owns the dispatch boundary", () => {
  test("a channel refusal before Runtime.callFunctionOn stays PRE_DISPATCH", async () => {
    const h = wireFakes({ apiExecution: "success" });
    try {
      await h.manager.start();
      const channel = await h.manager.openApiExecutionChannel();
      await channel.close();
      await assert.rejects(channel.request(REQUEST), (error: unknown) =>
        error instanceof BrowserLifecycleError && error.dispatchState === "PRE_DISPATCH"
      );
      assert.equal(
        h.connector.connections[0].calls.filter((call) => call.method === "Runtime.callFunctionOn").length,
        0,
      );
    } finally {
      await h.manager.stop().catch(() => undefined);
      h.cleanup();
    }
  });

  test("deadline after Runtime.callFunctionOn is marked POSSIBLY_DISPATCHED", async () => {
    const h = wireFakes({ apiExecution: "pending" });
    try {
      await h.manager.start();
      const channel = await h.manager.openApiExecutionChannel();
      const pending = channel.request(REQUEST);
      await h.clock.advance(REQUEST.deadlineMs);
      await assert.rejects(pending, (error: unknown) =>
        error instanceof BrowserLifecycleError &&
        error.dispatchState === "POSSIBLY_DISPATCHED" &&
        error.uncertaintyReason === "deadline"
      );
      assert.equal(
        h.connector.connections[0].calls.filter((call) => call.method === "Runtime.callFunctionOn").length,
        1,
      );
      await channel.close();
    } finally {
      await h.manager.stop().catch(() => undefined);
      h.cleanup();
    }
  });

  for (const [mode, reason] of [
    ["disconnect", "disconnect"],
    ["page-exception", "page-exception"],
    ["malformed", "malformed"],
    ["null-result", "malformed"],
  ] as const) {
    test(`${mode} after Runtime.callFunctionOn carries structured uncertainty`, async () => {
      const h = wireFakes({ apiExecution: mode });
      try {
        await h.manager.start();
        const channel = await h.manager.openApiExecutionChannel();
        await assert.rejects(channel.request(REQUEST), (error: unknown) =>
          error instanceof BrowserLifecycleError &&
          error.dispatchState === "POSSIBLY_DISPATCHED" &&
          error.uncertaintyReason === reason
        );
        assert.equal(
          h.connector.connections[0].calls.filter((call) => call.method === "Runtime.callFunctionOn").length,
          1,
        );
        await channel.close();
      } finally {
        await h.manager.stop().catch(() => undefined);
        h.cleanup();
      }
    });
  }
});

describe("BT8.2 remediation — backend is mutation-aware and dispatch-aware", () => {
  test("a mutation failure proven before dispatch preserves BROWSER_UNAVAILABLE", async () => {
    const auth = authority();
    let opens = 0;
    const backend = createBrowserApiBackend({
      reader: auth.asReader(),
      openChannel: async () => {
        opens += 1;
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-page-context");
      },
    });
    await assert.rejects(backend.executeResolved(mutationCall()), (error: unknown) =>
      error instanceof TransportError && error.kind === "BROWSER_UNAVAILABLE"
    );
    assert.equal(opens, 1);
  });

  for (const reason of ["deadline", "disconnect", "page-exception", "malformed"] as const) {
    test(`post-dispatch ${reason} becomes MUTATION_OUTCOME_UNKNOWN once, without retry`, async () => {
      const h = backendWith(async () => { throw postDispatchError(reason); });
      await assert.rejects(h.backend.executeResolved(mutationCall()), (error: unknown) =>
        error instanceof TransportError &&
        error.kind === "MUTATION_OUTCOME_UNKNOWN" &&
        error.detail === reason
      );
      assert.equal(h.requests.length, 1);
    });
  }

  test("an equivalent post-dispatch read failure preserves BROWSER_UNAVAILABLE", async () => {
    const h = backendWith(async () => { throw postDispatchError("deadline"); });
    await assert.rejects(h.backend.executeResolved(readCall()), (error: unknown) =>
      error instanceof TransportError && error.kind === "BROWSER_UNAVAILABLE"
    );
    assert.equal(h.requests.length, 1);
  });

  test("over-cap and malformed mutation responses become UNKNOWN without retry", async () => {
    for (const [response, reason] of [
      [{ status: 204, contentType: "", body: "", truncated: true }, "over-cap"],
      [{ status: 204, contentType: "", body: "unexpected", truncated: false }, "malformed"],
    ] as const) {
      const h = backendWith(async () => response);
      await assert.rejects(h.backend.executeResolved(mutationCall()), (error: unknown) =>
        error instanceof TransportError &&
        error.kind === "MUTATION_OUTCOME_UNKNOWN" &&
        error.detail === reason
      );
      assert.equal(h.requests.length, 1);
    }
  });

  test("the equivalent over-cap read response preserves INVALID_RESPONSE", async () => {
    const h = backendWith(async () => ({
      status: 200,
      contentType: "application/json",
      body: "",
      truncated: true,
    }));
    await assert.rejects(h.backend.executeResolved(readCall()), (error: unknown) =>
      error instanceof TransportError &&
      error.kind === "INVALID_RESPONSE" &&
      error.detail === "over-cap"
    );
  });

  test("auth generation change after a completed mutation becomes UNKNOWN", async () => {
    const auth = authority();
    const h = backendWith(async () => {
      auth.invalidate("LOGOUT");
      return { status: 204, contentType: "", body: "", truncated: false };
    }, auth);
    await assert.rejects(h.backend.executeResolved(mutationCall()), (error: unknown) =>
      error instanceof TransportError &&
      error.kind === "MUTATION_OUTCOME_UNKNOWN" &&
      error.detail === "auth-generation"
    );
    assert.equal(h.requests.length, 1);
  });
});
