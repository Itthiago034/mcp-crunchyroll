# MCP Crunchyroll — BT4 Completion Errata

Internal design checkpoint for the BT4 completion macrophase. It does not
rewrite `CRUNCHYROLL-BT4-DESIGN.md` or `CRUNCHYROLL-BT4-IMPLEMENTATION-REPORT.md`;
both remain the record of the accepted producer foundation. It authorizes no BT5
work.

## 1. Why the first BT4 candidate was only a producer foundation

The first candidate delivered the trusted producer — login/refresh/status/logout/
invalid_grant/bootstrap ordering — proven against the real BT3 authority, and
deliberately stopped short of production wiring. The reason was recorded as
BT4-D1: three BT3 Task 5 closure assertions forbid any production import of
`auth-context.ts`, and the first macrophase was instructed to keep BT3 tests
both unmodified and passing.

External review has now ruled that those assertions are **stage-closure**
assertions, not eternal architecture invariants, and that BT4 is precisely the
stage that makes them obsolete. This errata resolves BT4-D1 and BT4-D2 and
completes the remaining roadmap scope.

## 2. Design precedence applied

| Rank | Source | Authoritative for |
|---|---|---|
| A | closed BT3 design + implementation (in-repo) | AuthContext, revision, CAS, writer/reader split, secret lifetime, storage compatibility, error vocabulary, BT3-R1 |
| B | BT4 foundation through `e39c951` | producer semantics, ports, outcomes |
| C | `/tmp/CRUNCHYROLL-BROWSER-TRANSPORT-DESIGN-P1.1-ERRATA.md` (SHA-256 `02ce03e2620c53d3279cdc060788a9e1bdf01deec7e6447d96c2cc2f3a388213`) | remaining BT4 delivery obligations |

Source C is **not** in the repository; it was located on disk and is quoted by
section here so a reviewer can verify the reading. Its §28 assigns BT4 exactly:
*"Interactive login + status readiness contract (breaking input and output schema
changes), incl. `LOGGING_OUT` reporting … `index.ts` auth tools + status …
NOT CALLER-REACHABLE (auth tools only; no content operation migrated yet)."*

Reconciliation where C predates the closed BT3:

- C §11 says the bearer lives in transport memory and is never persisted, and
  C §26.1 removes `token_expires_at` because "there is no persisted local token
  lifecycle". The in-repo BT3/BT4 architecture **does** keep hardened
  persistence (`src/auth.ts`) and installs material through the writer. This
  errata follows **A and B**: material continues to flow through the existing
  hardened storage owner and the BT3 candidate. C's older persistence
  assumptions are not revived. The public consequence C requires — removing
  `token_expires_at`, `email` and `account_id` from status — is adopted in full,
  because those fields are either unsourceable or internal identity under A.
- C §10's `AuthContext` (bearer + accountId + profileId + handle + generation as
  one value) is superseded by the closed BT3 `AuthContext` (opaque capability)
  plus the private `ActiveAuthRecord`. C's *state machine* is adopted; C's
  *AuthContext shape* is not.

No unresolved conflict remains.

## 3. BT4-D1 resolution — production authority ownership

`src/index.ts` is the composition root and the only place that may construct an
authority.

```
src/index.ts (composition root)
  authority = createAuthContextAuthority()        // EXACTLY ONE per process
  writer    = authority.asWriter()                // the only port handed out
  producer  = createAuthProducer(createDefaultAuthProducerPorts(writer))
  orchestrator = createAuthOrchestrator({ producer, browserAuth, … })
```

Rules, each mechanically asserted:

- exactly one `createAuthContextAuthority` call site exists in `src/`, and it is
  in the composition root;
- no per-request or per-tool authority;
- the authority object never leaves the composition root — only `asWriter()`
  crosses;
- `asReader()`, `bind()` and `runCurrent()` are **not** called anywhere in
  production BT4;
- no MCP caller input reaches the writer, the authority or a context;
- `BrowserSessionManager` gains no auth field and no auth authority.

## 4. BT4-D2 resolution — live invalid_grant ordering

The live invalid_grant path is inside `src/api.ts`'s `refreshOperation`, which
clears storage and then throws. Content tools still reach it through the legacy
`getValidToken()` (BT5 has not happened), so the producer cannot preempt it from
outside.

Minimal correction, frozen: `src/api.ts` gains one narrow, injectable
**transition sink** — no auth state, no authority reference, no storage
knowledge:

```ts
export interface LegacyAuthTransitionSink { onInvalidGrant(): void }
export function setLegacyAuthTransitionSink(sink: LegacyAuthTransitionSink | undefined): void
```

`refreshOperation` calls `sink.onInvalidGrant()` **before** `clearAuthData()`.
The composition root registers a sink that calls
`writer.invalidate("INVALID_GRANT")`. The sink is synchronous, never throws
outward, and the secure-clearing implementation is not duplicated or moved.

## 5. Retirement of the BT3 stage-closure assertions

Exactly three assertions in `test/auth-context.test.ts` encoded the BT3 closure
condition *"BT3 exists but is not yet integrated"*:

1. *no import path from the MCP entry point reaches the authority*;
2. *no other production module imports the authority*;
3. *the published bundle carries no trace of the authority*.

They are replaced **in place** by ten stronger BT4 architecture assertions. The
other 158 BT3 behavioural and security tests are untouched.

| # | Replacement assertion |
|---|---|
| 1 | exactly one `createAuthContextAuthority(` call site exists under `src/` |
| 2 | that call site is in the composition root (`src/index.ts`) |
| 3 | the producer receives only `asWriter()`; the authority object is never passed on |
| 4 | no MCP tool schema admits a writer, reader, authority, context, epoch or generation |
| 5 | no production module calls `bind(` or `runCurrent(` |
| 6 | no production module calls `asReader(` |
| 7 | `PRODUCTION_OPERATIONS` is empty and no content tool routes through the dispatcher |
| 8 | `auth-context.js` is imported only by the composition root and the modules the composition root composes |
| 9 | no module other than the composition root can manufacture a second production authority (single call-site proof + no exported factory re-export) |
| 10 | no public tool result serializes an AuthContext or a revision (sentinel sweep over every auth tool result) |

## 6. Auth orchestration state model

New module `src/transport/auth-orchestrator.ts`. It owns browser/login
orchestration only; it duplicates no BT3 state machine and no BT2 lifecycle.

Closed state set (C §10, reduced to what BT4 can truthfully report):

`LOGIN_REQUIRED` · `AUTHENTICATING` · `ACCOUNT_READY` · `PROFILE_READY` ·
`REAUTH_REQUIRED` · `LOGGING_OUT` · `DEGRADED`

Mapping — no state may imply authentication merely because a browser exists:

| BT2 lifecycle | BT3 availability | BT4 orchestration |
|---|---|---|
| any | any, while the logout gate is held | `LOGGING_OUT` |
| `DEGRADED`/disconnected | any | `DEGRADED` |
| any | UNAVAILABLE, after a REAUTH signal | `REAUTH_REQUIRED` |
| any | UNAVAILABLE | `LOGIN_REQUIRED` |
| any | READY, login in flight | `AUTHENTICATING` |
| any | READY, record has no profile id | `ACCOUNT_READY` |
| any | READY, record has a profile id | `PROFILE_READY` |

`ACCOUNT_READY` vs `PROFILE_READY` is derived from the authority's existing safe
diagnostic `hasProfileId`, never from a new secret channel.

### `LOGGING_OUT`

Entry is conditional on acquiring an exclusive logout gate, so it cannot be
entered twice. While held: interactive login cannot begin (it is refused
immediately with a typed state, never queued); a concurrent logout joins the
in-flight single-flight transaction; `authenticated`, `logged_in` and
`profile_ready` are all false; the authority is invalidated **before** any
cleanup; a failed or partial cleanup never restores a ready state; exit is
`LOGIN_REQUIRED`, never a previous ready state.

BT8's browser-session clear and composite four-axis logout result are **not**
implemented here. `crunchyroll_logout`'s public output is unchanged.

## 7. Interactive login

`crunchyroll_login({})` — no credential arguments of any kind.

```
ensure the managed browser is available
open the FIXED Crunchyroll login surface
enter AUTHENTICATING (single-flight; idempotent)
HUMAN types credentials directly into Crunchyroll
observe a bounded auth transition at the token endpoint
build a validated closed candidate
install through the accepted BT4 producer path → BT3 writer
return SAFE readiness only
```

The model never receives or supplies email, password, username, OTP,
verification code, CAPTCHA answer, cookie, bearer or Authorization. The code
never reads form fields, never types credentials, never automates a challenge.

Fixed origins, hard-coded, never caller input and never environment-configurable:

| Purpose | Value |
|---|---|
| login surface | `https://www.crunchyroll.com/login` |
| permitted auth origins during human login | `https://www.crunchyroll.com`, `https://sso.crunchyroll.com` |
| observed token endpoint | `https://www.crunchyroll.com/auth/v1/token` |

Idempotence: a login while already `AUTHENTICATING` returns `AUTHENTICATING` and
opens no second window; a login while already ready returns readiness and opens
nothing; a login during `LOGGING_OUT` is refused.

## 8. Login input schema — breaking change

| | Contract |
|---|---|
| OLD | `{ type: "object", properties: { email: {…}, password: {…} }, required: ["email","password"] }` |
| NEW | `{ type: "object", properties: {}, additionalProperties: false }` |

The handler additionally rejects **any** supplied argument locally with a typed
error rather than ignoring it, so a credential-shaped input fails closed on both
surfaces. The description states that login is browser-interactive. The
credential-consuming code path is removed. B6 redaction is **not** narrowed: the
generic `SENSITIVE_ARG_KEYS` registration and all static patterns remain.

## 9. Browser auth observation

New module `src/transport/browser-auth.ts`. Baseline per C §10/DD-15:
**`Fetch`-domain interception at response stage**, scoped to the token endpoint
only.

Exact CDP additions, frozen:

| Method / event | Use |
|---|---|
| `Target.attachToTarget` (`flatten: true`) | obtain a session on the managed page |
| `Target.detachFromTarget` | release it |
| `Fetch.enable` with `patterns:[{urlPattern:<fixed>, requestStage:"Response"}]` | arm response-stage pause for the token endpoint only |
| `Fetch.requestPaused` (event) | receive the paused response |
| `Fetch.getResponseBody` | read the bounded body |
| `Fetch.continueResponse` | let the browser's own response proceed untouched |
| `Fetch.disable` | disarm |

Nothing else. No `Runtime.evaluate`, no `Network.*`, no cookie API, no generic
`sendCDP`, no caller-reachable method string, no caller-controlled URL or
pattern, no request modification, no arbitrary interception. The browser's
cookie jar never leaves the browser.

`src/transport/cdp-client.ts` gains an **optional** `sessionId` on `send` and an
optional second listener argument, because flattened session routing needs it.
Both are additive; every existing caller and fake is unaffected.
`BrowserSessionManager` gains one narrow accessor returning a closed
response-interception session with exactly the operations above — it gains no
auth field, no token, no identity and no generic CDP send.

### Response bounding

Before any parsing: the paused event must be response stage; the URL must equal
the fixed token endpoint after origin/path revalidation; the status must be 2xx;
the body is read with a hard cap of **64 KiB** and rejected beyond it; the body
must parse as JSON; only the closed fields below are read, each exactly once.
No provider body, header or request id enters an error, a log, a diagnostic or
a result.

### Candidate construction

Only the closed BT3 candidate is produced:
`accessToken`, `tokenType`, `expiresAt`, `accountId`, optional `profileId`.
Never `refreshToken`, cookie, password, email, Authorization, provider payload,
browser object, request id or CDP object. `expiresAt` is derived as
`now + expires_in*1000` with `expires_in` validated as a finite positive number.

A stale observation — one whose BT2 connection generation or login attempt no
longer matches, or one arriving after logout — is discarded and can never
install.

## 10. Status — breaking output contract

| Field | Disposition |
|---|---|
| `logged_in` | REDEFINED: "authenticated work is currently permitted" |
| `authenticated` | NEW, always `=== logged_in` |
| `browser_running` | NEW, from BT2 lifecycle |
| `browser_connected` | NEW, from BT2 lifecycle |
| `auth_state` | NEW, the closed orchestration enum |
| `profile_ready` | NEW |
| `player_ready` | NEW, always `false` — BT10 owns the player and BT4 has no truthful source for `true` |
| `email` | REMOVED — the MCP never receives it under browser login |
| `account_id` | REMOVED — internal identity |
| `token_expires_at` | REMOVED — no fabricated lifetime |
| `profile` | OMITTED — BT4 has no truthful profile-handle source; adding one would require an account fetch BT4 does not own |

During `LOGGING_OUT`: `authenticated=false`, `logged_in=false`,
`profile_ready=false`, `auth_state="LOGGING_OUT"`.

Status remains strictly read-only: it never logs in, refreshes, mints, commits,
invalidates, increments a generation, mutates storage, navigates or reopens a
browser. It reports current known readiness honestly.

## 11. Bootstrap and shutdown

Bootstrap is wired at startup with the already-accepted semantics: validated
material → explicit ESTABLISH CAS; missing → unavailable; expired → not
installed; corrupt/insecure → fail closed; terminal → rejected, no retry. No
epoch or generation is persisted; `src/auth.ts` hardening is untouched.

Shutdown: `main()` is the only teardown seam. A `SIGINT`/`SIGTERM` handler and
the stdio transport close path invoke `producer.invalidateForShutdown()`
**before** asynchronous teardown. No process manager is invented.

## 12. File map (frozen)

New: `CRUNCHYROLL-BT4-COMPLETION-ERRATA.md`, `src/transport/auth-orchestrator.ts`,
`src/transport/browser-auth.ts`, `test/auth-orchestrator.test.ts`,
`test/browser-auth.test.ts`, `test/bt4-composition.test.ts`.

Modified: `CRUNCHYROLL-BT4-IMPLEMENTATION-REPORT.md` (append only), `src/index.ts`,
`src/api.ts` (transition sink only), `src/transport/auth-producer.ts`,
`src/transport/browser-session-manager.ts`, `src/transport/browser-lifecycle-types.ts`,
`src/transport/cdp-client.ts`, `test/auth-context.test.ts` (three stage
assertions only), `test/auth-producer.test.ts`, `test/mcp-harness.test.ts`,
`test/fixtures/baseline-tools.json` (login schema only).

Unchanged: `src/transport/auth-context.ts`, `src/auth.ts`, `src/redact.ts`,
`src/transport/types.ts`, `operation-registry.ts`, `dispatcher.ts`,
`websocket.ts`, `browser-profile.ts`, `transport-error.ts`, `package.json`,
`package-lock.json`, `tsconfig.json`, `build.js`, `.github/`.

Any required path outside this map = STOP for review.

## 13. Test matrix

Families A–Z of the completion mandate, all deterministic, offline and
browser-free, with fake CDP, fake browser state, synthetic token responses and
sentinel secrets. No automated test uses a real account, real credentials or
network egress.

## 14. BT5 boundary

Untouched: `PRODUCTION_OPERATIONS` stays empty, no content or account operation
is migrated, no `TransportBackend` becomes caller-reachable, `bind`/`runCurrent`
stay unused in production, no `OPERATION_NOT_MIGRATED`, no Node-fetch guard, no
endpoint template moves into the registry, and every content tool keeps its
legacy `getValidToken()` path in full.

## 15. Live / manual smoke boundary

The automated suite is complete and network-isolated. The interactive login
smoke is separate: it needs a human to type credentials into the browser. The
agent may start the browser, open the fixed login surface, wait for a transition
and report safe state metadata only. It must never request, read, type or log a
credential. If human interaction is unavailable, the result is reported as
PENDING and formal candidate readiness is not claimed.

## 16. Rollback boundary

Each commit is revertible on its own: the composition wiring, the browser-auth
module, the login schema, the status contract and the orchestration races are
separate commits. Reverting the schema commits restores the previous public
contract; reverting the wiring commit restores the unwired producer foundation.

## 17. Open questions

**Blocking: 0.**

Non-blocking: BT4-N1 — the observed token endpoint is taken from C's evidence
baseline (`POST /auth/v1/token` on the web origin). If a live smoke shows the web
app minting at a different exact path, only the frozen constant changes; the
mechanism, bounding and validation do not.
