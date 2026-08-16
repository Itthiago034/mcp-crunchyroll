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
import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import {
  createAuthProducer,
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
function recordingWriter(authority: ReturnType<typeof createAuthContextAuthority>) {
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

function storageFake(initial: TokenLike | null = null): StorageFake {
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
  const writer = recordingWriter(authority);
  const storage = storageFake(initialTokens);
  const legacy = legacyFake();
  const producer = createAuthProducer({
    writer: writer.port,
    storage: storage.port,
    legacy: legacy.port,
  });
  return { authority, writer, storage, legacy, producer };
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
