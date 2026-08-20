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
const UPDATE_OPERATION = "UPDATE_PLAYHEAD";
const ADD_OPERATION = "ADD_TO_WATCHLIST";
const REMOVE_OPERATION = "REMOVE_FROM_WATCHLIST";
const CONTENT_ID = "GE00377909ENUS";
const ACCOUNT_ID = "AUTH-DERIVED-ACCOUNT-BT84";
const TOKEN = "AUTH-DERIVED-TOKEN-BT84";

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

describe("BT8.4 — UPDATE_PLAYHEAD production contract", () => {
  test("registers UPDATE with the proved POST playheads contract", () => {
    const descriptor = PRODUCTION_OPERATIONS.find((entry) => String(entry.id) === UPDATE_OPERATION);
    assert.ok(descriptor, "UPDATE_PLAYHEAD must be registered");
    assert.equal(descriptor.mutation, "PROGRESS");
    assert.equal(descriptor.method, "POST");
    assert.equal(descriptor.pathTemplate, "/content/v2/{accountId}/playheads");
    assert.deepEqual(descriptor.authDerivedParams, { accountId: { source: "accountId" } });
    assert.deepEqual(Object.keys(descriptor.callerParams), ["content_id", "playhead"]);
    assert.deepEqual(descriptor.body, {
      contentType: "application/json",
      fields: { content_id: "content_id", playhead: "playhead" },
      fixedFields: {},
    });
    assert.deepEqual(descriptor.queryParams, {});
    assert.deepEqual(descriptor.fixedQuery, {});
    assert.deepEqual(descriptor.repeatedQueryParams, {});
    assert.deepEqual(descriptor.joinedQueryParams, {});
    assert.deepEqual(descriptor.response, { successStatuses: [204], body: "EMPTY" });
  });

  test("the public update tool advertises the closed destructive mutation schema", () => {
    const source = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
    const start = source.indexOf('name: "crunchyroll_update_playhead"');
    const end = source.indexOf("// Recommendations", start);
    const block = source.slice(start, end);
    assert.notEqual(start, -1);
    assert.match(block, /additionalProperties:\s*false/);
    assert.match(block, /annotations:\s*\{[\s\S]*readOnlyHint:\s*false/);
    assert.match(block, /destructiveHint:\s*true/);
  });

  test("UPDATE has no competing production owner in the legacy client", () => {
    const source = readFileSync(join(REPO_ROOT, "src/api.ts"), "utf8");
    assert.equal(/export async function updatePlayhead\b/.test(source), false);
  });

  test("a successful update returns the closed applied result and forwards only functional params", async () => {
    const h = gatewayHarness();
    const result = await h.gateway.callTool("crunchyroll_update_playhead", {
      content_id: CONTENT_ID,
      playhead: 42,
    });
    assert.deepEqual(result, {
      tool: "crunchyroll_update_playhead",
      operation: UPDATE_OPERATION,
      mutation: true,
      mutation_class: "PROGRESS",
      content_id: CONTENT_ID,
      playhead: 42,
      outcome: "APPLIED",
      outcome_certainty: "CERTAIN",
      retry_performed: false,
      verify_with: "crunchyroll_get_playheads",
    });
    assert.equal(h.backend.calls.length, 1);
    assert.deepEqual(h.backend.calls[0].callerParams, { content_id: CONTENT_ID, playhead: 42 });
  });

  test("identity, transport overrides, and invalid playhead values are rejected before transport", async () => {
    const forbidden: Array<[string, TransportError["kind"]]> = [
      ["accountId", "CALLER_SUPPLIED_IDENTITY"],
      ["account_id", "INVALID_ARGUMENTS"],
      ["profile_id", "INVALID_ARGUMENTS"],
      ["method", "INVALID_ARGUMENTS"],
      ["path", "INVALID_ARGUMENTS"],
      ["headers", "INVALID_ARGUMENTS"],
      ["body", "INVALID_ARGUMENTS"],
      ["query", "INVALID_ARGUMENTS"],
      ["Authorization", "INVALID_ARGUMENTS"],
    ];
    for (const [key, kind] of forbidden) {
      const h = gatewayHarness();
      await assert.rejects(
        h.gateway.callTool("crunchyroll_update_playhead", {
          content_id: CONTENT_ID,
          playhead: 42,
          [key]: "caller",
        }),
        (error: unknown) => error instanceof TransportError && error.kind === kind,
        key,
      );
      assert.equal(h.backend.calls.length, 0, `${key} must fail before transport`);
    }
    for (const playhead of [NaN, Infinity, -Infinity, 1.5, -1, 86_401, "42"]) {
      const h = gatewayHarness();
      await assert.rejects(
        h.gateway.callTool("crunchyroll_update_playhead", { content_id: CONTENT_ID, playhead }),
        (error: unknown) => error instanceof TransportError && error.kind === "INVALID_ARGUMENTS",
        String(playhead),
      );
      assert.equal(h.backend.calls.length, 0, `${String(playhead)} must fail before transport`);
    }
  });

  test("the backend derives account identity and serializes only content_id plus playhead", async () => {
    const h = backendHarness({ status: 204, contentType: "", body: "", truncated: false });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const call = resolveCall(registry, UPDATE_OPERATION, { content_id: CONTENT_ID, playhead: 86400 });
    const result = await h.backend.executeResolved(call);
    assert.equal(result.status, 204);
    assert.equal(result.json, undefined);
    assert.equal(h.fake.requests.length, 1);
    const request = h.fake.requests[0] as {
      url: string;
      method: string;
      body: { contentType: string; text: string };
    };
    assert.equal(request.url, `https://www.crunchyroll.com/content/v2/${ACCOUNT_ID}/playheads`);
    assert.equal(request.method, "POST");
    assert.deepEqual(request.body, {
      contentType: "application/json",
      text: JSON.stringify({ content_id: CONTENT_ID, playhead: 86400 }),
    });
    assert.deepEqual(JSON.parse(request.body.text), { content_id: CONTENT_ID, playhead: 86400 });
    assert.equal("headers" in request, false);
    assert.equal("accountId" in request, false);
    assert.equal(buildRequestUrl(call, { accountId: ACCOUNT_ID }), request.url);
    assert.deepEqual(buildRequestBody(call), request.body);
  });

  test("204 with an empty body and no content type is accepted", async () => {
    const h = backendHarness({ status: 204, contentType: "", body: "", truncated: false });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const result = await h.backend.executeResolved(
      resolveCall(registry, UPDATE_OPERATION, { content_id: CONTENT_ID, playhead: 42 }),
    );
    assert.equal(result.status, 204);
    assert.equal(result.contentType, "");
    assert.equal(result.json, undefined);
  });

  test("400 cms_item_not_found is determined API_BAD_REQUEST and is never retried", async () => {
    const h = backendHarness({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        code: "content.set_playhead_v2.data_validation_error",
        context: [{ code: "content.set_playhead_v2.cms_item_not_found", field: "content_id" }],
      }),
      truncated: false,
    });
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    await assert.rejects(
      h.backend.executeResolved(resolveCall(registry, UPDATE_OPERATION, { content_id: CONTENT_ID, playhead: 42 })),
      (error: unknown) =>
        error instanceof TransportError &&
        error.kind === "API_BAD_REQUEST" &&
        error.detail === "cms_item_not_found",
    );
    assert.equal(h.fake.requests.length, 1);
  });

  test("same-value and provider clamping candidates remain real writes with no local rewrite", async () => {
    const h = gatewayHarness();
    await h.gateway.callTool("crunchyroll_update_playhead", { content_id: CONTENT_ID, playhead: 77 });
    await h.gateway.callTool("crunchyroll_update_playhead", { content_id: CONTENT_ID, playhead: 77 });
    await h.gateway.callTool("crunchyroll_update_playhead", { content_id: CONTENT_ID, playhead: 86400 });
    assert.equal(h.backend.calls.length, 3);
    assert.deepEqual(h.backend.calls.map((call) => call.callerParams), [
      { content_id: CONTENT_ID, playhead: 77 },
      { content_id: CONTENT_ID, playhead: 77 },
      { content_id: CONTENT_ID, playhead: 86400 },
    ]);
  });

  test("pre-dispatch failure stays determined while post-dispatch uncertainty is UNKNOWN", async () => {
    const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
    const preAuthority = readyAuthority();
    const pre = createBrowserApiBackend({
      reader: preAuthority.asReader(),
      openChannel: async () => {
        throw new BrowserLifecycleError("BROWSER_UNAVAILABLE", "no-page-context");
      },
    });
    await assert.rejects(
      pre.executeResolved(resolveCall(registry, UPDATE_OPERATION, { content_id: CONTENT_ID, playhead: 42 })),
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
      post.executeResolved(resolveCall(registry, UPDATE_OPERATION, { content_id: CONTENT_ID, playhead: 42 })),
      (error: unknown) =>
        error instanceof TransportError &&
        error.kind === "MUTATION_OUTCOME_UNKNOWN" &&
        error.detail === "disconnect",
    );
    assert.equal(requests, 1, "an uncertain update is never retried");
  });
});

describe("BT8.4 — migration ratchet", () => {
  test("ADD and REMOVE remain migrated while UPDATE is now migrated", () => {
    const h = gatewayHarness();
    assert.equal(h.registry.has(ADD_OPERATION), true);
    assert.equal(h.registry.has(REMOVE_OPERATION), true);
    assert.equal(h.registry.has(UPDATE_OPERATION), true);
  });
});
