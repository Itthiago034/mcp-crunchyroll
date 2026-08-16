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
