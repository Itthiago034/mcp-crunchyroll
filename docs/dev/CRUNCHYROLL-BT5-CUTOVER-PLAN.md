# MCP Crunchyroll — BT5 Cutover Plan (frozen)

Short and operational, per mandate. Base `c229b31` (BT4 formally closed).
Authority: source C §13, §13A, §17A, §28 (SHA-256 `02ce03e2…388213`) plus the
external ruling authorizing one closed `Runtime.callFunctionOn` channel.

## 1. Scope — exactly one operation

`GET_CATEGORIES` is the only content operation migrated. `PRODUCTION_OPERATIONS`
goes from `[]` to exactly one descriptor:

| field | value |
|---|---|
| `id` | `GET_CATEGORIES` |
| `method` | `GET` |
| `pathTemplate` | `/content/v2/discover/categories?locale=en-US` |
| `callerParams` | none |
| `authDerivedParams` | none |
| `scope` | `PUBLIC` (ruling 6 — no identity params, but a bearer is still required) |
| `mutation` | `false` |

Origin is the frozen constant `https://www.crunchyroll.com`. The path literal
leaves `src/api.ts`'s reachable graph in the same commit it enters the registry.

## 2. The cutover boundary — one decision site

`src/transport/content-gateway.ts` maps every content tool name to an operation
id and decides once:

```
tool name → operation id
   ├── id ∈ PRODUCTION_OPERATIONS → dispatcher → browser transport
   └── otherwise                  → TransportError("OPERATION_NOT_MIGRATED")
```

`src/index.ts` routes every content tool through it before the switch, and the
18 legacy content cases plus their `api.ts` imports are removed. No handler
decides anything on its own; no unknown operation falls through to legacy.

## 3. Node fallback: none, and guarded

Browser transport failure is a failure. There is no second attempt, no legacy
retry, no degraded mode. `src/transport/node-egress-guard.ts` wraps the global
`fetch` at composition and fails closed — before any socket — on a request to
`crunchyroll.com` or a subdomain, counting the attempt and emitting one
secret-free stderr line. Every other destination (localhost, test fixtures)
passes through untouched. It is host-scoped, not env-scoped, not stack-scoped.

## 4. The authorized execution channel

`BrowserSessionManager.openApiExecutionChannel()` returns a closed channel with
one verb, `request()`. Inside it, and nowhere else:

- `Runtime.enable`, `Runtime.executionContextCreated`, `Runtime.callFunctionOn`
  — those three only, on the managed page's flattened session;
- a single **constant** function declaration exported as
  `CRUNCHYROLL_FETCH_FUNCTION`, never assembled from any input;
- url / method / authorization / cap cross as structured CDP **arguments**;
- context selection requires the live connection generation, the managed
  target's own session, a default context, and origin
  `https://www.crunchyroll.com`; anything else fails closed;
- `awaitPromise`, `returnByValue`, an explicit deadline, a byte cap re-checked
  in Node, `credentials: "omit"`, `redirect: "manual"`;
- `exceptionDetails` becomes a typed, secret-free error; no page object, body
  or stack crosses out.

Serial by page context, per ruling 7. No pool, no scheduler.

## 5. Operation lifecycle (source C §13, §13A)

```
resolve operation + caller args (registry)
→ snapshot AuthContext generation N   → none ⇒ AUTH_NOT_READY
→ build URL from descriptor, revalidate origin
→ browser-context request with N's bearer
→ bounded, normalized TransportResult
→ FINAL generation commit check       → changed ⇒ AUTH_GENERATION_CHANGED
→ domain parser → MCP result
```

Nothing from the response is released before the final check.

## 6. Public surface

21 tool names unchanged; `crunchyroll_get_categories` keeps its schema and its
`{count, categories}` output shape. Parsing moves out of `api.ts` transport
into a small parser; no schema change anywhere. If any of this had required a
breaking schema change, the stage stops instead.

## 7. Stage-closure assertions retired here

Four assertions encode "cutover has not happened": `PRODUCTION_OPERATIONS` is
empty (three sites) and the dispatcher is unreachable from the composition root
(one site). BT5 is the stage that makes them false by design, exactly as BT4
retired BT3's three. They are replaced in place, with the reason recorded, and
their RED is preserved in the report.

## 8. Out of scope

No second operation, no mutation, no account reads, no player, no auto-login,
no auth-contract change, no onboarding change, no CDP beyond the three
authorized methods, no BT6.
