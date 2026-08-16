// BT4 completion — production composition and live invalid_grant ordering.
//
// Deterministic and offline: no real Crunchyroll network, no real credentials,
// no browser. The fetch stub asserts the exact URL it is given and throws for
// anything unexpected; persistence runs against an isolated temporary HOME.
//
// Frozen design: CRUNCHYROLL-BT4-COMPLETION-ERRATA.md §3, §4, §11.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveTokens, type TokenData } from "../src/auth.js";
import { refreshRequest, setLegacyAuthTransitionSink } from "../src/api.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");
const COMPOSITION_ROOT = join(SRC_ROOT, "index.ts");

const AUTH_URL = "https://auth.crunchyroll.com/auth/v1/token";

/** The modules that DEFINE these factories; a definition is not a call site. */
const DEFINING_MODULES = new Set([
  join(SRC_ROOT, "transport", "auth-context.ts"),
  join(SRC_ROOT, "transport", "auth-producer.ts"),
]);

/** Call sites of `name(`, excluding the module that defines it. */
function callSitesOf(name: string): string[] {
  const pattern = new RegExp(String.raw`(?<!function\s)${name}\s*\(`);
  return productionSources()
    .filter((file) => !DEFINING_MODULES.has(file.path))
    .filter((file) => pattern.test(file.code))
    .map((file) => file.path);
}

/** Every .ts file under src/, with its comments stripped. */
function productionSources(): Array<{ path: string; code: string }> {
  const files: Array<{ path: string; code: string }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const raw = readFileSync(full, "utf-8");
        files.push({ path: full, code: raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "") });
      }
    }
  };
  walk(SRC_ROOT);
  return files;
}

describe("BT4 composition — exactly one production authority", () => {
  test("there is exactly one createAuthContextAuthority call site under src/", () => {
    const callers = callSitesOf("createAuthContextAuthority");
    assert.equal(callers.length, 1, `expected one call site, found: ${callers}`);
  });

  test("that call site is the composition root", () => {
    assert.deepEqual(
      callSitesOf("createAuthContextAuthority"),
      [COMPOSITION_ROOT],
      "only src/index.ts may construct the authority"
    );
  });

  test("the composition root hands out only the writer port", () => {
    const code = readFileSync(COMPOSITION_ROOT, "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.match(code, /asWriter\s*\(\s*\)/, "the writer must be derived");
    assert.equal(/asReader\s*\(/.test(code), false, "BT4 must not derive the reader");
    // The authority object itself is never passed into a constructed component:
    // every composed factory receives the writer or a narrower port.
    assert.equal(
      /create\w+\(\s*\{[^}]*\bauthority\b\s*[,}]/.test(code),
      false,
      "the authority object must not be handed to a component"
    );
  });

  test("no production module uses the BT3 reader side", () => {
    for (const file of productionSources()) {
      if (file.path.endsWith("auth-context.ts")) continue; // BT3 defines them
      assert.equal(/\basReader\s*\(/.test(file.code), false, `${file.path} calls asReader`);
      assert.equal(/\brunCurrent\s*\(/.test(file.code), false, `${file.path} calls runCurrent`);
    }
  });

  test("the composition root composes the accepted producer, not a second one", () => {
    const code = readFileSync(COMPOSITION_ROOT, "utf-8");
    assert.match(code, /createDefaultAuthProducerPorts/);
    assert.match(code, /createAuthProducer/);
    assert.deepEqual(
      callSitesOf("createAuthProducer"),
      [COMPOSITION_ROOT],
      "exactly one producer construction site, in the composition root"
    );
  });
});

describe("BT4 composition — live invalid_grant invalidates before cleanup", () => {
  function isolatedHome(tokens: TokenData): { home: string; tokenFile: string; restore(): void } {
    const home = mkdtempSync(join(tmpdir(), "bt4-home-"));
    const strider = join(home, ".strider");
    mkdirSync(join(strider, "crunchyroll"), { recursive: true });
    chmodSync(strider, 0o700);
    chmodSync(join(strider, "crunchyroll"), 0o700);
    const previous = process.env.HOME;
    process.env.HOME = home;
    return {
      home,
      tokenFile: join(strider, "crunchyroll", "tokens.json"),
      restore: () => {
        process.env.HOME = previous;
        rmSync(home, { recursive: true, force: true });
      },
    };
  }

  const synthetic: TokenData = {
    access_token: "BT4-SYNTHETIC-ACCESS",
    refresh_token: "BT4-SYNTHETIC-REFRESH",
    expires_at: Date.now() + 3_600_000,
    token_type: "Bearer",
    account_id: "BT4-SYNTHETIC-ACCOUNT",
  };

  test("the sink runs BEFORE clearAuthData removes the stored tokens", async () => {
    const originalFetch = globalThis.fetch;
    const scope = isolatedHome(synthetic);
    const observed: Array<{ event: string; tokensStillPresent: boolean }> = [];
    try {
      await saveTokens(synthetic);
      assert.equal(existsSync(scope.tokenFile), true, "precondition: tokens are on disk");

      setLegacyAuthTransitionSink({
        onInvalidGrant: () => {
          // The whole point: at invalidation time the cleanup has NOT run yet.
          observed.push({ event: "invalidate", tokensStillPresent: existsSync(scope.tokenFile) });
        },
      });

      globalThis.fetch = (async (url: unknown) => {
        assert.equal(String(url), AUTH_URL);
        return {
          status: 400,
          text: async () => JSON.stringify({ error: "invalid_grant" }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      await assert.rejects(refreshRequest(synthetic));

      assert.deepEqual(observed, [{ event: "invalidate", tokensStillPresent: true }]);
      assert.equal(existsSync(scope.tokenFile), false, "cleanup still runs afterwards");
    } finally {
      setLegacyAuthTransitionSink(undefined);
      globalThis.fetch = originalFetch;
      scope.restore();
    }
  });

  test("a sink that throws never becomes an outward failure of its own", async () => {
    const originalFetch = globalThis.fetch;
    const scope = isolatedHome(synthetic);
    try {
      await saveTokens(synthetic);
      setLegacyAuthTransitionSink({
        onInvalidGrant: () => {
          throw new Error("SINK-FAILURE-MUST-NOT-ESCAPE");
        },
      });
      globalThis.fetch = (async () =>
        ({
          status: 400,
          text: async () => JSON.stringify({ error: "invalid_grant" }),
        }) as unknown as Response) as unknown as typeof fetch;

      await assert.rejects(refreshRequest(synthetic), (error: unknown) => {
        const message = (error as Error).message;
        assert.equal(message.includes("SINK-FAILURE-MUST-NOT-ESCAPE"), false);
        return (error as { name?: string }).name === "RefreshError";
      });
      assert.equal(existsSync(scope.tokenFile), false, "cleanup still ran");
    } finally {
      setLegacyAuthTransitionSink(undefined);
      globalThis.fetch = originalFetch;
      scope.restore();
    }
  });

  test("no sink registered is a no-op, and the legacy behaviour is unchanged", async () => {
    const originalFetch = globalThis.fetch;
    const scope = isolatedHome(synthetic);
    try {
      await saveTokens(synthetic);
      setLegacyAuthTransitionSink(undefined);
      globalThis.fetch = (async () =>
        ({
          status: 400,
          text: async () => JSON.stringify({ error: "invalid_grant" }),
        }) as unknown as Response) as unknown as typeof fetch;

      await assert.rejects(refreshRequest(synthetic));
      assert.equal(existsSync(scope.tokenFile), false);
    } finally {
      globalThis.fetch = originalFetch;
      scope.restore();
    }
  });

  test("a transient failure never notifies the sink", async () => {
    const originalFetch = globalThis.fetch;
    const scope = isolatedHome(synthetic);
    let notified = 0;
    try {
      await saveTokens(synthetic);
      setLegacyAuthTransitionSink({ onInvalidGrant: () => void (notified += 1) });
      globalThis.fetch = (async () =>
        ({ status: 503, text: async () => "" }) as unknown as Response) as unknown as typeof fetch;

      await assert.rejects(refreshRequest(synthetic));
      assert.equal(notified, 0, "only a semantic invalid_grant is an auth transition");
      assert.equal(existsSync(scope.tokenFile), true, "material is preserved");
    } finally {
      setLegacyAuthTransitionSink(undefined);
      globalThis.fetch = originalFetch;
      scope.restore();
    }
  });
});
