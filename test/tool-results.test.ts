import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalShape } from "../src/transport/browser-api-backend.js";

test("a 403 body is classified by shape only, never by content", () => {
  assert.equal(refusalShape(""), "empty-response");
  assert.equal(refusalShape("   \n"), "empty-response");
  assert.equal(refusalShape("<!DOCTYPE html><title>Just a moment...</title>"), "html-response");
  assert.equal(refusalShape('{"code":"forbidden.not_allowed"}'), "json-response");
  assert.equal(refusalShape("denied"), "other-response");
});

import { createContentGateway } from "../src/transport/content-gateway.js";
import { createOperationRegistry, PRODUCTION_OPERATIONS, resolveCall } from "../src/transport/operation-registry.js";
import { buildRequestBody } from "../src/transport/browser-api-backend.js";
import { TransportError } from "../src/transport/transport-error.js";
import type { CrunchyrollTransport, TransportResult } from "../src/transport/types.js";

function favoriteGateway(onWatchlist: boolean) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  let present = onWatchlist;
  const transport: CrunchyrollTransport = {
    async execute(operation, params) {
      calls.push({ op: String(operation), params: { ...params } });
      if (String(operation) === "SET_FAVORITE" && !present) {
        throw new TransportError("API_NOT_FOUND", "watchlist-item-absent");
      }
      if (String(operation) === "ADD_TO_WATCHLIST") present = true;
      return { status: 204, contentType: "", json: undefined } as unknown as TransportResult;
    },
  };
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  return { calls, gateway: createContentGateway(transport, registry) };
}

test("SET_FAVORITE sends the intent as a PATCH body, never a toggle", () => {
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  const call = resolveCall(registry, "SET_FAVORITE", { content_id: "GY8VEQ95Y", favorite: true });
  assert.equal(call.descriptor.method, "PATCH");
  assert.deepEqual(JSON.parse(buildRequestBody(call)!.text), { is_favorite: true });
  assert.throws(() => resolveCall(registry, "SET_FAVORITE", { content_id: "GY8VEQ95Y" }));
});

test("favoriting an item already on the watchlist is one call", async () => {
  const h = favoriteGateway(true);
  const result = (await h.gateway.callTool("crunchyroll_set_favorite", { content_id: "GY8VEQ95Y", favorite: true })) as Record<string, unknown>;
  assert.equal(result.outcome, "APPLIED");
  assert.equal(result.added_to_watchlist, false);
  assert.deepEqual(h.calls.map((c) => c.op), ["SET_FAVORITE"]);
});

test("favoriting an item not on the watchlist adds it first, then favorites it", async () => {
  const h = favoriteGateway(false);
  const result = (await h.gateway.callTool("crunchyroll_set_favorite", { content_id: "GY8VEQ95Y", favorite: true })) as Record<string, unknown>;
  assert.equal(result.outcome, "APPLIED");
  assert.equal(result.added_to_watchlist, true);
  assert.deepEqual(h.calls.map((c) => c.op), ["SET_FAVORITE", "ADD_TO_WATCHLIST", "SET_FAVORITE"]);
});

test("unfavoriting an item not on the watchlist is a NOOP and adds nothing", async () => {
  const h = favoriteGateway(false);
  const result = (await h.gateway.callTool("crunchyroll_set_favorite", { content_id: "GY8VEQ95Y", favorite: false })) as Record<string, unknown>;
  assert.equal(result.outcome, "NOOP");
  assert.equal(result.reason, "NOT_ON_WATCHLIST");
  assert.deepEqual(h.calls.map((c) => c.op), ["SET_FAVORITE"]);
});
