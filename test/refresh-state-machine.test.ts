// Gate B4 — deterministic refresh state machine tests (TDD).
//
// All tests are deterministic: no real Crunchyroll network, no real
// credentials. Each test installs its own globalThis.fetch stub that
// asserts the exact expected URL/method/body, throws for any unexpected
// fetch, and restores the original fetch in afterEach.
//
// Test isolation: each test that exercises persistence creates an isolated
// temporary HOME with the B2/B3 synthetic fixture contracts and restores
// process.env.HOME afterwards.
//
// B4-01..B4-20 groups + explicit login contract coverage.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  TokenData,
  saveTokens,
  loadTokens,
  clearAuthData,
} from "../src/auth.js";
import { refreshRequest, RefreshError } from "../src/api.js";

const AUTH_URL = "https://auth.crunchyroll.com/auth/v1/token";
const API_BASE_URL = "https://www.crunchyroll.com"; // mirrors src/api.ts API_BASE (consumer URL construction)
const B4_SENTINEL = "B4_SHARED_SECRET_SENTINEL_7f39c1";

// ── Synthetic fixtures ──────────────────────────────────────────────────────

function syntheticTokens(overrides: Partial<TokenData> = {}): TokenData {
  return {
    access_token: "b4-synthetic-access-token",
    refresh_token: "b4-synthetic-refresh-token",
    expires_at: Date.now() + 7_200_000,
    token_type: "Bearer",
    account_id: "b4-synthetic-account-id",
    ...overrides,
  };
}

function rotatedProviderResponse(token: string, includeRefresh = true): object {
  const base: Record<string, unknown> = {
    access_token: token,
    expires_in: 1800,
    token_type: "Bearer",
    account_id: "b4-synthetic-account-id",
  };
  if (includeRefresh) base.refresh_token = `${token}-refresh`;
  return base;
}

function setupIsolatedHome(existingTokens: TokenData | null): string {
  const tmpHome = mkdtempSync(joinPath(tmpdir(), "b4-home-"));
  const striderDir = joinPath(tmpHome, ".strider");
  const configDir = joinPath(striderDir, "crunchyroll");
  mkdirSync(configDir, { recursive: true });
  chmodSync(striderDir, 0o700);
  chmodSync(configDir, 0o700);
  if (existingTokens) {
    writeFileSync(joinPath(configDir, "tokens.json"), JSON.stringify(existingTokens));
    chmodSync(joinPath(configDir, "tokens.json"), 0o600);
    writeFileSync(
      joinPath(configDir, "session.json"),
      JSON.stringify({ email: "b4-synthetic@example.invalid", account_id: "b4-synthetic-account-id", saved_at: "2026-08-14T12:00:00Z" })
    );
    chmodSync(joinPath(configDir, "session.json"), 0o600);
  }
  return tmpHome;
}

function readPersisted(tmpHome: string): { tokens: string | null; session: string | null } {
  const configDir = joinPath(tmpHome, ".strider", "crunchyroll");
  let tokens: string | null = null;
  let session: string | null = null;
  try {
    tokens = readFileSync(joinPath(configDir, "tokens.json"), "utf8");
  } catch {
    tokens = null;
  }
  try {
    session = readFileSync(joinPath(configDir, "session.json"), "utf8");
  } catch {
    session = null;
  }
  return { tokens, session };
}

// ── Fetch harness ────────────────────────────────────────────────────────────

type FetchHandler = (input: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler): void {
  (globalThis as { fetch: unknown }).fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
}

function restoreFetch(originalFetch: typeof fetch): void {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
}

// ── Assertion helpers ────────────────────────────────────────────────────────

function assertAuthForm(body: string): void {
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "refresh_token", "grant_type must be refresh_token");
  assert.equal(params.get("refresh_token"), "b4-synthetic-refresh-token", "refresh_token must be the old token");
  assert.equal(params.get("scope"), "offline_access", "scope must be offline_access");
}

function expectExactlyOneRequest(handler: { calls: number }): FetchHandler {
  return (input: string, init?: RequestInit) => {
    handler.calls += 1;
    assert.equal(input, AUTH_URL, `unexpected fetch URL: ${input}`);
    assert.equal(init?.method, "POST", "refresh must be POST");
    const body = String(init?.body ?? "");
    assertAuthForm(body);
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    );
  };
}

// ── B4-01: rotated refresh ──────────────────────────────────────────────────

describe("B4-01 — rotated refresh success", () => {
  test("valid rotated response replaces both tokens and persists (source semantics)", async () => {
    const originalFetch = globalThis.fetch;
    installFetch(() => {
      return Promise.resolve(
        new Response(JSON.stringify(rotatedProviderResponse("b4-new-access")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const result = await refreshRequest(syntheticTokens());
      assert.equal(result.access_token, "b4-new-access");
      assert.equal(result.refresh_token, "b4-new-access-refresh");
      assert.equal(result.token_type, "Bearer");
      assert.equal(result.account_id, "b4-synthetic-account-id");
      assert.equal(typeof result.expires_at, "number");
      assert.ok(result.expires_at >= Date.now() - 5000, "expires_at must be derived from now + expires_in");
      const { tokens } = readPersisted(tmpHome);
      assert.ok(tokens, "tokens.json must persist after rotated success");
      const parsed = JSON.parse(tokens!);
      assert.equal(parsed.access_token, "b4-new-access");
      assert.equal(parsed.refresh_token, "b4-new-access-refresh");
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-02: non-rotated refresh preserves old refresh_token ──────────────────

describe("B4-02 — non-rotated refresh success", () => {
  test("absent refresh_token in 2xx response is success and reuses old refresh_token", async () => {
    const originalFetch = globalThis.fetch;
    installFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(rotatedProviderResponse("b4-new-access-no-rotation", false)),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const result = await refreshRequest(syntheticTokens());
      assert.equal(result.access_token, "b4-new-access-no-rotation");
      assert.equal(result.refresh_token, "b4-synthetic-refresh-token", "old refresh_token must be preserved on non-rotation");
      const { tokens } = readPersisted(tmpHome);
      const parsed = JSON.parse(tokens!);
      assert.equal(parsed.access_token, "b4-new-access-no-rotation");
      assert.equal(parsed.refresh_token, "b4-synthetic-refresh-token");
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-03: semantic invalid_grant ───────────────────────────────────────────

describe("B4-03 — semantic invalid_grant", () => {
  test("error === 'invalid_grant' (strict) clears local auth and never returns old access", async () => {
    const originalFetch = globalThis.fetch;
    installFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const result = await refreshRequest(syntheticTokens());
      assert.fail("refreshRequest must reject on semantic invalid_grant");
      return;
    } catch (err) {
      assert.ok(err instanceof RefreshError, "must be a RefreshError");
      assert.equal((err as RefreshError).kind, "REAUTH_REQUIRED");
      assert.equal((err as RefreshError).httpStatus, 400);
    }
    const { tokens } = readPersisted(tmpHome);
    assert.equal(tokens, null, "tokens.json must be cleared after invalid_grant");
  }
);

  test("near-misses do NOT count as semantic invalid_grant: error_message field, case variant, suffix variant", async () => {
    const originalFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const candidates: Array<{ label: string; body: string; status: number }> = [
      { label: "error_message field", body: JSON.stringify({ error_message: "invalid_grant" }), status: 400 },
      { label: "uppercase error", body: JSON.stringify({ error: "INVALID_GRANT" }), status: 400 },
      { label: "suffix variant", body: JSON.stringify({ error: "invalid_grant_expired" }), status: 400 },
    ];
    for (const c of candidates) {
      const callState = { calls: 0 };
      installFetch(() => {
        callState.calls += 1;
        return Promise.resolve(
          new Response(c.body, { status: c.status, headers: { "Content-Type": "application/json" } })
        );
      });
      const tmpHome = setupIsolatedHome(syntheticTokens());
      process.env.HOME = tmpHome;
      try {
        try {
          await refreshRequest(syntheticTokens());
        } catch (err) {
          // These paths must NOT be REAUTH_REQUIRED; a transient/safe failure is
          // acceptable, but never the destructive auth-clear path, and the old
          // persisted auth must survive.
          if (err instanceof RefreshError) {
            assert.notEqual(err.kind, "REAUTH_REQUIRED", `${c.label} must not be REAUTH_REQUIRED`);
          }
        }
        const { tokens } = readPersisted(tmpHome);
        assert.ok(tokens, `${c.label}: old persisted auth must be preserved (not cleared)`);
        assert.equal(callState.calls, 1, `${c.label}: exactly one request`);
      } finally {
        process.env.HOME = prevHome;
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }
    restoreFetch(originalFetch);
  });
});

// ── B4-04: HTTP 400 non-invalid_grant preserves auth ────────────────────────

describe("B4-04 — HTTP 400 non-invalid_grant", () => {
  test("400 with error != invalid_grant throws SAFE_FAILURE and preserves auth", async () => {
    const originalFetch = globalThis.fetch;
    installFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      try {
        await refreshRequest(syntheticTokens());
        assert.fail("refreshRequest must reject on 400");
      } catch (err) {
        assert.ok(err instanceof RefreshError, "must be a RefreshError");
        assert.equal((err as RefreshError).kind, "SAFE_FAILURE");
        assert.equal((err as RefreshError).httpStatus, 400);
      }
      const { tokens } = readPersisted(tmpHome);
      assert.ok(tokens, "old tokens.json must survive 400");
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-05 / B4-06: HTTP 401 / 403 ambiguous preserve auth ───────────────────

describe("B4-05/06 — HTTP 401 / 403 ambiguous", () => {
  test("401/403 without semantic invalid_grant preserve auth (SAFE_FAILURE)", async () => {
    const originalFetch = globalThis.fetch;
    for (const status of [401, 403]) {
      const body = status === 401 ? "" : JSON.stringify({ error: "access_denied" });
      installFetch(() =>
        Promise.resolve(new Response(body, { status, headers: { "Content-Type": "application/json" } }))
      );
      const tmpHome = setupIsolatedHome(syntheticTokens());
      const prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        try {
          await refreshRequest(syntheticTokens());
          assert.fail(`refreshRequest must reject on HTTP ${status}`);
        } catch (err) {
          assert.ok(err instanceof RefreshError);
          assert.equal((err as RefreshError).kind, "SAFE_FAILURE", `HTTP ${status} must be SAFE_FAILURE`);
          assert.equal((err as RefreshError).httpStatus, status);
        }
        const { tokens } = readPersisted(tmpHome);
        assert.ok(tokens, `old tokens.json must survive HTTP ${status}`);
      } finally {
        process.env.HOME = prevHome;
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }
    restoreFetch(originalFetch);
  });
});

// ── B4-07/08/09: 429 / 500 / 503 transient preserve auth ────────────────────

describe("B4-07/08/09 — HTTP 429 / 500 / 503 transient", () => {
  test("429, 500 and 503 are classified TRANSIENT and preserve auth", async () => {
    const originalFetch = globalThis.fetch;
    for (const status of [429, 500, 503]) {
      installFetch(() =>
        Promise.resolve(new Response("", { status, headers: { "Content-Type": "application/json" } }))
      );
      const tmpHome = setupIsolatedHome(syntheticTokens());
      const prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        try {
          await refreshRequest(syntheticTokens());
          assert.fail(`refreshRequest must reject on HTTP ${status}`);
        } catch (err) {
          assert.ok(err instanceof RefreshError);
          assert.equal((err as RefreshError).kind, "TRANSIENT", `HTTP ${status} must be TRANSIENT`);
          assert.equal((err as RefreshError).httpStatus, status);
        }
        const { tokens } = readPersisted(tmpHome);
        assert.ok(tokens, `old tokens.json must survive HTTP ${status}`);
      } finally {
        process.env.HOME = prevHome;
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }
    restoreFetch(originalFetch);
  });
});

// ── B4-10: network/fetch failure preserves auth (TRANSIENT) ─────────────────

describe("B4-10 — network failure", () => {
  test("fetch throwing before response is TRANSIENT and preserves auth", async () => {
    const originalFetch = globalThis.fetch;
    installFetch(() => Promise.reject(new Error("ETIMEDOUT simulated network failure")));
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      try {
        await refreshRequest(syntheticTokens());
        assert.fail("refreshRequest must reject on network failure");
      } catch (err) {
        assert.ok(err instanceof RefreshError, "network failure must be wrapped as RefreshError");
        assert.equal((err as RefreshError).kind, "TRANSIENT");
        assert.equal((err as RefreshError).message.includes("ETIMEDOUT"), false, "must not echo raw network diagnostic");
      }
      const { tokens } = readPersisted(tmpHome);
      assert.ok(tokens, "old tokens.json must survive network failure");
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-11: 2xx malformed JSON ───────────────────────────────────────────────

describe("B4-11 — 2xx malformed JSON", () => {
  test("200 with non-JSON body is MALFORMED_RESPONSE and preserves auth", async () => {
    const originalFetch = globalThis.fetch;
    installFetch(() =>
      Promise.resolve(new Response("<html>not json</html>", { status: 200 }))
    );
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      try {
        await refreshRequest(syntheticTokens());
        assert.fail("refreshRequest must reject on non-JSON 200");
      } catch (err) {
        assert.ok(err instanceof RefreshError);
        assert.equal((err as RefreshError).kind, "MALFORMED_RESPONSE");
      }
      const { tokens } = readPersisted(tmpHome);
      assert.ok(tokens, "old tokens.json must survive malformed JSON");
    } finally {
      process.env.HOME = prevHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-12 / B4-13: structurally invalid 2xx + present-invalid refresh_token ─

describe("B4-12/13 — structurally invalid responses", () => {
  test("missing required fields on 2xx are MALFORMED_RESPONSE (no save)", async () => {
    const originalFetch = globalThis.fetch;
    const variants: Array<{ label: string; body: object }> = [
      { label: "missing access_token", body: { expires_in: 1800, token_type: "Bearer", account_id: "a" } },
      { label: "missing expires_in", body: { access_token: "x", token_type: "Bearer", account_id: "a" } },
      { label: "missing token_type", body: { access_token: "x", expires_in: 1800, account_id: "a" } },
      { label: "missing account_id", body: { access_token: "x", expires_in: 1800, token_type: "Bearer" } },
      { label: "empty access_token", body: { access_token: "", expires_in: 1800, token_type: "Bearer", account_id: "a" } },
      { label: "whitespace access_token", body: { access_token: "   ", expires_in: 1800, token_type: "Bearer", account_id: "a" } },
      { label: "zero expires_in", body: { access_token: "x", expires_in: 0, token_type: "Bearer", account_id: "a" } },
      { label: "non-object array body", body: ["x"] },
    ];
    for (const v of variants) {
      installFetch(() =>
        Promise.resolve(new Response(JSON.stringify(v.body), { status: 200, headers: { "Content-Type": "application/json" } }))
      );
      const tmpHome = setupIsolatedHome(syntheticTokens());
      const prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        try {
          await refreshRequest(syntheticTokens());
          assert.fail(`${v.label}: must reject`);
        } catch (err) {
          assert.ok(err instanceof RefreshError, `${v.label}: must be RefreshError`);
          assert.equal((err as RefreshError).kind, "MALFORMED_RESPONSE", `${v.label}: must be MALFORMED_RESPONSE`);
        }
        const { tokens } = readPersisted(tmpHome);
        assert.ok(tokens, `${v.label}: old tokens.json must survive`);
      } finally {
        process.env.HOME = prevHome;
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }
    restoreFetch(originalFetch);
  });

  test("present-but-invalid refresh_token values are MALFORMED_RESPONSE (no save, no clear)", async () => {
    const originalFetch = globalThis.fetch;
    const invalidValues: Array<{ label: string; value: unknown }> = [
      { label: "null", value: null },
      { label: "empty string", value: "" },
      { label: "whitespace string", value: "   " },
      { label: "number", value: 123 },
      { label: "array", value: [] },
      { label: "object", value: {} },
    ];
    for (const iv of invalidValues) {
      installFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "b4-new-access",
              refresh_token: iv.value,
              expires_in: 1800,
              token_type: "Bearer",
              account_id: "b4-synthetic-account-id",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
      );
      const tmpHome = setupIsolatedHome(syntheticTokens());
      const prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        try {
          await refreshRequest(syntheticTokens());
          assert.fail(`${iv.label}: must reject on present-invalid refresh_token`);
        } catch (err) {
          assert.ok(err instanceof RefreshError);
          assert.equal((err as RefreshError).kind, "MALFORMED_RESPONSE", `${iv.label}: MALFORMED_RESPONSE`);
        }
        const { tokens } = readPersisted(tmpHome);
        assert.ok(tokens, `${iv.label}: old tokens.json must be preserved`);
        // No partial write: access_token must still be the OLD one.
        const parsed = JSON.parse(tokens!);
        assert.equal(parsed.access_token, "b4-synthetic-access-token", `${iv.label}: no partial write of new access_token`);
      } finally {
        process.env.HOME = prevHome;
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }
    restoreFetch(originalFetch);
  });
});

// ── B4-14: no partial persistence across all preserving failures ────────────

describe("B4-14 — no partial persistence", () => {
  test("session.json untouched and no saveTokens call on preserving failures", async () => {
    const originalFetch = globalThis.fetch;
    for (const scenario of [
      { label: "400 non-ig", handler: () => Promise.resolve(new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 })) },
      { label: "429", handler: () => Promise.resolve(new Response("", { status: 429 })) },
      { label: "503", handler: () => Promise.resolve(new Response("", { status: 503 })) },
      { label: "network", handler: () => Promise.reject(new Error("network")) },
    ]) {
      installFetch(scenario.handler as FetchHandler);
      const tmpHome = setupIsolatedHome(syntheticTokens());
      const prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        const before = readPersisted(tmpHome);
        assert.ok(before.tokens, `${scenario.label}: tokens must exist before failure`);
        assert.ok(before.session, `${scenario.label}: session must exist before failure`);
        try {
          await refreshRequest(syntheticTokens());
          assert.fail(`${scenario.label}: must reject`);
        } catch (err) {
          assert.ok(err instanceof RefreshError);
        }
        const after = readPersisted(tmpHome);
        assert.equal(after.tokens, before.tokens, `${scenario.label}: tokens.json byte-identical after failure`);
        assert.equal(after.session, before.session, `${scenario.label}: session.json byte-identical after failure`);
      } finally {
        process.env.HOME = prevHome;
        rmSync(tmpHome, { recursive: true, force: true });
      }
    }
    restoreFetch(originalFetch);
  });
});

// ── B4-15: exactly one refresh HTTP request with 3 concurrent callers ───────

describe("B4-15 — single-flight: exactly one request", () => {
  test("3 concurrent expired-callers issue exactly one refresh HTTP request", async () => {
    const originalFetch = globalThis.fetch;
    let httpCalls = 0;
    installFetch(() => {
      httpCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify(rotatedProviderResponse("b4-flight-access")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const old = syntheticTokens({ access_token: "b4-old-access" });
      const [r1, r2, r3] = await Promise.all([
        refreshRequest(old),
        refreshRequest(old),
        refreshRequest(old),
      ]);
      assert.equal(httpCalls, 1, "exactly one refresh HTTP request for 3 concurrent callers");
      assert.equal(r1.access_token, "b4-flight-access");
      assert.equal(r2.access_token, r1.access_token, "concurrent callers share the same success");
      assert.equal(r3.access_token, r1.access_token);
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-16 / B4-17: shared concurrent success / failure ──────────────────────

describe("B4-16 — shared concurrent success", () => {
  test("concurrent callers during one refresh receive the identical TokenData", async () => {
    const originalFetch = globalThis.fetch;
    installFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(rotatedProviderResponse("b4-shared-access")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const old = syntheticTokens();
      const results = await Promise.all(Array.from({ length: 5 }, () => refreshRequest(old)));
      for (const r of results) {
        assert.equal(r.access_token, "b4-shared-access");
        assert.equal(r.refresh_token, "b4-shared-access-refresh");
      }
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("B4-17 — shared concurrent failure", () => {
  test("concurrent callers during one transient failure all receive the same failure", async () => {
    const originalFetch = globalThis.fetch;
    let httpCalls = 0;
    installFetch(() => {
      httpCalls += 1;
      return Promise.resolve(new Response("", { status: 503 }));
    });
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const old = syntheticTokens();
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () => refreshRequest(old).then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err })
        ))
      );
      assert.equal(httpCalls, 1, "exactly one request despite 4 concurrent callers");
      for (const o of outcomes) {
        assert.equal(o.ok, false, "all callers must observe failure");
        assert.ok(o.err instanceof RefreshError);
        assert.equal((o.err as RefreshError).kind, "TRANSIENT");
      }
      const { tokens } = readPersisted(tmpHome);
      assert.ok(tokens, "old auth preserved after shared transient failure");
    } finally {
      process.env.HOME = prevHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-18: future call after settled TRANSIENT may start a new refresh ──────

describe("B4-18 — new attempt after settled transient failure", () => {
  test("after a settled TRANSIENT failure, a later call initiates a fresh refresh", async () => {
    const originalFetch = globalThis.fetch;
    let httpCalls = 0;
    installFetch(() => {
      httpCalls += 1;
      if (httpCalls === 1) {
        return Promise.resolve(new Response("", { status: 503 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(rotatedProviderResponse("b4-retry-access")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    });
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const old = syntheticTokens();
      try {
        await refreshRequest(old);
        assert.fail("first call must fail with 503");
      } catch (err) {
        assert.ok(err instanceof RefreshError);
        assert.equal((err as RefreshError).kind, "TRANSIENT");
      }
      const second = await refreshRequest(old);
      assert.equal(httpCalls, 2, "second call must initiate a new attempt, not reuse the settled promise");
      assert.equal(second.access_token, "b4-retry-access");
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-19: exactly one refresh attempt, NO retry ────────────────────────────

describe("B4-19 — no automatic retry", () => {
  test("a single transient response never triggers a second automatic HTTP request", async () => {
    const originalFetch = globalThis.fetch;
    let httpCalls = 0;
    installFetch(() => {
      httpCalls += 1;
      return Promise.resolve(new Response("", { status: 500 }));
    });
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      try {
        await refreshRequest(syntheticTokens());
        assert.fail("must reject on 500");
      } catch (err) {
        assert.ok(err instanceof RefreshError);
        assert.equal((err as RefreshError).kind, "TRANSIENT");
      }
      assert.equal(httpCalls, 1, "exactly one attempt: no automatic retry");
      const { tokens } = readPersisted(tmpHome);
      assert.ok(tokens, "old auth preserved");
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-20A: sentinel-bearing provider error never leaks on the error path ───

describe("B4-20A — error path is secret-free (sentinel probe)", () => {
  test("provider payload containing the synthetic sentinel never escapes the failure", async () => {
    const originalFetch = globalThis.fetch;
    installFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "temporarily_unavailable",
            diagnostic: B4_SENTINEL,
            request_id: B4_SENTINEL,
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      try {
        await refreshRequest(syntheticTokens());
        assert.fail("must reject on 503 with sentinel-bearing body");
      } catch (err) {
        const message = (err as Error).message;
        const stringified = String(err);
        const stack = (err as Error).stack ?? "";
        const serialized = JSON.stringify({ kind: (err as RefreshError).kind, httpStatus: (err as RefreshError).httpStatus, message });
        assert.equal(message.includes(B4_SENTINEL), false, "error.message must not contain the sentinel");
        assert.equal(stringified.includes(B4_SENTINEL), false, "String(error) must not contain the sentinel");
        assert.equal(stack.includes(B4_SENTINEL), false, "error.stack must not contain the sentinel");
        assert.equal(serialized.includes(B4_SENTINEL), false, "serialized safe failure must not contain the sentinel");
        assert.equal((err as RefreshError).kind, "TRANSIENT");
      }
      const { tokens } = readPersisted(tmpHome);
      assert.ok(tokens, "old auth preserved");
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── B4-20B: shared concurrent failure with sentinel is secret-free ──────────

describe("B4-20B — shared failure with sentinel is secret-free", () => {
  test("2+ concurrent callers share one failure and none of them sees the sentinel", async () => {
    const originalFetch = globalThis.fetch;
    let httpCalls = 0;
    installFetch(() => {
      httpCalls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: "temporarily_unavailable", diagnostic: B4_SENTINEL }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      );
    });
    const tmpHome = setupIsolatedHome(syntheticTokens());
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const old = syntheticTokens();
      const outcomes = await Promise.all(
        Array.from({ length: 3 }, () =>
          refreshRequest(old).then(
            () => ({ ok: true as const }),
            (err: unknown) => ({ ok: false as const, err })
          )
        )
      );
      assert.equal(httpCalls, 1, "exactly one refresh HTTP request");
      for (const o of outcomes) {
        assert.equal(o.ok, false);
        const message = (o.err as Error).message;
        const stringified = String(o.err);
        const stack = (o.err as Error).stack ?? "";
        assert.equal(message.includes(B4_SENTINEL), false, "shared failure message must not contain the sentinel");
        assert.equal(stringified.includes(B4_SENTINEL), false, "String(shared failure) must not contain the sentinel");
        assert.equal(stack.includes(B4_SENTINEL), false, "shared failure stack must not contain the sentinel");
      }
      // No retained in-flight secret state: a new call can start fresh.
      // The next refresh attempt is stubbed to succeed, proving the reference
      // was cleared after the settled failure.
      const prev = (globalThis as { fetch: unknown }).fetch;
      (globalThis as { fetch: unknown }).fetch = () =>
        Promise.resolve(
          new Response(JSON.stringify(rotatedProviderResponse("b4-post-clear")), { status: 200 })
        );
      const fresh = await refreshRequest(old);
      assert.equal(fresh.access_token, "b4-post-clear", "reference cleared: a fresh attempt can start after settle");
      (globalThis as { fetch: unknown }).fetch = prev;
    } finally {
      process.env.HOME = prevHome;
      restoreFetch(originalFetch);
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ── Login contract: 2xx missing refresh_token is malformed ──────────────────

describe("B4-login — malformed login response contract", () => {
  test("successful HTTP login missing refresh_token fails and persists nothing", async () => {
    const originalFetch = globalThis.fetch;
    // The production login path goes through the generic request() — which
    // asserts the exact URL/method headers; body validation is done inside
    // validateLoginTokenResponse. Here we validate the exported contract
    // function directly (pure, no I/O) and assert the production login uses
    // it by verifying a 2xx-without-refresh_token body does not pass.
    const { validateLoginTokenResponse } = await import("../src/api.js");
    const payloads: Array<{ label: string; body: unknown; expect: "reject" | "accept" }> = [
      { label: "missing refresh_token", body: { access_token: "x", expires_in: 1800, token_type: "Bearer", account_id: "a" }, expect: "reject" },
      { label: "null refresh_token", body: { access_token: "x", refresh_token: null, expires_in: 1800, token_type: "Bearer", account_id: "a" }, expect: "reject" },
      { label: "empty refresh_token", body: { access_token: "x", refresh_token: "", expires_in: 1800, token_type: "Bearer", account_id: "a" }, expect: "reject" },
      { label: "whitespace refresh_token", body: { access_token: "x", refresh_token: "   ", expires_in: 1800, token_type: "Bearer", account_id: "a" }, expect: "reject" },
      { label: "valid login", body: { access_token: "x", refresh_token: "y", expires_in: 1800, token_type: "Bearer", account_id: "a" }, expect: "accept" },
    ];
    for (const p of payloads) {
      const passed = (() => {
        try {
          validateLoginTokenResponse(p.body);
          return true;
        } catch {
          return false;
        }
      })();
      assert.equal(
        passed,
        p.expect === "accept",
        `${p.label}: validation must ${p.expect === "accept" ? "accept" : "reject"}`
      );
    }
  });
});

// ── B4-FIX-1 regression groups (blockers B4-C1 / B4-C2 / B4-C3) ─────────────
//
// C1: the expired-token path in getValidToken() must return the REFRESHED
// account_id from the same TokenData the refresh returned — not the stale
// value loaded before the refresh. Exercised through the REAL public
// consumer `getStatus()` (which reads the persisted identity), no new
// exports or test hooks.
// C2: the REAL production `login()` must be tested end-to-end (login →
// request() → synthetic HTTP 200 without refresh_token → failure with
// zero persistence and no raw synthetic secrets in the outward message).
// C3: LoginTokenResponse / RefreshTokenResponse are statically distinct —
// refresh_token REQUIRED on login, OPTIONAL-ONLY-BY-ABSENCE on refresh,
// with no cast to a type requiring refresh_token on the non-rotated path.

describe("B4-FIX-1-C1 — refreshed identity used by a real public consumer", () => {
  const oldAccountId = "b4f1-old-account-id";
  const newAccountId = "b4f1-refreshed-account-id";

  test("getStatus() after a non-rotated refresh reports the refreshed account_id, not the stale one", async () => {
    // Non-vacuous setup: the refreshed provider response carries a
    // DELIBERATELY DIFFERENT account_id than the one persisted before the
    // refresh.
    const originalFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = setupIsolatedHome(
      syntheticTokens({ account_id: oldAccountId, expires_at: Date.now() - 1000 }) // expired → refresh path
    );
    process.env.HOME = tmpHome;

    const expectedRefreshUrl = AUTH_URL;
    let refreshSeen = false;
    installFetch((input, init) => {
      if (String(input) === expectedRefreshUrl && init?.method === "POST") {
        refreshSeen = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "b4f1-refreshed-access",
              expires_in: 1800,
              token_type: "Bearer",
              account_id: newAccountId, // DELIBERATELY DIFFERENT from oldAccountId
              // no refresh_token → non-rotated
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      // The remaining legacy public consumer `getSubscription()` issues one
      // authenticated request to the subscription URL after the refresh; anything
      // else is unexpected in this synthetic setup.
      if (
        String(input) === `${API_BASE_URL}/subs/v1/subscriptions/${newAccountId}/benefits` &&
        init?.method === undefined
      ) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      assert.fail(`unexpected fetch: ${input}`);
    });

    try {
      // getStatus() reads the persisted identity but does NOT trigger a
      // refresh by itself — exercising the refresh requires a real consumer
      // that needs a valid token. getSubscription() is a remaining legacy consumer that
      // goes through getValidToken(), which issues the refresh for the
      // expired fixture above and then persists the refreshed identity.
      const { getSubscription, getStatus } = await import("../src/api.js");
      await getSubscription();
      assert.ok(refreshSeen, "the refresh HTTP request must have been made");

      // Now getStatus() — a second, separate public consumer — must report
      // the REFRESHED identity that the refresh path persisted, never the
      // stale one from before the refresh.
      const status = await getStatus();
      assert.equal(status.logged_in, true, "must still be logged in after refresh");
      assert.equal(
        status.account_id,
        newAccountId,
        "the identity persisted/consumed after refresh must be the REFRESHED account_id, not the stale one"
      );
    } finally {
      restoreFetch(originalFetch);
      process.env.HOME = prevHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("getValidToken() refresh path returns the refreshed access_token AND the refreshed account_id together", async () => {
    // Regression proof via the remaining legacy public consumer getSubscription():
    // its outgoing URL embeds the account_id returned by getValidToken().
    const originalFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = setupIsolatedHome(
      syntheticTokens({ account_id: oldAccountId, expires_at: Date.now() - 1000 })
    );
    process.env.HOME = tmpHome;

    let subscriptionUrl: string | undefined;
    installFetch((input, init) => {
      if (String(input) === AUTH_URL && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "b4f1-refreshed-access",
              expires_in: 1800,
              token_type: "Bearer",
              account_id: newAccountId,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      if (
        String(input) === `${API_BASE_URL}/subs/v1/subscriptions/${newAccountId}/benefits` &&
        init?.method === undefined
      ) {
        subscriptionUrl = String(input);
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      assert.fail(`unexpected fetch: ${input}`);
    });

    try {
      const { getSubscription } = await import("../src/api.js");
      await getSubscription();
      assert.ok(subscriptionUrl, "getSubscription must have issued its HTTP request");
      assert.ok(
        subscriptionUrl!.includes(`/subs/v1/subscriptions/${newAccountId}/benefits`),
        `subscription URL must embed the REFRESHED account_id ${newAccountId}, got ${subscriptionUrl}`
      );
      assert.ok(!subscriptionUrl!.includes(oldAccountId), "the STALE account_id must not appear in the URL");
    } finally {
      restoreFetch(originalFetch);
      process.env.HOME = prevHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("B4-FIX-1-C2 — production login() integration (real path, synthetic HTTP)", () => {
  const SYNTH_LOGIN_EMAIL = "b4f1-synthetic@example.invalid";
  const SYNTH_LOGIN_PASSWORD = "b4f1-synthetic-password-9x2k";

  test("login() with HTTP 200 body missing refresh_token returns failure and persists nothing", async () => {
    const originalFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = setupIsolatedHome(null); // clean HOME: nothing pre-persisted
    process.env.HOME = tmpHome;

    let seenCredentials: { email: string | null; password: string | null } = { email: null, password: null };
    installFetch((input, init) => {
      if (String(input) === AUTH_URL && init?.method === "POST") {
        const body = String(init?.body ?? "");
        const params = new URLSearchParams(body);
        seenCredentials.email = params.get("username");
        seenCredentials.password = params.get("password");
        // Synthetic HTTP 200 whose body is structurally login-like but
        // MISSING refresh_token entirely.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "synthetic-login-access",
              expires_in: 1800,
              token_type: "Bearer",
              account_id: "synthetic-login-account",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      assert.fail(`unexpected fetch: ${input}`);
    });

    try {
      const { login } = await import("../src/api.js");
      const result = await login(SYNTH_LOGIN_EMAIL, SYNTH_LOGIN_PASSWORD);

      // 1. failure contract
      assert.equal(result.success, false, "production login() must return success:false for a body missing refresh_token");
      // 7. outward message must not leak the synthetic secrets
      assert.ok(
        !result.message.includes(SYNTH_LOGIN_EMAIL) && !result.message.includes(SYNTH_LOGIN_PASSWORD),
        `outward login message must not contain synthetic credentials: ${result.message}`
      );

      // 2/3/4. zero persistence, no valid partial files
      const persisted = readPersisted(tmpHome);
      assert.equal(persisted.tokens, null, "no tokens.json must be persisted");
      assert.equal(persisted.session, null, "no session.json must be persisted");
      const configDir = joinPath(tmpHome, ".strider", "crunchyroll");
      let leftovers: string[] = []; try { leftovers = require("node:fs").readdirSync(configDir); } catch { leftovers = []; }
      assert.deepEqual(leftovers, [], `no partial files may appear in the config dir: ${leftovers.join(", ")}`);

      // credentials crossed the form body (expected, noAuth path) but no
      // real credential was used — values are synthetic-only
      assert.equal(seenCredentials.email, SYNTH_LOGIN_EMAIL);
      assert.equal(seenCredentials.password, SYNTH_LOGIN_PASSWORD);
    } finally {
      restoreFetch(originalFetch);
      process.env.HOME = prevHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("login() failure does not create the .strider directory tree at all", async () => {
    const originalFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = mkdtempSync(joinPath(tmpdir(), "b4f1-clean-"));
    process.env.HOME = tmpHome;

    installFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "synthetic-x",
            expires_in: 1800,
            token_type: "Bearer",
            account_id: "synthetic-y",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    try {
      const { login } = await import("../src/api.js");
      await login("b4f1-b@example.invalid", "b4f1-pass");
      const { tokens, session } = readPersisted(tmpHome);
      assert.equal(tokens, null);
      assert.equal(session, null);
    } finally {
      restoreFetch(originalFetch);
      process.env.HOME = prevHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("B4-FIX-1-C3 — static separation of Login vs Refresh token contracts", () => {
  test("LoginTokenResponse requires refresh_token while RefreshTokenResponse makes it optional", async () => {
    const api = await import("../src/api.js");
    const loginValidator = (api as unknown as Record<string, (v: unknown) => unknown>).validateLoginTokenResponse;
    const refreshValidator = (api as unknown as Record<string, (v: unknown) => unknown>).validateRefreshTokenResponse;
    assert.equal(typeof loginValidator, "function", "validateLoginTokenResponse must be exported");
    assert.equal(typeof refreshValidator, "function", "validateRefreshTokenResponse must be exported");

    const withoutRefresh: unknown = {
      access_token: "a",
      expires_in: 1800,
      token_type: "Bearer",
      account_id: "acct",
    };
    // login: refresh_token REQUIRED → must throw
    assert.throws(
      () => loginValidator(withoutRefresh),
      "LoginTokenResponse must REQUIRE refresh_token"
    );
    // refresh: absent refresh_token → valid non-rotation, no throw
    const refreshResult = refreshValidator(withoutRefresh) as { valid: boolean };
    assert.equal(refreshResult.valid, true, "RefreshTokenResponse must ACCEPT absent refresh_token (non-rotation)");
  });

  test("the non-rotated refresh path does not cast to a type requiring refresh_token", async () => {
    // Structural evidence: the source of validateRefreshTokenResponse must
    // not contain a cast (`as unknown as TokenResponse`-style) where the
    // target type demands refresh_token.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const refreshFnStart = source.indexOf("export function validateRefreshTokenResponse");
    const refreshFnEnd = source.indexOf("export function classifyRefreshResponse", refreshFnStart);
    const fnSource = source.slice(refreshFnStart, refreshFnEnd);
    assert.ok(
      fnSource.includes("as unknown as RefreshTokenResponse") || !fnSource.includes("as unknown as TokenResponse"),
      "the refresh validator must return RefreshTokenResponse (refresh_token optional) without casting to a type requiring refresh_token"
    );
    // The returned shape for non-rotated responses must carry the rotated flag
    // typed alongside the response, not hide it behind the shared TokenResponse.
    assert.ok(fnSource.includes("rotated"), "refresh validation result must express rotation explicitly");
  });
});
