import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRegistry, PRODUCTION_OPERATIONS, resolveCall } from "../src/transport/operation-registry.js";
import { createContentGateway } from "../src/transport/content-gateway.js";
import { buildRequestBody, buildRequestUrl, createBrowserApiBackend } from "../src/transport/browser-api-backend.js";
import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import { TransportError } from "../src/transport/transport-error.js";
import { CRUNCHYROLL_FETCH_FUNCTION } from "../src/transport/browser-session-manager.js";

const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
const id = "GT00384006";

test("PATCH favorite has a closed, authenticated body contract; GET/DELETE still reject bodies", () => {
  const call = resolveCall(registry, "SET_FAVORITE", { content_id: id, favorite: true });
  assert.equal(call.descriptor.method, "PATCH");
  assert.equal(call.descriptor.scope, "ACCOUNT");
  assert.equal(call.descriptor.auth, "BEARER");
  assert.equal(call.descriptor.mutation, "ACCOUNT");
  assert.deepEqual(buildRequestBody(call), { contentType: "application/json", text: '{"is_favorite":true}' });
  assert.equal(buildRequestUrl(call, { accountId: "ACCOUNT" }), `https://www.crunchyroll.com/content/v2/ACCOUNT/watchlist/${id}`);
  for (const method of ["GET", "DELETE", "PUT"]) {
    assert.throws(() => createOperationRegistry([{ ...call.descriptor, method, mutation: method === "GET" ? false : "ACCOUNT" } as never]));
  }
  for (const extra of [{ scope: "PUBLIC" }, { auth: "NONE" }, { body: { contentType: "application/json", fields: { is_favorite: "undeclared" }, fixedFields: {} } }]) {
    assert.throws(() => createOperationRegistry([{ ...call.descriptor, ...extra } as never]));
  }
});

function harness(present: boolean, fail?: string) {
  const calls: Array<{ operation: string; params: unknown }> = [];
  const failure = new Error("uncertain dispatch");
  const gateway = createContentGateway({ async execute(operation, params) {
    resolveCall(registry, operation, params);
    calls.push({ operation, params });
    if (operation === fail) throw failure;
    return { status: operation === "GET_WATCHLIST_ENTRY" ? 200 : 204, contentType: "application/json", json: operation === "GET_WATCHLIST_ENTRY" ? { data: present ? [{ id, is_favorite: true }] : [] } : undefined };
  } }, registry);
  return { calls, gateway, failure };
}

for (const favorite of [true, false]) test(`present entry PATCHes desired ${favorite} without toggling`, async () => {
  const h = harness(true);
  for (let n = 0; n < 2; n++) {
    const result = await h.gateway.callTool("crunchyroll_set_favorite", { content_id: id, favorite }) as any;
    assert.equal(result.favorite, favorite);
    assert.equal(result.outcome, "APPLIED");
    assert.equal(result.retry_performed, false);
    assert.equal(result.verify_with, "crunchyroll_get_watchlist");
  }
  assert.deepEqual(h.calls.map(c => c.operation), ["GET_WATCHLIST_ENTRY", "SET_FAVORITE", "GET_WATCHLIST_ENTRY", "SET_FAVORITE"]);
  assert.deepEqual(h.calls[1].params, { content_id: id, favorite });
});

test("absent true reads exact target, ADDs then PATCHes", async () => {
  const h = harness(false);
  await h.gateway.callTool("crunchyroll_set_favorite", { content_id: id, favorite: true });
  assert.deepEqual(h.calls.map(c => c.operation), ["GET_WATCHLIST_ENTRY", "ADD_TO_WATCHLIST", "SET_FAVORITE"]);
  const call = resolveCall(registry, "GET_WATCHLIST_ENTRY", { content_id: id });
  assert.equal(buildRequestUrl(call, { accountId: "ACCOUNT" }), `https://www.crunchyroll.com/content/v2/ACCOUNT/watchlist?content_ids=${id}&locale=en-US`);
});

test("absent false is a certain NOOP without writes", async () => {
  const h = harness(false);
  const result = await h.gateway.callTool("crunchyroll_set_favorite", { content_id: id, favorite: false }) as any;
  assert.equal(result.outcome, "NOOP");
  assert.equal(result.outcome_certainty, "CERTAIN");
  assert.deepEqual(h.calls.map(c => c.operation), ["GET_WATCHLIST_ENTRY"]);
});

test("invalid input is refused before even reading", async () => {
  for (const args of [{ content_id: id }, { content_id: id, favorite: "true" }, { content_id: "../bad", favorite: true }, { content_id: id, favorite: null }, { content_id: id, favorite: true, method: "POST" }, { content_id: id, favorite: true, accountId: "override" }]) {
    const h = harness(true);
    await assert.rejects(h.gateway.callTool("crunchyroll_set_favorite", args));
    assert.equal(h.calls.length, 0);
  }
});

for (const fail of ["GET_WATCHLIST_ENTRY", "ADD_TO_WATCHLIST", "SET_FAVORITE"]) test(`failure/uncertainty at ${fail} is propagated without replay`, async () => {
  const h = harness(false, fail);
  await assert.rejects(h.gateway.callTool("crunchyroll_set_favorite", { content_id: id, favorite: true }), e => e === h.failure);
  const expected = ["GET_WATCHLIST_ENTRY", "ADD_TO_WATCHLIST", "SET_FAVORITE"];
  assert.deepEqual(h.calls.map(c => c.operation), expected.slice(0, expected.indexOf(fail) + 1));
});

test("real backend sends PATCH bool once; non-2xx remains uncertain without replay", async () => {
  for (const status of [204, 401, 403, 404, 500]) {
    const authority = createAuthContextAuthority();
    const writer = authority.asWriter();
    writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", {
      accessToken: "SYNTHETIC", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, accountId: "ACCOUNT",
    } as never);
    const requests: any[] = [];
    const backend = createBrowserApiBackend({
      reader: authority.asReader(), deadlineMs: 5_000,
      openChannel: async () => ({ connectionGeneration: 1, async close() {}, async request(input) {
        requests.push(input);
        return { status, body: "", contentType: "", truncated: false };
      } }),
    });
    const promise = backend.executeResolved(resolveCall(registry, "SET_FAVORITE", { content_id: id, favorite: false }));
    if (status === 204) assert.equal((await promise).status, 204);
    else {
      const kind = status === 401 ? "API_UNAUTHORIZED" : status === 403 ? "API_FORBIDDEN" : status === 404 ? "API_NOT_FOUND" : "MUTATION_OUTCOME_UNKNOWN";
      await assert.rejects(promise, (error: unknown) => error instanceof TransportError && error.kind === kind);
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "PATCH");
    assert.deepEqual(requests[0].body, { contentType: "application/json", text: '{"is_favorite":false}' });
  }
});

test("frozen function transmits explicit PATCH body with closed headers", async () => {
  const requests: any[] = [];
  const fn = new Function("fetch", `return (${CRUNCHYROLL_FETCH_FUNCTION})`)(async (url: string, init: unknown) => {
    requests.push({ url, init });
    return { status: 204, headers: { get: () => null }, body: null };
  });
  await fn("https://www.crunchyroll.com/content/v2/test", "PATCH", "SYNTHETIC", 100, '{"is_favorite":true}', "application/json");
  assert.deepEqual(requests[0].init, { method: "PATCH", headers: { Authorization: "SYNTHETIC", "Content-Type": "application/json" }, credentials: "omit", redirect: "manual", body: '{"is_favorite":true}' });
});

test("frozen function refuses unknown methods and GET/DELETE bodies before fetch", async () => {
  const fn = new Function("fetch", `return (${CRUNCHYROLL_FETCH_FUNCTION})`)(async () => { throw new Error("unexpected-fetch"); });
  for (const [method, body] of [["PUT", undefined], ["GET", "{}"], ["DELETE", "{}"]]) {
    await assert.rejects(fn("https://www.crunchyroll.com/content/v2/test", method, "test", 100, body, "application/json"), /method/);
  }
});
