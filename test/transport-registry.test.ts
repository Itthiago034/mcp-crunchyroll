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
  auth: "NONE",
  mutation: false,
};

export const SYNTHETIC_ACCOUNT: OperationDescriptor = {
  id: "SYNTHETIC_ACCOUNT" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/{accountId}/items",
  callerParams: { n: optionalIntegerInRange(1, 100) },
  authDerivedParams: { accountId: { source: "accountId" } },
  scope: "ACCOUNT",
  auth: "BEARER",
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

  test("the production operation table holds exactly the migrated operations", () => {
    // RETIRED AT BT5: "empty in BT1" was true until the cutover. A descriptor
    // enters only when its path literal LEAVES src/api.ts, which is what BT5
    // did for GET_CATEGORIES; the remaining reads follow at BT6/BT7.
    assert.deepEqual(
      [...PRODUCTION_OPERATIONS].map((d) => d.id),
      ["GET_CATEGORIES"]
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

describe("BT1 registry — auth-owned parameters", () => {
  const registry = createOperationRegistry([SYNTHETIC_ACCOUNT]);

  test("caller-supplied accountId is rejected as CALLER_SUPPLIED_IDENTITY", () => {
    assert.throws(
      () => resolveCall(registry, "SYNTHETIC_ACCOUNT", { n: 20, accountId: "acct-1" }),
      (e: unknown) =>
        e instanceof TransportError && e.kind === "CALLER_SUPPLIED_IDENTITY" &&
        String(e.detail).includes("accountId")
    );
  });

  test("caller-supplied profileId is rejected as CALLER_SUPPLIED_IDENTITY", () => {
    const withProfile = createOperationRegistry([{
      ...SYNTHETIC_ACCOUNT,
      id: "SYNTHETIC_PROFILE" as OperationId,
      pathTemplate: "/synthetic/v1/{accountId}/{profileId}/items",
      authDerivedParams: {
        accountId: { source: "accountId" }, profileId: { source: "profileId" },
      },
    }]);
    assert.throws(
      () => resolveCall(withProfile, "SYNTHETIC_PROFILE", { profileId: "p-1" }),
      (e: unknown) =>
        e instanceof TransportError && e.kind === "CALLER_SUPPLIED_IDENTITY" &&
        String(e.detail).includes("profileId")
    );
  });

  test("identity rejection is not masked as a generic unknown argument", () => {
    try {
      resolveCall(registry, "SYNTHETIC_ACCOUNT", { accountId: "acct-1" });
      assert.fail("expected a TransportError");
    } catch (e) {
      assert.ok(e instanceof TransportError);
      assert.equal(e.kind, "CALLER_SUPPLIED_IDENTITY");
    }
  });

  test("callerParams and authDerivedParams overlap is rejected at definition time", () => {
    assert.throws(
      () => createOperationRegistry([{
        ...SYNTHETIC_ACCOUNT,
        id: "SYNTHETIC_OVERLAP" as OperationId,
        callerParams: { accountId: nonEmptyString },
      }]),
      (e: unknown) =>
        e instanceof TransportError && e.kind === "INVALID_ARGUMENTS" &&
        String(e.detail).includes("accountId")
    );
  });

  test("an auth-derived param absent from the path template is rejected at definition time", () => {
    assert.throws(
      () => createOperationRegistry([{
        ...SYNTHETIC_ACCOUNT,
        id: "SYNTHETIC_BAD_PATH" as OperationId,
        pathTemplate: "/synthetic/v1/items",
      }]),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
  });
});

describe("BT1 registry — immutability of captured policy", () => {
  test("mutating a caller ParamSpec after construction does not change policy", () => {
    const spec = { required: true, validate: (v: unknown) => typeof v === "string" };
    const descriptor: OperationDescriptor = {
      id: "SYNTHETIC_MUTABLE" as OperationId,
      method: "GET",
      pathTemplate: "/synthetic/v1/mutable",
      callerParams: { q: spec },
      authDerivedParams: {},
      scope: "PUBLIC",
  auth: "NONE",
      mutation: false,
    };
    const registry = createOperationRegistry([descriptor]);
    assert.throws(() => resolveCall(registry, "SYNTHETIC_MUTABLE", { q: 123 }));

    (spec as { validate: (v: unknown) => boolean }).validate = () => true;

    assert.throws(
      () => resolveCall(registry, "SYNTHETIC_MUTABLE", { q: 123 }),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
      "the registry must use its captured predicate, not the caller's mutated one"
    );
  });

  test("adding a key to the original callerParams map does not widen the registry", () => {
    const callerParams: Record<string, typeof nonEmptyString> = { q: nonEmptyString };
    const descriptor: OperationDescriptor = {
      id: "SYNTHETIC_WIDEN" as OperationId,
      method: "GET",
      pathTemplate: "/synthetic/v1/widen",
      callerParams,
      authDerivedParams: {},
      scope: "PUBLIC",
  auth: "NONE",
      mutation: false,
    };
    const registry = createOperationRegistry([descriptor]);

    callerParams.url = nonEmptyString;

    assert.throws(
      () => resolveCall(registry, "SYNTHETIC_WIDEN", { q: "x", url: "https://evil.example" }),
      (e: unknown) =>
        e instanceof TransportError && e.kind === "INVALID_ARGUMENTS" &&
        String(e.detail).includes("url")
    );
  });

  test("mutating the original descriptor's path template does not change the registry copy", () => {
    const descriptor: OperationDescriptor = {
      id: "SYNTHETIC_PATH" as OperationId,
      method: "GET",
      pathTemplate: "/synthetic/v1/original",
      callerParams: {},
      authDerivedParams: {},
      scope: "PUBLIC",
  auth: "NONE",
      mutation: false,
    };
    const registry = createOperationRegistry([descriptor]);
    (descriptor as { pathTemplate: string }).pathTemplate = "/synthetic/v1/hijacked";
    assert.equal(registry.get("SYNTHETIC_PATH")?.pathTemplate, "/synthetic/v1/original");
  });

  test("mutating the original authDerivedParams map does not change the registry copy", () => {
    const authDerivedParams: Record<string, { source: "accountId" | "profileId" }> = {
      accountId: { source: "accountId" },
    };
    const descriptor: OperationDescriptor = {
      id: "SYNTHETIC_AUTH_COPY" as OperationId,
      method: "GET",
      pathTemplate: "/synthetic/v1/{accountId}/items",
      callerParams: {},
      authDerivedParams,
      scope: "ACCOUNT",
  auth: "BEARER",
      mutation: false,
    };
    const registry = createOperationRegistry([descriptor]);
    delete authDerivedParams.accountId;
    assert.throws(
      () => resolveCall(registry, "SYNTHETIC_AUTH_COPY", { accountId: "a" }),
      (e: unknown) => e instanceof TransportError && e.kind === "CALLER_SUPPLIED_IDENTITY"
    );
  });

  test("the descriptor returned by the registry cannot be mutated to widen policy", () => {
    const registry = createOperationRegistry([SYNTHETIC_PUBLIC]);
    const got = registry.get("SYNTHETIC_PUBLIC");
    assert.ok(got);
    assert.throws(() => {
      (got.callerParams as Record<string, unknown>).url = nonEmptyString;
    }, TypeError, "the exposed callerParams map must be frozen");
    assert.throws(
      () => resolveCall(registry, "SYNTHETIC_PUBLIC", { query: "x", url: "https://evil.example" }),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
  });
});

// ── BT5-FIX1: auth requirement is a dimension of its own ────────────────────

describe("BT5-FIX1 registry — scope and auth are orthogonal", () => {
  const base = {
    method: "GET" as const,
    pathTemplate: "/synthetic/v1/thing",
    callerParams: {},
    authDerivedParams: {},
    mutation: false as const,
  };

  test("ACCOUNT + NONE is rejected at construction as a meaningless combination", () => {
    assert.throws(
      () =>
        createOperationRegistry([
          { ...base, id: "SYNTH_ACCOUNT_NONE" as OperationId, scope: "ACCOUNT",
  auth: "BEARER", auth: "NONE" },
        ]),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS"
    );
  });

  test("an unknown or missing auth requirement is rejected, never defaulted", () => {
    for (const auth of [undefined, "MAYBE", "", null]) {
      assert.throws(
        () =>
          createOperationRegistry([
            {
              ...base,
              id: "SYNTH_BAD_AUTH" as OperationId,
              scope: "PUBLIC",
  auth: "NONE",
              auth: auth as never,
            },
          ]),
        (e: unknown) => e instanceof TransportError && e.kind === "INVALID_ARGUMENTS",
        `auth=${String(auth)} must be refused`
      );
    }
  });

  test("the three meaningful combinations are accepted", () => {
    const registry = createOperationRegistry([
      { ...base, id: "SYNTH_PUBLIC_NONE" as OperationId, scope: "PUBLIC",
  auth: "NONE", auth: "NONE" },
      { ...base, id: "SYNTH_PUBLIC_BEARER" as OperationId, scope: "PUBLIC",
  auth: "NONE", auth: "BEARER" },
      {
        ...base,
        id: "SYNTH_ACCOUNT_BEARER" as OperationId,
        pathTemplate: "/synthetic/v1/{accountId}/thing",
        authDerivedParams: { accountId: { source: "accountId" as const } },
        scope: "ACCOUNT",
  auth: "BEARER",
        auth: "BEARER",
      },
    ]);
    assert.deepEqual(
      [...registry.ids()].sort(),
      ["SYNTH_ACCOUNT_BEARER", "SYNTH_PUBLIC_BEARER", "SYNTH_PUBLIC_NONE"]
    );
  });

  test("the captured descriptor keeps the auth requirement immutably", () => {
    const mutable = {
      ...base,
      id: "SYNTH_CAPTURE" as OperationId,
      scope: "PUBLIC" as const,
      auth: "BEARER" as const,
    };
    const registry = createOperationRegistry([mutable]);
    (mutable as { auth: string }).auth = "NONE";
    assert.equal(registry.get("SYNTH_CAPTURE")!.auth, "BEARER", "registry policy is a copy");
  });
});
