# Architecture, security, and network review

*Portuguese version: [pt-BR](pt-BR/revisao-arquitetura.md).*

Review from 2026-10-08. The fixes keep the contract of the 21 MCP tools and
the production stdio transport. The initial cloud review included no
authenticated calls to Crunchyroll. The later validation on the Linux PC,
reported by the operator, passed 12 read calls; there was no account mutation
test. See the [browser report](browser-validation.md).

## Architecture and changes

```mermaid
flowchart LR
  Client[MCP client] -->|stdio| Root[Result composition and redaction]
  Root --> Gateway[Domain gateway]
  Gateway --> Registry[Closed operation registry]
  Registry --> Backend[Backend and authenticated identity]
  Backend --> Session[Session manager]
  Session -->|Bounded local CDP| Browser[Sandboxed browser]
  Browser -->|HTTPS and bounded reads| Provider[Crunchyroll]
```

The registry remains responsible for methods, paths, arguments, and bodies;
the authentication authority remains responsible for identity and generation.
The changes concentrate resource limits and subscription release in the
transport, avoiding duplication of those controls in the tool handlers.

| Finding | Evidence | Fix |
| --- | --- | --- |
| Full read before the limit | The fixture of 100 chunks of 8 bytes consumed all 100 chunks, even with a 16-byte budget. | Incremental read: 3 chunks, cancellation once the budget is exceeded, without consuming the remaining 97. |
| Limit in characters instead of bytes | `😀😀` was accepted under a limit of 4, despite occupying 8 UTF-8 bytes. | Counting of the received bytes and incremental decoding, including characters split across chunks. |
| Subscriptions retained across calls | The channels registered callbacks with no removal mechanism. | `CdpConnection.on` returns a disposer; the tests verify zero retained subscriptions after 100 cycles, plus initialization failures. |
| CDP resources without explicit limits | Handshake with no deadline, pending queue with no cap, and the default WebSocket frame limit. | Handshake bounded by the CDP timeout; up to 128 pending commands and frames of up to 4 MiB; compression disabled. |
| Malformed JSON frames | `null` was accessed as an object in the parser. | Primitives and arrays are ignored; a test interleaves those frames with a valid response. |
| Shutdown dependent on the peer | `close()` waited for the remote close before rejecting commands. | Immediate local shutdown, timer cancellation, callback cleanup, and socket termination. |
| Origin validated without the port | The hostname comparison accepted port 8443. | `URL.origin` comparison; alternative ports and credentials in the URL are refused before dispatch. The default port 443 remains valid. |
| Null result after dispatch | A test reproduced a `TypeError` when receiving a `null` CDP result. | Structural failure with `POSSIBLY_DISPATCHED`/`malformed`, preserving the classification of uncertain mutations and the absence of automatic retry. |

The 4 MiB CDP limit accommodates the 512 KiB API body even when JSON
serialization expands escaped characters. The cap of 128 pending commands is a
protection policy, not an optimal capacity demonstrated by benchmark. Excess
concurrency is refused locally before the extra command is sent; a pending
command that completes or expires frees capacity.

## Dependencies

The initial `npm audit --omit=dev` reported 14 affected entries: 4 moderate,
8 high, and 2 critical, including transitive effects. That does not mean 14
vulnerabilities were exploitable by the stdio server: several advisories
involved HTTP/OAuth surfaces that this flow does not expose.

Dependencies were updated within the ranges already present in the lockfile,
including MCP SDK 1.27.1 → 1.32.1 and `ws` 8.21.3 → 8.22.0.
esbuild moved from `^0.20.0` to `^0.28.2` to also resolve the development
advisory GHSA-67mh-4wv8-2f99; the project uses the build, without exposing
esbuild's development server. The Node.js >=18 requirement was preserved.

After a clean install, the full `npm audit` returned zero known advisories.
That result is a snapshot of the registry consulted, not a guarantee that no
vulnerabilities exist.

## Reproducible validation

```bash
cd /workspace/mcp-crunchyroll
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
npm run typecheck
npm run build
(umask 022; CI=true CRUNCHYROLL_BROWSER_EXECUTABLE=/usr/bin/chromium npm test)
npm audit --cache /workspace/.npm-cache
git diff --check
```

In the cloud, the browser tests need to run outside the additional command
isolation when it blocks namespaces or remaps the owner of the SUID helper.
Chromium's native sandbox stays enabled. The `umask 022` lets the storage test
deliberately create insecure 0755 directories.

Validation: Node.js 24.19.0, Chromium 151.0.7922.173; clean install, types,
build, and the suite of 1,017 tests passed, with no failures or skipped tests.
The suite includes running the bounded read function in real Chromium,
adversarial WebSocket fixtures, identity generation, mutations, and MCP stdio
in both the source code and the bundle. The Node.js 18/20/22 matrix was not
run locally; it remains in CI.

## Linux authentication and profile continuity

The stdio SDK inherits a limited set of environment variables. The initial
runner detected a graphical session in the parent process but did not forward
`DISPLAY`/`WAYLAND_DISPLAY` to the MCP. The first adjustment forwarded those
variables and the session runtime resources.

The later manual launch inherited the terminal's entire environment, while the
MCP still used a reduced list. Adjustment `a59dd13` uses the same
`browserLaunchEnvironment()` function for both stages and preserves the desktop
identification and the XDG directories. That removes a configuration difference
that could affect Chromium's access to protected storage on Linux; it does not
demonstrate that this was the only cause of the repeated login prompt.

The validation flow integrates a manual login in the dedicated profile and
waits for a normal close before opening the managed browser. Authentication
depends on material observed and validated by the MCP, preserving the existing
authority and gates. A busy profile is refused without deleting locks or
terminating other processes. The run saves phases and distinguishes an
incomplete report from an approval, without including account data or
environment values.

The 85 related tests passed in the cloud, including a persistent synthetic
session in real Chromium and verification of the environment received by a real
SDK subprocess. On the PC, the operator confirmed the persistence test,
`PROFILE_READY`, and 12/12 reads at concurrency 2. That evidence validates the
flow in that run; it does not isolate every provider or keyring difference.

## Limits and next measurements

- There are 12 latencies from authenticated MCP calls to the real Crunchyroll,
  reported by the operator. There are no measurements of throughput, RSS, time
  to headers, or stable provider percentiles. The reduction in consumed chunks
  demonstrates work avoided in the fixture, without extrapolating a percentage
  gain to production.
- The deadline bounds the local wait; cancelling a request still active in the
  browser after that deadline needs a dedicated experiment.
  A future change using `AbortController` must preserve uncertain mutations.
- The Node egress guard wraps `globalThis.fetch`, not every socket, nor the
  operating system's network egress policy. It must not be treated as a general
  firewall against arbitrary code.
- The session, CDP, the local read, and the authentication flow on the PC were
  tested. The browser also received HTTPS responses from the provider in
  anonymous probes; DNS, proxy, and TLS were not measured separately. The
  redirect and rate limit cases were verified in fixtures, not induced on
  Crunchyroll. Resumption after restarting the PC has not been observed yet.
- Caching, session pooling, and a broad split of the authentication modules
  were not introduced: measurements that would justify the risks of shared
  state, stale responses, and invalidation are missing. The first step is to
  measure channel open time, time to headers, and read duration per operation.
