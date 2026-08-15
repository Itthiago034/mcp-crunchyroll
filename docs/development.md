# Development

## Commands

All commands come from `package.json` — none are invented:

```bash
npm ci                    # clean install from lockfile
npm run typecheck         # tsc --noEmit
npm run build             # esbuild → dist/index.js
npm test                  # unit + MCP stdio harness tests
npm run dev               # run from TypeScript source via tsx
npm run start             # run compiled bundle (node dist/index.js)
```

## CI

GitHub Actions runs on push, across Node.js 18, 20, and 22, in strict order:

```text
npm ci → npm run typecheck → npm run build → npm test → verify clean tree
```

The test suite includes a deterministic MCP harness that boots the server as a real stdio subprocess for both the TypeScript source (`tsx`) and the compiled bundle (`node dist/index.js`), verifying tool discovery (21 tools, ordered and byte-identical schemas against the registered baseline), standard error responses (`-32601 Method not found`), and result redaction. The build must complete before the harness runs, so the bundle target is always exercised.

## Connecting to Clients

### Generic stdio client (Claude Desktop, etc.)

```json
{
  "mcpServers": {
    "crunchyroll": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-crunchyroll/dist/index.js"]
    }
  }
}
```

### Hermes Agent — catalog entry

Drop `manifest.yaml` into `optional-mcps/crunchyroll/` of a hermes-agent checkout:

```bash
hermes mcp install crunchyroll
```

The manifest handles cloning, production install, and the launch command (`npx -y tsx src/index.ts`). Note: the manifest's bootstrap uses an unpinned `npx -y tsx` combined with a production install — a known reproducibility risk that is tracked, not dismissed.

### Development loop

```bash
npm run dev   # tsx src/index.ts — no build step required
```

## Testing Conventions

- Unit tests use `node:test` via `tsx --test` (TAP output); suites run sequentially.
- MCP boundary tests use the real stdio subprocess harness (both source and bundle targets).
- Filesystem-sensitive tests run under a fake home directory with deterministic UID/mode/symlink injection through internal test-only seams; these seams never reach the published bundle (`dist/index.js` contains no test symbols, enforced by test).
- No real Crunchyroll credentials are used in tests; all account behavior is validated against the protocol surface with synthetic data.

## Internal Methodology

The repository uses an internal gated development methodology (A → B2 → B3 → B6-core → B4 → B5 → B1 → B7), where each gate is a design, TDD, regression, and CI cycle reviewed externally before consolidation. Gate labels are internal process artifacts; the features they validate are documented in [tools.md](tools.md), [architecture.md](architecture.md), and [security.md](security.md).

## Known Review Items

| Item | State |
|------|-------|
| Live Crunchyroll authentication compatibility | Under investigation (web SSO flow changes) |
| Package identity (`@striderlabs/mcp-crunchyroll`) | Under review before distribution |
| Manifest reproducibility (unpinned `npx -y tsx`) | Tracked |
| SDK v1 / protocol 2025-03-26 vs. current MCP line | Decision deferred |
