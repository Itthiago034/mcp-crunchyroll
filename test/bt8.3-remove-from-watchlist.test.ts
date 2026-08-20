import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import {
  buildRequestBody,
  buildRequestUrl,
  createBrowserApiBackend,
} from "../src/transport/browser-api-backend.js";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { createContentGateway } from "../src/transport/content-gateway.js";
import { createTransportDispatcher } from "../src/transport/dispatcher.js";
import {
  createOperationRegistry,
  PRODUCTION_OPERATIONS,
  resolveCall,
} from "../src/transport/operation-registry.js";
import { TransportError } from "../src/transport/transport-error.js";
import type {
  ApiExecutionChannel,
  ApiExecutionResponse,
} from "../src/transport/browser-lifecycle-types.js";
import type { TransportResult } from "../src/transport/types.js";
import { FakeTransportBackend } from "./_fake-backend.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REMOVE_OPERATION = "REMOVE_FROM_WATCHLIST";
const ADD_OPERATION = "ADD_TO_WATCHLIST";
const UPDATE_OPERATION = "UPDATE_PLAYHEAD";
const CONTENT_ID = "GY8VEQ95Y";
const ACCOUNT_ID = "AUTH-DERIVED-ACCOUNT-BT83";
const TOKEN = "AUTH-DERIVED-TOKEN-BT83";

function readyAuthority() {
  const authority = createAuthContextAuthority();
  const writer = authority.asWriter();
  writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", {
    accessToken: TOKEN,
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000,
    accountId: ACCOUNT_ID,
  } as never);
  return authority;
}

function channelFor(response: ApiExecutionResponse) {
  const requests: Array<Record<string, unknown>> = [];
  const channel: ApiExecutionChannel = {
    connectionGeneration: 1,
    async request(input) {
      requests.push(input as unknown as Record<string, unknown>);
      return response;
    },
    async close() {},
  };
  return { channel, requests };
}

function backendHarness(response: ApiExecutionResponse) {
  const authority = readyAuthority();
  const fake = channelFor(response);
  const backend = createBrowserApiBackend({
    openChannel: async () => fake.channel,
    reader: authority.asReader(),
    deadlineMs: 5_000,
  });
  return { backend, fake };
}

function gatewayHarness(result: TransportResult = { status: 204, contentType: "", json: undefined }) {
  const backend = new FakeTransportBackend({ result });
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const gateway = createContentGateway(createTransportDispatcher(registry, backend), registry);
  return { backend, gateway, registry };
}

describe("BT8.3 — REMOVE_FROM_WATCHLIST production contract", () => {
  test("registers REMOVE with the proved bodyless item DELETE contract", () => {
    const descriptor = PRODUCTION_OPERATIONS.find((entry) => String(entry.id) === REMOVE_OPERATION);
    assert.ok(descriptor, "REMOVE_FROM_WATCHLIST must be registered");
    assert.equal(descriptor.mutation, "ACCOUNT");
    assert.equal(descriptor.method, "DELETE");
    assert.equal(descriptor.pathTemplate, "/content/v2/{accountId}/watchlist/{content_id}");
    assert.deepEqual(descriptor.authDerivedParams, { accountId: { source: "accountId" } });
    assert.deepEqual(descriptor.callerParams && Object.keys(descriptor.callerParams), ["content_id"]);
    assert.equal(descriptor.body, undefined);
    assert.deepEqual(descriptor.queryParams, {});
    assert.deepEqual(descriptor.fixedQuery, {});
    assert.deepEqual(descriptor.repeatedQueryParams, {});
    assert.deepEqual(descriptor.joinedQueryParams, {});
    assert.deepEqual(descriptor.response, {
      successStatuses: [204],
      body: "EMPTY",
      determinedNotFound: "watchlist-item-absent",
    });
  });

  test("the public remove tool advertises a closed destructive mutation schema", () => {
    const source = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
    const start = source.indexOf('name: "crunchyroll_remove_from_watchlist"');
    const end = source.indexOf('// History & Progress', start);
    const block = source.slice(start, end);
    assert.notEqual(start, -1);
    assert.match(block, /additionalProperties:\s*false/);
    assert.match(block, /annotations:\s*\{[\s\S]*readOnlyHint:\s*false/);
    assert.match(block, /destructiveHint:\s*true/);
  });

  test("a successful removal returns the closed applied result and forwards only content_id", async () => {
    const h = gatewayHarness();
    const result = await h.gateway.callTool("crunchyroll_remove_from_watchlist", { content_id: CONTENT_ID });
    assert.deepEqual(result, {
      tool: "crunchyroll_remove_from_watchlist",
      operation: REMOVE_OPERATION,
      mutation: true,
      mutation_class: "ACCOUNT",
      content_id: CONTENT_ID,
      outcome: "APPLIED",
      outcome_certainty: "CERTAIN",
      retry_performed: false,
      verify_with: "crunchyroll_get_watchlist",
    });
    assert.equal(h.backend.calls.length, 1);
    assert.deepEqual(h.backend.calls[0].callerParams, { content_id: CONTENT_ID });
  });

  test("identity and wire overrides are rejected rather than silently dropped", async () => {
    const forbidden: Array<[string, TransportError["kind"]]> = [
      ["accountId", "CALLER_SUPPLIED_IDENTITY"],
      ["account_id", "INVALID_ARGUMENTS"],
      ["profile_id", "INVALID_ARGUMENTS"],
      ["method", "INVALID_ARGUMENTS"],
      ["body", "INVALID_ARGUMENTS"],
      ["headers", "INVALID_ARGUMENTS"],
      ["path", "INVALID_ARGUMENTS"],
      ["query", "INVALID_ARGUMENTS"],
    ];
    for (const [key, kind] of forbidden) {
      const h = gatewayHarness();
      await assert.rejects(
        h.gateway.callTool("crunchyroll_remove_from_watchlist", { content_id: CONTENT_ID, [key]: "caller" }),
        (error: unknown) => error instanceof TransportError && error.kind === kind,
        key,
      );
      assert.equal(h.backend.calls.length, 0, `${key} must fail before transport`);
    }
  });

  test("the backend derives account identity, encodes the item path and sends no body", async () => {
    const h = backendHarness({ status: 204, contentType: "", body: "", truncated: false });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const call = resolveCall(registry, REMOVE_OPERATION, { content_id: CONTENT_ID });
    const result = await h.backend.executeResolved(call);
    assert.equal(result.status, 204);
    assert.equal(result.json, undefined);
    assert.equal(h.fake.requests.length, 1);
    const request = h.fake.requests[0] as { url: string; method: string; body?: unknown };
    assert.equal(
      request.url,
      `https://www.crunchyroll.com/content/v2/${ACCOUNT_ID}/watchlist/${CONTENT_ID}`,
    );
    assert.equal(request.method, "DELETE");
    assert.equal("body" in request, false, "a bodyless DELETE must not carry Content-Type input");
    assert.equal(buildRequestBody(call), undefined);
    assert.equal(buildRequestUrl(call, { accountId: ACCOUNT_ID }), request.url);
  });

  test("204 with an empty body and no content type is accepted", async () => {
    const h = backendHarness({ status: 204, contentType: "", body: "", truncated: false });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const result = await h.backend.executeResolved(
      resolveCall(registry, REMOVE_OPERATION, { content_id: CONTENT_ID }),
    );
    assert.equal(result.status, 204);
    assert.equal(result.contentType, "");
    assert.equal(result.json, undefined);
  });

  test("two unrelated 404 HTML bodies are the same determined item-absent refusal", async () => {
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    for (const body of ["<html>first synthetic shell</html>", "<!doctype html><title>different fixture</title>"]) {
      const h = backendHarness({ status: 404, contentType: "text/html", body, truncated: false });
      await assert.rejects(
        h.backend.executeResolved(resolveCall(registry, REMOVE_OPERATION, { content_id: CONTENT_ID })),
        (error: unknown) =>
          error instanceof TransportError &&
          error.kind === "API_NOT_FOUND" &&
          error.detail === "watchlist-item-absent",
      );
      assert.equal(h.fake.requests.length, 1, "a determined 404 is never retried");
    }
  });

  test("a pre-dispatch failure remains determined, while a post-dispatch failure is unknown", async () => {
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const preAuthority = readyAuthority();
    const pre = createBrowserApiBackend({
      reader: preAuthority.asReader(),
      openChannel: async () => {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-page-context");
      },
    });
    await assert.rejects(
      pre.executeResolved(resolveCall(registry, REMOVE_OPERATION, { content_id: CONTENT_ID })),
      (error: unknown) => error instanceof TransportError && error.kind === "BROWSER_UNAVAILABLE",
    );

    const postAuthority = readyAuthority();
    let requests = 0;
    const post = createBrowserApiBackend({
      reader: postAuthority.asReader(),
      openChannel: async () => ({
        connectionGeneration: 1,
        async request() {
          requests += 1;
          throw new BrowserLifecycleError(
            "BROWSER_DISCONNECTED",
            undefined,
            "POSSIBLY_DISPATCHED",
            "disconnect",
          );
        },
        async close() {},
      }),
    });
    await assert.rejects(
      post.executeResolved(resolveCall(registry, REMOVE_OPERATION, { content_id: CONTENT_ID })),
      (error: unknown) =>
        error instanceof TransportError &&
        error.kind === "MUTATION_OUTCOME_UNKNOWN" &&
        error.detail === "disconnect",
    );
    assert.equal(requests, 1, "an uncertain removal is never retried");
  });
});

describe("BT8.3 — migration ratchet", () => {
  test("ADD remains migrated and UPDATE remains locally refused", async () => {
    const h = gatewayHarness();
    assert.equal(h.registry.has(ADD_OPERATION), true);
    assert.equal(h.registry.has(REMOVE_OPERATION), true);
    await assert.rejects(
      h.gateway.callTool("crunchyroll_update_playhead", { content_id: CONTENT_ID, playhead: 1 }),
      (error: unknown) => error instanceof TransportError && error.kind === "OPERATION_NOT_MIGRATED",
    );
    assert.equal(h.backend.calls.length, 0);
    assert.equal(h.registry.has(UPDATE_OPERATION), false);
  });
});
