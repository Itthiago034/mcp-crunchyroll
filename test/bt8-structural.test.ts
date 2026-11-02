// BT8.1 — mutation structural support.
//
// Deterministic and offline: the REAL BT3 authority driven through its REAL
// reader, a fake execution channel, synthetic descriptors, no browser, no
// network, no credentials, no provider.
//
// BT8.4 registers the final UPDATE_PLAYHEAD mutation; all three BT8 mutations
// are asserted below while BT7 reads remain unchanged.
//
// Frozen design: CRUNCHYROLL-BT8-MUTATIONS-DESIGN.md §12 (registry evolution),
// §13 (body ownership), §14 (response model), §18 (browser boundary).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCTION_OPERATIONS,
  accountMutation,
  createOperationRegistry,
  resolveCall,
} from "../src/transport/operation-registry.js";
import { createTransportDispatcher } from "../src/transport/dispatcher.js";
import { createContentGateway } from "../src/transport/content-gateway.js";
import {
  buildRequestBody,
  createBrowserApiBackend,
  CRUNCHYROLL_API_ORIGIN,
} from "../src/transport/browser-api-backend.js";
import { CRUNCHYROLL_FETCH_FUNCTION } from "../src/transport/browser-session-manager.js";
import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import { TransportError } from "../src/transport/transport-error.js";
import { FakeTransportBackend } from "./_fake-backend.js";
import type {
  ApiExecutionChannel,
  ApiExecutionRequest,
  ApiExecutionResponse,
} from "../src/transport/browser-lifecycle-types.js";
import {
  contentId,
  requiredIntegerInRange,
  HTTP_METHODS,
  MUTATION_CLASSES,
  type OperationDescriptor,
  type OperationId,
  type ResolvedCall,
  type TransportResult,
} from "../src/transport/types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(REPO_ROOT, "src");

const ACCOUNT_SENTINEL = "SYNTHETIC-ACCOUNT-ID-BT8";
const BEARER_SENTINEL = "SYNTHETIC-BEARER-BT8-MUST-NOT-LEAK";

const BT8_MUTATIONS = ["ADD_TO_WATCHLIST", "REMOVE_FROM_WATCHLIST", "UPDATE_PLAYHEAD", "SET_FAVORITE"];

// ── Synthetic descriptors ───────────────────────────────────────────────────

/** A POST that carries a descriptor-owned body. */
const SYNTHETIC_WRITE = accountMutation({
  id: "SYNTHETIC_WRITE",
  method: "POST",
  pathTemplate: "/synthetic/v1/{accountId}/things",
  mutation: "PROGRESS",
  callerParams: { content_id: contentId, position: requiredIntegerInRange(0, 86_400) },
  body: {
    contentType: "application/json",
    fields: { content_id: "content_id", position: "position" },
    fixedFields: { origin: "synthetic" },
  },
  response: { successStatuses: [200], body: "JSON" },
});

/** A DELETE that carries none, and answers with no document at all. */
const SYNTHETIC_ERASE = accountMutation({
  id: "SYNTHETIC_ERASE",
  method: "DELETE",
  pathTemplate: "/synthetic/v1/{accountId}/things/{content_id}",
  mutation: "ACCOUNT",
  callerParams: { content_id: contentId },
  response: { successStatuses: [204], body: "EMPTY" },
});

/** A plain read, unchanged in shape from every BT5–BT7 descriptor. */
const SYNTHETIC_READ: OperationDescriptor = Object.freeze({
  id: "SYNTHETIC_READ" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/{accountId}/things",
  callerParams: Object.freeze({ content_id: contentId }),
  authDerivedParams: Object.freeze({ accountId: Object.freeze({ source: "accountId" }) }),
  fixedQuery: Object.freeze({}),
  queryParams: Object.freeze({ content_id: "content_id" }),
  repeatedQueryParams: Object.freeze({}),
  joinedQueryParams: Object.freeze({}),
  scope: "ACCOUNT",
  auth: "BEARER",
  mutation: false,
}) as OperationDescriptor;

/** Build one descriptor from SYNTHETIC_WRITE with fields overridden. */
function write(overrides: Record<string, unknown>): OperationDescriptor {
  return { ...(SYNTHETIC_WRITE as object), ...overrides } as OperationDescriptor;
}

function refuses(descriptor: OperationDescriptor, why: string): void {
  assert.throws(
    () => createOperationRegistry([descriptor]),
    (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
    why
  );
}

// ── Harnesses ───────────────────────────────────────────────────────────────

function readyAuthority() {
  const authority = createAuthContextAuthority();
  const writer = authority.asWriter();
  writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", {
    accessToken: BEARER_SENTINEL,
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000,
    accountId: ACCOUNT_SENTINEL,
  } as never);
  return authority;
}

const OK_JSON: ApiExecutionResponse = Object.freeze({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ ok: true }),
  truncated: false,
});

function backendHarness(reply: ApiExecutionResponse = OK_JSON) {
  const requests: ApiExecutionRequest[] = [];
  const state = { opens: 0, closes: 0 };
  const channel: ApiExecutionChannel = {
    connectionGeneration: 1,
    async request(input) {
      requests.push(input);
      return reply;
    },
    async close() {
      state.closes += 1;
    },
  };
  const backend = createBrowserApiBackend({
    openChannel: async () => {
      state.opens += 1;
      return channel;
    },
    reader: readyAuthority().asReader(),
    deadlineMs: 5_000,
  });
  return { backend, requests, opens: () => state.opens };
}

/** The production gateway over the production table — the real cutover path. */
function gatewayHarness() {
  const backend = new FakeTransportBackend({
    result: { status: 200, contentType: "application/json", json: { data: [] } } as TransportResult,
  });
  const registry = createOperationRegistry(PRODUCTION_OPERATIONS);
  return {
    backend,
    registry,
    gateway: createContentGateway(createTransportDispatcher(registry, backend), registry),
  };
}

function syntheticCall(
  descriptor: OperationDescriptor,
  params: Record<string, unknown>
): ResolvedCall {
  const registry = createOperationRegistry([descriptor]);
  return resolveCall(registry, String(descriptor.id), params);
}

// ── A/B/C/D — the closed dimensions ─────────────────────────────────────────

describe("BT8.1 — mutation and method are closed at construction", () => {
  test("A: a read descriptor is accepted exactly as before", () => {
    const registry = createOperationRegistry([SYNTHETIC_READ]);
    assert.equal(registry.get("SYNTHETIC_READ")?.mutation, false);
    assert.equal(registry.get("SYNTHETIC_READ")?.method, "GET");
    // A read gains NO new fields: absence stays absence, so its captured key
    // set is the one every BT5–BT7 descriptor has always had.
    const captured = registry.get("SYNTHETIC_READ")!;
    assert.equal("body" in captured, false);
    assert.equal("response" in captured, false);
  });

  test("B: a structurally valid mutation is accepted — both shapes", () => {
    const registry = createOperationRegistry([SYNTHETIC_WRITE, SYNTHETIC_ERASE]);
    assert.equal(registry.get("SYNTHETIC_WRITE")?.mutation, "PROGRESS");
    assert.equal(registry.get("SYNTHETIC_WRITE")?.method, "POST");
    assert.deepEqual(registry.get("SYNTHETIC_WRITE")?.response, {
      successStatuses: [200],
      body: "JSON",
    });
    assert.equal(registry.get("SYNTHETIC_ERASE")?.mutation, "ACCOUNT");
    assert.equal(registry.get("SYNTHETIC_ERASE")?.method, "DELETE");
    // A DELETE declares no body, and that absence is preserved.
    assert.equal("body" in registry.get("SYNTHETIC_ERASE")!, false);
  });

  test("C: INV-M1 — a mutation class outside the closed set is refused, never coerced", () => {
    // Every one of these is truthy-or-falsy in a way that `!== false` would
    // have silently accepted or rejected. None may be reinterpreted.
    for (const bogus of [true, 1, 0, "true", "false", "ACCOUNT ", null, undefined, {}, []]) {
      refuses(write({ mutation: bogus }), `mutation ${JSON.stringify(bogus)} must be refused`);
    }
    assert.deepEqual([...MUTATION_CLASSES], [false, "ACCOUNT", "PROGRESS"]);
  });

  test("C: the closed set is exactly the three the design authorized", () => {
    for (const valid of ["ACCOUNT", "PROGRESS"]) {
      const registry = createOperationRegistry([write({ mutation: valid })]);
      assert.equal(registry.get("SYNTHETIC_WRITE")?.mutation, valid);
    }
  });

  test("D: INV-M3 — a method outside the closed set is refused", () => {
    for (const bogus of ["PUT", "HEAD", "OPTIONS", "get", "post", "patch", "", null, undefined]) {
      refuses(write({ method: bogus }), `method ${JSON.stringify(bogus)} must be refused`);
    }
    // PATCH joined the closed set for SET_FAVORITE's partial update.
    assert.deepEqual([...HTTP_METHODS], ["GET", "POST", "PATCH", "DELETE"]);
  });

  test("INV-M2 — method and mutation may never disagree", () => {
    // A GET that claims to mutate, and a POST that poses as a read: the two
    // shapes a mutation would have to wear to slip past a gate reading only
    // one of the fields.
    refuses(
      write({ method: "GET", body: undefined }),
      "a GET may not declare a mutation class"
    );
    refuses(
      write({ mutation: false, body: undefined, response: undefined }),
      "a POST may not declare itself a read"
    );
  });

  test("INV-M4 — a mutation must be an authenticated account operation", () => {
    refuses(write({ scope: "PUBLIC" }), "a public mutation is refused");
    refuses(write({ auth: "NONE" }), "a bearer-less mutation is refused");
  });

  test("INV-M5 — a body belongs to a POST mutation and nothing else", () => {
    refuses(
      { ...(SYNTHETIC_ERASE as object), body: SYNTHETIC_WRITE.body } as OperationDescriptor,
      "a DELETE may not carry a body"
    );
    refuses(
      { ...(SYNTHETIC_READ as object), body: SYNTHETIC_WRITE.body } as OperationDescriptor,
      "a read may not carry a body"
    );
  });

  test("INV-M6 — a body key must name a declared caller param, never identity", () => {
    refuses(
      write({
        body: { contentType: "application/json", fields: { who: "accountId" }, fixedFields: {} },
      }),
      "identity may not travel in a body"
    );
    refuses(
      write({
        body: { contentType: "application/json", fields: { x: "undeclared" }, fixedFields: {} },
      }),
      "an undeclared parameter may not fill a body key"
    );
  });

  test("INV-M7 — a body key may be filled exactly one way", () => {
    refuses(
      write({
        body: {
          contentType: "application/json",
          fields: { content_id: "content_id" },
          fixedFields: { content_id: "constant" },
        },
      }),
      "a key that is both fixed and caller-filled is ambiguous"
    );
  });

  test("INV-M6/M7 — an unsupported body content type is refused", () => {
    refuses(
      write({
        body: { contentType: "text/plain", fields: {}, fixedFields: {} },
      }),
      "only the one authorized encoding may be declared"
    );
  });

  test("INV-M8 — a mutation may not inherit the read success contract", () => {
    refuses(write({ response: undefined }), "a mutation must declare its response contract");
    refuses(
      write({ response: { successStatuses: [], body: "JSON" } }),
      "an empty success list declares nothing"
    );
    refuses(
      write({ response: { successStatuses: [200, 404], body: "JSON" } }),
      "a non-2xx may not be declared a success"
    );
    refuses(
      write({ response: { successStatuses: [200], body: "HTML" } }),
      "the body contract is closed"
    );
    refuses(
      { ...(SYNTHETIC_READ as object), response: { successStatuses: [200], body: "JSON" } } as OperationDescriptor,
      "a read may not declare a mutation response contract"
    );
  });

  test("INV-M9 — list-valued query encodings have no mutation use case", () => {
    refuses(
      write({ repeatedQueryParams: { ids: "content_id" } }),
      "a repeated query key on a mutation is refused"
    );
    refuses(
      write({ joinedQueryParams: { ids: { callerParam: "content_id", separator: "," } } }),
      "a joined query key on a mutation is refused"
    );
  });

  test("the captured mutation policy is immune to later mutation of the source", () => {
    const source = {
      ...(SYNTHETIC_WRITE as object),
      body: {
        contentType: "application/json",
        fields: { content_id: "content_id" },
        fixedFields: { origin: "synthetic" },
      },
      response: { successStatuses: [200], body: "JSON" },
    } as OperationDescriptor;
    const registry = createOperationRegistry([source]);
    // Widen the objects the caller passed in, exactly as BT1 does for params.
    (source.body!.fields as Record<string, string>).sneaky = "content_id";
    (source.response!.successStatuses as number[]).push(500);
    assert.deepEqual(Object.keys(registry.get("SYNTHETIC_WRITE")!.body!.fields), ["content_id"]);
    assert.deepEqual([...registry.get("SYNTHETIC_WRITE")!.response!.successStatuses], [200]);
  });

  test("the production table still satisfies every invariant it enforces", () => {
    assert.doesNotThrow(() => createOperationRegistry(PRODUCTION_OPERATIONS));
  });
});

// ── The critical exit requirement: zero production mutations ────────────────

describe("BT8.4 — the capability is used only by the three migrated mutations", () => {
  test("BT7 production reads remain reads and all BT8 mutations own their contracts", () => {
    for (const d of PRODUCTION_OPERATIONS) {
      if (BT8_MUTATIONS.includes(String(d.id))) continue;
      assert.equal(d.mutation, false, `${String(d.id)} must remain a read`);
      assert.equal(d.method, "GET", `${String(d.id)} must remain a GET`);
      assert.equal(d.body, undefined, `${String(d.id)} must carry no body`);
      assert.equal(d.response, undefined, `${String(d.id)} must declare no response contract`);
    }
    const add = PRODUCTION_OPERATIONS.find((d) => String(d.id) === "ADD_TO_WATCHLIST")!;
    assert.equal(add.mutation, "ACCOUNT");
    assert.equal(add.method, "POST");
    const remove = PRODUCTION_OPERATIONS.find((d) => String(d.id) === "REMOVE_FROM_WATCHLIST")!;
    assert.equal(remove.mutation, "ACCOUNT");
    assert.equal(remove.method, "DELETE");
    const update = PRODUCTION_OPERATIONS.find((d) => String(d.id) === "UPDATE_PLAYHEAD")!;
    assert.equal(update.mutation, "PROGRESS");
    assert.equal(update.method, "POST");
    const favorite = PRODUCTION_OPERATIONS.find((d) => String(d.id) === "SET_FAVORITE")!;
    assert.equal(favorite.mutation, "ACCOUNT");
    assert.equal(favorite.method, "PATCH");
    assert.equal(favorite.response?.body, "IGNORED");
  });

  test("all BT8 mutations and SET_FAVORITE are registered", () => {
    const ids = PRODUCTION_OPERATIONS.map((d) => String(d.id));
    for (const id of BT8_MUTATIONS) assert.equal(ids.includes(id), true, `${id} must be registered`);
    assert.equal(PRODUCTION_OPERATIONS.length, 18, "17 tool operations + internal GET_OBJECTS");
  });

  test("UPDATE reaches the same dispatcher/gateway mutation boundary", async () => {
    const h = gatewayHarness();
    const result = await h.gateway.callTool("crunchyroll_update_playhead", {
      content_id: "GE00377909ENUS",
      playhead: 42,
    });
    assert.equal(result.operation, "UPDATE_PLAYHEAD");
    assert.equal(h.backend.calls.length, 1);
  });

  test("no legacy mutation owner acquired a caller inside src/", () => {
    const gateway = readFileSync(join(SRC, "transport", "content-gateway.ts"), "utf-8");
    const api = readFileSync(join(SRC, "api.ts"), "utf-8");
    assert.equal(gateway.includes("updatePlayhead"), false, "the gateway must not reach the legacy function");
    assert.equal(/export async function updatePlayhead\b/.test(api), false, "UPDATE owner must be removed");
  });
});

// ── E/F/G/I — the caller owns no part of the wire ───────────────────────────

describe("BT8.1 — the caller cannot control method, body, headers or identity", () => {
  const registry = createOperationRegistry([SYNTHETIC_WRITE]);

  test("E/F/G: every transport-shaped argument is REFUSED, not silently dropped", () => {
    for (const key of [
      "method",
      "body",
      "payload",
      "json",
      "headers",
      "Authorization",
      "authorization",
      "token",
      "access_token",
      "cookie",
      "url",
      "path",
      "host",
      "query",
      "contentType",
    ]) {
      assert.throws(
        () =>
          resolveCall(registry, "SYNTHETIC_WRITE", {
            content_id: "GY8VEQ95Y",
            position: 1,
            [key]: "anything",
          }),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `${key} must be refused outright`
      );
    }
  });

  test("I: caller-supplied identity is refused with the precise reason", () => {
    assert.throws(
      () =>
        resolveCall(registry, "SYNTHETIC_WRITE", {
          content_id: "GY8VEQ95Y",
          position: 1,
          accountId: "someone-else",
        }),
      (e: unknown) => e instanceof TransportError && e.kind === "CALLER_SUPPLIED_IDENTITY"
    );
    // The snake_case spellings are undeclared rather than auth-derived, so they
    // get the generic refusal — but they ARE refused, which is the property that
    // matters for a write: a dropped identity argument is a caller writing to an
    // account it did not name.
    for (const key of ["account_id", "profileId", "profile_id"]) {
      assert.throws(
        () =>
          resolveCall(registry, "SYNTHETIC_WRITE", {
            content_id: "GY8VEQ95Y",
            position: 1,
            [key]: "someone-else",
          }),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `${key} must be refused`
      );
    }
  });

  test("verbatim forwarding: resolveCall refuses, it never returns a filtered set", () => {
    // The design's §6.3 rule depends on this: a future mutation handler that
    // forwards its arguments unchanged gets a refusal, not a quiet trim.
    assert.throws(() =>
      resolveCall(registry, "SYNTHETIC_WRITE", {
        content_id: "GY8VEQ95Y",
        position: 1,
        extra: "ignored?",
      })
    );
    const clean = resolveCall(registry, "SYNTHETIC_WRITE", {
      content_id: "GY8VEQ95Y",
      position: 1,
    });
    assert.deepEqual(Object.keys(clean.callerParams).sort(), ["content_id", "position"]);
  });

  test("the method on the wire is the descriptor's, and identity is the record's", async () => {
    const h = backendHarness();
    await h.backend.executeResolved(
      syntheticCall(SYNTHETIC_WRITE, { content_id: "GY8VEQ95Y", position: 7 })
    );
    assert.equal(h.requests[0].method, "POST");
    assert.equal(
      h.requests[0].url,
      `${CRUNCHYROLL_API_ORIGIN}/synthetic/v1/${ACCOUNT_SENTINEL}/things`
    );
    assert.equal(h.requests[0].authorization, `Bearer ${BEARER_SENTINEL}`);
  });
});

// ── H/K — descriptor-owned body serialization ───────────────────────────────

describe("BT8.1 — the body is the descriptor's, the values are the caller's", () => {
  test("H/K: constants first, then declared caller values, deterministically", () => {
    const body = buildRequestBody(
      syntheticCall(SYNTHETIC_WRITE, { content_id: "GY8VEQ95Y", position: 90 })
    );
    assert.equal(body?.contentType, "application/json");
    assert.equal(body?.text, '{"origin":"synthetic","content_id":"GY8VEQ95Y","position":90}');
    assert.deepEqual(JSON.parse(body!.text), {
      origin: "synthetic",
      content_id: "GY8VEQ95Y",
      position: 90,
    });
  });

  test("a descriptor with no body spec produces no body at all", () => {
    assert.equal(
      buildRequestBody(syntheticCall(SYNTHETIC_ERASE, { content_id: "GY8VEQ95Y" })),
      undefined
    );
    assert.equal(
      buildRequestBody(syntheticCall(SYNTHETIC_READ, { content_id: "GY8VEQ95Y" })),
      undefined
    );
  });

  test("an unsupplied optional field stays ABSENT, never a null", () => {
    const optional = write({
      callerParams: { content_id: contentId, position: { validate: (v: unknown) => typeof v === "number" } },
    });
    const body = buildRequestBody(syntheticCall(optional, { content_id: "GY8VEQ95Y" }));
    assert.equal(body?.text, '{"origin":"synthetic","content_id":"GY8VEQ95Y"}');
    assert.equal(body!.text.includes("null"), false);
  });

  test("the serializer knows the rule and never an operation name", () => {
    const backendSource = readFileSync(join(SRC, "transport", "browser-api-backend.ts"), "utf-8");
    const fn = backendSource.slice(
      backendSource.indexOf("export function buildRequestBody"),
      backendSource.indexOf("export const CRUNCHYROLL_API_ORIGIN")
    );
    for (const id of [...BT8_MUTATIONS, "SYNTHETIC_WRITE"]) {
      assert.equal(fn.includes(id), false, `${id} must not be special-cased in the serializer`);
    }
  });
});

// ── J — the execution gate and the request record ───────────────────────────

describe("BT8.1 — the execution gate authorizes rather than forbids", () => {
  test("J: a read's request record is byte-for-byte the one BT5 shipped", async () => {
    const h = backendHarness();
    await h.backend.executeResolved(syntheticCall(SYNTHETIC_READ, { content_id: "GY8VEQ95Y" }));
    assert.deepEqual(Object.keys(h.requests[0]).sort(), [
      "authorization",
      "deadlineMs",
      "maxBytes",
      "method",
      "url",
    ]);
    assert.equal(h.requests[0].method, "GET");
  });

  test("a POST mutation carries its serialized body and its content type", async () => {
    const h = backendHarness();
    await h.backend.executeResolved(
      syntheticCall(SYNTHETIC_WRITE, { content_id: "GY8VEQ95Y", position: 3 })
    );
    assert.deepEqual(Object.keys(h.requests[0]).sort(), [
      "authorization",
      "body",
      "deadlineMs",
      "maxBytes",
      "method",
      "url",
    ]);
    assert.equal(h.requests[0].body?.contentType, "application/json");
    assert.deepEqual(JSON.parse(h.requests[0].body!.text), {
      origin: "synthetic",
      content_id: "GY8VEQ95Y",
      position: 3,
    });
  });

  test("a DELETE mutation carries no body key at all", async () => {
    const h = backendHarness(
      Object.freeze({ status: 204, contentType: "", body: "", truncated: false })
    );
    await h.backend.executeResolved(syntheticCall(SYNTHETIC_ERASE, { content_id: "GY8VEQ95Y" }));
    assert.equal("body" in h.requests[0], false);
    assert.equal(h.requests[0].method, "DELETE");
  });

  test("a structurally invalid mutation is still refused, even past the registry", async () => {
    // Handed straight to the backend, bypassing construction entirely: the gate
    // re-derives the invariants rather than trusting the table it was given.
    for (const bogus of [
      { ...(SYNTHETIC_WRITE as object), scope: "PUBLIC" },
      { ...(SYNTHETIC_WRITE as object), auth: "NONE" },
      { ...(SYNTHETIC_WRITE as object), response: undefined },
      { ...(SYNTHETIC_WRITE as object), mutation: false },
      { ...(SYNTHETIC_READ as object), mutation: "ACCOUNT" },
      { ...(SYNTHETIC_ERASE as object), body: SYNTHETIC_WRITE.body },
    ] as OperationDescriptor[]) {
      const h = backendHarness();
      await assert.rejects(
        h.backend.executeResolved(
          Object.freeze({
            descriptor: bogus,
            callerParams: Object.freeze({ content_id: "GY8VEQ95Y", position: 1 }),
          }) as ResolvedCall
        ),
        (e: unknown) =>
          e instanceof TransportError &&
          e.kind === "OPERATION_NOT_MIGRATED" &&
          e.detail === "method"
      );
      assert.equal(h.opens(), 0, "a refused operation opens no channel");
    }
  });
});

// ── The response contract ───────────────────────────────────────────────────

describe("BT8.1 — a mutation gets the response contract it declared", () => {
  test("an EMPTY contract accepts 204 with no document and no content type", async () => {
    const h = backendHarness(
      Object.freeze({ status: 204, contentType: "", body: "", truncated: false })
    );
    const result = await h.backend.executeResolved(
      syntheticCall(SYNTHETIC_ERASE, { content_id: "GY8VEQ95Y" })
    );
    assert.equal(result.status, 204);
    assert.equal(result.json, undefined);
  });

  test("an EMPTY mutation contract treats an unexpected body as an unknown outcome", async () => {
    const h = backendHarness(
      Object.freeze({ status: 204, contentType: "", body: "{\"surprise\":1}", truncated: false })
    );
    await assert.rejects(
      h.backend.executeResolved(syntheticCall(SYNTHETIC_ERASE, { content_id: "GY8VEQ95Y" })),
      (e: unknown) =>
        e instanceof TransportError &&
        e.kind === "MUTATION_OUTCOME_UNKNOWN" &&
        e.detail === "malformed"
    );
  });

  test("a status outside the declared success list is an upstream failure", async () => {
    const h = backendHarness(
      Object.freeze({ status: 200, contentType: "", body: "", truncated: false })
    );
    await assert.rejects(
      h.backend.executeResolved(syntheticCall(SYNTHETIC_ERASE, { content_id: "GY8VEQ95Y" })),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_RESPONSE"
    );
  });

  test("reads are untouched: any 2xx, and a JSON document is still demanded", async () => {
    const json = backendHarness(
      Object.freeze({ status: 202, contentType: "application/json", body: "{}", truncated: false })
    );
    assert.deepEqual(
      (await json.backend.executeResolved(syntheticCall(SYNTHETIC_READ, { content_id: "GY8VEQ95Y" })))
        .json,
      {}
    );
    // The pre-BT8.1 behaviour for a bodyless read, unchanged: a read never
    // opted into EMPTY, so it is still an unreadable response.
    const empty = backendHarness(
      Object.freeze({ status: 204, contentType: "", body: "", truncated: false })
    );
    await assert.rejects(
      empty.backend.executeResolved(syntheticCall(SYNTHETIC_READ, { content_id: "GY8VEQ95Y" })),
      (e: unknown) =>
        e instanceof TransportError && e.kind === "INVALID_RESPONSE" && e.detail === "content-type"
    );
  });
});

// ── The browser boundary did not widen ──────────────────────────────────────

describe("BT8.1 — the page primitive grew two arguments and no authority", () => {
  const MANAGER_SOURCE = readFileSync(
    join(SRC, "transport", "browser-session-manager.ts"),
    "utf-8"
  );

  test("the function is still ONE frozen literal, never assembled", () => {
    assert.equal(CRUNCHYROLL_FETCH_FUNCTION.includes("${"), false, "no interpolation");
    assert.equal(/\+\s*(url|method|authorization|body|bearer)/.test(CRUNCHYROLL_FETCH_FUNCTION), false);
    assert.equal(CRUNCHYROLL_FETCH_FUNCTION.includes(BEARER_SENTINEL), false);
    assert.match(
      MANAGER_SOURCE,
      /functionDeclaration:\s*CRUNCHYROLL_FETCH_FUNCTION/,
      "the constant itself must be handed to CDP"
    );
  });

  test("the body pair arrives as trailing STRUCTURED parameters", () => {
    assert.match(
      CRUNCHYROLL_FETCH_FUNCTION,
      /async function\s*\(\s*url\s*,\s*method\s*,\s*authorization\s*,\s*maxBytes\s*,\s*bodyText\s*,\s*bodyContentType\s*\)/
    );
  });

  test("exactly two header names exist, both literal in the function's own source", () => {
    // The whole point of the expansion: a caller gained a body, not a header.
    // Header one is an object key; header two is the only indexed assignment,
    // and its key must be a LITERAL — a computed one would be a header name
    // arriving from somewhere, which is the thing that must be impossible.
    const indexed = [...CRUNCHYROLL_FETCH_FUNCTION.matchAll(/headers\[([^\]]*)\]/g)].map((m) => m[1]);
    assert.deepEqual(indexed, ['"Content-Type"'], "only a literal Content-Type may be indexed in");
    assert.equal(
      [...CRUNCHYROLL_FETCH_FUNCTION.matchAll(/\bAuthorization\s*:/g)].length,
      1,
      "Authorization appears exactly once, as an object key"
    );
    // And no other header name reaches the request by any route.
    assert.equal(/headers\s*=\s*\{[^}]*,/.test(CRUNCHYROLL_FETCH_FUNCTION), false);
    assert.equal(CRUNCHYROLL_FETCH_FUNCTION.includes("...headers"), false);
    assert.equal(CRUNCHYROLL_FETCH_FUNCTION.includes("Object.assign"), false);
  });

  test("Content-Type is set ONLY when a body is actually present", () => {
    // The guard, not merely the assignment: a bodyless request must keep the
    // header set it has always had.
    assert.match(CRUNCHYROLL_FETCH_FUNCTION, /if\s*\(\s*typeof bodyText === "string"\s*\)/);
    const guarded = CRUNCHYROLL_FETCH_FUNCTION.slice(
      CRUNCHYROLL_FETCH_FUNCTION.indexOf('typeof bodyText === "string"')
    );
    assert.match(guarded, /Content-Type/);
    assert.equal(
      CRUNCHYROLL_FETCH_FUNCTION.slice(
        0,
        CRUNCHYROLL_FETCH_FUNCTION.indexOf('typeof bodyText === "string"')
      ).includes("Content-Type"),
      false,
      "Content-Type must not be set unconditionally"
    );
  });

  test("the request invariants BT5 fixed are still fixed", () => {
    assert.match(CRUNCHYROLL_FETCH_FUNCTION, /credentials:\s*"omit"/);
    assert.match(CRUNCHYROLL_FETCH_FUNCTION, /redirect:\s*"manual"/);
  });

  test("the channel refuses a body on anything but a POST", () => {
    assert.match(
      MANAGER_SOURCE,
      /input\.body !== undefined && input\.method !== "POST"/,
      "the page side re-checks what the registry already refused"
    );
  });

  test("the CDP argument list appends the body pair rather than padding it", () => {
    assert.match(MANAGER_SOURCE, /if \(input\.body !== undefined\) \{\s*callArguments\.push\(/);
  });

  test("no new execution surface appeared anywhere in the transport", () => {
    for (const file of ["browser-session-manager.ts", "browser-api-backend.ts", "cdp-client.ts"]) {
      const source = readFileSync(join(SRC, "transport", file), "utf-8");
      assert.equal(/Runtime\.evaluate/.test(source), false, `${file}`);
      assert.equal(/Network\.(enable|setExtraHTTPHeaders|setCookie)/.test(source), false, `${file}`);
      assert.equal(source.includes("new Function"), false, `${file}`);
    }
    const runtimeCalls = [...MANAGER_SOURCE.matchAll(/"Runtime\.[A-Za-z]+"/g)].map((m) => m[0]);
    assert.deepEqual(
      [...new Set(runtimeCalls)].sort(),
      // Player control added two READ-ONLY context lifecycle events, so a
      // destroyed frame is never targeted. No new command was added.
      [
        '"Runtime.callFunctionOn"',
        '"Runtime.enable"',
        '"Runtime.executionContextCreated"',
        '"Runtime.executionContextDestroyed"',
        '"Runtime.executionContextsCleared"',
      ]
    );
    // Every page function is one of the two frozen constants; none is assembled.
    const declarations = [...MANAGER_SOURCE.matchAll(/functionDeclaration:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    assert.deepEqual(
      [...new Set(declarations)].sort(),
      ["CRUNCHYROLL_FETCH_FUNCTION", "CRUNCHYROLL_PLAYER_FUNCTION"]
    );
  });

  test("the Node egress prohibition is untouched", () => {
    const root = readFileSync(join(SRC, "index.ts"), "utf-8");
    assert.match(root, /installNodeCrunchyrollGuard\(\);/);
    const guard = readFileSync(join(SRC, "transport", "node-egress-guard.ts"), "utf-8");
    assert.match(guard, /const GUARDED_DOMAIN = "crunchyroll\.com";/);
  });
});
