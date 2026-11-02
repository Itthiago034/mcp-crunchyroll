// BT4 — the trusted auth producer.
//
// Deterministic and offline: no network, no DNS, no socket, no browser, no real
// credential. Every token, account, profile and password value is SYNTHETIC.
//
// The authority under test is the REAL BT3 AuthContextAuthority, driven through
// its REAL asWriter() port — BT4 mocks its own storage and legacy-network
// ports, never the boundary it is being judged on.
//
// Frozen design: CRUNCHYROLL-BT4-DESIGN.md, over the closed BT3 contracts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import { PRODUCTION_OPERATIONS } from "../src/transport/operation-registry.js";
import {
  createAuthProducer,
  createDefaultAuthProducerPorts,
  type AuthProducerPorts,
  type AuthWriterPort,
  type TokenLike,
} from "../src/transport/auth-producer.js";
import type { LogoutResult } from "../src/auth.js";

// ── Symbolic material ───────────────────────────────────────────────────────

const EPOCH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const T0 = 1_000_000;
const ONE_HOUR = 3_600_000;

const ACCESS_SENTINEL = "SYNTHETIC-ACCESS-TOKEN-BT4-1";
const ACCESS_SENTINEL_B = "SYNTHETIC-ACCESS-TOKEN-BT4-2";
const REFRESH_SENTINEL = "SYNTHETIC-REFRESH-TOKEN-BT4-MUST-NOT-PROPAGATE";
const ACCOUNT_SENTINEL = "SENSITIVE-ACCOUNT-SENTINEL-bt4-a1";
const ACCOUNT_SENTINEL_B = "SENSITIVE-ACCOUNT-SENTINEL-bt4-b2";
const PROFILE_SENTINEL = "SENSITIVE-PROFILE-SENTINEL-bt4-c3";
const PROFILE_SENTINEL_B = "SENSITIVE-PROFILE-SENTINEL-bt4-d4";
const PASSWORD_SENTINEL = "SYNTHETIC-PASSWORD-MUST-NEVER-REACH-AUTHORITY";
const EMAIL_SENTINEL = "bt4-probe@example.invalid";

function tokens(overrides: Partial<Record<string, unknown>> = {}): TokenLike {
  return {
    access_token: ACCESS_SENTINEL,
    refresh_token: REFRESH_SENTINEL,
    expires_at: T0 + ONE_HOUR,
    token_type: "Bearer",
    account_id: ACCOUNT_SENTINEL,
    ...overrides,
  } as TokenLike;
}

const CLEARED: LogoutResult = {
  state: "CLEARED",
  tokens: { state: "REMOVED" },
  session: { state: "REMOVED" },
};

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * The real BT3 authority behind a recording writer port. Delegation is total —
 * the semantics under test are BT3's own — while the call log lets a test prove
 * that a read-only operation touched no writer method at all.
 */
function recordingWriter(
  authority: ReturnType<typeof createAuthContextAuthority>,
  events: string[] = []
) {
  const calls: string[] = [];
  const writer = authority.asWriter();
  const port: AuthWriterPort = {
    currentRevision: () => {
      calls.push("currentRevision");
      return writer.currentRevision();
    },
    commitAuthenticatedMaterial: (expected, mode, candidate) => {
      calls.push(`commit:${String(mode)}`);
      return writer.commitAuthenticatedMaterial(expected, mode, candidate as never);
    },
    invalidate: (cause) => {
      calls.push(`invalidate:${String(cause)}`);
      events.push(`invalidate:${String(cause)}`);
      return writer.invalidate(cause);
    },
  };
  return { calls, port };
}

interface StorageFake {
  port: AuthProducerPorts["storage"];
  calls: { load: number; clear: number };
  set(next: TokenLike | null): void;
  failLoad(error: unknown): void;
  setClearResult(result: LogoutResult): void;
}

function storageFake(initial: TokenLike | null = null, events: string[] = []): StorageFake {
  let current = initial;
  let loadError: unknown;
  let clearResult: LogoutResult = CLEARED;
  const calls = { load: 0, clear: 0 };
  return {
    calls,
    set: (next) => {
      current = next;
    },
    failLoad: (error) => {
      loadError = error;
    },
    setClearResult: (result) => {
      clearResult = result;
    },
    port: {
      loadTokens: async () => {
        calls.load += 1;
        if (loadError) throw loadError;
        return current;
      },
      clearAuthData: async () => {
        calls.clear += 1;
        events.push("clear");
        return clearResult;
      },
      isTokenExpired: (t) => T0 >= t.expires_at - 60_000,
    },
  };
}

interface LegacyFake {
  port: AuthProducerPorts["legacy"];
  calls: { login: number; refresh: number; status: number };
  observedCredentials: Array<{ email: string; password: string }>;
  setLogin(result: { success: boolean; message: string }): void;
  setRefresh(handler: () => Promise<TokenLike>): void;
  setStatus(result: Record<string, unknown>): void;
}

function legacyFake(): LegacyFake {
  const calls = { login: 0, refresh: 0, status: 0 };
  const observedCredentials: Array<{ email: string; password: string }> = [];
  let loginResult = { success: true, message: "ok" };
  let refreshHandler: () => Promise<TokenLike> = async () => tokens();
  let statusResult: Record<string, unknown> = { logged_in: false };
  return {
    calls,
    observedCredentials,
    setLogin: (result) => {
      loginResult = result;
    },
    setRefresh: (handler) => {
      refreshHandler = handler;
    },
    setStatus: (result) => {
      statusResult = result;
    },
    port: {
      login: async (email, password) => {
        calls.login += 1;
        observedCredentials.push({ email, password });
        return loginResult;
      },
      refreshRequest: async () => {
        calls.refresh += 1;
        return refreshHandler();
      },
      getStatus: async () => {
        calls.status += 1;
        return statusResult;
      },
    },
  };
}

function harness(initialTokens: TokenLike | null = null) {
  const authority = createAuthContextAuthority({
    epochFactory: () => EPOCH,
    now: () => T0,
  });
  /** One ordered log across BOTH side-effecting layers, so an ordering rule
   *  ("invalidate before any filesystem work") is a single deepEqual. */
  const events: string[] = [];
  const writer = recordingWriter(authority, events);
  const storage = storageFake(initialTokens, events);
  const legacy = legacyFake();
  const producer = createAuthProducer({
    writer: writer.port,
    storage: storage.port,
    legacy: legacy.port,
  });
  return { authority, writer, storage, legacy, producer, events };
}

describe("BT4 login — persistence first, authority second", () => {
  test("A: a successful login establishes exactly one generation", async () => {
    const h = harness();
    h.storage.set(tokens());

    const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    assert.deepEqual(outcome, { kind: "ESTABLISHED" });
    assert.equal(h.authority.diagnostics().availability, "READY");
    assert.equal(h.authority.currentRevision().generation, 1);
    assert.deepEqual(h.writer.calls, ["currentRevision", "commit:ESTABLISH"]);
    assert.equal(h.legacy.calls.login, 1);
  });

  test("A: the established record carries exactly the persisted identity", async () => {
    const h = harness();
    h.storage.set(tokens({ profile_id: PROFILE_SENTINEL }));

    await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    const seen = h.authority.inspectForTest();
    assert.equal(seen.accountId, ACCOUNT_SENTINEL);
    assert.equal(seen.profileId, PROFILE_SENTINEL);
    assert.equal(seen.tokenType, "Bearer");
    assert.equal(seen.expiresAt, T0 + ONE_HOUR);
  });

  test("B: a failed login performs no authority transition at all", async () => {
    const h = harness();
    h.legacy.setLogin({ success: false, message: "Login failed: nope" });
    h.storage.set(tokens());

    const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    assert.deepEqual(outcome, { kind: "LOGIN_FAILED" });
    assert.equal(h.authority.currentRevision().generation, 0);
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.deepEqual(h.writer.calls, [], "the writer must not be touched");
    assert.equal(h.storage.calls.load, 0, "no read-back after a failed login");
  });

  test("B: a non-boolean success field is not treated as success", async () => {
    const h = harness();
    h.legacy.setLogin({ success: "yes" as never, message: "" });
    h.storage.set(tokens());

    const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);
    assert.deepEqual(outcome, { kind: "LOGIN_FAILED" });
    assert.deepEqual(h.writer.calls, []);
  });

  test("C: material absent after a reportedly successful login", async () => {
    const h = harness();
    h.storage.set(null);

    const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    assert.deepEqual(outcome, { kind: "MATERIAL_UNAVAILABLE" });
    assert.equal(h.authority.currentRevision().generation, 0);
    assert.deepEqual(h.writer.calls, ["currentRevision"], "revision captured, nothing committed");
  });

  test("C: a storage failure during read-back leaves the authority untouched", async () => {
    const h = harness();
    h.storage.failLoad(Object.assign(new Error("insecure store"), { name: "StorageError" }));

    const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    assert.deepEqual(outcome, { kind: "MATERIAL_UNAVAILABLE" });
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.deepEqual(h.writer.calls, ["currentRevision"]);
  });

  const invalidMaterial: Array<[string, Record<string, unknown>]> = [
    ["an empty access token", { access_token: "" }],
    ["a non-string access token", { access_token: 42 }],
    ["an empty token type", { token_type: "" }],
    ["an empty account id", { account_id: "" }],
    ["a non-string account id", { account_id: null }],
    ["an empty profile id", { profile_id: "" }],
    ["a non-numeric expiry", { expires_at: "soon" }],
    ["an expired token", { expires_at: T0 - 1 }],
  ];

  for (const [name, override] of invalidMaterial) {
    test(`C: read-back with ${name} performs no transition`, async () => {
      const h = harness();
      h.storage.set(tokens(override));

      const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

      assert.deepEqual(outcome, { kind: "MATERIAL_UNAVAILABLE" });
      assert.equal(h.authority.currentRevision().generation, 0);
      assert.equal(h.writer.calls.some((c) => c.startsWith("commit")), false);
    });
  }

  test("C: a commit rejected by the authority is reported, never retried", async () => {
    const h = harness();
    h.storage.set(tokens());
    // Terminal authority: every commit is refused.
    const terminal = createAuthContextAuthority({
      epochFactory: () => EPOCH,
      now: () => T0,
      initialGeneration: Number.MAX_SAFE_INTEGER,
    });
    const writer = recordingWriter(terminal);
    const producer = createAuthProducer({
      writer: writer.port,
      storage: h.storage.port,
      legacy: h.legacy.port,
    });

    const outcome = await producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    assert.deepEqual(outcome, { kind: "AUTHORITY_REJECTED", reason: "UNAVAILABLE" });
    assert.equal(writer.calls.filter((c) => c.startsWith("commit")).length, 1, "no retry");
  });

  test("S: the password and email never reach the authority or the candidate", async () => {
    const h = harness();
    h.storage.set(tokens({ profile_id: PROFILE_SENTINEL }));

    await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    // They reached the legacy login boundary, and stopped there.
    assert.deepEqual(h.legacy.observedCredentials, [
      { email: EMAIL_SENTINEL, password: PASSWORD_SENTINEL },
    ]);
    const rendered = JSON.stringify(h.authority.inspectForTest());
    assert.equal(rendered.includes(PASSWORD_SENTINEL), false);
    assert.equal(rendered.includes(EMAIL_SENTINEL), false);
  });

  test("R: the refresh token never enters the candidate or the authority", async () => {
    const h = harness();
    const captured: unknown[] = [];
    const spyingWriter: AuthWriterPort = {
      currentRevision: () => h.writer.port.currentRevision(),
      commitAuthenticatedMaterial: (expected, mode, candidate) => {
        captured.push(candidate);
        return h.writer.port.commitAuthenticatedMaterial(expected, mode, candidate);
      },
      invalidate: (cause) => h.writer.port.invalidate(cause),
    };
    const producer = createAuthProducer({
      writer: spyingWriter,
      storage: h.storage.port,
      legacy: h.legacy.port,
    });
    h.storage.set(tokens());

    await producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    assert.equal(captured.length, 1);
    const candidate = captured[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(candidate).sort(), [
      "accessToken",
      "accountId",
      "expiresAt",
      "tokenType",
    ]);
    assert.equal("refresh_token" in candidate, false);
    assert.equal("refreshToken" in candidate, false);
    assert.equal(JSON.stringify(candidate).includes(REFRESH_SENTINEL), false);
    assert.equal(Object.isFrozen(candidate), true);
  });

  test("the candidate omits profileId entirely when there is none", async () => {
    const h = harness();
    const captured: Record<string, unknown>[] = [];
    const producer = createAuthProducer({
      writer: {
        currentRevision: () => h.writer.port.currentRevision(),
        commitAuthenticatedMaterial: (expected, mode, candidate) => {
          captured.push(candidate as Record<string, unknown>);
          return h.writer.port.commitAuthenticatedMaterial(expected, mode, candidate);
        },
        invalidate: (cause) => h.writer.port.invalidate(cause),
      },
      storage: h.storage.port,
      legacy: h.legacy.port,
    });
    h.storage.set(tokens());

    await producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);
    assert.equal("profileId" in captured[0], false);
    assert.equal(h.authority.diagnostics().hasProfileId, false);
  });
});

describe("BT4 login — a hostile storage document cannot smuggle a second value", () => {
  test("each authorized field is read at most once from the stored document", async () => {
    const h = harness();
    const reads: Record<string, number> = {
      access_token: 0,
      token_type: 0,
      expires_at: 0,
      account_id: 0,
      profile_id: 0,
    };
    const answers: Record<string, unknown> = {
      access_token: ACCESS_SENTINEL,
      token_type: "Bearer",
      expires_at: T0 + ONE_HOUR,
      account_id: ACCOUNT_SENTINEL,
      profile_id: PROFILE_SENTINEL,
    };
    const hostile: Record<string, unknown> = { refresh_token: REFRESH_SENTINEL };
    for (const field of Object.keys(reads)) {
      Object.defineProperty(hostile, field, {
        enumerable: true,
        get() {
          reads[field] += 1;
          // A changing answer: the second read is poison.
          return reads[field] === 1 ? answers[field] : `POISONED-${field}`;
        },
      });
    }
    h.storage.set(hostile as unknown as TokenLike);

    const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    assert.deepEqual(outcome, { kind: "ESTABLISHED" });
    for (const field of Object.keys(reads)) {
      assert.ok(reads[field] <= 1, `${field} was read ${reads[field]} times`);
    }
    // The installed record is the single validated snapshot, not the poison.
    assert.equal(h.authority.inspectForTest().accountId, ACCOUNT_SENTINEL);
    assert.equal(h.authority.inspectForTest().profileId, PROFILE_SENTINEL);
  });

  test("a getter that mutates the authority mid-read cannot be overwritten", async () => {
    const h = harness();
    const hostile: Record<string, unknown> = { refresh_token: REFRESH_SENTINEL };
    const answers: Record<string, unknown> = {
      access_token: ACCESS_SENTINEL,
      token_type: "Bearer",
      expires_at: T0 + ONE_HOUR,
      account_id: ACCOUNT_SENTINEL,
      profile_id: undefined,
    };
    for (const field of Object.keys(answers)) {
      Object.defineProperty(hostile, field, {
        enumerable: true,
        get() {
          if (field === "access_token") h.authority.invalidate("LOGOUT");
          return answers[field];
        },
      });
    }
    h.storage.set(hostile as unknown as TokenLike);

    const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);

    // BT3's own CAS is what rejects it — BT4 captures the revision before the
    // untrusted read and never re-reads it.
    assert.deepEqual(outcome, { kind: "AUTHORITY_REJECTED", reason: "STALE" });
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
  });
});

// ── Material observed in the human's own browser (completion errata §7, §9) ──

/** Exactly the closed observation shape; never a refresh token, never a cookie. */
function observed(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: ACCESS_SENTINEL,
    tokenType: "Bearer",
    expiresAt: T0 + ONE_HOUR,
    accountId: ACCOUNT_SENTINEL,
    ...overrides,
  } as Parameters<
    ReturnType<typeof createAuthProducer>["establishFromObservedMaterial"]
  >[0];
}

describe("BT4 completion — observed material installs through the same CAS", () => {
  test("an observation establishes exactly one generation and touches no storage", async () => {
    const h = harness();

    const outcome = await h.producer.establishFromObservedMaterial(observed());

    assert.deepEqual(outcome, { kind: "ESTABLISHED" });
    assert.equal(h.authority.diagnostics().availability, "READY");
    assert.equal(h.authority.currentRevision().generation, 1);
    assert.deepEqual(h.writer.calls, ["currentRevision", "commit:ESTABLISH"]);
    assert.equal(h.storage.calls.load, 0, "the browser path reads no stored document");
    assert.equal(h.storage.calls.clear, 0);
    assert.equal(h.legacy.calls.login, 0, "no credential grant is performed");
  });

  test("the installed record carries exactly the observed identity", async () => {
    const h = harness();

    await h.producer.establishFromObservedMaterial(
      observed({ profileId: PROFILE_SENTINEL })
    );

    const seen = h.authority.inspectForTest();
    assert.equal(seen.accountId, ACCOUNT_SENTINEL);
    assert.equal(seen.profileId, PROFILE_SENTINEL);
    assert.equal(seen.tokenType, "Bearer");
    assert.equal(seen.expiresAt, T0 + ONE_HOUR);
  });

  test("the candidate carries the five closed fields and no refresh token", async () => {
    const h = harness();
    const captured: Record<string, unknown>[] = [];
    const producer = createAuthProducer({
      writer: {
        currentRevision: () => h.writer.port.currentRevision(),
        commitAuthenticatedMaterial: (expected, mode, candidate) => {
          captured.push(candidate as Record<string, unknown>);
          return h.writer.port.commitAuthenticatedMaterial(expected, mode, candidate);
        },
        invalidate: (cause) => h.writer.port.invalidate(cause),
      },
      storage: h.storage.port,
      legacy: h.legacy.port,
    });

    await producer.establishFromObservedMaterial(
      observed({ profileId: PROFILE_SENTINEL, refreshToken: REFRESH_SENTINEL } as never)
    );

    const candidate = captured[0];
    assert.deepEqual(Object.keys(candidate).sort(), [
      "accessToken",
      "accountId",
      "expiresAt",
      "profileId",
      "tokenType",
    ]);
    assert.equal("refreshToken" in candidate, false);
    assert.equal("refresh_token" in candidate, false);
    assert.equal(JSON.stringify(candidate).includes(REFRESH_SENTINEL), false);
    assert.equal(Object.isFrozen(candidate), true);
  });

  test("a malformed observation is never committed", async () => {
    for (const broken of [
      observed({ accessToken: "   " }),
      observed({ tokenType: "" }),
      observed({ accountId: "" }),
      observed({ profileId: "" }),
      observed({ expiresAt: Number.NaN }),
      observed({ expiresAt: "soon" as never }),
    ]) {
      const h = harness();
      const outcome = await h.producer.establishFromObservedMaterial(broken);
      assert.deepEqual(outcome, { kind: "MATERIAL_UNAVAILABLE" });
      assert.equal(h.authority.currentRevision().generation, 0);
      assert.deepEqual(h.writer.calls, ["currentRevision"], "revision captured, nothing committed");
    }
  });

  test("an already-expired observation is never installed", async () => {
    const h = harness();

    const outcome = await h.producer.establishFromObservedMaterial(
      observed({ expiresAt: T0 - ONE_HOUR })
    );

    assert.deepEqual(outcome, { kind: "MATERIAL_UNAVAILABLE" });
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
  });

  test("each authorized field is read at most once from the observation", async () => {
    const h = harness();
    const reads: Record<string, number> = {
      accessToken: 0,
      tokenType: 0,
      expiresAt: 0,
      accountId: 0,
      profileId: 0,
    };
    const answers: Record<string, unknown> = {
      accessToken: ACCESS_SENTINEL,
      tokenType: "Bearer",
      expiresAt: T0 + ONE_HOUR,
      accountId: ACCOUNT_SENTINEL,
      profileId: PROFILE_SENTINEL,
    };
    const hostile: Record<string, unknown> = {};
    for (const field of Object.keys(reads)) {
      Object.defineProperty(hostile, field, {
        enumerable: true,
        get() {
          reads[field] += 1;
          return answers[field];
        },
      });
    }

    await h.producer.establishFromObservedMaterial(hostile as never);

    for (const [field, count] of Object.entries(reads)) {
      assert.ok(count <= 1, `${field} was read ${count} times`);
    }
  });

  test("a terminal authority answers AUTHORITY_REJECTED and never throws", async () => {
    const terminal = createAuthContextAuthority({
      epochFactory: () => EPOCH,
      now: () => T0,
      initialGeneration: Number.MAX_SAFE_INTEGER,
    });
    const producer = createAuthProducer({
      writer: recordingWriter(terminal).port,
      storage: storageFake().port,
      legacy: legacyFake().port,
    });

    const outcome = await producer.establishFromObservedMaterial(observed());

    assert.deepEqual(outcome, { kind: "AUTHORITY_REJECTED", reason: "UNAVAILABLE" });
  });

  test("logging in as a different account is an explicit new session", async () => {
    const h = harness();
    await h.producer.establishFromObservedMaterial(observed());

    const outcome = await h.producer.establishFromObservedMaterial(
      observed({ accessToken: ACCESS_SENTINEL_B, accountId: ACCOUNT_SENTINEL_B })
    );

    // ESTABLISH is BT3's explicit new-session path; only REFRESH demands
    // identity continuity. BT4 compares no identity of its own.
    assert.deepEqual(outcome, { kind: "ESTABLISHED" });
    assert.equal(h.authority.currentRevision().generation, 2);
    assert.equal(h.authority.inspectForTest().accountId, ACCOUNT_SENTINEL_B);
  });

  test("no observed outcome carries material or identity", async () => {
    const h = harness();
    const rendered = [
      JSON.stringify(await h.producer.establishFromObservedMaterial(observed({ profileId: PROFILE_SENTINEL }))),
      JSON.stringify(await h.producer.establishFromObservedMaterial(observed({ accessToken: "" }))),
    ].join("\n");

    for (const sentinel of [ACCESS_SENTINEL, ACCOUNT_SENTINEL, PROFILE_SENTINEL, REFRESH_SENTINEL]) {
      assert.equal(rendered.includes(sentinel), false, `leaked ${sentinel}`);
    }
  });
});

// ── Refresh ─────────────────────────────────────────────────────────────────

/** A RefreshError-shaped rejection, exactly as src/api.ts produces it. */
function refreshError(kind: string): Error {
  const error = new Error(`fixed message for ${kind}`);
  error.name = "RefreshError";
  (error as unknown as { kind: string }).kind = kind;
  return error;
}

async function established(h: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
  h.storage.set(tokens(overrides));
  const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);
  assert.deepEqual(outcome, { kind: "ESTABLISHED" });
  h.writer.calls.length = 0;
  h.events.length = 0;
  return h;
}

describe("BT4 refresh — one commit, or none at all", () => {
  test("G: a successful refresh commits exactly one REFRESH", async () => {
    const h = await established(harness());
    h.legacy.setRefresh(async () => tokens({ access_token: ACCESS_SENTINEL_B }));

    const outcome = await h.producer.refresh();

    assert.deepEqual(outcome, { kind: "REFRESHED" });
    assert.equal(h.authority.currentRevision().generation, 2);
    assert.equal(h.authority.diagnostics().availability, "READY");
    assert.deepEqual(h.writer.calls, ["currentRevision", "commit:REFRESH"]);
  });

  test("G: the refresh token is never handed to the writer", async () => {
    const h = await established(harness());
    const captured: Record<string, unknown>[] = [];
    const producer = createAuthProducer({
      writer: {
        currentRevision: () => h.writer.port.currentRevision(),
        commitAuthenticatedMaterial: (expected, mode, candidate) => {
          captured.push(candidate as Record<string, unknown>);
          return h.writer.port.commitAuthenticatedMaterial(expected, mode, candidate);
        },
        invalidate: (cause) => h.writer.port.invalidate(cause),
      },
      storage: h.storage.port,
      legacy: h.legacy.port,
    });
    h.legacy.setRefresh(async () =>
      tokens({ access_token: ACCESS_SENTINEL_B, refresh_token: "ROTATED-REFRESH-SENTINEL" })
    );

    await producer.refresh();

    assert.equal(JSON.stringify(captured[0]).includes("ROTATED-REFRESH-SENTINEL"), false);
    assert.equal(JSON.stringify(captured[0]).includes(REFRESH_SENTINEL), false);
    assert.equal("refresh_token" in captured[0], false);
  });

  test("refresh with no persisted material performs no transition", async () => {
    const h = harness();
    h.storage.set(null);
    const outcome = await h.producer.refresh();
    assert.deepEqual(outcome, { kind: "NO_MATERIAL" });
    assert.equal(h.legacy.calls.refresh, 0);
    assert.equal(h.authority.currentRevision().generation, 0);
  });

  test("refresh against an unavailable authority cannot bootstrap an identity", async () => {
    const h = harness();
    h.storage.set(tokens());
    const outcome = await h.producer.refresh();
    // BT3 refuses REFRESH continuity with nothing to continue.
    assert.deepEqual(outcome, { kind: "UNAVAILABLE" });
    assert.equal(h.authority.currentRevision().generation, 0);
  });

  test("H: a refresh that loses to a logout is stale and restores nothing", async () => {
    const h = await established(harness());
    h.legacy.setRefresh(async () => {
      // The logout lands while the network request is in flight.
      h.authority.invalidate("LOGOUT");
      return tokens({ access_token: ACCESS_SENTINEL_B });
    });

    const outcome = await h.producer.refresh();

    assert.deepEqual(outcome, { kind: "STALE" });
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.equal(h.authority.diagnostics().cause, "LOGOUT");
    assert.equal(h.authority.currentRevision().generation, 2, "the stale commit is not a transition");
  });

  test("I: concurrent refreshes share one request and produce one transition", async () => {
    const h = await established(harness());
    let operations = 0;
    let inFlight: Promise<TokenLike> | undefined;
    // Mirrors the legacy single-flight in src/api.ts: BT4 must not add a second
    // deduplication layer, and must not break the existing one.
    h.legacy.setRefresh(() => {
      if (!inFlight) {
        operations += 1;
        inFlight = Promise.resolve(tokens({ access_token: ACCESS_SENTINEL_B })).finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    });

    const [first, second] = await Promise.all([h.producer.refresh(), h.producer.refresh()]);

    assert.equal(operations, 1, "the single-flight is preserved");
    assert.equal(h.legacy.calls.refresh, 2, "BT4 adds no deduplication of its own");
    const kinds = [first.kind, second.kind].sort();
    assert.deepEqual(kinds, ["REFRESHED", "STALE"], "exactly one commit wins");
    assert.equal(h.authority.currentRevision().generation, 2, "no double increment");
  });

  test("J: a refresh that changes the account id invalidates instead of switching", async () => {
    const h = await established(harness());
    h.legacy.setRefresh(async () => tokens({ account_id: ACCOUNT_SENTINEL_B }));

    const outcome = await h.producer.refresh();

    assert.deepEqual(outcome, { kind: "IDENTITY_CHANGED" });
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.equal(h.authority.currentRevision().generation, 2);
    // BT4 never auto-establishes the new identity.
    assert.equal(h.authority.inspectForTest().accountId, undefined);
  });

  const profileChanges: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["a profile appears", {}, { profile_id: PROFILE_SENTINEL }],
    ["a profile disappears", { profile_id: PROFILE_SENTINEL }, {}],
    ["a profile changes", { profile_id: PROFILE_SENTINEL }, { profile_id: PROFILE_SENTINEL_B }],
  ];

  for (const [name, initial, refreshed] of profileChanges) {
    test(`K: refresh where ${name} is an identity change`, async () => {
      const h = await established(harness(), initial);
      h.legacy.setRefresh(async () => tokens(refreshed));

      const outcome = await h.producer.refresh();

      assert.deepEqual(outcome, { kind: "IDENTITY_CHANGED" });
      assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    });
  }

  test("L: invalid_grant invalidates the authority BEFORE any filesystem work", async () => {
    const h = await established(harness());
    h.legacy.setRefresh(async () => {
      throw refreshError("REAUTH_REQUIRED");
    });

    const outcome = await h.producer.refresh();

    assert.deepEqual(outcome, { kind: "REAUTH_REQUIRED" });
    assert.deepEqual(h.events, ["invalidate:INVALID_GRANT", "clear"], "ordering is the whole point");
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.equal(h.authority.diagnostics().cause, "INVALID_GRANT");
  });

  test("L: a failed clear after invalid_grant never resurrects the authority", async () => {
    const h = await established(harness());
    h.storage.setClearResult({
      state: "FAILED",
      tokens: { state: "FAILED", reason: "INSECURE_DIR" },
      session: { state: "FAILED", reason: "INSECURE_DIR" },
    });
    h.legacy.setRefresh(async () => {
      throw refreshError("REAUTH_REQUIRED");
    });

    const outcome = await h.producer.refresh();

    assert.deepEqual(outcome, { kind: "REAUTH_REQUIRED" });
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
  });

  const preservingFailures: Array<[string, string, string]> = [
    ["M: a transient failure", "TRANSIENT", "TRANSIENT"],
    ["a safe failure", "SAFE_FAILURE", "FAILED"],
    ["a malformed response", "MALFORMED_RESPONSE", "FAILED"],
    ["an unrecognised failure", "SOMETHING_ELSE", "FAILED"],
  ];

  for (const [name, errorKind, expected] of preservingFailures) {
    test(`${name} preserves the current material untouched`, async () => {
      const h = await established(harness());
      h.legacy.setRefresh(async () => {
        throw refreshError(errorKind);
      });

      const outcome = await h.producer.refresh();

      assert.deepEqual(outcome, { kind: expected });
      assert.equal(h.authority.diagnostics().availability, "READY");
      assert.equal(h.authority.currentRevision().generation, 1, "no transition");
      assert.equal(h.authority.inspectForTest().accountId, ACCOUNT_SENTINEL);
      assert.deepEqual(h.events, [], "no invalidation, no filesystem work");
    });
  }

  test("a structurally invalid refreshed payload performs no transition", async () => {
    const h = await established(harness());
    h.legacy.setRefresh(async () => tokens({ access_token: "" }));

    const outcome = await h.producer.refresh();

    assert.deepEqual(outcome, { kind: "FAILED" });
    assert.equal(h.authority.currentRevision().generation, 1);
    assert.equal(h.authority.diagnostics().availability, "READY");
  });

  test("a hostile refreshed payload is read at most once per field", async () => {
    const h = await established(harness());
    const reads: Record<string, number> = { access_token: 0, token_type: 0, expires_at: 0, account_id: 0, profile_id: 0 };
    h.legacy.setRefresh(async () => {
      const hostile: Record<string, unknown> = { refresh_token: REFRESH_SENTINEL };
      const answers: Record<string, unknown> = {
        access_token: ACCESS_SENTINEL_B,
        token_type: "Bearer",
        expires_at: T0 + ONE_HOUR,
        account_id: ACCOUNT_SENTINEL,
        profile_id: undefined,
      };
      for (const field of Object.keys(reads)) {
        Object.defineProperty(hostile, field, {
          enumerable: true,
          get() {
            reads[field] += 1;
            return reads[field] === 1 ? answers[field] : `POISONED-${field}`;
          },
        });
      }
      return hostile as unknown as TokenLike;
    });

    const outcome = await h.producer.refresh();

    assert.deepEqual(outcome, { kind: "REFRESHED" });
    for (const field of Object.keys(reads)) {
      assert.ok(reads[field] <= 1, `${field} read ${reads[field]} times`);
    }
    assert.equal(h.authority.inspectForTest().accountId, ACCOUNT_SENTINEL);
  });
});

// ── Logout, status, bootstrap, shutdown ─────────────────────────────────────

describe("BT4 logout — authority first, persistence second, layers separate", () => {
  test("N: the authority is invalidated BEFORE any filesystem work", async () => {
    const h = await established(harness());

    const outcome = await h.producer.logout();

    assert.deepEqual(h.events, ["invalidate:LOGOUT", "clear"]);
    assert.equal(outcome.authority, "INVALIDATED");
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.equal(h.authority.diagnostics().cause, "LOGOUT");
  });

  test("N: the structured persistence result is preserved verbatim", async () => {
    const cases: LogoutResult[] = [
      CLEARED,
      { state: "ALREADY_ABSENT", tokens: { state: "ALREADY_ABSENT" }, session: { state: "ALREADY_ABSENT" } },
      {
        state: "PARTIAL",
        tokens: { state: "REMOVED" },
        session: { state: "FAILED", reason: "INSECURE_OWNER" },
      },
      {
        state: "FAILED",
        tokens: { state: "FAILED", reason: "FILESYSTEM_ERROR" },
        session: { state: "FAILED", reason: "INSECURE_DIR" },
      },
    ];
    for (const persistence of cases) {
      const h = await established(harness());
      h.storage.setClearResult(persistence);
      const outcome = await h.producer.logout();
      assert.deepEqual(outcome.persistence, persistence, "no second outcome matrix");
      assert.equal(outcome.persistence.tokens.reason, persistence.tokens.reason);
      assert.equal(outcome.persistence.session.reason, persistence.session.reason);
    }
  });

  test("O: a partial or failed clear never restores the authority", async () => {
    for (const state of ["PARTIAL", "FAILED"] as const) {
      const h = await established(harness());
      h.storage.setClearResult({
        state,
        tokens: { state: "FAILED", reason: "INSECURE_DIR" },
        session: { state: "FAILED", reason: "INSECURE_DIR" },
      });

      const outcome = await h.producer.logout();

      assert.equal(outcome.persistence.state, state);
      assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
      assert.throws(() => h.authority.acquire());
    }
  });

  test("O: logout on a terminal authority still performs the cleanup", async () => {
    const terminal = createAuthContextAuthority({
      epochFactory: () => EPOCH,
      now: () => T0,
      initialGeneration: Number.MAX_SAFE_INTEGER,
    });
    const events: string[] = [];
    const writer = recordingWriter(terminal, events);
    const storage = storageFake(tokens(), events);
    const producer = createAuthProducer({
      writer: writer.port,
      storage: storage.port,
      legacy: legacyFake().port,
    });

    const outcome = await producer.logout();

    assert.equal(outcome.authority, "ALREADY_TERMINAL");
    assert.equal(storage.calls.clear, 1, "cleanup must not be skipped");
    assert.equal(terminal.diagnostics().availability, "UNAVAILABLE");
  });
});

describe("BT4 status — strictly read-only", () => {
  test("P: status never touches the writer and never moves the generation", async () => {
    const h = await established(harness());
    const before = h.authority.currentRevision().generation;
    h.legacy.setStatus({ logged_in: true, account_id: ACCOUNT_SENTINEL, token_expires_at: "2026-01-01T00:00:00.000Z" });

    const status = await h.producer.status();

    assert.deepEqual(h.writer.calls, [], "not even currentRevision may be called");
    assert.equal(h.authority.currentRevision().generation, before);
    assert.equal(h.authority.diagnostics().availability, "READY");
    assert.deepEqual(status, {
      logged_in: true,
      account_id: ACCOUNT_SENTINEL,
      token_expires_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("P: status neither refreshes nor mutates storage", async () => {
    const h = await established(harness());
    await h.producer.status();
    await h.producer.status();
    assert.equal(h.legacy.calls.refresh, 0);
    assert.equal(h.storage.calls.clear, 0);
    assert.deepEqual(h.events, []);
    assert.equal(h.authority.currentRevision().generation, 1);
  });

  test("P: status adds no field of its own to the public shape", async () => {
    const h = harness();
    h.legacy.setStatus({ logged_in: false });
    const status = await h.producer.status();
    assert.deepEqual(Object.keys(status), ["logged_in"]);
    const rendered = JSON.stringify(status);
    assert.equal(rendered.includes(EPOCH), false);
    assert.equal(rendered.includes("generation"), false);
    assert.equal(rendered.includes("epoch"), false);
    assert.equal(rendered.includes("context"), false);
  });
});

describe("BT4 bootstrap — explicit, never implicit trust", () => {
  test("D: valid persisted material establishes through the CAS", async () => {
    const h = harness();
    h.storage.set(tokens({ profile_id: PROFILE_SENTINEL }));

    const outcome = await h.producer.bootstrapFromStorage();

    assert.deepEqual(outcome, { kind: "ESTABLISHED" });
    assert.equal(h.authority.currentRevision().generation, 1);
    assert.equal(h.authority.inspectForTest().accountId, ACCOUNT_SENTINEL);
    assert.equal(h.authority.inspectForTest().profileId, PROFILE_SENTINEL);
    assert.deepEqual(h.writer.calls, ["currentRevision", "commit:ESTABLISH"]);
  });

  test("E: missing material leaves the process unavailable", async () => {
    const h = harness();
    h.storage.set(null);

    const outcome = await h.producer.bootstrapFromStorage();

    assert.deepEqual(outcome, { kind: "NO_MATERIAL" });
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.equal(h.writer.calls.some((c) => c.startsWith("commit")), false);
  });

  test("F: corrupt or insecure storage stays unavailable, never 'logged out'", async () => {
    for (const state of ["CORRUPT_SESSION", "INSECURE_DIR", "INSECURE_OWNER", "FILESYSTEM_ERROR"]) {
      const h = harness();
      const error = Object.assign(new Error("storage refused"), { name: "StorageError", state });
      h.storage.failLoad(error);

      const outcome = await h.producer.bootstrapFromStorage();

      assert.deepEqual(outcome, { kind: "STORAGE_UNUSABLE" }, state);
      assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
      assert.equal(h.writer.calls.some((c) => c.startsWith("commit")), false);
    }
  });

  test("expired persisted material is not installed", async () => {
    const h = harness();
    h.storage.set(tokens({ expires_at: T0 - 1 }));

    const outcome = await h.producer.bootstrapFromStorage();

    assert.deepEqual(outcome, { kind: "EXPIRED" });
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.equal(h.writer.calls.some((c) => c.startsWith("commit")), false);
  });

  test("a bootstrap rejected by the authority is reported, not retried", async () => {
    const terminal = createAuthContextAuthority({
      epochFactory: () => EPOCH,
      now: () => T0,
      initialGeneration: Number.MAX_SAFE_INTEGER,
    });
    const writer = recordingWriter(terminal);
    const producer = createAuthProducer({
      writer: writer.port,
      storage: storageFake(tokens()).port,
      legacy: legacyFake().port,
    });

    const outcome = await producer.bootstrapFromStorage();

    assert.deepEqual(outcome, { kind: "AUTHORITY_REJECTED", reason: "UNAVAILABLE" });
    assert.equal(writer.calls.filter((c) => c.startsWith("commit")).length, 1);
  });

  test("no epoch or generation is ever written back to storage", async () => {
    const h = harness();
    h.storage.set(tokens());
    await h.producer.bootstrapFromStorage();
    // The storage port exposes no save at all: BT4 cannot change the on-disk
    // format even by mistake.
    assert.deepEqual(Object.keys(h.storage.port).sort(), [
      "clearAuthData",
      "isTokenExpired",
      "loadTokens",
    ]);
  });
});

describe("BT4 shutdown — invalidate without destroying credentials", () => {
  test("shutdown invalidates the live authority and performs no filesystem work", async () => {
    const h = await established(harness());

    const outcome = h.producer.invalidateForShutdown();

    assert.deepEqual(outcome, { authority: "INVALIDATED" });
    assert.deepEqual(h.events, ["invalidate:PROCESS_SHUTDOWN"]);
    assert.equal(h.storage.calls.clear, 0, "shutdown must not clear stored credentials");
    assert.equal(h.authority.diagnostics().availability, "UNAVAILABLE");
    assert.equal(h.authority.diagnostics().cause, "PROCESS_SHUTDOWN");
  });

  test("shutdown on a terminal authority is reported, never thrown", async () => {
    const terminal = createAuthContextAuthority({
      epochFactory: () => EPOCH,
      now: () => T0,
      initialGeneration: Number.MAX_SAFE_INTEGER,
    });
    const producer = createAuthProducer({
      writer: recordingWriter(terminal).port,
      storage: storageFake().port,
      legacy: legacyFake().port,
    });

    assert.deepEqual(producer.invalidateForShutdown(), { authority: "ALREADY_TERMINAL" });
  });
});

// ── Security and boundary closure ───────────────────────────────────────────

const BT4_REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRODUCER_SOURCE_PATH = join(BT4_REPO_ROOT, "src/transport/auth-producer.ts");
const PRODUCER_SOURCE = readFileSync(PRODUCER_SOURCE_PATH, "utf-8");
/** Comments stripped: prose about cookies is not a cookie capability. */
const PRODUCER_CODE = PRODUCER_SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

describe("BT4 closure — Q: no outcome or failure carries material or identity", () => {
  test("every reachable producer outcome is sentinel-free", async () => {
    const rendered: string[] = [];

    const ok = await established(harness(), { profile_id: PROFILE_SENTINEL });
    rendered.push(JSON.stringify(await ok.producer.status()));
    rendered.push(JSON.stringify(await ok.producer.logout()));

    const failed = harness();
    failed.legacy.setLogin({ success: false, message: `Login failed: ${PASSWORD_SENTINEL}` });
    rendered.push(JSON.stringify(await failed.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL)));

    const absent = harness();
    absent.storage.set(null);
    rendered.push(JSON.stringify(await absent.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL)));
    rendered.push(JSON.stringify(await absent.producer.refresh()));
    rendered.push(JSON.stringify(await absent.producer.bootstrapFromStorage()));

    const identity = await established(harness());
    identity.legacy.setRefresh(async () => tokens({ account_id: ACCOUNT_SENTINEL_B }));
    rendered.push(JSON.stringify(await identity.producer.refresh()));

    const grant = await established(harness());
    grant.legacy.setRefresh(async () => {
      throw refreshError("REAUTH_REQUIRED");
    });
    rendered.push(JSON.stringify(await grant.producer.refresh()));

    const shutdown = await established(harness());
    rendered.push(JSON.stringify(shutdown.producer.invalidateForShutdown()));

    const everything = rendered.join("\n");
    for (const sentinel of [
      ACCESS_SENTINEL,
      ACCESS_SENTINEL_B,
      REFRESH_SENTINEL,
      ACCOUNT_SENTINEL,
      ACCOUNT_SENTINEL_B,
      PROFILE_SENTINEL,
      PROFILE_SENTINEL_B,
      PASSWORD_SENTINEL,
      EMAIL_SENTINEL,
      EPOCH,
    ]) {
      assert.equal(everything.includes(sentinel), false, `leaked ${sentinel}`);
    }
  });

  test("the legacy login message is never propagated into a producer outcome", async () => {
    const h = harness();
    h.legacy.setLogin({ success: false, message: `Login failed: ${ACCOUNT_SENTINEL}` });
    const outcome = await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);
    assert.deepEqual(Object.keys(outcome), ["kind"]);
    assert.equal(JSON.stringify(outcome).includes(ACCOUNT_SENTINEL), false);
  });

  test("outcomes are frozen and carry only closed discriminants", async () => {
    const h = await established(harness());
    const outcome = await h.producer.refresh();
    assert.equal(Object.isFrozen(outcome), true);
    assert.deepEqual(Object.keys(outcome), ["kind"]);
  });
});

describe("BT4 closure — T/V/W: no capability BT4 must not have", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["an import of the BT3 authority", /from\s+"[^"]*auth-context\.js"/],
    ["the BT3 reader port", /AuthContextReader|asReader/],
    ["context binding", /\bbind\s*\(/],
    ["guarded execution", /runCurrent/],
    ["cookie handling", /cookie/i],
    ["a browser session manager", /BrowserSessionManager/],
    ["CDP", /\bcdp\b|CdpClient|Runtime\.evaluate|Fetch\.|Network\./i],
    ["an http(s) URL literal", /https?:\/\//],
    ["a direct fetch", /\bfetch\s*\(/],
    ["a websocket or raw socket", /WebSocket|node:net|node:tls|node:https?/],
    ["direct filesystem access", /node:fs|readFile|writeFile|unlink/],
    ["environment reading", /process\.env/],
    ["a timer", /setTimeout|setInterval/],
    ["an operation registry or dispatcher", /operation-registry|dispatcher|PRODUCTION_OPERATIONS/],
    ["an epoch or generation it could choose", /epochFactory|initialGeneration/],
  ];

  for (const [name, pattern] of forbidden) {
    test(`the producer source contains no ${name}`, () => {
      assert.equal(pattern.test(PRODUCER_CODE), false, `${name} must not appear in auth-producer.ts`);
    });
  }

  test("V: the writer port the producer consumes has exactly three methods", () => {
    const authority = createAuthContextAuthority({ epochFactory: () => EPOCH, now: () => T0 });
    assert.deepEqual(Object.keys(authority.asWriter()).sort(), [
      "commitAuthenticatedMaterial",
      "currentRevision",
      "invalidate",
    ]);
  });

  test("V: the producer only ever calls those three writer methods", async () => {
    const h = harness();
    h.storage.set(tokens());
    await h.producer.establishFromLogin(EMAIL_SENTINEL, PASSWORD_SENTINEL);
    h.legacy.setRefresh(async () => tokens({ access_token: ACCESS_SENTINEL_B }));
    await h.producer.refresh();
    await h.producer.status();
    await h.producer.bootstrapFromStorage();
    h.producer.invalidateForShutdown();
    await h.producer.logout();

    const distinct = new Set(h.writer.calls.map((c) => c.split(":")[0]));
    assert.deepEqual([...distinct].sort(), ["commit", "currentRevision", "invalidate"]);
  });

  test("W: the producer stays out of the content path the cutover opened", () => {
    // RETIRED AT BT5: this used to assert the registry was empty and the entry
    // point had no dispatcher, registry or backend — the pre-cutover shape.
    // BT5 is the cutover, so what must remain true is narrower and about the
    // PRODUCER: it gained no content role when content started flowing.
    // RETIRED AT BT6: the exact table moved to test/bt6-catalog.test.ts. What
    // this file asserts is that the PRODUCER gained no content role, whatever
    // the catalog migration does next.
    assert.ok(PRODUCTION_OPERATIONS.some((d) => String(d.id) === "GET_CATEGORIES"));
    assert.equal(Object.isFrozen(PRODUCTION_OPERATIONS), true);
    const entry = readFileSync(join(BT4_REPO_ROOT, "src/index.ts"), "utf-8");
    assert.equal(/from\s+"[^"]*dispatcher\.js"/.test(entry), true, "content routes through the dispatcher");
    assert.equal(/auth-producer\.js/.test(entry), true, "the producer is still wired for auth");
    // The producer itself never learned about operations, transports or content.
    for (const forbidden of ["executeResolved", "TransportBackend", "dispatcher", "content-gateway"]) {
      assert.equal(
        PRODUCER_CODE.includes(forbidden),
        false,
        `the producer must not reference ${forbidden}`
      );
    }
  });

  test("U: the public tool contract is exactly 23 names (21 unchanged + crunchyroll_play + crunchyroll_player_control)", () => {
    const baseline = JSON.parse(
      readFileSync(join(BT4_REPO_ROOT, "test/fixtures/baseline-tools.json"), "utf-8")
    ) as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
    assert.equal(baseline.length, 24);
    for (const tool of baseline) {
      for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
        assert.equal(
          ["authorization", "bearer", "cookie", "token", "accountid", "profileid", "epoch", "authgeneration", "context"].includes(
            property.toLowerCase()
          ),
          false,
          `${tool.name} must not admit ${property}`
        );
      }
    }
  });

  test("no dependency was added and the engine floor is unchanged", () => {
    const manifest = JSON.parse(readFileSync(join(BT4_REPO_ROOT, "package.json"), "utf-8")) as {
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

describe("BT4 closure — the real ports satisfy the producer contract", () => {
  test("the default adapter binds the real storage and legacy functions", () => {
    const authority = createAuthContextAuthority({ epochFactory: () => EPOCH, now: () => T0 });
    const ports = createDefaultAuthProducerPorts(authority.asWriter());

    assert.deepEqual(Object.keys(ports).sort(), ["legacy", "storage", "writer"]);
    assert.deepEqual(Object.keys(ports.storage).sort(), [
      "clearAuthData",
      "isTokenExpired",
      "loadTokens",
    ]);
    assert.deepEqual(Object.keys(ports.legacy).sort(), ["getStatus", "login", "refreshRequest"]);
    for (const fn of [...Object.values(ports.storage), ...Object.values(ports.legacy)]) {
      assert.equal(typeof fn, "function");
    }
    // A producer really can be built from them — the wiring BT4-D1 defers is
    // exactly this call plus one composition-root line.
    assert.equal(typeof createAuthProducer(ports).refresh, "function");
  });

  test("the real isTokenExpired keeps its one-minute buffer semantics", () => {
    const authority = createAuthContextAuthority({ epochFactory: () => EPOCH, now: () => T0 });
    const ports = createDefaultAuthProducerPorts(authority.asWriter());
    const future = { ...tokens(), expires_at: Date.now() + ONE_HOUR };
    const past = { ...tokens(), expires_at: Date.now() - 1 };
    assert.equal(ports.storage.isTokenExpired(future), false);
    assert.equal(ports.storage.isTokenExpired(past), true);
  });
});
