// BT4 completion — bounded browser auth observation.
//
// Deterministic and offline: no browser, no CDP socket, no network, no real
// credentials. A fake interception channel plays back exactly the paused
// responses each test dictates, and every timer is a controllable seam.
//
// Frozen design: CRUNCHYROLL-BT4-COMPLETION-ERRATA.md §9.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createBrowserAuthObserver,
  CRUNCHYROLL_TOKEN_ENDPOINT,
  CRUNCHYROLL_LOGIN_URL,
  MAX_AUTH_RESPONSE_BYTES,
  type BrowserAuthPorts,
} from "../src/transport/browser-auth.js";
import type { PausedResponse, ResponseInterception } from "../src/transport/browser-lifecycle-types.js";

const ACCESS_SENTINEL = "SYNTHETIC-BROWSER-ACCESS-TOKEN";
const REFRESH_SENTINEL = "SYNTHETIC-BROWSER-REFRESH-TOKEN-MUST-NOT-PROPAGATE";
const ACCOUNT_SENTINEL = "SENSITIVE-ACCOUNT-SENTINEL-browser-1";
const PROFILE_SENTINEL = "SENSITIVE-PROFILE-SENTINEL-browser-1";
const COOKIE_SENTINEL = "etp_rt=MUST-NOT-PROPAGATE";
const T0 = 5_000_000;

function tokenPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: ACCESS_SENTINEL,
    refresh_token: REFRESH_SENTINEL,
    expires_in: 3600,
    token_type: "Bearer",
    account_id: ACCOUNT_SENTINEL,
    ...overrides,
  });
}

interface FakeChannel {
  interception: ResponseInterception;
  emit(event: Partial<PausedResponse> & { requestId?: string }): void;
  bodies: Map<string, { body: string; base64Encoded: boolean }>;
  continued: string[];
  closed: boolean;
  pattern: string | undefined;
}

function fakeChannel(generation = 7): FakeChannel {
  const listeners = new Set<(event: PausedResponse) => void>();
  const state: FakeChannel = {
    bodies: new Map(),
    continued: [],
    closed: false,
    pattern: undefined,
    emit(event) {
      const paused: PausedResponse = Object.freeze({
        requestId: event.requestId ?? "req-1",
        url: event.url ?? CRUNCHYROLL_TOKEN_ENDPOINT,
        responseStatusCode: event.responseStatusCode ?? 200,
      });
      for (const listener of [...listeners]) listener(paused);
    },
    interception: {
      connectionGeneration: generation,
      onPaused(listener) {
        listeners.add(listener);
      },
      async getResponseBody(requestId) {
        const body = state.bodies.get(requestId);
        if (!body) throw new Error("no body for this request");
        return body;
      },
      async continueResponse(requestId) {
        state.continued.push(requestId);
      },
      async close() {
        state.closed = true;
        listeners.clear();
      },
    },
  };
  return state;
}

interface Harness {
  ports: BrowserAuthPorts;
  channel: FakeChannel;
  fireTimers(): void;
  openCalls: string[];
}

function harness(channel = fakeChannel()): Harness {
  const timers: Array<() => void> = [];
  const openCalls: string[] = [];
  return {
    channel,
    openCalls,
    fireTimers() {
      const pending = timers.splice(0, timers.length);
      for (const fire of pending) fire();
    },
    ports: {
      openInterception: async (pattern: string) => {
        openCalls.push(pattern);
        channel.pattern = pattern;
        return channel.interception;
      },
      now: () => T0,
      schedule: (callback: () => void) => {
        timers.push(callback);
        return { cancel: () => void 0 };
      },
    },
  };
}

describe("BT4 browser auth — the observed endpoint is pinned", () => {
  test("the fixed constants are HTTPS Crunchyroll origins and never configurable", () => {
    assert.equal(CRUNCHYROLL_LOGIN_URL, "https://www.crunchyroll.com/login");
    assert.equal(CRUNCHYROLL_TOKEN_ENDPOINT, "https://www.crunchyroll.com/auth/v1/token");
    for (const url of [CRUNCHYROLL_LOGIN_URL, CRUNCHYROLL_TOKEN_ENDPOINT]) {
      const parsed = new URL(url);
      assert.equal(parsed.protocol, "https:");
      assert.match(parsed.hostname, /^([a-z]+\.)?crunchyroll\.com$/);
      assert.equal(parsed.username, "");
      assert.equal(parsed.password, "");
    }
  });

  test("interception is armed for the token endpoint only", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    assert.deepEqual(h.openCalls, [CRUNCHYROLL_TOKEN_ENDPOINT]);
    h.channel.bodies.set("req-1", { body: tokenPayload(), base64Encoded: false });
    h.channel.emit({});
    await pending;
  });

  test("afterArmed runs only once the channel is listening, and its failure is ignored", async () => {
    const h = harness();
    const order: string[] = [];
    const ports: BrowserAuthPorts = {
      ...h.ports,
      openInterception: async (pattern: string) => {
        order.push("armed");
        return h.ports.openInterception(pattern);
      },
      afterArmed: async () => {
        order.push("afterArmed");
        throw new Error("reload failed");
      },
    };
    const pending = createBrowserAuthObserver(ports).observeNextAuthMaterial();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["armed", "afterArmed"]);
    h.channel.bodies.set("req-1", { body: tokenPayload(), base64Encoded: false });
    h.channel.emit({});
    assert.equal((await pending).kind, "OBSERVED");
  });

  const rejectedUrls: Array<[string, string]> = [
    ["a different host", "https://evil.example.com/auth/v1/token"],
    ["a lookalike host", "https://www.crunchyroll.com.evil.example/auth/v1/token"],
    ["a different path", "https://www.crunchyroll.com/content/v2/discover/browse"],
    ["plain http", "http://www.crunchyroll.com/auth/v1/token"],
    ["userinfo smuggling", "https://user:pass@www.crunchyroll.com/auth/v1/token"],
    ["a path traversal suffix", "https://www.crunchyroll.com/auth/v1/token/../../evil"],
  ];

  for (const [name, url] of rejectedUrls) {
    test(`N: ${name} can never install material`, async () => {
      const h = harness();
      const observer = createBrowserAuthObserver(h.ports);
      const pending = observer.observeNextAuthMaterial();
      await Promise.resolve();
      h.channel.bodies.set("req-1", { body: tokenPayload(), base64Encoded: false });
      h.channel.emit({ url });
      h.fireTimers();
      const outcome = await pending;
      assert.deepEqual(outcome, { kind: "TIMED_OUT" });
      assert.deepEqual(h.channel.continued, ["req-1"], "the browser response still proceeds");
    });
  }

  test("a non-2xx response can never install material", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    h.channel.bodies.set("req-1", { body: tokenPayload(), base64Encoded: false });
    h.channel.emit({ responseStatusCode: 401 });
    h.fireTimers();
    assert.deepEqual(await pending, { kind: "TIMED_OUT" });
    assert.deepEqual(h.channel.continued, ["req-1"]);
  });
});

describe("BT4 browser auth — bounded, validated, closed material", () => {
  test("J: a valid mint produces exactly the closed BT3 candidate", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    h.channel.bodies.set("req-1", {
      body: tokenPayload({ profile_id: PROFILE_SENTINEL }),
      base64Encoded: false,
    });
    h.channel.emit({});

    const outcome = await pending;
    assert.equal(outcome.kind, "OBSERVED");
    if (outcome.kind !== "OBSERVED") return;
    assert.deepEqual({ ...outcome.material }, {
      accessToken: ACCESS_SENTINEL,
      tokenType: "Bearer",
      expiresAt: T0 + 3_600_000,
      accountId: ACCOUNT_SENTINEL,
      profileId: PROFILE_SENTINEL,
    });
    assert.equal(outcome.connectionGeneration, 7);
    assert.equal(Object.isFrozen(outcome.material), true);
    assert.deepEqual(h.channel.continued, ["req-1"], "continueResponse always runs");
    assert.equal(h.channel.closed, true, "the channel is closed afterwards");
  });

  test("O: no refresh token, cookie or provider payload enters the material", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    h.channel.bodies.set("req-1", {
      body: tokenPayload({ cookie: COOKIE_SENTINEL, id_token: "SYNTHETIC-ID-TOKEN" }),
      base64Encoded: false,
    });
    h.channel.emit({});
    const outcome = await pending;
    assert.equal(outcome.kind, "OBSERVED");
    if (outcome.kind !== "OBSERVED") return;
    const rendered = JSON.stringify(outcome.material);
    assert.equal(rendered.includes(REFRESH_SENTINEL), false);
    assert.equal(rendered.includes(COOKIE_SENTINEL), false);
    assert.equal(rendered.includes("SYNTHETIC-ID-TOKEN"), false);
    assert.deepEqual(Object.keys(outcome.material).sort(), [
      "accessToken",
      "accountId",
      "expiresAt",
      "tokenType",
    ]);
  });

  test("a base64 body is decoded before validation", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    h.channel.bodies.set("req-1", {
      body: Buffer.from(tokenPayload(), "utf-8").toString("base64"),
      base64Encoded: true,
    });
    h.channel.emit({});
    const outcome = await pending;
    assert.equal(outcome.kind, "OBSERVED");
  });

  test("M: an oversized response cannot install material", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    const padded = JSON.stringify({
      access_token: ACCESS_SENTINEL,
      expires_in: 3600,
      token_type: "Bearer",
      account_id: ACCOUNT_SENTINEL,
      padding: "x".repeat(MAX_AUTH_RESPONSE_BYTES + 1),
    });
    assert.ok(Buffer.byteLength(padded, "utf-8") > MAX_AUTH_RESPONSE_BYTES);
    h.channel.bodies.set("req-1", { body: padded, base64Encoded: false });
    h.channel.emit({});
    h.fireTimers();
    assert.deepEqual(await pending, { kind: "TIMED_OUT" });
    assert.deepEqual(h.channel.continued, ["req-1"]);
  });

  const malformed: Array<[string, Record<string, unknown>]> = [
    ["an absent access token", { access_token: undefined }],
    ["an empty access token", { access_token: "" }],
    ["a non-string access token", { access_token: 1 }],
    ["an absent token type", { token_type: undefined }],
    ["an absent account id", { account_id: undefined }],
    ["an empty account id", { account_id: "  " }],
    ["an empty profile id", { profile_id: "" }],
    ["a non-numeric expiry", { expires_in: "3600" }],
    ["a zero expiry", { expires_in: 0 }],
    ["a negative expiry", { expires_in: -1 }],
    ["an infinite expiry", { expires_in: Number.POSITIVE_INFINITY }],
  ];

  for (const [name, override] of malformed) {
    test(`L: ${name} cannot install material`, async () => {
      const h = harness();
      const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
      await Promise.resolve();
      h.channel.bodies.set("req-1", { body: tokenPayload(override), base64Encoded: false });
      h.channel.emit({});
      h.fireTimers();
      assert.deepEqual(await pending, { kind: "TIMED_OUT" });
      assert.deepEqual(h.channel.continued, ["req-1"]);
    });
  }

  test("L: a non-JSON body cannot install material and is never echoed", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    h.channel.bodies.set("req-1", {
      body: "<html>challenge SENSITIVE-CHALLENGE-BODY</html>",
      base64Encoded: false,
    });
    h.channel.emit({});
    h.fireTimers();
    const outcome = await pending;
    assert.deepEqual(outcome, { kind: "TIMED_OUT" });
    assert.equal(JSON.stringify(outcome).includes("SENSITIVE-CHALLENGE-BODY"), false);
  });

  test("a body read that fails still continues the browser response", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    // No body registered: getResponseBody throws.
    h.channel.emit({});
    h.fireTimers();
    assert.deepEqual(await pending, { kind: "TIMED_OUT" });
    assert.deepEqual(h.channel.continued, ["req-1"]);
  });

  test("an earlier invalid mint does not stop a later valid one", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    h.channel.bodies.set("req-1", { body: tokenPayload({ access_token: "" }), base64Encoded: false });
    h.channel.emit({ requestId: "req-1" });
    await new Promise((resolve) => setImmediate(resolve));
    h.channel.bodies.set("req-2", { body: tokenPayload(), base64Encoded: false });
    h.channel.emit({ requestId: "req-2" });
    const outcome = await pending;
    assert.equal(outcome.kind, "OBSERVED");
    assert.deepEqual(h.channel.continued, ["req-1", "req-2"]);
  });
});

describe("BT4 browser auth — cancellation and lifecycle", () => {
  test("an aborted observation resolves as cancelled and closes the channel", async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial({
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    assert.deepEqual(await pending, { kind: "CANCELLED" });
    assert.equal(h.channel.closed, true);
  });

  test("an already-aborted signal never opens a channel at all", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const outcome = await createBrowserAuthObserver(h.ports).observeNextAuthMaterial({
      signal: controller.signal,
    });
    assert.deepEqual(outcome, { kind: "CANCELLED" });
    assert.deepEqual(h.openCalls, []);
  });

  test("a browser that cannot open a channel is reported as unavailable", async () => {
    const failing: BrowserAuthPorts = {
      openInterception: async () => {
        throw new Error("BROWSER_UNAVAILABLE");
      },
      now: () => T0,
      schedule: () => ({ cancel: () => void 0 }),
    };
    assert.deepEqual(await createBrowserAuthObserver(failing).observeNextAuthMaterial(), {
      kind: "UNAVAILABLE",
    });
  });

  test("the channel is closed even when the deadline expires", async () => {
    const h = harness();
    const pending = createBrowserAuthObserver(h.ports).observeNextAuthMaterial();
    await Promise.resolve();
    h.fireTimers();
    assert.deepEqual(await pending, { kind: "TIMED_OUT" });
    assert.equal(h.channel.closed, true);
  });
});
