// BT3 — auth context, revision domain and authority.
//
// Deterministic and offline: no network, no DNS, no socket, no browser, no
// credentials. Every token/identity value here is SYNTHETIC. The epoch, clock
// and starting generation are injected through the authority seam so that every
// race in the frozen design is expressed as an explicit, ordered barrier rather
// than as timing.
//
// Frozen design: CRUNCHYROLL-BT3-DESIGN-GATE0.md + …-FIX1-ERRATA.md.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as authContextModule from "../src/transport/auth-context.js";
import {
  createAuthContextAuthority,
  nextGeneration,
  revisionsEqual,
  AuthContextError,
  MAX_AUTH_GENERATION,
} from "../src/transport/auth-context.js";

// ── Symbolic material (never a real credential) ─────────────────────────────

const EPOCH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EPOCH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A fixed clock. Material expiring after this is usable, before it is not. */
const T0 = 1_000_000;

function authority(overrides: {
  epoch?: string;
  now?: () => number;
  initialGeneration?: number;
} = {}) {
  return createAuthContextAuthority({
    epochFactory: () => overrides.epoch ?? EPOCH_A,
    now: overrides.now ?? (() => T0),
    initialGeneration: overrides.initialGeneration,
  });
}

describe("BT3 revision domain — epoch and generation", () => {
  test("a fresh authority is unavailable at generation 0", () => {
    const a = authority();
    const revision = a.currentRevision();
    assert.equal(revision.generation, 0);
    assert.equal(revision.epoch, EPOCH_A);
    assert.equal(a.diagnostics().availability, "UNAVAILABLE");
    assert.equal(a.diagnostics().reason, "INITIAL");
  });

  test("the injected epoch factory is used and is not read from the environment", () => {
    assert.equal(authority({ epoch: EPOCH_B }).currentRevision().epoch, EPOCH_B);
  });

  test("a production authority mints 32 lowercase hex characters, distinct per instance", () => {
    // No seam: this is the real randomBytes(16) path.
    const first = createAuthContextAuthority().currentRevision().epoch;
    const second = createAuthContextAuthority().currentRevision().epoch;
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.match(second, /^[0-9a-f]{32}$/);
    assert.notEqual(first, second);
  });

  test("the revision view is frozen and cannot be mutated by its receiver", () => {
    const revision = authority().currentRevision();
    assert.equal(Object.isFrozen(revision), true);
    assert.throws(() => {
      (revision as { generation: number }).generation = 99;
    }, TypeError);
  });

  test("T9: equal generations in different epochs are NOT the same revision", () => {
    const inA = { epoch: EPOCH_A, generation: 1 };
    const inB = { epoch: EPOCH_B, generation: 1 };
    assert.equal(revisionsEqual(inA, inA), true);
    assert.equal(revisionsEqual(inA, inB), false);
    assert.equal(revisionsEqual(inA, { epoch: EPOCH_A, generation: 2 }), false);
  });

  test("generation increments by exactly one and never wraps at the maximum", () => {
    assert.equal(nextGeneration(0), 1);
    assert.equal(nextGeneration(41), 42);
    assert.equal(nextGeneration(MAX_AUTH_GENERATION - 1), MAX_AUTH_GENERATION);
    assert.equal(MAX_AUTH_GENERATION, Number.MAX_SAFE_INTEGER);
    assert.throws(
      () => nextGeneration(MAX_AUTH_GENERATION),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
  });

  test("an injected starting generation is honoured for deterministic overflow tests", () => {
    const a = authority({ initialGeneration: MAX_AUTH_GENERATION });
    assert.equal(a.currentRevision().generation, MAX_AUTH_GENERATION);
  });
});

describe("BT3 error vocabulary — closed, fixed and secret-free", () => {
  test("each kind carries only its fixed message", () => {
    const cases: Array<[string, string]> = [
      ["AUTH_CONTEXT_UNAVAILABLE", "Authentication context is unavailable"],
      ["AUTH_CONTEXT_STALE", "Authentication context is stale"],
      ["AUTH_IDENTITY_CHANGED", "Authentication identity changed unexpectedly"],
    ];
    for (const [kind, message] of cases) {
      const error = new AuthContextError(kind as never);
      assert.equal(error.message, message);
      assert.equal(error.kind, kind);
      assert.equal(error.name, "AuthContextError");
      assert.ok(error instanceof Error);
    }
  });

  test("the error carries no detail, cause, identity or material channel", () => {
    const error = new AuthContextError("AUTH_CONTEXT_STALE");
    // Only the fixed Error shape (`name`) plus the discriminant `kind` —
    // nothing that could carry a token, an account id, an epoch, a provider
    // body or a raw cause. TransportError's `detail` channel is deliberately
    // absent here.
    assert.deepEqual(Object.keys(error).sort(), ["kind", "name"]);
    for (const channel of ["detail", "cause", "context", "revision", "record", "candidate"]) {
      assert.equal((error as unknown as Record<string, unknown>)[channel], undefined, channel);
    }
  });
});

describe("BT3 opacity — a caller cannot construct an AuthContext", () => {
  test("the module exports no context constructor, brand or issuance helper", () => {
    const exported = Object.keys(authContextModule);
    const forbidden = exported.filter((name) =>
      /brand|issue|mint|forge|createAuthContext$|newAuthContext|toAuthContext|fromJSON|rehydrate/i.test(
        name
      )
    );
    assert.deepEqual(forbidden, [], `module must expose no context construction path: ${forbidden}`);
  });

  test("AuthContext is a type-only export with no runtime value", () => {
    assert.equal((authContextModule as Record<string, unknown>).AuthContext, undefined);
  });
});
