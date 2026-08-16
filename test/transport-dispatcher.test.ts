// BT1 — the dispatcher is the single caller-facing validation path.
//
// Deterministic and offline: no network, no DNS, no socket, no credentials.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createOperationRegistry } from "../src/transport/operation-registry.js";
import { createTransportDispatcher } from "../src/transport/dispatcher.js";
import { TransportError } from "../src/transport/transport-error.js";
import {
  nonEmptyString, type OperationDescriptor, type OperationId,
} from "../src/transport/types.js";
import { FakeTransportBackend } from "./_fake-backend.js";

const OP: OperationDescriptor = {
  id: "SYNTHETIC_PUBLIC" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/public",
  callerParams: { query: nonEmptyString },
  authDerivedParams: {},
  fixedQuery: {},
  queryParams: {},
  scope: "PUBLIC",
  auth: "NONE",
  mutation: false,
};

const ACCOUNT_OP: OperationDescriptor = {
  id: "SYNTHETIC_ACCOUNT" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/{accountId}/items",
  callerParams: {},
  authDerivedParams: { accountId: { source: "accountId" } },
  scope: "ACCOUNT",
  auth: "BEARER",
  mutation: false,
};

function wire(descriptors: OperationDescriptor[], backend = new FakeTransportBackend()) {
  return {
    backend,
    transport: createTransportDispatcher(createOperationRegistry(descriptors), backend),
  };
}

describe("BT1 dispatcher — the single validation path", () => {
  test("a valid call reaches the backend as a ResolvedCall", async () => {
    const { backend, transport } = wire([OP]);
    const result = await transport.execute("SYNTHETIC_PUBLIC" as OperationId, { query: "frieren" });

    assert.equal(backend.calls.length, 1);
    const call = backend.calls[0];
    assert.equal(call.descriptor.id, "SYNTHETIC_PUBLIC");
    assert.equal(call.descriptor.method, "GET");
    assert.deepEqual(call.callerParams, { query: "frieren" });
    assert.equal(result.status, 200);
  });

  test("the backend receives the resolved descriptor, not raw caller input", async () => {
    const { backend, transport } = wire([OP]);
    await transport.execute("SYNTHETIC_PUBLIC" as OperationId, { query: "frieren" });
    const call = backend.calls[0];
    assert.deepEqual(Object.keys(call).sort(), ["callerParams", "descriptor"]);
  });

  test("an unknown operation never reaches the backend", async () => {
    const { backend, transport } = wire([OP]);
    await assert.rejects(
      () => transport.execute("NOT_REGISTERED" as OperationId, {}),
      (e: unknown) => e instanceof TransportError && e.kind === "UNKNOWN_OPERATION"
    );
    assert.equal(backend.calls.length, 0);
  });

  test("an unexpected caller argument never reaches the backend", async () => {
    const { backend, transport } = wire([OP]);
    await assert.rejects(
      () => transport.execute("SYNTHETIC_PUBLIC" as OperationId, { query: "x", url: "https://evil.example" }),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
    assert.equal(backend.calls.length, 0, "validation must fail closed before dispatch");
  });

  for (const forbidden of ["url", "method", "headers", "Authorization", "bearer", "cookie", "javascript"]) {
    test(`injected "${forbidden}" never reaches the backend`, async () => {
      const { backend, transport } = wire([OP]);
      await assert.rejects(
        () => transport.execute("SYNTHETIC_PUBLIC" as OperationId, { query: "x", [forbidden]: "v" }),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
      );
      assert.equal(backend.calls.length, 0);
    });
  }

  test("caller-supplied identity never reaches the backend", async () => {
    const { backend, transport } = wire([ACCOUNT_OP]);
    await assert.rejects(
      () => transport.execute("SYNTHETIC_ACCOUNT" as OperationId, { accountId: "acct-1" }),
      (e: unknown) => e instanceof TransportError && e.kind === "CALLER_SUPPLIED_IDENTITY"
    );
    assert.equal(backend.calls.length, 0);
  });

  test("a deterministic backend success is returned unchanged", async () => {
    const backend = new FakeTransportBackend({
      result: { status: 200, contentType: "application/json", json: { data: [1, 2, 3] } },
    });
    const { transport } = wire([OP], backend);
    const result = await transport.execute("SYNTHETIC_PUBLIC" as OperationId, { query: "x" });
    assert.deepEqual(result.json, { data: [1, 2, 3] });
  });

  test("a deterministic backend failure propagates in typed form", async () => {
    const backend = new FakeTransportBackend({
      failWith: new TransportError("TRANSPORT_FAILURE", "injected"),
    });
    const { transport } = wire([OP], backend);
    await assert.rejects(
      () => transport.execute("SYNTHETIC_PUBLIC" as OperationId, { query: "x" }),
      (e: unknown) => e instanceof TransportError && e.kind === "TRANSPORT_FAILURE"
    );
    assert.equal(backend.calls.length, 1, "the call was validated and dispatched before failing");
  });

  test("the caller-facing transport exposes only execute", () => {
    const { transport } = wire([OP]);
    assert.deepEqual(Object.keys(transport), ["execute"]);
  });
});
