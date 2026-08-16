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
 * Guarded execution entry point used by the tests. Task 4 replaces the handle
 * with the frozen AuthorizedCall wrapper; keeping the indirection here means
 * that change is one edit, not thirty.
 */
function runGuarded<T>(
  a: Authority,
  context: unknown,
  execute: (view: { accessToken: string; tokenType: string; signal: AbortSignal }) => Promise<T>
): Promise<T> {
  return a.runCurrent(context as never, execute as never) as Promise<T>;
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
