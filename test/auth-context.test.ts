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

// ── Symbolic material for the authority lifecycle ───────────────────────────
//
// FIX1 §11 requires the account/profile probes to be named sentinels so that a
// leak into a log, an error or a serialization is unambiguous.

const SENSITIVE_ACCOUNT_SENTINEL = "SENSITIVE-ACCOUNT-SENTINEL-7f3a";
const SENSITIVE_ACCOUNT_SENTINEL_B = "SENSITIVE-ACCOUNT-SENTINEL-b219";
const SENSITIVE_PROFILE_SENTINEL = "SENSITIVE-PROFILE-SENTINEL-4c8d";
const SENSITIVE_PROFILE_SENTINEL_B = "SENSITIVE-PROFILE-SENTINEL-e015";
const TOKEN_SENTINEL = "SYNTHETIC-ACCESS-TOKEN-SENTINEL-1";
const TOKEN_SENTINEL_B = "SYNTHETIC-ACCESS-TOKEN-SENTINEL-2";

const ONE_HOUR = 3_600_000;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: TOKEN_SENTINEL,
    tokenType: "Bearer",
    expiresAt: T0 + ONE_HOUR,
    accountId: SENSITIVE_ACCOUNT_SENTINEL,
    ...overrides,
  } as never;
}

type Authority = ReturnType<typeof authority>;

/** Install first material through the explicit ESTABLISH path. */
function establish(a: Authority, overrides: Record<string, unknown> = {}) {
  return a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", candidate(overrides));
}

/**
 * The current generation's invalidation signal, through the single test-only
 * inspector seam. Capturing it BEFORE a transition is how the reentrancy and
 * stale-execution barriers below are made deterministic.
 */
function signalOf(a: Authority): AbortSignal {
  const signal = a.inspectForTest().signal;
  assert.ok(signal, "a READY authority must expose its generation signal to the test seam");
  return signal;
}

describe("BT3 authority — install and acquire", () => {
  test("an unavailable authority refuses acquisition, fail-closed", () => {
    const a = authority();
    assert.throws(
      () => a.acquire(),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
  });

  test("the first validated installation moves generation 0 → 1 and becomes READY", () => {
    const a = authority();
    const context = establish(a);
    assert.equal(a.currentRevision().generation, 1);
    assert.equal(a.currentRevision().epoch, EPOCH_A);
    assert.equal(a.diagnostics().availability, "READY");
    assert.equal(a.diagnostics().reason, undefined);
    assert.ok(context);
  });

  test("the issued handle is opaque: frozen, null-prototype, empty and unserializable", () => {
    const context = establish(authority());
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.getPrototypeOf(context), null);
    assert.deepEqual(Object.keys(context), []);
    assert.deepEqual(Object.getOwnPropertyNames(context), []);
    assert.deepEqual(Object.getOwnPropertySymbols(context), []);
    // Generic serialization yields nothing usable, and nothing that could be
    // rehydrated into an accepted capability.
    assert.equal(JSON.stringify(context), "{}");
    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes(TOKEN_SENTINEL), false);
    assert.equal(serialized.includes(SENSITIVE_ACCOUNT_SENTINEL), false);
    assert.equal(serialized.includes(EPOCH_A), false);
  });

  test("a rehydrated lookalike is not the handle and cannot be acquired into", () => {
    const a = authority();
    const context = establish(a);
    const lookalike = Object.freeze(Object.create(null));
    assert.notEqual(lookalike, context);
    assert.equal(a.acquire(), context);
  });

  test("repeated acquisition returns the same handle and never increments", () => {
    const a = authority();
    const context = establish(a);
    assert.equal(a.acquire(), context);
    assert.equal(a.acquire(), context);
    assert.equal(a.currentRevision().generation, 1);
  });

  test("simultaneous acquisitions observe one canonical current handle", () => {
    const a = authority();
    establish(a);
    const handles = [a.acquire(), a.acquire(), a.acquire()];
    assert.equal(new Set(handles).size, 1);
  });

  test("the test-only inspector reports identity and metadata but never the token", () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });
    const seen = a.inspectForTest();
    assert.equal(seen.accountId, SENSITIVE_ACCOUNT_SENTINEL);
    assert.equal(seen.profileId, SENSITIVE_PROFILE_SENTINEL);
    assert.equal(seen.tokenType, "Bearer");
    assert.equal(seen.availability, "READY");
    assert.equal("accessToken" in seen, false);
    assert.equal(JSON.stringify(seen).includes(TOKEN_SENTINEL), false);
  });

  test("diagnostics report whether a profile id was present, never its value", () => {
    const withProfile = authority();
    establish(withProfile, { profileId: SENSITIVE_PROFILE_SENTINEL });
    assert.equal(withProfile.diagnostics().hasProfileId, true);

    const withoutProfile = authority();
    establish(withoutProfile);
    assert.equal(withoutProfile.diagnostics().hasProfileId, false);

    const rendered = JSON.stringify(withProfile.diagnostics());
    assert.equal(rendered.includes(SENSITIVE_PROFILE_SENTINEL), false);
    assert.equal(rendered.includes(SENSITIVE_ACCOUNT_SENTINEL), false);
    assert.equal(rendered.includes(EPOCH_A), false);
  });
});

describe("BT3 authority — closed candidate validation (fail closed)", () => {
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["absent access token", { accessToken: undefined }],
    ["empty access token", { accessToken: "" }],
    ["whitespace access token", { accessToken: "   " }],
    ["non-string access token", { accessToken: 42 }],
    ["absent token type", { tokenType: undefined }],
    ["empty token type", { tokenType: "" }],
    ["absent account id", { accountId: undefined }],
    ["empty account id", { accountId: "" }],
    ["null profile id", { profileId: null }],
    ["empty profile id", { profileId: "" }],
    ["non-string profile id", { profileId: 7 }],
    ["already expired material", { expiresAt: T0 - 1 }],
    ["material expiring exactly now", { expiresAt: T0 }],
    ["non-numeric expiry", { expiresAt: "soon" }],
    ["NaN expiry", { expiresAt: Number.NaN }],
    ["infinite expiry", { expiresAt: Number.POSITIVE_INFINITY }],
  ];

  for (const [name, override] of rejected) {
    test(`${name} produces no context and no generation change`, () => {
      const a = authority();
      assert.throws(
        () => establish(a, override),
        (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
      );
      assert.equal(a.currentRevision().generation, 0);
      assert.equal(a.diagnostics().availability, "UNAVAILABLE");
      assert.equal(a.diagnostics().reason, "INITIAL");
    });
  }

  test("a rejected candidate never disturbs already-installed material", () => {
    const a = authority();
    const context = establish(a);
    assert.throws(() => a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: "" })));
    assert.equal(a.currentRevision().generation, 1);
    assert.equal(a.acquire(), context);
    assert.equal(signalOf(a).aborted, false);
  });

  test("material that expires while installed fails acquisition without incrementing", () => {
    let clock = T0;
    const a = createAuthContextAuthority({ epochFactory: () => EPOCH_A, now: () => clock });
    a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", candidate());
    clock = T0 + ONE_HOUR + 1;
    assert.throws(
      () => a.acquire(),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
    // Expiry is not an authority transition: only a trusted producer mutates.
    assert.equal(a.currentRevision().generation, 1);
  });
});

describe("BT3 authority — replacement and identity continuity", () => {
  test("a same-identity refresh increments once and issues a new handle", () => {
    const a = authority();
    const first = establish(a);
    const second = a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));
    assert.equal(a.currentRevision().generation, 2);
    assert.notEqual(second, first);
    assert.equal(a.acquire(), second);
  });

  test("T5: the handle of a replaced generation is permanently stale", () => {
    const a = authority();
    const first = establish(a);
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));
    assert.notEqual(a.acquire(), first);
    // Staleness is permanent: no later transition can make it current again.
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL }));
    assert.notEqual(a.acquire(), first);
  });

  test("a replaced generation's signal is aborted", () => {
    const a = authority();
    establish(a);
    const firstSignalAborted = signalOf(a).aborted;
    assert.equal(firstSignalAborted, false);
    const signal = signalOf(a);
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));
    assert.equal(signal.aborted, true);
    assert.equal(signalOf(a).aborted, false, "the new generation's own signal is live");
  });

  test("T14: a refresh that changes the account id is rejected as an identity change", () => {
    const a = authority();
    const first = establish(a);
    assert.throws(
      () =>
        a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({
          accountId: SENSITIVE_ACCOUNT_SENTINEL_B,
        })),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_IDENTITY_CHANGED"
    );
    // Fail closed: the candidate is NOT installed, the old context is gone, and
    // the transition is published as a new generation.
    assert.equal(a.diagnostics().availability, "UNAVAILABLE");
    assert.equal(a.diagnostics().reason, "INVALIDATED");
    assert.equal(a.currentRevision().generation, 2);
    assert.equal(a.inspectForTest().accountId, undefined);
    assert.throws(() => a.acquire(), AuthContextError);
    assert.ok(first);
  });

  const identityChanges: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["a profile id appears", {}, { profileId: SENSITIVE_PROFILE_SENTINEL }],
    ["a profile id disappears", { profileId: SENSITIVE_PROFILE_SENTINEL }, {}],
    [
      "a profile id changes value",
      { profileId: SENSITIVE_PROFILE_SENTINEL },
      { profileId: SENSITIVE_PROFILE_SENTINEL_B },
    ],
  ];

  for (const [name, initial, refreshed] of identityChanges) {
    test(`T14: refresh where ${name} invalidates instead of switching silently`, () => {
      const a = authority();
      establish(a, initial);
      assert.throws(
        () => a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ profileId: undefined, ...refreshed })),
        (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_IDENTITY_CHANGED"
      );
      assert.equal(a.diagnostics().availability, "UNAVAILABLE");
      assert.equal(a.currentRevision().generation, 2);
    });
  }

  test("a refresh with no current material cannot bootstrap an identity", () => {
    const a = authority();
    assert.throws(
      () => a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate()),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
    assert.equal(a.currentRevision().generation, 0);
  });

  test("ESTABLISH may switch account as an explicit new session", () => {
    const a = authority();
    const accountA = establish(a);
    const accountB = a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", candidate({
      accountId: SENSITIVE_ACCOUNT_SENTINEL_B,
      accessToken: TOKEN_SENTINEL_B,
    }));
    assert.equal(a.currentRevision().generation, 2);
    assert.equal(a.inspectForTest().accountId, SENSITIVE_ACCOUNT_SENTINEL_B);
    assert.equal(a.acquire(), accountB);
    assert.notEqual(a.acquire(), accountA);
  });
});

describe("BT3 authority — invalidation", () => {
  test("logout publishes UNAVAILABLE at the next generation and aborts the old signal", () => {
    const a = authority();
    establish(a);
    const signal = signalOf(a);
    const revision = a.invalidate("LOGOUT");
    assert.equal(revision.generation, 2);
    assert.equal(a.diagnostics().availability, "UNAVAILABLE");
    assert.equal(a.diagnostics().reason, "INVALIDATED");
    assert.equal(a.diagnostics().cause, "LOGOUT");
    assert.equal(signal.aborted, true);
    assert.throws(() => a.acquire(), AuthContextError);
  });

  test("an explicit invalidation while already unavailable is an ordering barrier", () => {
    const a = authority();
    assert.equal(a.currentRevision().generation, 0);
    assert.equal(a.invalidate("PROCESS_SHUTDOWN").generation, 1);
    assert.equal(a.invalidate("PROCESS_SHUTDOWN").generation, 2);
    assert.equal(a.diagnostics().availability, "UNAVAILABLE");
  });

  test("every invalidation cause is accepted and reported as a closed enum", () => {
    for (const cause of ["LOGOUT", "INVALID_GRANT", "AUTH_MATERIAL_LOST", "PROCESS_SHUTDOWN"] as const) {
      const a = authority();
      establish(a);
      a.invalidate(cause);
      assert.equal(a.diagnostics().cause, cause);
    }
  });

  test("material can be established again after an invalidation, at a new generation", () => {
    const a = authority();
    const first = establish(a);
    a.invalidate("LOGOUT");
    const second = a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", candidate());
    assert.equal(a.currentRevision().generation, 3);
    assert.notEqual(second, first);
    assert.equal(a.acquire(), second);
  });
});

describe("BT3 authority — generation overflow is terminal, never wrapped", () => {
  test("T15: an increment required at the maximum publishes EXHAUSTED and refuses", () => {
    const a = authority({ initialGeneration: MAX_AUTH_GENERATION - 1 });
    establish(a);
    assert.equal(a.currentRevision().generation, MAX_AUTH_GENERATION);
    const signal = signalOf(a);

    assert.throws(
      () => a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B })),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );

    assert.equal(a.diagnostics().availability, "UNAVAILABLE");
    assert.equal(a.diagnostics().reason, "EXHAUSTED");
    assert.equal(a.currentRevision().generation, MAX_AUTH_GENERATION, "never wraps, never resets");
    assert.equal(signal.aborted, true, "the prior READY controller is aborted after publication");
    assert.throws(() => a.acquire(), AuthContextError);
  });

  test("T15: an exhausted authority cannot be reopened by any later transition", () => {
    const a = authority({ initialGeneration: MAX_AUTH_GENERATION });
    assert.throws(() => a.invalidate("LOGOUT"), AuthContextError);
    assert.equal(a.diagnostics().reason, "EXHAUSTED");
    assert.throws(
      () => a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", candidate()),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
    assert.equal(a.currentRevision().generation, MAX_AUTH_GENERATION);
    assert.equal(a.diagnostics().availability, "UNAVAILABLE");
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
