// BT5 — the authorized browser-context execution channel and its backend.
//
// Deterministic and offline: a fake CDP connection, synthetic bearers, no
// browser, no network. Every race is an explicit barrier, never a sleep.
//
// Frozen design: CRUNCHYROLL-BT5-CUTOVER-PLAN.md over source C §13/§13A and
// the external ruling authorizing Runtime.enable / executionContextCreated /
// callFunctionOn and nothing else.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBrowserApiBackend,
  CRUNCHYROLL_API_ORIGIN,
} from "../src/transport/browser-api-backend.js";
import { createAuthContextAuthority } from "../src/transport/auth-context.js";
import { CRUNCHYROLL_FETCH_FUNCTION } from "../src/transport/browser-session-manager.js";
import {
  MAX_API_RESPONSE_BYTES,
  type ApiExecutionChannel,
  type ApiExecutionRequest,
} from "../src/transport/browser-lifecycle-types.js";
import { TransportError } from "../src/transport/transport-error.js";
import type { OperationDescriptor, OperationId, ResolvedCall } from "../src/transport/types.js";

const BEARER_SENTINEL = "SYNTHETIC-BEARER-BT5-MUST-NOT-LEAK";
const ACCOUNT_SENTINEL = "SENSITIVE-ACCOUNT-SENTINEL-bt5";

const GET_CATEGORIES: OperationDescriptor = Object.freeze({
  id: "GET_CATEGORIES" as OperationId,
  method: "GET" as const,
  pathTemplate: "/content/v2/discover/categories?locale=en-US",
  callerParams: Object.freeze({}),
  authDerivedParams: Object.freeze({}),
  // BT5-FIX1/FIX2: PUBLIC + BEARER with zero auth-derived params — the
  // endpoint addresses nobody's account and still requires a live AuthContext.
  // The registry now refuses any descriptor whose scope and identity disagree.
  fixedQuery: {},
  queryParams: {},
  scope: "PUBLIC" as const,
  auth: "BEARER" as const,
  mutation: false as const,
});

const CALL: ResolvedCall = Object.freeze({
  descriptor: GET_CATEGORIES,
  callerParams: Object.freeze({}),
});

/**
 * The REAL BT3 authority behind the REAL reader port. BT5 does not mock the
 * boundary it is being judged on: the snapshot, the secret registration and
 * the final generation commit check are BT3's own code here.
 */
function authority(installed = true) {
  const auth = createAuthContextAuthority();
  if (installed) {
    const writer = auth.asWriter();
    writer.commitAuthenticatedMaterial(writer.currentRevision(), "ESTABLISH", {
      accessToken: BEARER_SENTINEL,
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
      accountId: ACCOUNT_SENTINEL,
    });
  }
  return auth;
}

interface ChannelFake {
  channel: ApiExecutionChannel;
  requests: ApiExecutionRequest[];
  opens: number;
  closes: number;
}

function channelFake(
  respond: (input: ApiExecutionRequest) => Promise<unknown> = async () => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [{ id: "action", localization: { title: "Action" } }] }),
    truncated: false,
  }),
  generation = 11
): ChannelFake {
  const state = { opens: 0, closes: 0 };
  const requests: ApiExecutionRequest[] = [];
  const channel: ApiExecutionChannel = {
    connectionGeneration: generation,
    async request(input) {
      requests.push(input);
      return (await respond(input)) as never;
    },
    async close() {
      state.closes += 1;
    },
  };
  return {
    channel,
    requests,
    get opens() {
      return state.opens;
    },
    get closes() {
      return state.closes;
    },
  };
}

function backend(
  fake: ChannelFake,
  auth = authority(),
  overrides: { deadlineMs?: number } = {}
) {
  return createBrowserApiBackend({
    openChannel: async () => fake.channel,
    reader: auth.asReader(),
    deadlineMs: overrides.deadlineMs ?? 15_000,
  });
}

// ── The channel's shape: no generic execution surface ───────────────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANAGER_SOURCE = readFileSync(
  join(REPO_ROOT, "src/transport/browser-session-manager.ts"),
  "utf-8"
);
const BACKEND_SOURCE = readFileSync(
  join(REPO_ROOT, "src/transport/browser-api-backend.ts"),
  "utf-8"
);

describe("BT5 channel — A/B/C/D: no function source, no caller script", () => {
  test("A: no API anywhere accepts a function declaration from its caller", () => {
    // The channel's request record is closed and carries no code-bearing field;
    // the backend never mentions a declaration at all — only the manager does,
    // and only as the frozen constant.
    const types = readFileSync(
      join(REPO_ROOT, "src/transport/browser-lifecycle-types.ts"),
      "utf-8"
    );
    const shape = types.slice(types.indexOf("interface ApiExecutionRequest"));
    for (const forbidden of ["functionDeclaration", "expression", "script", "code", "eval"]) {
      // Word-boundary, not substring: "descriptor" contains "script".
      const pattern = new RegExp(`\\b${forbidden}\\b`);
      assert.equal(
        pattern.test(shape.slice(0, shape.indexOf("}"))),
        false,
        `the request record must not carry ${forbidden}`
      );
      assert.equal(
        pattern.test(BACKEND_SOURCE),
        false,
        `the backend must not reference ${forbidden}`
      );
    }
    assert.equal(BACKEND_SOURCE.includes("new Function"), false);
  });

  test("B: the caller cannot supply url, headers, bearer or method", async () => {
    const fake = channelFake();
    const b = backend(fake);
    await b.executeResolved(CALL);
    const sent = fake.requests[0];
    // Everything on the wire is derived: origin+descriptor for the URL, the
    // descriptor for the method, the auth snapshot for the header.
    assert.equal(sent.url, `${CRUNCHYROLL_API_ORIGIN}${GET_CATEGORIES.pathTemplate}`);
    assert.equal(sent.method, "GET");
    assert.equal(sent.authorization, `Bearer ${BEARER_SENTINEL}`);
    assert.deepEqual(Object.keys(sent).sort(), [
      "authorization",
      "deadlineMs",
      "maxBytes",
      "method",
      "url",
    ]);
  });

  test("C: the function declaration is a frozen constant, not assembled", () => {
    assert.equal(typeof CRUNCHYROLL_FETCH_FUNCTION, "string");
    // It is a literal in the source: no template placeholder, no concatenation.
    assert.equal(CRUNCHYROLL_FETCH_FUNCTION.includes("${"), false, "no interpolation");
    assert.equal(/\+\s*(url|method|authorization|bearer)/.test(CRUNCHYROLL_FETCH_FUNCTION), false);
    // Exactly the authorized request shape.
    assert.match(CRUNCHYROLL_FETCH_FUNCTION, /credentials:\s*"omit"/);
    assert.match(CRUNCHYROLL_FETCH_FUNCTION, /redirect:\s*"manual"/);
    assert.match(CRUNCHYROLL_FETCH_FUNCTION, /Authorization/);
    // The manager must send THIS constant and never a computed string.
    assert.match(
      MANAGER_SOURCE,
      /functionDeclaration:\s*CRUNCHYROLL_FETCH_FUNCTION/,
      "the constant itself must be handed to CDP"
    );
  });

  test("D: the bearer travels as a structured argument, never in the function source", () => {
    assert.equal(CRUNCHYROLL_FETCH_FUNCTION.includes("Bearer "), false, "no literal bearer");
    assert.equal(CRUNCHYROLL_FETCH_FUNCTION.includes(BEARER_SENTINEL), false);
    // The function receives its inputs as parameters.
    assert.match(CRUNCHYROLL_FETCH_FUNCTION, /^\s*async function\s*\(\s*url\s*,\s*method\s*,/);
  });

  test("only the three authorized Runtime methods appear in production", () => {
    const runtimeCalls = [...MANAGER_SOURCE.matchAll(/"Runtime\.[A-Za-z]+"/g)].map((m) => m[0]);
    assert.deepEqual(
      [...new Set(runtimeCalls)].sort(),
      // Player control added two READ-ONLY context lifecycle events, so a
      // destroyed frame is never targeted. No new command was added.
      [
        '"Runtime.callFunctionOn"',
        '"Runtime.enable"',
        '"Runtime.executionContextCreated"',
        '"Runtime.executionContextDestroyed"',
        '"Runtime.executionContextsCleared"',
      ]
    );
    assert.equal(MANAGER_SOURCE.includes("Runtime.evaluate"), false, "evaluate is forbidden");
    // Every page function is one of the two frozen constants; none is assembled.
    const declarations = [...MANAGER_SOURCE.matchAll(/functionDeclaration:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    assert.deepEqual(
      [...new Set(declarations)].sort(),
      ["CRUNCHYROLL_FETCH_FUNCTION", "CRUNCHYROLL_PLAYER_FUNCTION"]
    );
  });
});

// ── The backend: auth, bounding, generation ─────────────────────────────────

describe("BT5 backend — auth snapshot and the final commit check", () => {
  test("without a usable AuthContext nothing is requested", async () => {
    const fake = channelFake();
    const b = backend(fake, authority(false));

    await assert.rejects(
      b.executeResolved(CALL),
      (e: unknown) => e instanceof TransportError && e.kind === "AUTH_NOT_READY"
    );
    assert.equal(fake.requests.length, 0, "no request may be attempted");
  });

  test("K: a generation change between request and commit discards the response", async () => {
    const auth = authority();
    const fake = channelFake(async () => {
      // The user logs out while the response is in flight. The material this
      // request was made with is no longer the live session.
      auth.invalidate("LOGOUT");
      return {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
        truncated: false,
      };
    });
    const b = createBrowserApiBackend({
      openChannel: async () => fake.channel,
      reader: auth.asReader(),
      deadlineMs: 15_000,
    });

    await assert.rejects(
      b.executeResolved(CALL),
      (e: unknown) => e instanceof TransportError && e.kind === "AUTH_GENERATION_CHANGED"
    );
  });

  test("an unchanged generation releases a normalized TransportResult", async () => {
    const fake = channelFake();
    const result = await backend(fake).executeResolved(CALL);

    assert.deepEqual(Object.keys(result).sort(), ["contentType", "json", "status"]);
    assert.equal(result.status, 200);
    assert.equal(result.contentType, "application/json");
    assert.deepEqual(result.json, { data: [{ id: "action", localization: { title: "Action" } }] });
  });

  test("the request carries the bearer of the installed record", async () => {
    const fake = channelFake();
    await backend(fake).executeResolved(CALL);
    assert.equal(fake.requests[0].authorization, `Bearer ${BEARER_SENTINEL}`);
  });
});

describe("BT5 backend — H/I/J: bounded, typed, secret-free", () => {
  test("J: an over-cap body never crosses the boundary", async () => {
    const oversized = "x".repeat(MAX_API_RESPONSE_BYTES + 10);
    const fake = channelFake(async () => ({
      status: 200,
      contentType: "application/json",
      body: oversized,
      truncated: true,
    }));

    await assert.rejects(
      backend(fake).executeResolved(CALL),
      (e: unknown) => e instanceof TransportError && e.kind === "INVALID_RESPONSE"
    );
  });

  test("a non-JSON challenge body is INVALID_RESPONSE, and its content never escapes", async () => {
    const fake = channelFake(async () => ({
      status: 403,
      contentType: "text/html",
      body: `<html>cf-mitigated ${ACCOUNT_SENTINEL}</html>`,
      truncated: false,
    }));

    await assert.rejects(backend(fake).executeResolved(CALL), (error: unknown) => {
      const rendered = `${(error as Error).message} ${JSON.stringify(error)}`;
      assert.equal(rendered.includes(ACCOUNT_SENTINEL), false, "provider body leaked");
      assert.equal(rendered.includes("<html>"), false, "raw body leaked");
      return error instanceof TransportError;
    });
  });

  test("upstream status codes become typed transport errors, not bodies", async () => {
    for (const [status, kind] of [
      [401, "API_UNAUTHORIZED"],
      [403, "API_FORBIDDEN"],
      [404, "API_NOT_FOUND"],
      [429, "API_RATE_LIMITED"],
      [503, "API_SERVER_ERROR"],
    ] as const) {
      const fake = channelFake(async () => ({
        status,
        contentType: "application/json",
        body: JSON.stringify({ secret: ACCOUNT_SENTINEL }),
        truncated: false,
      }));
      await assert.rejects(backend(fake).executeResolved(CALL), (error: unknown) => {
        assert.equal(JSON.stringify(error).includes(ACCOUNT_SENTINEL), false);
        return error instanceof TransportError && error.kind === kind;
      });
    }
  });

  test("H: a page exception is normalized without carrying its text", async () => {
    const fake = channelFake(async () => {
      throw new TransportError("TRANSPORT_FAILURE", "execution");
    });

    await assert.rejects(backend(fake).executeResolved(CALL), (error: unknown) => {
      assert.equal(String((error as Error).message).includes(BEARER_SENTINEL), false);
      return error instanceof TransportError;
    });
  });

  test("I: the deadline is bounded and passed to the channel", async () => {
    const fake = channelFake();
    await backend(fake, authority(), { deadlineMs: 4_000 }).executeResolved(CALL);
    assert.equal(fake.requests[0].deadlineMs, 4_000);
    assert.equal(fake.requests[0].maxBytes, MAX_API_RESPONSE_BYTES);
  });

  test("no reachable failure renders the bearer", async () => {
    const rendered: string[] = [];
    for (const respond of [
      async () => ({ status: 500, contentType: "application/json", body: "{}", truncated: false }),
      async () => ({ status: 200, contentType: "text/html", body: "<html/>", truncated: false }),
      async () => {
        throw new TransportError("TRANSPORT_FAILURE", "execution");
      },
    ]) {
      const fake = channelFake(respond as never);
      try {
        await backend(fake).executeResolved(CALL);
      } catch (error) {
        rendered.push(`${(error as Error).message}|${JSON.stringify(error)}`);
      }
    }
    const everything = rendered.join("\n");
    assert.equal(everything.includes(BEARER_SENTINEL), false);
    assert.equal(everything.includes("Bearer "), false);
  });
});

describe("BT5 backend — L: a transport failure never becomes a Node request", () => {
  test("channel acquisition failure fails closed with no second path", async () => {
    let nodeFetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      nodeFetches += 1;
      return originalFetch(...(args as Parameters<typeof fetch>));
    }) as typeof fetch;
    try {
      const b = createBrowserApiBackend({
        openChannel: async () => {
          throw new TransportError("BROWSER_UNAVAILABLE");
        },
        reader: authority().asReader(),
        deadlineMs: 15_000,
      });

      await assert.rejects(
        b.executeResolved(CALL),
        (e: unknown) => e instanceof TransportError && e.kind === "BROWSER_UNAVAILABLE"
      );
      assert.equal(nodeFetches, 0, "a browser failure must not fall back to Node");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the backend performs no I/O of its own and knows one origin only", () => {
    const code = BACKEND_SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const forbidden of ["fetch(", "node:http", "node:net", "axios", '"./api.js"', "../api.js"]) {
      assert.equal(code.includes(forbidden), false, `the backend must not reference ${forbidden}`);
    }
    // It DOES hold the frozen origin — that is the point — and exactly one.
    // Scanned on RAW source: comment stripping would swallow a URL literal at
    // its own "//" and make this pass vacuously.
    const urls = [...BACKEND_SOURCE.matchAll(/"https?:\/\/[^"]*"/g)].map((m) => m[0]);
    assert.deepEqual(urls, ['"https://www.crunchyroll.com"']);
  });
});
