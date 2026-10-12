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
import { withRedactionScope, redactSecrets, REDACTED_MARKER } from "../src/redact.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOperationRegistry,
  resolveCall,
  PRODUCTION_OPERATIONS,
} from "../src/transport/operation-registry.js";
import { createTransportDispatcher } from "../src/transport/dispatcher.js";
import { TransportError } from "../src/transport/transport-error.js";
import {
  nonEmptyString,
  type OperationDescriptor,
  type OperationId,
  type ResolvedCall,
  type TransportResult,
} from "../src/transport/types.js";

// ── Synthetic descriptors ───────────────────────────────────────────────────
//
// Declared here rather than imported from another test file: importing a suite
// would run it twice. PRODUCTION_OPERATIONS stays empty — BT3 migrates no
// endpoint and owns no path literal.

const PUBLIC_DESCRIPTOR: OperationDescriptor = {
  id: "BT3_SYNTHETIC_PUBLIC" as OperationId,
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

/** BT5-FIX1: needs a bearer, resolves no identity. PUBLIC + BEARER. */
const PUBLIC_BEARER_DESCRIPTOR: OperationDescriptor = {
  id: "BT3_SYNTHETIC_PUBLIC_BEARER" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/catalog",
  callerParams: {},
  authDerivedParams: {},
  fixedQuery: {},
  queryParams: {},
  scope: "PUBLIC",
  auth: "BEARER",
  mutation: false,
};

const ACCOUNT_DESCRIPTOR: OperationDescriptor = {
  id: "BT3_SYNTHETIC_ACCOUNT" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/{accountId}/items",
  callerParams: {},
  authDerivedParams: { accountId: { source: "accountId" } },
  scope: "ACCOUNT",
  auth: "BEARER",
  mutation: false,
};

const PROFILE_DESCRIPTOR: OperationDescriptor = {
  id: "BT3_SYNTHETIC_PROFILE" as OperationId,
  method: "GET",
  pathTemplate: "/synthetic/v1/{accountId}/{profileId}/items",
  callerParams: {},
  authDerivedParams: { accountId: { source: "accountId" }, profileId: { source: "profileId" } },
  scope: "ACCOUNT",
  auth: "BEARER",
  mutation: false,
};

const REGISTRY = createOperationRegistry([PUBLIC_DESCRIPTOR, ACCOUNT_DESCRIPTOR, PROFILE_DESCRIPTOR]);

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

// ── Deterministic async barriers ────────────────────────────────────────────
//
// Every race below is expressed as an explicit ordering, never as a timeout:
// the test decides exactly when a producer completes and when a backend
// settles.

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Guarded execution entry point used by the tests.
 *
 * The wrapper is hand-built here rather than obtained from `bind`, precisely so
 * that a forged, stale or cross-authority handle can be smuggled in. Acceptance
 * must come from issuance membership plus current-record identity — never from
 * trusting the provenance of the wrapper that carries the handle.
 */
function runGuarded<T>(
  a: Authority,
  context: unknown,
  execute: (view: { accessToken: string; tokenType: string; signal: AbortSignal }) => Promise<T>
): Promise<T> {
  const smuggled = Object.freeze({
    kind: "AUTHENTICATED",
    call: resolveCall(REGISTRY, "BT3_SYNTHETIC_ACCOUNT", {}),
    context,
    authDerivedParams: Object.freeze({}),
  });
  return a.runCurrent(smuggled as never, execute as never) as Promise<T>;
}

function isStale(e: unknown): boolean {
  return e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_STALE";
}

describe("BT3 authority — compare-and-swap commits", () => {
  test("T11: a late producer candidate cannot overwrite a logout", async () => {
    const a = authority();
    establish(a);
    const captured = a.currentRevision();

    // The producer does its asynchronous validation/refresh OUTSIDE the
    // authority, and a logout lands while it is away.
    await Promise.resolve();
    a.invalidate("LOGOUT");

    assert.throws(
      () => a.commitAuthenticatedMaterial(captured, "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B })),
      isStale
    );
    assert.equal(a.diagnostics().availability, "UNAVAILABLE");
    assert.equal(a.currentRevision().generation, 2, "the rejected commit is not a transition");
  });

  test("a mismatched expected revision neither mutates nor aborts", () => {
    const a = authority();
    establish(a);
    const captured = a.currentRevision();
    a.commitAuthenticatedMaterial(captured, "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));

    const signal = signalOf(a);
    let notified = false;
    signal.addEventListener("abort", () => {
      notified = true;
    });

    assert.throws(() => a.commitAuthenticatedMaterial(captured, "REFRESH", candidate()), isStale);
    assert.equal(a.currentRevision().generation, 2);
    assert.equal(notified, false, "a CAS mismatch must not notify the current generation");
    assert.equal(signal.aborted, false);
  });

  test("a commit under a foreign epoch is stale even at an equal generation", () => {
    const a = authority();
    establish(a);
    const foreign = { epoch: EPOCH_B, generation: a.currentRevision().generation };
    assert.throws(() => a.commitAuthenticatedMaterial(foreign, "REFRESH", candidate()), isStale);
    assert.equal(a.currentRevision().generation, 1);
  });

  test("a commit at the exact current revision is accepted", () => {
    const a = authority();
    establish(a);
    const context = a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({
      accessToken: TOKEN_SENTINEL_B,
    }));
    assert.equal(a.acquire(), context);
    assert.equal(a.currentRevision().generation, 2);
  });

  test("T15: an exhausted authority refuses even a same-maximum expected revision", () => {
    const a = authority({ initialGeneration: MAX_AUTH_GENERATION - 1 });
    establish(a);
    const atMaximum = a.currentRevision();

    assert.throws(
      () => a.commitAuthenticatedMaterial(atMaximum, "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B })),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
    assert.equal(a.diagnostics().reason, "EXHAUSTED");

    // The published revision still numerically equals `atMaximum`. Terminal
    // means terminal: it cannot be committed back into READY.
    assert.equal(a.currentRevision().generation, atMaximum.generation);
    assert.throws(
      () => a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", candidate()),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
  });
});

describe("BT3 authority — guarded execution", () => {
  test("the callback receives the current material and the generation signal", async () => {
    const a = authority();
    const context = establish(a);
    const seen: Array<{ accessToken: string; tokenType: string; aborted: boolean }> = [];

    const result = await runGuarded(a, context, async (view) => {
      seen.push({ accessToken: view.accessToken, tokenType: view.tokenType, aborted: view.signal.aborted });
      return "BACKEND-RESULT";
    });

    assert.equal(result, "BACKEND-RESULT");
    assert.deepEqual(seen, [{ accessToken: TOKEN_SENTINEL, tokenType: "Bearer", aborted: false }]);
  });

  test("the execution view is frozen and carries no refresh token, cookie or identity", async () => {
    const a = authority();
    const context = establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });
    await runGuarded(a, context, async (view) => {
      assert.equal(Object.isFrozen(view), true);
      assert.deepEqual(Object.keys(view).sort(), ["accessToken", "signal", "tokenType"]);
      const rendered = JSON.stringify({ accessToken: "", tokenType: view.tokenType });
      assert.equal(rendered.includes(SENSITIVE_ACCOUNT_SENTINEL), false);
      assert.equal(rendered.includes(SENSITIVE_PROFILE_SENTINEL), false);
      return "ok";
    });
  });

  test("an unavailable authority never invokes the backend", async () => {
    const a = authority();
    const context = establish(a);
    a.invalidate("LOGOUT");

    let invoked = 0;
    await assert.rejects(
      runGuarded(a, context, async () => {
        invoked += 1;
        return "never";
      }),
      isStale
    );
    assert.equal(invoked, 0);
  });

  test("T3: a handle from a replaced generation is rejected before any side effect", async () => {
    const a = authority();
    const boundAtG1 = establish(a);
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));

    let invoked = 0;
    let observedToken: string | undefined;
    await assert.rejects(
      runGuarded(a, boundAtG1, async (view) => {
        invoked += 1;
        observedToken = view.accessToken;
        return "never";
      }),
      isStale
    );
    assert.equal(invoked, 0, "the backend must not run at all");
    assert.equal(observedToken, undefined, "generation 2 material is never substituted into generation 1");
  });

  test("T8: a retained stale handle retrieves no material, and current work is unaffected", async () => {
    const a = authority();
    const retained = establish(a);
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));
    const current = a.acquire();

    await assert.rejects(runGuarded(a, retained, async () => "never"), isStale);

    const observed = await runGuarded(a, current, async (view) => view.accessToken);
    assert.equal(observed, TOKEN_SENTINEL_B);
  });

  test("T13: a forged lookalike handle is rejected as stale", async () => {
    const a = authority();
    establish(a);
    const forged = Object.freeze(Object.create(null));
    let invoked = 0;
    await assert.rejects(
      runGuarded(a, forged, async () => {
        invoked += 1;
        return "never";
      }),
      isStale
    );
    assert.equal(invoked, 0);
  });

  test("T13: a handle issued by another authority is rejected as stale", async () => {
    const authorityA = authority();
    const authorityB = authority({ epoch: EPOCH_B });
    establish(authorityA);
    const fromB = establish(authorityB);

    await assert.rejects(runGuarded(authorityA, fromB, async () => "never"), isStale);
    // …and B is untouched by A's rejection.
    assert.equal(authorityB.acquire(), fromB);
  });

  test("expired material refuses execution as unavailable, not as staleness", async () => {
    let clock = T0;
    const a = createAuthContextAuthority({ epochFactory: () => EPOCH_A, now: () => clock });
    const context = a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", candidate());
    clock = T0 + ONE_HOUR + 1;

    let invoked = 0;
    await assert.rejects(
      runGuarded(a, context, async () => {
        invoked += 1;
        return "never";
      }),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
    assert.equal(invoked, 0);
  });
});

describe("BT3 authority — stale results across an await", () => {
  test("T12: invalidation during execution aborts the signal and discards the result", async () => {
    const a = authority();
    const context = establish(a);
    const gate = deferred<string>();
    let sawAbort = false;

    const pending = runGuarded(a, context, async (view) => {
      view.signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      return gate.promise;
    });

    a.invalidate("LOGOUT");
    gate.resolve("REMOTE-SIDE-EFFECT-ALREADY-SENT");

    await assert.rejects(pending, isStale);
    assert.equal(sawAbort, true, "the in-flight consumer is notified");
  });

  test("T12: a replacement during execution also discards the older result", async () => {
    const a = authority();
    const context = establish(a);
    const gate = deferred<string>();

    const pending = runGuarded(a, context, async () => gate.promise);
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));
    gate.resolve("RESULT-FROM-GENERATION-1");

    await assert.rejects(pending, isStale);
    // No replay, no substitution: the result is dropped, not reissued under G2.
    assert.equal(a.currentRevision().generation, 2);
  });

  test("every pending operation of one generation is aborted and rejected", async () => {
    const a = authority();
    const context = establish(a);
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const aborts: boolean[] = [false, false, false];

    const pending = gates.map((gate, index) =>
      runGuarded(a, context, async (view) => {
        view.signal.addEventListener("abort", () => {
          aborts[index] = true;
        });
        return gate.promise;
      })
    );

    a.invalidate("LOGOUT");
    for (const gate of gates) gate.resolve("late");

    const settled = await Promise.allSettled(pending);
    assert.equal(settled.every((s) => s.status === "rejected" && isStale(s.reason)), true);
    assert.deepEqual(aborts, [true, true, true]);
  });

  test("a backend rejection propagates unchanged, without an authority verdict", async () => {
    const a = authority();
    const context = establish(a);
    const backendFailure = new Error("BACKEND-SPECIFIC-FAILURE");
    await assert.rejects(
      runGuarded(a, context, async () => {
        throw backendFailure;
      }),
      (e: unknown) => e === backendFailure
    );
    assert.equal(a.currentRevision().generation, 1, "a backend failure is not an auth transition");
  });

  test("a still-current operation returns its result after settling", async () => {
    const a = authority();
    const context = establish(a);
    const gate = deferred<string>();
    const pending = runGuarded(a, context, async () => gate.promise);
    gate.resolve("ACCEPTED");
    assert.equal(await pending, "ACCEPTED");
  });
});

describe("BT3 authority — reentrancy from an abort listener (FIX1 §9)", () => {
  test("an invalidation listener observes the already-published UNAVAILABLE state", () => {
    const a = authority();
    const staleHandle = establish(a);
    const signal = signalOf(a);

    let observed: Record<string, unknown> | undefined;
    signal.addEventListener("abort", () => {
      let acquireRejected = false;
      try {
        a.acquire();
      } catch {
        acquireRejected = true;
      }
      observed = {
        availability: a.diagnostics().availability,
        reason: a.diagnostics().reason,
        generation: a.currentRevision().generation,
        acquireRejected,
      };
    });

    a.invalidate("LOGOUT");

    assert.deepEqual(observed, {
      availability: "UNAVAILABLE",
      reason: "INVALIDATED",
      generation: 2,
      acquireRejected: true,
    });
    assert.ok(staleHandle, "the old handle survives as an object but never as a capability");
  });

  test("a replacement listener observes the already-published G+1 READY state", () => {
    const a = authority();
    const oldHandle = establish(a);
    const signal = signalOf(a);

    let observed: Record<string, unknown> | undefined;
    signal.addEventListener("abort", () => {
      observed = {
        availability: a.diagnostics().availability,
        generation: a.currentRevision().generation,
        currentIsOldHandle: a.acquire() === oldHandle,
        tokenType: a.inspectForTest().tokenType,
      };
    });

    const newHandle = a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({
      accessToken: TOKEN_SENTINEL_B,
    }));

    assert.deepEqual(observed, {
      availability: "READY",
      generation: 2,
      currentIsOldHandle: false,
      tokenType: "Bearer",
    });
    assert.notEqual(newHandle, oldHandle);
  });

  test("an overflow listener observes EXHAUSTED published before the notification", () => {
    const a = authority({ initialGeneration: MAX_AUTH_GENERATION - 1 });
    establish(a);
    const signal = signalOf(a);

    let observed: Record<string, unknown> | undefined;
    signal.addEventListener("abort", () => {
      observed = {
        availability: a.diagnostics().availability,
        reason: a.diagnostics().reason,
        generation: a.currentRevision().generation,
      };
    });

    assert.throws(
      () => a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B })),
      AuthContextError
    );

    assert.deepEqual(observed, {
      availability: "UNAVAILABLE",
      reason: "EXHAUSTED",
      generation: MAX_AUTH_GENERATION,
    });
  });
});

describe("BT3 authority — access material redaction (design §19)", () => {
  test("the access token is registered with the operation scope before the callback runs", async () => {
    const a = authority();
    const context = establish(a);

    await withRedactionScope(async () => {
      await runGuarded(a, context, async (view) => {
        // Registration must already have happened: a backend that renders the
        // token into a failure string is covered from its first instruction.
        const rendered = redactSecrets(`request failed for token ${view.accessToken}`);
        assert.equal(rendered.includes(TOKEN_SENTINEL), false);
        assert.equal(rendered.includes(REDACTED_MARKER), true);
        return "ok";
      });
    });
  });

  test("registration also covers the failing path", async () => {
    const a = authority();
    const context = establish(a);

    await withRedactionScope(async () => {
      await assert.rejects(
        runGuarded(a, context, async () => {
          throw new Error("failure");
        })
      );
      assert.equal(redactSecrets(`leaked ${TOKEN_SENTINEL}`).includes(TOKEN_SENTINEL), false);
    });
  });

  test("outside any operation scope nothing is retained anywhere", async () => {
    const a = authority();
    const context = establish(a);
    await runGuarded(a, context, async () => "ok");
    // No active scope: registerSensitiveValue is a documented no-op, so the
    // literal is not held in some parallel global registry.
    assert.equal(redactSecrets(`plain ${TOKEN_SENTINEL}`), `plain ${TOKEN_SENTINEL}`);
  });
});

// ── Binding helpers ─────────────────────────────────────────────────────────

function resolved(operation: string, params: Record<string, unknown> = {}): ResolvedCall {
  return resolveCall(REGISTRY, operation, params);
}

function bindAccount(a: Authority, operation = "BT3_SYNTHETIC_ACCOUNT") {
  return a.bind(resolved(operation)) as {
    kind: string;
    call: ResolvedCall;
    context: unknown;
    authDerivedParams: Record<string, string>;
  };
}

describe("BT3 binding — public and authenticated execution wrappers", () => {
  test("a public descriptor binds to an explicit PUBLIC wrapper with no context", () => {
    const a = authority();
    establish(a);
    const call = resolved("BT3_SYNTHETIC_PUBLIC", { query: "frieren" });
    const wrapper = a.bind(call);

    assert.equal(wrapper.kind, "PUBLIC");
    assert.equal(wrapper.call, call, "the resolved call is preserved by identity");
    assert.equal("context" in wrapper, false);
    assert.equal("authDerivedParams" in wrapper, false);
    assert.equal(Object.isFrozen(wrapper), true);
  });

  test("a public descriptor binds even when the authority is unavailable", () => {
    const a = authority();
    const wrapper = a.bind(resolved("BT3_SYNTHETIC_PUBLIC", { query: "frieren" }));
    assert.equal(wrapper.kind, "PUBLIC");
  });

  test("an account descriptor binds to the current handle and its declared identity", () => {
    const a = authority();
    const context = establish(a);
    const call = resolved("BT3_SYNTHETIC_ACCOUNT");
    const wrapper = a.bind(call) as never as { kind: string; call: ResolvedCall; context: unknown; authDerivedParams: Record<string, string> };

    assert.equal(wrapper.kind, "AUTHENTICATED");
    assert.equal(wrapper.call, call, "ResolvedCall is wrapped, never rebuilt or extended");
    assert.equal(wrapper.context, context);
    assert.deepEqual({ ...wrapper.authDerivedParams }, { accountId: SENSITIVE_ACCOUNT_SENTINEL });
  });

  test("only DECLARED auth-derived sources are resolved", () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });

    // The record holds a profile id, but this descriptor never declared one.
    const accountOnly = bindAccount(a);
    assert.deepEqual(Object.keys(accountOnly.authDerivedParams), ["accountId"]);

    const both = bindAccount(a, "BT3_SYNTHETIC_PROFILE");
    assert.deepEqual({ ...both.authDerivedParams }, {
      accountId: SENSITIVE_ACCOUNT_SENTINEL,
      profileId: SENSITIVE_PROFILE_SENTINEL,
    });
  });

  test("a descriptor requiring an absent profile id fails closed", () => {
    const a = authority();
    establish(a); // no profile id in the record
    assert.throws(
      () => a.bind(resolved("BT3_SYNTHETIC_PROFILE")),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
    // The caller cannot supply what the authority lacks: binding simply fails.
    assert.throws(() => resolved("BT3_SYNTHETIC_PROFILE", { profileId: "caller-supplied" }), TransportError);
  });

  test("an account descriptor cannot bind while the authority is unavailable", () => {
    const a = authority();
    assert.throws(
      () => a.bind(resolved("BT3_SYNTHETIC_ACCOUNT")),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
  });

  test("an account descriptor cannot bind to expired material", () => {
    let clock = T0;
    const a = createAuthContextAuthority({ epochFactory: () => EPOCH_A, now: () => clock });
    a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", candidate());
    clock = T0 + ONE_HOUR + 1;
    assert.throws(
      () => a.bind(resolved("BT3_SYNTHETIC_ACCOUNT")),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
  });

  test("binding is not a transition and does not increment", () => {
    const a = authority();
    establish(a);
    bindAccount(a);
    bindAccount(a);
    assert.equal(a.currentRevision().generation, 1);
  });

  test("a mutation between resolution and binding yields the NEWLY current context", () => {
    const a = authority();
    establish(a);
    // Registry resolution captured no auth, so this call is not yet bound to G1.
    const call = resolved("BT3_SYNTHETIC_ACCOUNT");
    const g2 = a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({
      accessToken: TOKEN_SENTINEL_B,
    }));
    const wrapper = a.bind(call) as never as { context: unknown };
    assert.equal(wrapper.context, g2);
  });

  test("a bound call executes against its own generation and is accepted", async () => {
    const a = authority();
    establish(a);
    const wrapper = a.bind(resolved("BT3_SYNTHETIC_ACCOUNT"));
    const observed = await a.runCurrent(wrapper as never, async (view) => view.accessToken);
    assert.equal(observed, TOKEN_SENTINEL);
  });

  test("a bound call whose generation was replaced is rejected before the backend", async () => {
    const a = authority();
    establish(a);
    const wrapper = a.bind(resolved("BT3_SYNTHETIC_ACCOUNT"));
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));

    let invoked = 0;
    await assert.rejects(
      a.runCurrent(wrapper as never, async () => {
        invoked += 1;
        return "never";
      }),
      isStale
    );
    assert.equal(invoked, 0);
  });
});

describe("BT3 binding — sensitive identity is mechanically contained (FIX1 §11)", () => {
  test("context and auth-derived identity are non-enumerable, read-only own properties", () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });
    const wrapper = bindAccount(a, "BT3_SYNTHETIC_PROFILE");

    assert.deepEqual(Object.keys(wrapper).sort(), ["call", "kind"]);
    for (const property of ["context", "authDerivedParams"]) {
      const descriptor = Object.getOwnPropertyDescriptor(wrapper, property);
      assert.ok(descriptor, `${property} must be an own property`);
      assert.equal(descriptor.enumerable, false, `${property} must not be enumerable`);
      assert.equal(descriptor.writable, false, `${property} must be read-only`);
      assert.equal(descriptor.configurable, false, `${property} must not be reconfigurable`);
    }
    assert.equal(Object.isFrozen(wrapper), true);
    assert.equal(Object.isFrozen(wrapper.authDerivedParams), true);
  });

  test("generic serialization of the wrapper emits no identity and no handle", () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });
    const wrapper = bindAccount(a, "BT3_SYNTHETIC_PROFILE");

    const rendered = JSON.stringify(wrapper);
    assert.equal(rendered.includes(SENSITIVE_ACCOUNT_SENTINEL), false);
    assert.equal(rendered.includes(SENSITIVE_PROFILE_SENTINEL), false);
    assert.equal(rendered.includes(TOKEN_SENTINEL), false);
    assert.equal(rendered.includes(EPOCH_A), false);
    assert.equal(rendered.includes("context"), false);

    // The same holds for a generic debug dump of its own enumerable entries.
    assert.equal(JSON.stringify({ ...wrapper }).includes(SENSITIVE_ACCOUNT_SENTINEL), false);
  });

  test("auth-derived identity never enters callerParams", () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });
    const wrapper = bindAccount(a, "BT3_SYNTHETIC_PROFILE");

    assert.deepEqual(Object.keys(wrapper.call.callerParams), []);
    assert.equal("accountId" in wrapper.call.callerParams, false);
    assert.equal("profileId" in wrapper.call.callerParams, false);
    assert.equal(JSON.stringify(wrapper.call).includes(SENSITIVE_ACCOUNT_SENTINEL), false);
  });

  test("the auth-derived map cannot be widened or rewritten by its receiver", () => {
    const a = authority();
    establish(a);
    const wrapper = bindAccount(a);
    assert.throws(() => {
      (wrapper.authDerivedParams as Record<string, string>).accountId = "attacker";
    }, TypeError);
    assert.throws(() => {
      (wrapper.authDerivedParams as Record<string, string>).injected = "attacker";
    }, TypeError);
    assert.equal(wrapper.authDerivedParams.accountId, SENSITIVE_ACCOUNT_SENTINEL);
  });

  test("a bind failure carries no identity in its message or fields", () => {
    const a = authority();
    establish(a);
    try {
      a.bind(resolved("BT3_SYNTHETIC_PROFILE"));
      assert.fail("expected a fail-closed rejection");
    } catch (error) {
      const rendered = `${(error as Error).message} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
      assert.equal(rendered.includes(SENSITIVE_ACCOUNT_SENTINEL), false);
      assert.equal(rendered.includes(SENSITIVE_PROFILE_SENTINEL), false);
      assert.equal(rendered.includes(TOKEN_SENTINEL), false);
      assert.equal(rendered.includes(EPOCH_A), false);
    }
  });

  test("diagnostics and inspection never render the epoch or the token", () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });
    const diagnostics = JSON.stringify(a.diagnostics());
    assert.equal(diagnostics.includes(EPOCH_A), false);
    assert.equal(diagnostics.includes(SENSITIVE_ACCOUNT_SENTINEL), false);
    assert.equal(diagnostics.includes(SENSITIVE_PROFILE_SENTINEL), false);
    assert.equal(diagnostics.includes(TOKEN_SENTINEL), false);
  });

  test("D0-H1: bound identity is registered for redaction before any rendering", async () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });

    await withRedactionScope(async () => {
      const wrapper = bindAccount(a, "BT3_SYNTHETIC_PROFILE");
      // Whatever BT5 later renders these into is already covered: registration
      // happens at bind time, which is strictly before any rendering can occur.
      const url = `/synthetic/v1/${wrapper.authDerivedParams.accountId}/${wrapper.authDerivedParams.profileId}/items`;
      const rendered = redactSecrets(url);
      assert.equal(rendered.includes(SENSITIVE_ACCOUNT_SENTINEL), false);
      assert.equal(rendered.includes(SENSITIVE_PROFILE_SENTINEL), false);
      assert.equal(rendered.includes(REDACTED_MARKER), true);
    });
  });
});

describe("BT3 binding — T1/T2: caller injection is rejected before any backend", () => {
  const injections: Array<[string, Record<string, unknown>]> = [
    ["accountId", { accountId: "attacker-account" }],
    ["profileId", { profileId: "attacker-profile" }],
    ["Authorization", { Authorization: "Bearer attacker" }],
    ["authorization", { authorization: "Bearer attacker" }],
    ["bearer", { bearer: "attacker" }],
    ["token", { token: "attacker" }],
    ["access_token", { access_token: "attacker" }],
    ["cookie", { cookie: "session=attacker" }],
    ["authGeneration", { authGeneration: 99 }],
    ["epoch", { epoch: EPOCH_B }],
    ["context", { context: {} }],
  ];

  for (const [name, params] of injections) {
    test(`${name} never reaches a backend`, async () => {
      let backendCalls = 0;
      const backend = {
        async executeResolved(): Promise<TransportResult> {
          backendCalls += 1;
          return { status: 200, contentType: "application/json", json: {} };
        },
      };
      const transport = createTransportDispatcher(REGISTRY, backend);

      await assert.rejects(
        transport.execute("BT3_SYNTHETIC_PROFILE" as OperationId, params),
        TransportError
      );
      assert.equal(backendCalls, 0);
    });
  }

  test("the identity rejection is precise, not a generic unexpected argument", async () => {
    const transport = createTransportDispatcher(REGISTRY, {
      async executeResolved(): Promise<TransportResult> {
        throw new Error("unreachable");
      },
    });
    await assert.rejects(
      transport.execute("BT3_SYNTHETIC_ACCOUNT" as OperationId, { accountId: "attacker" }),
      (e: unknown) => e instanceof TransportError && e.kind === "CALLER_SUPPLIED_IDENTITY"
    );
  });
});

describe("BT3 ports — BT4 writes, BT5 reads, neither does both", () => {
  test("the writer port exposes only the three producer methods", () => {
    const writer = authority().asWriter();
    assert.deepEqual(
      Object.keys(writer).sort(),
      ["commitAuthenticatedMaterial", "currentRevision", "invalidate"]
    );
    for (const forbidden of ["bind", "runCurrent", "acquire", "inspectForTest", "diagnostics"]) {
      assert.equal((writer as Record<string, unknown>)[forbidden], undefined, forbidden);
    }
    assert.equal(Object.isFrozen(writer), true);
  });

  test("the reader port exposes only bind and guarded execution", () => {
    const reader = authority().asReader();
    assert.deepEqual(Object.keys(reader).sort(), ["bind", "runCurrent"]);
    for (const forbidden of [
      "commitAuthenticatedMaterial",
      "invalidate",
      "currentRevision",
      "acquire",
      "inspectForTest",
    ]) {
      assert.equal((reader as Record<string, unknown>)[forbidden], undefined, forbidden);
    }
    assert.equal(Object.isFrozen(reader), true);
  });

  test("the ports operate on the same single authority", () => {
    const a = authority();
    const writer = a.asWriter();
    const reader = a.asReader();

    writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", candidate() as never);
    const wrapper = reader.bind(resolved("BT3_SYNTHETIC_ACCOUNT"));
    assert.equal(wrapper.kind, "AUTHENTICATED");

    writer.invalidate("LOGOUT");
    assert.throws(() => reader.bind(resolved("BT3_SYNTHETIC_ACCOUNT")), AuthContextError);
  });
});

// ── Source and boundary scanning (Task 5) ───────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTH_CONTEXT_SOURCE_PATH = join(REPO_ROOT, "src/transport/auth-context.ts");
const AUTH_CONTEXT_SOURCE = readFileSync(AUTH_CONTEXT_SOURCE_PATH, "utf-8");

/** Source with comments stripped: prose about cookies is not a cookie API. */
const AUTH_CONTEXT_CODE = AUTH_CONTEXT_SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

/** Every local module reachable from an entry point, following real imports. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf-8");
    const specifiers = [
      ...source.matchAll(/from\s+"(\.[^"]+)"/g),
      ...source.matchAll(/import\s*\(\s*"(\.[^"]+)"\s*\)/g),
      ...source.matchAll(/import\s+"(\.[^"]+)"/g),
    ];
    for (const match of specifiers) {
      const target = resolve(dirname(file), match[1].replace(/\.js$/, ".ts"));
      if (existsSync(target)) queue.push(target);
    }
  }
  return seen;
}

describe("BT3 closure — T8: capability bookkeeping owns no secret", () => {
  test("issuance is exactly a WeakSet of contexts", () => {
    assert.match(AUTH_CONTEXT_CODE, /issuedContexts\s*=\s*new WeakSet<AuthContext>\(\)/);
  });

  test("no map of any kind is keyed by an AuthContext", () => {
    assert.equal(/WeakMap/.test(AUTH_CONTEXT_CODE), false, "a WeakMap<AuthContext, …> is forbidden by FIX1 §5");
    // The key type must be AuthContext *itself*: `Record<AuthContextErrorKind,
    // string>` is a table of fixed messages keyed by an error kind, not a
    // handle-to-secret association, so the boundary here is deliberate.
    assert.equal(/(?:Map|Record)<\s*AuthContext\s*[,>]/.test(AUTH_CONTEXT_CODE), false);
    // The only WeakSet in the module is the issuance registry itself.
    assert.equal((AUTH_CONTEXT_CODE.match(/new WeakSet/g) ?? []).length, 1);
  });

  test("the only authority-owned root of a record is the current state", () => {
    // A record is written to exactly one place: `this.state`. No second field,
    // history array, cache or index may hold an ActiveAuthRecord.
    const recordAssignments = AUTH_CONTEXT_CODE.match(/this\.state\s*=/g) ?? [];
    assert.equal(recordAssignments.length >= 1, true);
    assert.equal(/history|previousRecord|recordCache|byContext|records\s*[:=]/.test(AUTH_CONTEXT_CODE), false);
  });
});

describe("BT3 closure — the module has no capability it must not have", () => {
  const forbiddenSourceTokens: Array<[string, RegExp]> = [
    ["refresh token", /refreshToken|refresh_token/],
    ["cookie handling", /cookie/i],
    ["password", /password/i],
    ["browser session manager", /BrowserSessionManager/],
    ["CDP client", /cdp|CdpClient/i],
    ["Runtime.evaluate", /Runtime\.evaluate/],
    ["Fetch domain", /Fetch\./],
    ["Network domain", /Network\./],
    ["an http(s) URL literal", /https?:\/\//],
    ["fetch()", /\bfetch\s*\(/],
    ["node:http", /node:https?/],
    ["a websocket", /WebSocket|node:net|node:tls/],
    ["filesystem access", /node:fs|readFile|writeFile/],
    ["environment reading", /process\.env/],
    ["a timer", /setTimeout|setInterval/],
    ["dynamic require", /require\s*\(/],
  ];

  for (const [name, pattern] of forbiddenSourceTokens) {
    test(`the authority source contains no ${name}`, () => {
      assert.equal(pattern.test(AUTH_CONTEXT_CODE), false, `${name} must not appear in auth-context.ts`);
    });
  }

  test("its only runtime imports are node:crypto and the existing redaction scope", () => {
    const imports = [...AUTH_CONTEXT_SOURCE.matchAll(/^import\s+(?!type)[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1]
    );
    assert.deepEqual(imports.sort(), ["../redact.js", "node:crypto"]);
  });

  test("the exported runtime surface is exactly the closed set", () => {
    assert.deepEqual(Object.keys(authContextModule).sort(), [
      "AuthContextAuthority",
      "AuthContextError",
      "MAX_AUTH_GENERATION",
      "createAuthContextAuthority",
      "nextGeneration",
      "revisionsEqual",
    ]);
  });
});

// ── RETIRED AT BT4 ──────────────────────────────────────────────────────────
//
// Three assertions used to live here:
//
//   - no import path from the MCP entry point reaches the authority;
//   - no other production module imports the authority;
//   - the published bundle carries no trace of the authority.
//
// They encoded the BT3 CLOSURE CONDITION — "BT3 exists but is not yet
// integrated" — not an eternal architecture invariant. BT4 is the stage that
// integrates it, so satisfying them would now mean the production authority
// does not exist. They are replaced in place by the stronger architecture
// assertions below, which say what must be true once the authority IS wired.
// The other 158 BT3 behavioural and security tests are untouched.
//
// Recorded RED before replacement: with the BT4 composition root wired, those
// three failed and only those three (158/161 still green).

describe("BT4 architecture — the authority is wired, and only as intended", () => {
  const SRC = join(REPO_ROOT, "src");
  const COMPOSITION_ROOT = join(SRC, "index.ts");

  function sources(): Array<{ path: string; code: string }> {
    const files: Array<{ path: string; code: string }> = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          files.push({
            path: full,
            code: readFileSync(full, "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""),
          });
        }
      }
    };
    walk(SRC);
    return files;
  }

  test("1. exactly one production authority construction site exists", () => {
    const callers = sources()
      .filter((f) => f.path !== AUTH_CONTEXT_SOURCE_PATH)
      .filter((f) => /createAuthContextAuthority\s*\(/.test(f.code))
      .map((f) => f.path);
    assert.deepEqual(callers, [COMPOSITION_ROOT], "one authority per process, built in one place");
  });

  test("2. it is constructed in the composition root, not a utility module", () => {
    const code = readFileSync(COMPOSITION_ROOT, "utf-8");
    assert.match(code, /createAuthContextAuthority\s*\(\s*\)/);
    assert.match(code, /composition root/i, "the section must be identified as such");
  });

  test("3. only the writer port is handed out; the authority never travels", () => {
    const code = readFileSync(COMPOSITION_ROOT, "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.match(code, /asWriter\s*\(\s*\)/);
    for (const other of sources()) {
      if (other.path === COMPOSITION_ROOT || other.path === AUTH_CONTEXT_SOURCE_PATH) continue;
      assert.equal(/asWriter\s*\(/.test(other.code), false, `${other.path} derives a writer`);
    }
  });

  test("4. no MCP tool schema admits a writer, reader, authority, context, epoch or generation", () => {
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, "test/fixtures/baseline-tools.json"), "utf-8")
    ) as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
    const forbidden = ["writer", "reader", "authority", "context", "epoch", "generation", "authgeneration"];
    for (const tool of baseline) {
      for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
        assert.equal(forbidden.includes(property.toLowerCase()), false, `${tool.name}.${property}`);
      }
    }
  });

  // RETIRED AT BT5 (cutover). Assertions 5, 6 and 8 said the BT3 READER was
  // unused and the authority module was imported by the composition root only.
  // They encoded "no content operation exists yet", not an invariant: BT5 is
  // the stage where a content operation takes a bearer, and BT3 built bind()/
  // runCurrent() for exactly that. What must remain true once the reader IS
  // used is that it is used in ONE place, by the transport backend, and that
  // no module reaches the material any other way.
  //
  // Recorded RED before replacement: with the cutover wired, 5, 6, 7 and 8
  // failed, and only those four in this file.

  test("5/6/8. the BT3 reader is used by exactly one production module", () => {
    const users = sources()
      .filter((f) => f.path !== AUTH_CONTEXT_SOURCE_PATH)
      .filter((f) => /\brunCurrent\s*\(|\bbind\s*\(/.test(f.code))
      .map((f) => f.path);
    assert.deepEqual(users, [join(SRC, "transport", "browser-api-backend.ts")]);

    // The reader is DERIVED only where the authority lives, and handed on.
    const derivers = sources()
      .filter((f) => f.path !== AUTH_CONTEXT_SOURCE_PATH)
      .filter((f) => /asReader\s*\(/.test(f.code))
      .map((f) => f.path);
    assert.deepEqual(derivers, [COMPOSITION_ROOT]);

    // And the authority module is imported by those two modules only.
    const importers = sources()
      .filter((f) => f.path !== AUTH_CONTEXT_SOURCE_PATH)
      .filter((f) => /from\s+"[^"]*auth-context\.js"/.test(f.code))
      .map((f) => f.path)
      .sort();
    assert.deepEqual(importers, [COMPOSITION_ROOT, join(SRC, "transport", "browser-api-backend.ts")].sort());
  });

  test("5/6/8. no module reads auth material outside the reader", () => {
    for (const file of sources()) {
      if (file.path === AUTH_CONTEXT_SOURCE_PATH) continue;
      // inspectForTest is the only other door to a record, and it is test-only.
      assert.equal(/inspectForTest\s*\(/.test(file.code), false, `${file.path}`);
    }
  });

  test("7. the content path is CUT: exactly one migrated operation, one route", () => {
    // RETIRED AT BT5: this used to assert the registry was empty and the
    // dispatcher unreachable. That was the pre-cutover condition; BT5 is the
    // cutover. What replaces it is the shape of the cut itself.
    // RETIRED AT BT6: "exactly one" was the BT5 cutover shape. What this file
    // cares about is that the content path is CUT and routed, not how many
    // operations have been migrated since; test/bt6-catalog.test.ts owns the
    // exact table.
    assert.ok(
      PRODUCTION_OPERATIONS.some((d) => String(d.id) === "GET_CATEGORIES"),
      "the first migrated operation is still migrated"
    );
    assert.ok(PRODUCTION_OPERATIONS.length >= 1);
    const reachable = importClosure(COMPOSITION_ROOT);
    assert.equal(
      reachable.has(join(SRC, "transport", "dispatcher.ts")),
      true,
      "content now routes through the transport dispatcher"
    );
    assert.equal(
      reachable.has(join(SRC, "transport", "browser-api-backend.ts")),
      true,
      "and through the browser transport backend"
    );
  });

  test("9. no other module can manufacture a second production authority", () => {
    // The factory is not re-exported anywhere, so there is no second door.
    for (const file of sources()) {
      if (file.path === AUTH_CONTEXT_SOURCE_PATH || file.path === COMPOSITION_ROOT) continue;
      assert.equal(
        /export\s+\{[^}]*createAuthContextAuthority/.test(file.code),
        false,
        `${file.path} re-exports the authority factory`
      );
    }
  });

  test("10. the tool-call boundary never touches the authority", () => {
    const code = readFileSync(COMPOSITION_ROOT, "utf-8");
    const handlerStart = code.indexOf("setRequestHandler(CallToolRequestSchema");
    assert.ok(handlerStart > 0, "the CallTool handler must exist");
    const handlerBody = code.slice(handlerStart);
    for (const forbidden of [
      "authAuthority",
      "asWriter",
      "currentRevision",
      "inspectForTest",
      "commitAuthenticatedMaterial",
    ]) {
      assert.equal(
        handlerBody.includes(forbidden),
        false,
        `the tool boundary must not reference ${forbidden}`
      );
    }
  });
});

describe("BT3 closure — preserved scope proofs", () => {
  test("PRODUCTION_OPERATIONS holds the migrated reads and stays frozen", () => {
    // RETIRED AT BT5 ("remains empty"), narrowed again at BT6: the exact table
    // lives in test/bt6-catalog.test.ts. Here it is enough that the table is
    // non-empty, frozen, and still contains BT5's operation.
    assert.ok(PRODUCTION_OPERATIONS.some((d) => String(d.id) === "GET_CATEGORIES"));
    assert.equal(Object.isFrozen(PRODUCTION_OPERATIONS), true);
  });

  test("the public tool contract is exactly 22 names (21 unchanged + crunchyroll_play)", () => {
    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, "test/fixtures/baseline-tools.json"), "utf-8")
    ) as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
    assert.equal(baseline.length, 22);

    const forbiddenCallerKeys = [
      "authorization",
      "bearer",
      "cookie",
      "token",
      "accountid",
      "profileid",
      "epoch",
      "authgeneration",
      "context",
      "cdp",
      "browser",
    ];
    for (const tool of baseline) {
      for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
        assert.equal(
          forbiddenCallerKeys.includes(property.toLowerCase()),
          false,
          `${tool.name} must not admit ${property}`
        );
      }
    }
  });

  test("no dependency was added, and the engine floor is unchanged", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      engines: Record<string, string>;
    };
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@modelcontextprotocol/sdk", "ws"]);
    assert.deepEqual(Object.keys(manifest.devDependencies).sort(), [
      "@types/node",
      "@types/ws",
      "esbuild",
      "tsx",
      "typescript",
    ]);
    assert.equal(manifest.engines.node, ">=18.0.0");
  });
});

describe("BT3 closure — no failure path leaks material or identity", () => {
  test("every reachable rejection is one of three fixed, sentinel-free messages", async () => {
    const collected: string[] = [];
    const record = (error: unknown): void => {
      const e = error as Error;
      collected.push(`${e.name} ${e.message} ${JSON.stringify(e)} ${e.stack ?? ""}`);
    };

    // 1. acquisition with nothing installed
    const empty = authority();
    try {
      empty.acquire();
    } catch (e) {
      record(e);
    }

    // 2. invalid candidate
    try {
      establish(empty, { accessToken: "" });
    } catch (e) {
      record(e);
    }

    // 3. identity change during refresh
    const switched = authority();
    establish(switched, { profileId: SENSITIVE_PROFILE_SENTINEL });
    try {
      switched.commitAuthenticatedMaterial(switched.currentRevision(), "REFRESH", candidate({
        accountId: SENSITIVE_ACCOUNT_SENTINEL_B,
        profileId: SENSITIVE_PROFILE_SENTINEL_B,
      }));
    } catch (e) {
      record(e);
    }

    // 4. CAS mismatch
    const raced = authority();
    establish(raced);
    const captured = raced.currentRevision();
    raced.invalidate("LOGOUT");
    try {
      raced.commitAuthenticatedMaterial(captured, "REFRESH", candidate());
    } catch (e) {
      record(e);
    }

    // 5. stale guarded execution
    const staleAuthority = authority();
    const staleHandle = establish(staleAuthority);
    staleAuthority.commitAuthenticatedMaterial(staleAuthority.currentRevision(), "REFRESH", candidate({
      accessToken: TOKEN_SENTINEL_B,
    }));
    try {
      await runGuarded(staleAuthority, staleHandle, async () => "never");
    } catch (e) {
      record(e);
    }

    // 6. missing required profile identity at bind
    const noProfile = authority();
    establish(noProfile);
    try {
      noProfile.bind(resolved("BT3_SYNTHETIC_PROFILE"));
    } catch (e) {
      record(e);
    }

    assert.equal(collected.length, 6, "every failure path must have been exercised");
    const everything = collected.join("\n");
    for (const sentinel of [
      SENSITIVE_ACCOUNT_SENTINEL,
      SENSITIVE_ACCOUNT_SENTINEL_B,
      SENSITIVE_PROFILE_SENTINEL,
      SENSITIVE_PROFILE_SENTINEL_B,
      TOKEN_SENTINEL,
      TOKEN_SENTINEL_B,
      EPOCH_A,
    ]) {
      assert.equal(everything.includes(sentinel), false, `a failure path leaked ${sentinel}`);
    }
    for (const message of collected) {
      assert.match(
        message,
        /Authentication context is unavailable|Authentication context is stale|Authentication identity changed unexpectedly/
      );
    }
  });

  test("a retained stale handle yields nothing through any exposed surface", async () => {
    const a = authority();
    const retained = establish(a);
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({ accessToken: TOKEN_SENTINEL_B }));

    // Everything an internal consumer could try with a handle it kept.
    assert.equal(JSON.stringify(retained), "{}");
    assert.deepEqual(Object.getOwnPropertyNames(retained), []);
    assert.equal(String(Object.keys(retained)), "");
    await assert.rejects(runGuarded(a, retained, async () => "never"), isStale);
    // …and the authority's own diagnostics still describe only the current one.
    assert.equal(a.diagnostics().generation, 2);
    assert.equal(a.inspectForTest().tokenType, "Bearer");
  });
});

// ── External review FIX1 — BT3-R1 ───────────────────────────────────────────
//
// AuthMaterialCandidate is an ordinary JavaScript object at runtime. Its
// properties may be getters or Proxy traps, so every read is a call into
// producer-controlled code that can synchronously reenter the authority. The
// authority must therefore read each authorized field AT MOST ONCE, validate
// only that snapshot, and re-check the revision afterwards — the snapshot reads
// are the last untrusted boundary before publication.

const AUTHORIZED_CANDIDATE_FIELDS = [
  "accessToken",
  "tokenType",
  "expiresAt",
  "accountId",
  "profileId",
] as const;

type CandidateField = (typeof AUTHORIZED_CANDIDATE_FIELDS)[number];
type ReadCounts = Record<CandidateField, number>;

const NO_READS: ReadCounts = {
  accessToken: 0,
  tokenType: 0,
  expiresAt: 0,
  accountId: 0,
  profileId: 0,
};

const ONE_READ_EACH: ReadCounts = {
  accessToken: 1,
  tokenType: 1,
  expiresAt: 1,
  accountId: 1,
  profileId: 1,
};

/**
 * A candidate whose authorized fields are getters with deterministic counters,
 * and optional hooks that reenter the authority or change their answer between
 * reads. No timing, no sleeps — the barrier is the property read itself.
 */
function probeCandidate(
  values: Partial<Record<CandidateField, unknown>> = {},
  hooks: Partial<Record<CandidateField, (readCount: number) => unknown>> = {}
): { candidate: never; reads: ReadCounts } {
  const answers: Record<CandidateField, unknown> = {
    accessToken: TOKEN_SENTINEL,
    tokenType: "Bearer",
    expiresAt: T0 + ONE_HOUR,
    accountId: SENSITIVE_ACCOUNT_SENTINEL,
    profileId: undefined,
    ...values,
  };
  const reads: ReadCounts = { ...NO_READS };
  const candidate: Record<string, unknown> = {};
  for (const field of AUTHORIZED_CANDIDATE_FIELDS) {
    Object.defineProperty(candidate, field, {
      enumerable: true,
      configurable: true,
      get(): unknown {
        reads[field] += 1;
        const hook = hooks[field];
        return hook ? hook(reads[field]) : answers[field];
      },
    });
  }
  return { candidate: candidate as never, reads };
}

describe("BT3-R1 — a reentrant candidate cannot publish over a newer transition", () => {
  test("R1-A: a getter that invalidates mid-commit cannot republish READY", () => {
    const a = authority();
    establish(a);
    const expected = a.currentRevision();

    const probe = probeCandidate(
      { accessToken: TOKEN_SENTINEL_B },
      {
        // The producer object logs the user out while the authority is reading it.
        accessToken: () => {
          a.invalidate("LOGOUT");
          return TOKEN_SENTINEL_B;
        },
      }
    );

    assert.throws(() => a.commitAuthenticatedMaterial(expected, "ESTABLISH", probe.candidate), isStale);

    assert.equal(a.diagnostics().availability, "UNAVAILABLE", "the logout must stand");
    assert.equal(a.diagnostics().reason, "INVALIDATED");
    assert.equal(a.diagnostics().cause, "LOGOUT");
    assert.equal(a.currentRevision().generation, 2, "the stale commit adds no generation");
    assert.throws(() => a.acquire(), AuthContextError);
  });

  test("R1-A: the same holds for a refresh-mode commit", () => {
    const a = authority();
    establish(a);
    const expected = a.currentRevision();

    const probe = probeCandidate(
      {},
      {
        accountId: () => {
          a.invalidate("INVALID_GRANT");
          return SENSITIVE_ACCOUNT_SENTINEL;
        },
      }
    );

    assert.throws(() => a.commitAuthenticatedMaterial(expected, "REFRESH", probe.candidate), isStale);
    assert.equal(a.diagnostics().availability, "UNAVAILABLE");
    assert.equal(a.currentRevision().generation, 2);
  });

  test("R1-D: a getter that commits a newer generation cannot be overwritten", async () => {
    const a = authority();
    establish(a);
    const expected = a.currentRevision();

    const probe = probeCandidate(
      { accessToken: TOKEN_SENTINEL_B },
      {
        accessToken: () => {
          // A concurrent, legitimate refresh lands first.
          a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", candidate({
            accessToken: "SYNTHETIC-ACCESS-TOKEN-SENTINEL-NEWER",
          }));
          return TOKEN_SENTINEL_B;
        },
      }
    );

    assert.throws(() => a.commitAuthenticatedMaterial(expected, "REFRESH", probe.candidate), isStale);

    assert.equal(a.currentRevision().generation, 2, "the newer commit survives, alone");
    const observed = await runGuarded(a, a.acquire(), async (view) => view.accessToken);
    assert.equal(observed, "SYNTHETIC-ACCESS-TOKEN-SENTINEL-NEWER");
  });

  test("R1-B: every authorized field is read exactly once per ESTABLISH commit", () => {
    const a = authority();
    const probe = probeCandidate({ profileId: SENSITIVE_PROFILE_SENTINEL });
    a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", probe.candidate);
    assert.deepEqual(probe.reads, ONE_READ_EACH);
  });

  test("R1-B: every authorized field is read exactly once per REFRESH commit", () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });
    const probe = probeCandidate({
      accessToken: TOKEN_SENTINEL_B,
      profileId: SENSITIVE_PROFILE_SENTINEL,
    });
    a.commitAuthenticatedMaterial(a.currentRevision(), "REFRESH", probe.candidate);
    assert.deepEqual(probe.reads, ONE_READ_EACH);
  });

  test("R1-B: a rejected candidate is also read at most once per field", () => {
    const a = authority();
    const probe = probeCandidate({ accessToken: "" });
    assert.throws(
      () => a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", probe.candidate),
      (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
    );
    for (const field of AUTHORIZED_CANDIDATE_FIELDS) {
      assert.ok(probe.reads[field] <= 1, `${field} was read ${probe.reads[field]} times`);
    }
  });

  test("R1-C: a changing getter cannot smuggle an unvalidated second value", async () => {
    const a = authority();
    const probe = probeCandidate(
      {},
      {
        accessToken: (readCount) => (readCount === 1 ? TOKEN_SENTINEL : "POISONED-SECOND-READ"),
        accountId: (readCount) =>
          readCount === 1 ? SENSITIVE_ACCOUNT_SENTINEL : SENSITIVE_ACCOUNT_SENTINEL_B,
        tokenType: (readCount) => (readCount === 1 ? "Bearer" : "POISONED"),
      }
    );

    const context = a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", probe.candidate);

    // The installed record must correspond exactly to the single validated read.
    assert.equal(a.inspectForTest().accountId, SENSITIVE_ACCOUNT_SENTINEL);
    assert.equal(a.inspectForTest().tokenType, "Bearer");
    const observed = await runGuarded(a, context, async (view) => view.accessToken);
    assert.equal(observed, TOKEN_SENTINEL);
  });

  test("R1-proxy: the single-read property survives a Proxy get trap", () => {
    const seen: string[] = [];
    const target = {
      accessToken: TOKEN_SENTINEL,
      tokenType: "Bearer",
      expiresAt: T0 + ONE_HOUR,
      accountId: SENSITIVE_ACCOUNT_SENTINEL,
      profileId: SENSITIVE_PROFILE_SENTINEL,
      // Fields the authority must never touch, let alone copy.
      refreshToken: "SYNTHETIC-REFRESH-TOKEN-MUST-NOT-BE-READ",
      cookie: "session=MUST-NOT-BE-READ",
      password: "MUST-NOT-BE-READ",
    };
    const proxied = new Proxy(target, {
      get(object, property, receiver): unknown {
        if (typeof property === "string") seen.push(property);
        return Reflect.get(object, property, receiver);
      },
    });

    const a = authority();
    a.commitAuthenticatedMaterial(a.currentRevision(), "ESTABLISH", proxied as never);

    assert.equal(seen.length, 5, `expected five reads, saw: ${seen.join(", ")}`);
    assert.deepEqual([...seen].sort(), [...AUTHORIZED_CANDIDATE_FIELDS].sort());
    for (const forbidden of ["refreshToken", "cookie", "password"]) {
      assert.equal(seen.includes(forbidden), false, `${forbidden} must never be read`);
    }
    // And nothing unauthorized reached the private record.
    assert.equal(JSON.stringify(a.inspectForTest()).includes("MUST-NOT-BE-READ"), false);
  });
});

describe("BT3-R1 — the closed enums are enforced at runtime, not only in types", () => {
  const invalidModes: Array<[string, unknown]> = [
    ["an unknown mode", "UNKNOWN_MODE"],
    ["a lowercase mode", "establish"],
    ["an empty mode", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an object", { mode: "ESTABLISH" }],
  ];

  for (const [name, mode] of invalidModes) {
    test(`R1-E: ${name} is rejected without touching the candidate`, () => {
      const a = authority();
      establish(a);
      const signal = signalOf(a);
      const probe = probeCandidate({ accessToken: TOKEN_SENTINEL_B });

      assert.throws(
        () => a.commitAuthenticatedMaterial(a.currentRevision(), mode as never, probe.candidate),
        (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
      );

      assert.deepEqual(probe.reads, NO_READS, "mode must be validated before any candidate read");
      assert.equal(a.currentRevision().generation, 1, "no generation change");
      assert.equal(a.diagnostics().availability, "READY", "state unchanged");
      assert.equal(signal.aborted, false, "no abort");
    });
  }

  const invalidCauses: Array<[string, unknown]> = [
    ["an unknown cause", "UNKNOWN_CAUSE"],
    ["a lowercase cause", "logout"],
    ["an empty cause", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
  ];

  for (const [name, cause] of invalidCauses) {
    test(`R1-F: ${name} is rejected and invalidates nothing`, () => {
      const a = authority();
      establish(a);
      const signal = signalOf(a);

      assert.throws(
        () => a.invalidate(cause as never),
        (e: unknown) => e instanceof AuthContextError && e.kind === "AUTH_CONTEXT_UNAVAILABLE"
      );

      assert.equal(a.currentRevision().generation, 1, "no generation change");
      assert.equal(a.diagnostics().availability, "READY", "availability unchanged");
      assert.equal(a.diagnostics().cause, undefined, "lastCause must not be widened");
      assert.equal(signal.aborted, false, "the current controller must not be aborted");
    });
  }

  test("R1-E/F: the closed enums still accept every legitimate value", () => {
    for (const mode of ["ESTABLISH", "REFRESH"] as const) {
      const a = authority();
      establish(a);
      a.commitAuthenticatedMaterial(a.currentRevision(), mode, candidate({ accessToken: TOKEN_SENTINEL_B }) );
      assert.equal(a.currentRevision().generation, 2);
    }
    for (const cause of ["LOGOUT", "INVALID_GRANT", "AUTH_MATERIAL_LOST", "PROCESS_SHUTDOWN"] as const) {
      const a = authority();
      establish(a);
      assert.equal(a.invalidate(cause).generation, 2);
      assert.equal(a.diagnostics().cause, cause);
    }
  });

  test("R1-E/F: a rejection carries no identity, token or epoch", () => {
    const a = authority();
    establish(a, { profileId: SENSITIVE_PROFILE_SENTINEL });
    const collected: string[] = [];
    for (const attempt of [
      () => a.commitAuthenticatedMaterial(a.currentRevision(), "NOPE" as never, candidate() as never),
      () => a.invalidate("NOPE" as never),
    ]) {
      try {
        attempt();
        assert.fail("expected a fail-closed rejection");
      } catch (error) {
        const e = error as Error;
        collected.push(`${e.name} ${e.message} ${JSON.stringify(e)} ${e.stack ?? ""}`);
      }
    }
    const everything = collected.join("\n");
    for (const sentinel of [
      SENSITIVE_ACCOUNT_SENTINEL,
      SENSITIVE_PROFILE_SENTINEL,
      TOKEN_SENTINEL,
      EPOCH_A,
    ]) {
      assert.equal(everything.includes(sentinel), false, `leaked ${sentinel}`);
    }
    assert.equal(collected.length, 2);
    for (const message of collected) {
      assert.match(message, /Authentication context is unavailable/);
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

// ── BT5-FIX1: bearer requirement is orthogonal to endpoint scope ────────────

describe("BT5-FIX1 — PUBLIC + BEARER binds to an authorized call", () => {
  /** A READY authority holding synthetic material. */
  function readyAuthority(): Authority {
    const a = authority();
    establish(a);
    return a;
  }

  const publicBearerCall: ResolvedCall = Object.freeze({
    descriptor: PUBLIC_BEARER_DESCRIPTOR,
    callerParams: Object.freeze({}),
  });

  test("a PUBLIC descriptor that needs a bearer produces an AuthorizedCall", () => {
    const authority = readyAuthority();
    const bound = authority.asReader().bind(publicBearerCall);

    assert.equal(bound.kind, "AUTHENTICATED", "PUBLIC+BEARER must carry a context");
    // No identity is resolved: the endpoint is not account-scoped.
    assert.deepEqual((bound as { authDerivedParams: unknown }).authDerivedParams, {});
  });

  test("it releases the bearer only through runCurrent, with both checks", async () => {
    const authority = readyAuthority();
    const reader = authority.asReader();
    const bound = reader.bind(publicBearerCall);
    assert.equal(bound.kind, "AUTHENTICATED");

    let seen: string | undefined;
    const result = await reader.runCurrent(bound as never, async (view) => {
      seen = view.accessToken;
      assert.equal(view.signal.aborted, false, "the pre-check passed a live signal");
      return "released";
    });

    assert.equal(result, "released");
    assert.equal(seen, TOKEN_SENTINEL);
  });

  test("a generation change during the call discards the result", async () => {
    const authority = readyAuthority();
    const reader = authority.asReader();
    const bound = reader.bind(publicBearerCall);

    await assert.rejects(
      reader.runCurrent(bound as never, async () => {
        authority.invalidate("LOGOUT");
        return "must not be released";
      }),
      (error: unknown) => (error as { name?: string }).name === "AuthContextError"
    );
  });

  test("the wrapper never serializes the context or the bearer", () => {
    const authority = readyAuthority();
    const bound = authority.asReader().bind(publicBearerCall);
    const rendered = `${JSON.stringify(bound)}|${Object.keys(bound).join(",")}`;
    assert.equal(rendered.includes(TOKEN_SENTINEL), false);
    assert.equal(rendered.includes("context"), false);
  });

  test("without a usable context, PUBLIC + BEARER fails closed", () => {
    const authority = createAuthContextAuthority();
    assert.throws(
      () => authority.asReader().bind(publicBearerCall),
      (error: unknown) => (error as { name?: string }).name === "AuthContextError"
    );
  });

  test("PUBLIC + NONE still binds with no context at all", () => {
    const authority = readyAuthority();
    const bound = authority.asReader().bind(
      Object.freeze({ descriptor: PUBLIC_DESCRIPTOR, callerParams: Object.freeze({ query: "x" }) })
    );
    assert.equal(bound.kind, "PUBLIC");
    assert.equal("context" in bound, false);
  });

  test("an unknown auth requirement fails closed rather than defaulting", () => {
    const authority = readyAuthority();
    const hostile = Object.freeze({
      descriptor: Object.freeze({ ...PUBLIC_BEARER_DESCRIPTOR, auth: "MAYBE" as never }),
      callerParams: Object.freeze({}),
    });
    assert.throws(
      () => authority.asReader().bind(hostile),
      (error: unknown) => (error as { name?: string }).name === "AuthContextError"
    );
  });
});

describe("usable-record query for expiring browser bearers", () => {
  test("READY with unexpired material is usable; the same record stops being usable at expiry", () => {
    let now = T0;
    const a = authority({ now: () => now });
    assert.equal(a.hasUsableRecord(), false, "nothing established yet");
    establish(a);
    assert.equal(a.hasUsableRecord(), true);
    now = T0 + ONE_HOUR;
    assert.equal(a.hasUsableRecord(), false, "expired material is not usable");
    assert.equal(a.diagnostics().availability, "READY", "expiry is still not a transition");
  });

  test("a fresh ESTABLISH over an expired record makes it usable again", () => {
    let now = T0;
    const a = authority({ now: () => now });
    establish(a);
    now = T0 + ONE_HOUR;
    establish(a, { expiresAt: now + ONE_HOUR });
    assert.equal(a.hasUsableRecord(), true);
  });
});
