import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCTION_OPERATIONS,
  createOperationRegistry,
  resolveCall,
} from "../src/transport/operation-registry.js";
import { createTransportDispatcher } from "../src/transport/dispatcher.js";
import { createContentGateway } from "../src/transport/content-gateway.js";
import {
  buildRequestBody,
  buildRequestUrl,
  createBrowserApiBackend,
} from "../src/transport/browser-api-backend.js";
import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import { TransportError } from "../src/transport/transport-error.js";
import type {
  ApiExecutionChannel,
  ApiExecutionResponse,
} from "../src/transport/browser-lifecycle-types.js";
import type { TransportResult } from "../src/transport/types.js";
import { FakeTransportBackend } from "./_fake-backend.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ADD_OPERATION = "ADD_TO_WATCHLIST";
const REMOVE_OPERATION = "REMOVE_FROM_WATCHLIST";
const UPDATE_OPERATION = "UPDATE_PLAYHEAD";
const CONTENT_ID = "GY8VEQ95Y";
const ACCOUNT_ID = "AUTH-DERIVED-ACCOUNT-BT82";
const TOKEN = "AUTH-DERIVED-TOKEN-BT82";

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

describe("BT8.2 — ADD_TO_WATCHLIST production contract", () => {
  test("registers only ADD with the proved collection POST contract", () => {
    const descriptor = PRODUCTION_OPERATIONS.find((entry) => String(entry.id) === ADD_OPERATION);
    assert.ok(descriptor, "ADD_TO_WATCHLIST must be registered");
    assert.equal(descriptor.mutation, "ACCOUNT");
    assert.equal(descriptor.method, "POST");
    assert.equal(descriptor.pathTemplate, "/content/v2/{accountId}/watchlist");
    assert.deepEqual(descriptor.authDerivedParams, { accountId: { source: "accountId" } });
    assert.deepEqual(descriptor.body, {
      contentType: "application/json",
      fields: { content_id: "content_id" },
      fixedFields: {},
    });
    assert.deepEqual(descriptor.response, { successStatuses: [204], body: "EMPTY" });
    assert.deepEqual(descriptor.queryParams, {});
    assert.deepEqual(descriptor.fixedQuery, {});
    assert.deepEqual(descriptor.repeatedQueryParams, {});
    assert.deepEqual(descriptor.joinedQueryParams, {});
  });

  test("the public add tool advertises a closed mutation schema", () => {
    const source = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
    const start = source.indexOf('name: "crunchyroll_add_to_watchlist"');
    const end = source.indexOf('name: "crunchyroll_remove_from_watchlist"', start);
    const block = source.slice(start, end);
    assert.notEqual(start, -1);
    assert.match(block, /additionalProperties:\s*false/);
    assert.match(block, /annotations:\s*\{[\s\S]*readOnlyHint:\s*false/);
  });

  test("a successful add returns the closed applied result and forwards args verbatim", async () => {
    const h = gatewayHarness();
    const result = await h.gateway.callTool("crunchyroll_add_to_watchlist", { content_id: CONTENT_ID });
    assert.deepEqual(result, {
      tool: "crunchyroll_add_to_watchlist",
      operation: ADD_OPERATION,
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

  test("identity and wire overrides are rejected instead of being silently dropped", async () => {
    const forbidden: Array<[string, TransportError["kind"]]> = [
      ["accountId", "CALLER_SUPPLIED_IDENTITY"],
      ["account_id", "INVALID_ARGUMENTS"],
      ["profile_id", "INVALID_ARGUMENTS"],
      ["method", "INVALID_ARGUMENTS"],
      ["body", "INVALID_ARGUMENTS"],
      ["headers", "INVALID_ARGUMENTS"],
      ["path", "INVALID_ARGUMENTS"],
    ];
    for (const [key, kind] of forbidden) {
      const h = gatewayHarness();
      await assert.rejects(
        h.gateway.callTool("crunchyroll_add_to_watchlist", { content_id: CONTENT_ID, [key]: "caller" }),
        (error: unknown) => error instanceof TransportError && error.kind === kind,
        key
      );
      assert.equal(h.backend.calls.length, 0, `${key} must fail before transport`);
    }
  });

  test("the backend derives account identity and owns method, path and body", async () => {
    const h = backendHarness({ status: 204, contentType: "", body: "", truncated: false });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const call = resolveCall(registry, ADD_OPERATION, { content_id: CONTENT_ID });
    const bound = await h.backend.executeResolved(call);
    assert.equal(bound.status, 204);
    assert.equal(bound.json, undefined);
    assert.equal(h.fake.requests.length, 1);
    const request = h.fake.requests[0] as {
      url: string;
      method: string;
      body?: { contentType: string; text: string };
    };
    assert.equal(request.url, `https://www.crunchyroll.com/content/v2/${ACCOUNT_ID}/watchlist`);
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body, {
      contentType: "application/json",
      text: JSON.stringify({ content_id: CONTENT_ID }),
    });
    assert.equal("headers" in request, false);
    assert.equal("accountId" in request, false);
    assert.equal(buildRequestUrl(call, { accountId: ACCOUNT_ID }), request.url);
    assert.deepEqual(buildRequestBody(call), request.body);
  });

  test("204 with an empty body and no content type is accepted", async () => {
    const h = backendHarness({ status: 204, contentType: "", body: "", truncated: false });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const result = await h.backend.executeResolved(
      resolveCall(registry, ADD_OPERATION, { content_id: CONTENT_ID })
    );
    assert.equal(result.status, 204);
    assert.equal(result.contentType, "");
    assert.equal(result.json, undefined);
  });

  test("provider 409 item_already_exists is a deterministic conflict, not UNKNOWN", async () => {
    const h = backendHarness({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "content.add_watchlist_item_v2.item_already_exists", context: [] }),
      truncated: false,
    });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    await assert.rejects(
      h.backend.executeResolved(resolveCall(registry, ADD_OPERATION, { content_id: CONTENT_ID })),
      (error: unknown) =>
        error instanceof TransportError &&
        error.kind === "API_CONFLICT" &&
        error.detail === "item_already_exists"
    );
  });

  test("provider 400 cms_item_not_found is a deterministic bad request", async () => {
    const h = backendHarness({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        code: "content.add_watchlist_item_v2.data_validation_error",
        context: [{ code: "content.add_watchlist_item_v2.cms_item_not_found", field: "content_id" }],
      }),
      truncated: false,
    });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    await assert.rejects(
      h.backend.executeResolved(resolveCall(registry, ADD_OPERATION, { content_id: CONTENT_ID })),
      (error: unknown) =>
        error instanceof TransportError &&
        error.kind === "API_BAD_REQUEST" &&
        error.detail === "cms_item_not_found"
    );
  });

  test("unexpected provider errors remain fail-closed and are not retried", async () => {
    const h = backendHarness({ status: 418, contentType: "application/json", body: "{}", truncated: false });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    await assert.rejects(
      h.backend.executeResolved(resolveCall(registry, ADD_OPERATION, { content_id: CONTENT_ID })),
      (error: unknown) =>
        error instanceof TransportError && error.kind === "INVALID_RESPONSE"
    );
    assert.equal(h.fake.requests.length, 1);
  });
});

describe("BT8.2 — migration ratchet and BT7 read preservation", () => {
  test("UPDATE is now migrated while ADD and REMOVE remain migrated", async () => {
    const h = gatewayHarness();
    const result = await h.gateway.callTool("crunchyroll_update_playhead", { content_id: CONTENT_ID, playhead: 1 });
    assert.equal(result.operation, UPDATE_OPERATION);
    assert.equal(h.backend.calls.length, 1);
    assert.equal(h.registry.has(UPDATE_OPERATION), true);
    assert.equal(h.registry.has(REMOVE_OPERATION), true);
  });

  test("BT7 GET_WATCHLIST remains routed and parsed", async () => {
    const h = gatewayHarness({ status: 200, contentType: "application/json", json: { data: [] } });
    const result = await h.gateway.callTool("crunchyroll_get_watchlist", {});
    assert.deepEqual(result, { count: 0, items: [] });
    assert.equal(String(h.backend.calls[0].descriptor.id), "GET_WATCHLIST");
  });
});
