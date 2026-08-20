import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/index.js",
  banner: {
    // The shebang must stay the first line. The createRequire bridge follows:
    // bundled CommonJS dependencies (ws) require Node builtins, and an ESM
    // bundle has no `require` of its own. Same policy as the dedicated
    // websocket bundle smoke in test/transport-websocket.test.ts.
    js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
  },
  external: [],
  minify: false,
  sourcemap: false,
});

console.log("Build complete: dist/index.js");
