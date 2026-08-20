// BT1 — websocket dependency foundation.
//
// No socket is opened anywhere in BT1: no CDP URL, no localhost port, no
// browser, no DNS. The dedicated bundle smoke writes only to a temp directory.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createWebSocketClient, WEBSOCKET_OPEN } from "../src/transport/websocket.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

/**
 * Optional native accelerators policy.
 *
 * DEFAULT is `[]` — nothing is externalised, so the smoke genuinely traverses
 * `ws`. If and only if esbuild proves it cannot resolve `bufferutil` /
 * `utf-8-validate`, this becomes ["bufferutil", "utf-8-validate"] AND the
 * identical set is added to build.js. The two configurations are one policy in
 * two places and must never disagree.
 */
const OPTIONAL_NATIVE_EXTERNALS: string[] = [];

describe("BT1 websocket binding", () => {
  test("the binding loads and exposes the standard OPEN state", () => {
    assert.equal(typeof createWebSocketClient, "function");
    assert.equal(WEBSOCKET_OPEN, 1, "ws exposes the standard readyState constants");
  });
});

describe("BT1 websocket bundles under the production build settings", () => {
  // dist/index.js cannot prove this: BT1 deliberately leaves src/transport/*
  // unimported, so esbuild need never traverse websocket.ts. This bundles it AS
  // ITS OWN ENTRY POINT with build.js's settings.
  test("a dedicated esbuild bundle of websocket.ts builds and imports", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "bt1-ws-bundle-"));
    const outfile = join(outDir, "websocket-bundle.mjs");
    try {
      await build({
        entryPoints: [join(ROOT, "src/transport/websocket.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node18",
        outfile,
        external: OPTIONAL_NATIVE_EXTERNALS, // see the policy note above
        // ws is CommonJS and requires Node builtins. An ESM bundle has no
        // `require`, so esbuild emits a dynamic require that cannot run.
        // This banner supplies the standard Node bridge and changes nothing
        // else: still ESM, still node18, still nothing externalised.
        banner: {
          js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
        },
        logLevel: "silent",
      });
      const bundled = (await import(pathToFileURL(outfile).href)) as { WEBSOCKET_OPEN: number };
      assert.equal(bundled.WEBSOCKET_OPEN, 1, "the bundled module must carry ws, not a stub");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("the optional native accelerators are absent and not required", async () => {
    await assert.rejects(
      () => import("bufferutil"),
      "bufferutil must not be installed; ws must run on its pure-JS fallback"
    );
  });
});
