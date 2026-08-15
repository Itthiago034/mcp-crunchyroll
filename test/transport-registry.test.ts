// BT1 — Operation Registry contract.
//
// Deterministic and offline: no network, no DNS, no socket, no credentials.
// Every descriptor here is SYNTHETIC; the production table stays empty until
// an endpoint's path literal actually leaves src/api.ts (BT6/BT7).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createOperationRegistry, resolveCall, PRODUCTION_OPERATIONS,
} from "../src/transport/operation-registry.js";
import { TransportError } from "../src/transport/transport-error.js";
import {
  nonEmptyString, optionalIntegerInRange,
  type OperationDescriptor, type OperationId,
} from "../src/transport/types.js";

export const SYNTHETIC_PUBLIC: OperationDescriptor = {
  id: "SYNTHETIC_PUBLIC" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/public",
  callerParams: { query: nonEmptyString, n: optionalIntegerInRange(1, 100) },
  authDerivedParams: {},
  scope: "PUBLIC",
  mutation: false,
};

export const SYNTHETIC_ACCOUNT: OperationDescriptor = {
  id: "SYNTHETIC_ACCOUNT" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/{accountId}/items",
  callerParams: { n: optionalIntegerInRange(1, 100) },
  authDerivedParams: { accountId: { source: "accountId" } },
  scope: "ACCOUNT",
  mutation: false,
};

describe("BT1 registry — construction and lookup", () => {
  test("a known synthetic operation resolves through the registry", () => {
    const registry = createOperationRegistry([SYNTHETIC_PUBLIC, SYNTHETIC_ACCOUNT]);
    assert.equal(registry.has("SYNTHETIC_PUBLIC"), true);
    assert.equal(registry.get("SYNTHETIC_PUBLIC")?.method, "GET");
    assert.deepEqual([...registry.ids()].sort(), ["SYNTHETIC_ACCOUNT", "SYNTHETIC_PUBLIC"]);
  });

  test("an unknown operation id is absent, never fabricated", () => {
    const registry = createOperationRegistry([SYNTHETIC_PUBLIC]);
    assert.equal(registry.has("NOPE"), false);
    assert.equal(registry.get("NOPE"), undefined);
  });

  test("resolveCall returns the descriptor for a known operation", () => {
    const registry = createOperationRegistry([SYNTHETIC_PUBLIC]);
    // SYNTHETIC_PUBLIC declares `query` as required, so a well-formed call
    // supplies it; this test is about descriptor lookup, not about arguments.
    const resolved = resolveCall(registry, "SYNTHETIC_PUBLIC", { query: "frieren" });
    assert.equal(resolved.descriptor.id, "SYNTHETIC_PUBLIC");
  });

  test("resolveCall rejects an unknown operation as UNKNOWN_OPERATION", () => {
    const registry = createOperationRegistry([SYNTHETIC_PUBLIC]);
    assert.throws(
      () => resolveCall(registry, "NO_SUCH_OPERATION", {}),
      (e: unknown) => e instanceof TransportError && e.kind === "UNKNOWN_OPERATION"
    );
  });

  test("a duplicate operation id is rejected at construction", () => {
    assert.throws(
      () => createOperationRegistry([SYNTHETIC_PUBLIC, SYNTHETIC_PUBLIC]),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
  });

  test("the production operation table is empty in BT1", () => {
    assert.deepEqual(
      [...PRODUCTION_OPERATIONS],
      [],
      "real descriptors enter only when their path literal leaves src/api.ts (BT6/BT7)"
    );
  });
});

describe("BT1 registry — caller arguments", () => {
  const registry = createOperationRegistry([SYNTHETIC_PUBLIC]);

  test("declared caller arguments are accepted and returned validated", () => {
    const { descriptor, callerParams } = resolveCall(registry, "SYNTHETIC_PUBLIC", {
      query: "frieren", n: 20,
    });
    assert.equal(descriptor.id, "SYNTHETIC_PUBLIC");
    assert.deepEqual(callerParams, { query: "frieren", n: 20 });
  });

  test("a missing required caller argument is rejected", () => {
    assert.throws(
      () => resolveCall(registry, "SYNTHETIC_PUBLIC", { n: 5 }),
      (e: unknown) =>
        e instanceof TransportError && e.kind === "INVALID_ARGUMENTS" &&
        String(e.detail).includes("query")
    );
  });

  test("a caller argument failing its predicate is rejected", () => {
    assert.throws(
      () => resolveCall(registry, "SYNTHETIC_PUBLIC", { query: "frieren", n: 9999 }),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
  });

  // The safety property is structural: ONLY keys declared in callerParams are
  // accepted. This list demonstrates that rule; it is not a blacklist.
  for (const forbidden of [
    "url", "path", "origin", "method", "headers", "Authorization", "authorization",
    "bearer", "token", "cookie", "Cookie", "script", "javascript",
  ]) {
    test(`caller key "${forbidden}" is rejected as an unexpected argument`, () => {
      assert.throws(
        () => resolveCall(registry, "SYNTHETIC_PUBLIC", { query: "frieren", [forbidden]: "x" }),
        (e: unknown) =>
          e instanceof TransportError && e.kind === "INVALID_ARGUMENTS" &&
          String(e.detail).includes(forbidden)
      );
    });
  }
});
