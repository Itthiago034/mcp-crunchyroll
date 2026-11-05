# CRUNCHYROLL — BT8 ACCOUNT MUTATIONS — DESIGN

**Status:** DESIGN ONLY — no runtime code, no `src/` change, no `tests/` change, no CI change, no live mutation.
**Base:** `86f7baa7992a0ad287170dfd1c9159836bbb6bbc` (branch `bt7-account-reads`, BT7 formally CLOSED)
**Branch:** `bt8-account-mutations-design`
**Scope:** `ADD_TO_WATCHLIST`, `REMOVE_FROM_WATCHLIST`, `UPDATE_PLAYHEAD`

---

## 1. Executive Summary

BT8 is the first stage in this migration that asks the system to **change state on a
third party we do not control**. Every stage before it moved reads: a wrong read
returns wrong data the caller can inspect and discard. A wrong write is an action
against a real account, and some of its outcomes cannot be undone by re-reading.

Three findings dominate this design.

**Finding 1 — the transport physically cannot carry a mutation today.**
The single authorized browser primitive, `ApiExecutionRequest`, declares
`method: "GET"` as a *literal type* and has **no body field at all**
(`src/transport/browser-lifecycle-types.ts:120-127`). The frozen page-side function
`CRUNCHYROLL_FETCH_FUNCTION` sets exactly one header, `Authorization`, and passes no
request body (`src/transport/browser-session-manager.ts:113-131`). So BT8 is not a
table edit: it requires a deliberate, minimal, formally-designed expansion of the
one primitive that talks to Crunchyroll. That expansion is the highest-risk change in
the whole migration and is treated as its own stage (BT8.1).

**Finding 2 — no provider evidence exists for any of the three mutations.**
BT7's live smoke was explicitly read-only: *"Real session, dedicated profile,
read-only, no mutation attempted"* (`CRUNCHYROLL-BT7-IMPLEMENTATION-REPORT.md` §21),
and all three mutations were confirmed refused with **zero** transport calls. The
only artefact describing their wire contract is the legacy Node client in
`src/api.ts:658-693`, which is now **dead code with no caller**. BT7's own F-1
proved that a legacy path literal in that same file had silently stopped being
routed by the provider, and F-2 proved that a path which *is* still routed had
nevertheless changed its query contract. A legacy literal is therefore a
**hypothesis to probe, never a contract to implement**. All three mutations are
`CONTRACT PARTIALLY KNOWN` and all three are **BLOCKED — PROVIDER EVIDENCE
REQUIRED**.

**Finding 3 — "unknown outcome" is resolved by reading, never by retrying.**
Every one of the three mutations has a **read counterpart that is already migrated
and already proven live**: `GET_WATCHLIST` (123 items observed) covers add/remove,
and `GET_PLAYHEADS` (comma-joined, `array[3]` observed) covers playhead. That is an
unusually strong position: when a mutation's outcome cannot be established, the
system does not have to guess and does not have to re-send. It states
`MUTATION_OUTCOME_UNKNOWN` and names the read tool that settles the question. This
design therefore forbids **all** automatic retry of **all** mutations,
unconditionally, and offers determination-by-read in its place.

The design also closes one gap that only becomes dangerous at BT8: the BT7 gateway
*silently drops* caller arguments it does not forward. For a read, an ignored
`account_id` yields data the caller can inspect. For a write, it would mean the
caller believed it targeted one account while the server wrote to another. BT8
mutation tools therefore forward the caller's argument object **verbatim** to
`resolveCall`, so its existing allow-list produces an explicit
`CALLER_SUPPLIED_IDENTITY` refusal instead of a silent drop (§6.3).

**Ruling:** BT8.1 (structural support) is fully designed and **unblocked** — it
requires no provider evidence and leaves all three operations fail-closed.
BT8.2–BT8.4 (the operations themselves) are **blocked** on a controlled,
explicitly-authorized live probe (BT8.0) that this round did not and must not run.

---

## 2. Current-State Extraction

All statements in this section were read from the tree at `86f7baa`. No file was
modified.

### 2.A — Public inputs the three tools accept today

Source: `src/index.ts` `ListToolsRequestSchema` handler.

| Tool | Published `inputSchema` | Required | `additionalProperties` |
|---|---|---|---|
| `crunchyroll_add_to_watchlist` | `{ content_id: string }` | `content_id` | **not set** (open) |
| `crunchyroll_remove_from_watchlist` | `{ content_id: string }` | `content_id` | **not set** (open) |
| `crunchyroll_update_playhead` | `{ content_id: string, playhead: number }` | `content_id`, `playhead` | **not set** (open) |

Descriptions today (`src/index.ts:307`, `318`, `366`):

- "Add an anime series or movie to the watchlist."
- "Remove an anime series or movie from the watchlist."
- "Update watch progress for an episode or movie."

None of the three carries an MCP `annotations` block, so nothing in the published
contract states that these tools write. The SDK in use (`@modelcontextprotocol/sdk`
**1.27.1**) does support `ToolAnnotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`). This is a disclosure gap, not a safety hole —
the operations are refused anyway — and §11 closes it.

### 2.B — Invariants already implemented (inherited by BT8 unchanged)

1. **Closed caller allow-list.** `resolveCall` (`operation-registry.ts:255-264`)
   accepts only declared `callerParams`; any other key is `INVALID_ARGUMENTS`, and a
   key naming an auth-derived param is `CALLER_SUPPLIED_IDENTITY` — checked *first*,
   so the caller gets the precise reason.
2. **Descriptor owns the wire.** Path template, query mapping (`queryParams`,
   `fixedQuery`, `repeatedQueryParams`, `joinedQueryParams`), method, scope, auth and
   mutation class all live in the frozen registry. The URL builder knows *rules*,
   never operation names (`browser-api-backend.ts:69-76`).
3. **Registry construction invariants** (`operation-registry.ts:79-231`), enforced at
   runtime rather than by types, because `tsconfig` checks `src/` only: closed `auth`,
   closed `scope`, `ACCOUNT ⇒ auth ≠ NONE`, `PUBLIC ⇒ no identity`,
   `ACCOUNT ⇒ identity`, unique ids, no caller/auth-derived overlap, every
   auth-derived param present in the path template, no query string inside a path
   template, no undeclared path placeholder, every query mapping references a
   declared caller param, and **one wire key may be rendered exactly one way**
   (fixed / scalar / repeated / joined are mutually exclusive).
4. **Deep frozen capture.** `captureDescriptor` copies every descriptor and every
   param spec, so mutating the source object cannot change registry policy later.
5. **Identity is auth-derived, always.** `bind()` (`auth-context.ts:629-687`)
   resolves `{accountId}` / `{profileId}` from the private active record only,
   registers the value as a redaction secret at that moment, and attaches the handle
   and the identity as **non-enumerable** properties so `Object.keys`, spread and
   `JSON.stringify` emit neither.
6. **Generation-guarded execution.** `runCurrent` (`auth-context.ts:594-619`) does a
   synchronous pre-check, hands the consumer the generation's `AbortSignal`, and does
   a synchronous post-check after the callback settles. Its own comment is explicit:
   *"No claim is made that aborting retracts a request already sent. What is
   guaranteed is that its result is never accepted afterwards, and that it is never
   replayed or reissued under a newer generation."* That last clause is already a
   no-replay guarantee, and BT8 builds on it rather than restating it.
7. **Acquisition strictly precedes URL construction** (BT7 G-1,
   `browser-api-backend.ts:150-166`): `bind()` runs *before* `buildRequestUrl`, so no
   request can be shaped before the authority has been consulted.
8. **Bounded, normalized responses.** `MAX_API_RESPONSE_BYTES` (512 KiB) is enforced
   both page-side and again in Node; then status, then content-type, then
   `JSON.parse` — in that order, before anything is interpreted.
9. **Closed page channel.** One verb. The function source is a frozen constant;
   `url`, `method`, `authorization`, `maxChars` cross as **structured CDP arguments**
   and are never concatenated into source. `credentials: "omit"` keeps the browser
   cookie jar out. `redirect: "manual"` means a redirect is reported, not followed.
   The execution context is matched on session id, exact origin
   (`https://www.crunchyroll.com`), `auxData.isDefault === true` and the live
   connection generation; anything else fails closed with no fallback.
10. **Origin enforced three times**: the constant origin in the backend, a
    `startsWith` prefix re-check on the built URL, and a **parsed** origin+scheme
    equality check page-side (`isCrunchyrollApiUrl`, never a substring test).
11. **Permanent Node egress guard** (`node-egress-guard.ts`), installed
    unconditionally at composition for the life of the process, scoped by destination
    host: any Node-originated request to `crunchyroll.com` or a true subdomain fails
    closed before a socket exists.
12. **Operation-scoped redaction.** Every `CallTool` runs inside
    `withRedactionScope`; every outward result — success *and* error — passes through
    `sanitizeToolResult` while the registry is still populated; `TransportError`
    messages are fixed strings carrying a structural `detail` name, never a value.

### 2.C — Where `OPERATION_NOT_MIGRATED` occurs

Three distinct places, in the order a call would meet them:

| # | Location | Condition | Fires today for the three? |
|---|---|---|---|
| 1 | `content-gateway.ts:124-128` | tool maps to an operation id **absent from the registry** | **YES** — this is the live refusal |
| 2 | `content-gateway.ts:222-226` | descriptor exists but the gateway `switch` has no case (no parser) | no |
| 3 | `browser-api-backend.ts:138-140` | `descriptor.method !== "GET" \|\| descriptor.mutation !== false`, detail `"method"` | no |

Refusal #1 happens **locally, before any transport, any browser and any network**.
It is proven by `test/bt7-account.test.ts:632-648` (zero backend calls), by
`test/bt7-f1-f2.test.ts:428`, and live: BT7 §21 records all three refused in **≤1 ms
with 0 attempts**.

Refusal #3 is the defence-in-depth backstop. Note the important consequence: it
refuses **`mutation !== false`**, so simply registering a descriptor with
`mutation: "ACCOUNT"` would not make the operation reachable — it would move the
refusal from the gateway to the backend. That is deliberate, and BT8 must replace it
with an authorization rule rather than delete it (§12).

### 2.D — Components that must change for a mutation to become production

| # | Component | Change required | Blocked on evidence? |
|---|---|---|---|
| D1 | `browser-lifecycle-types.ts` — `ApiExecutionRequest` | widen `method` beyond the `"GET"` literal; add an optional descriptor-owned body (`{contentType, text}`) | no |
| D2 | `browser-session-manager.ts` — `CRUNCHYROLL_FETCH_FUNCTION` | accept two further **structured** arguments (body text, body content-type) and set `Content-Type` only when a body is present | no |
| D3 | `browser-session-manager.ts` — `channel.request` | pass the two new structured arguments through `Runtime.callFunctionOn` | no |
| D4 | `types.ts` | `BodySpec` on `OperationDescriptor`; response contract; keep `HttpMethod` closed | no |
| D5 | `operation-registry.ts` | new construction invariants for mutation descriptors + a `mutationWrite()` factory | no |
| D6 | `browser-api-backend.ts:138` | replace the GET-only refusal with a structural authorization check; add `buildRequestBody`; handle empty-body success | no |
| D7 | `transport-error.ts` | append `MUTATION_OUTCOME_UNKNOWN`, `API_BAD_REQUEST`, `API_CONFLICT` | no |
| D8 | `operation-registry.ts` — `PRODUCTION_OPERATIONS` | the three descriptors: method, path, body shape, success statuses | **YES** |
| D9 | `content-gateway.ts` | one `case` per mutation + outcome mapping | **YES** (mapping only) |
| D10 | a mutation-result module (or `account-domain.ts`) | outcome/audit shapes | partly |
| D11 | `src/index.ts` | `annotations` + `additionalProperties: false` on the three schemas | no |
| D12 | `src/api.ts` | remove the legacy owner **in the same commit** its descriptor enters the registry (BT5 rule) | **YES** |

D1–D7 and D11 are BT8.1 and need no provider evidence. D8–D10 and D12 are per-operation
and are gated.

### 2.E — Guards that currently refuse `mutation: true` / non-GET

1. `browser-api-backend.ts:138` — the only *runtime* guard. Refuses both a non-GET
   method and any non-`false` mutation class.
2. `ApiExecutionRequest.method: "GET"` — a **type-level** guard that is real for
   `src/` (which `tsc --noEmit` covers) and, more importantly, **structural**: there
   is no body field, so a body cannot be expressed at all.
3. `CRUNCHYROLL_FETCH_FUNCTION` — passes `method` through as a structured argument,
   so a non-GET method would technically reach `fetch`, but with **no body and no
   `Content-Type`**. A `POST` issued through today's primitive would send an empty
   body with the browser's default content type. This is a silent-wrong-request
   hazard, not a safety hole, and D2 closes it.
4. `content-gateway.ts:124` — the three operation ids are absent from
   `PRODUCTION_OPERATIONS`, so they never reach a transport.
5. `installNodeCrunchyrollGuard()` — the legacy `src/api.ts` mutation functions would
   fail closed with `NODE_CRUNCHYROLL_FORBIDDEN` even if something called them. They
   have **no caller** in `src/` (verified); their only references are structural
   assertions in `test/bt6-catalog.test.ts`, `test/bt7-account.test.ts` and
   `test/refresh-state-machine.test.ts` (the latter drives `addToWatchlist` against a
   `fetch` double, which is refresh-state evidence, **not** provider evidence).

### 2.F — Gap found during extraction: `MutationClass` is not closed at runtime

`createOperationRegistry` closes `auth` and `scope` at runtime with an explicit
`TransportError` (BT5-FIX1, `operation-registry.ts:83-100`), for the stated reason
that `tsconfig` checks `src/` only. It does **not** do the same for `mutation`:
`captureDescriptor` simply copies `d.mutation` (line 66). Today that is harmless
because every descriptor is `false` and the backend refuses anything else. At BT8 it
stops being harmless, because `mutation` becomes the field the authorization decision
reads. Closing it is BT8.1 work (§12, INV-M1).

---

## 3. Scope

**In scope (design only):**

| Tool | Operation id | Class |
|---|---|---|
| `crunchyroll_add_to_watchlist` | `ADD_TO_WATCHLIST` | `"ACCOUNT"` |
| `crunchyroll_remove_from_watchlist` | `REMOVE_FROM_WATCHLIST` | `"ACCOUNT"` |
| `crunchyroll_update_playhead` | `UPDATE_PLAYHEAD` | `"PROGRESS"` |

All three remain **fail-closed with `OPERATION_NOT_MIGRATED` for the entirety of this
round**, and remain fail-closed at the end of every BT8 stage that has not yet
migrated them.

**Other state-changing operations catalogued (FUTURE / OUT OF SCOPE).** A sweep of
`src/`, the published tool list and the BT3–BT7 documents found the following, and
none of them is adopted automatically:

| Operation | Where | Ruling |
|---|---|---|
| `crunchyroll_login` | `src/index.ts` / `auth-orchestrator` | State-changing (establishes a session) but **not a content mutation**; owned by BT4, out of BT8's scope entirely. |
| `crunchyroll_logout` | `src/index.ts` / `auth-orchestrator` | Same — BT4/B5 own it. Its four-axis result is noted in `src/index.ts:532` as "BT8's", which refers to a *presentation* refinement, **not** a mutation; explicitly **NOT** adopted here. |
| Token refresh (`POST /auth/v1/token`) | `src/api.ts:420` | Auth-plane, BT4-owned, deliberately outside the browser transport. Out of scope. |
| `fully_watched` / progress side effects | provider-derived | Not a caller-settable field in any design here. Out of scope — see §10. |
| Watchlist "favourite" toggle (`is_favorite` appears in read shapes) | `src/api.ts:109`, BT7 §22 | A plausible provider mutation with **no tool, no operation id and no legacy implementation** in this repo. Catalogued as FUTURE. Not designed, not probed, not registered. |
| `GET_CONTINUE_WATCHING`, `GET_SUBSCRIPTION` | deferred reads | Not mutations. §21 — remain DEFERRED, untouched. |

---

## 4. Non-Goals

1. **No generic HTTP execution.** BT8 does not add a caller-reachable way to choose a
   method, a URL, a path, a query, a header or a body.
2. **No new CDP surface.** No `Runtime.evaluate`, no arbitrary JS, no generic
   `connection.send` reachable from a caller, no `Network.*` domain, no cookie access,
   no manual browser control.
3. **No automatic retry of any mutation, ever** (§15).
4. **No invented provider contract.** No endpoint inferred from a name, no method
   guessed, no body guessed, no response shape guessed, no endpoint copied from a
   third-party project without validation.
5. **No live mutation in this round.**
6. **No BT7 deferred work** (`GET_CONTINUE_WATCHING`, `GET_SUBSCRIPTION`) — §21.
7. **No CI remediation** — §22.
8. **No confirmation state machine inside the MCP core** (§11) — approval is the
   host's job; the MCP's job is to never hide that a tool writes.
9. **No automatic post-mutation verification read** in BT8.1–BT8.4. The result names
   the read that settles the question; it does not perform it.
10. **No new mutations adopted implicitly** (§3).

---

## 5. Threat Model

| # | Threat | Consequence | Control |
|---|---|---|---|
| T1 | Caller directs identity (`account_id`, `profile_id`) to write to another account | Irreversible write on a third party's account | `resolveCall` allow-list → `CALLER_SUPPLIED_IDENTITY`; identity is path-only and auth-derived; **mutation tools forward args verbatim so the refusal is explicit, never a silent drop** (§6.3) |
| T2 | Caller directs transport (url/method/path/query/body/header) | Server becomes a generic authenticated HTTP proxy / SSRF against the Crunchyroll origin | Descriptor owns the whole wire; closed method set; closed body mapping; three independent origin checks; Node egress guard |
| T3 | Mutation amplification through retry | Double-apply; a progress overwrite that destroys a newer position | No automatic retry, unconditionally (§15); `MUTATION_OUTCOME_UNKNOWN` instead of a re-send |
| T4 | Silent mutation — the model calls a write believing it is a read | Unapproved state change | MCP `annotations` (`readOnlyHint: false`); description states it writes; result payload carries `mutation: true` in-band; host approval (§11) |
| T5 | Identity confusion mid-flight — session changes while the write is in flight | The write may have landed on the *previous* account | `runCurrent` post-check → outcome `UNKNOWN`, never `APPLIED`, never "not executed" (§17) |
| T6 | Secret leakage through the new body/audit surfaces | Bearer, cookie, account id exposure | Body carries only validated public caller values; audit record excludes URL, identity and provider text; existing fixed-message discipline unchanged (§19) |
| T7 | Boundary erosion — the page primitive grows into a general fetch | Loses every guarantee BT2–BT7 established | Page function stays ONE frozen source literal; only two further **structured** arguments; the function sets exactly `Authorization` and (conditionally) `Content-Type`; no header map ever (§18) |
| T8 | Ambient-authority write (browser cookies riding along) | A mutation attributable to the browser session rather than the observed bearer | `credentials: "omit"` retained verbatim |
| T9 | Redirect-following into an unvalidated origin on a write | Credentialed write to an unintended host | `redirect: "manual"` retained; an opaque redirect on a mutation is `UNKNOWN`, not a silent success (§14) |
| T10 | Stale legacy contract implemented as if current | A write to an unrouted or re-contracted endpoint; F-1/F-2 precedent | Evidence classification (§11 of the mandate → §11 here); all three BLOCKED pending probe |

---

## 6. Account Identity Boundary

### 6.1 The rule, restated unchanged from BT7

`accountId` is **AUTH-DERIVED**. The caller chooses **TOOL + PERMITTED PUBLIC
ARGUMENTS**. The MCP resolves **IDENTITY + AUTH + PROVIDER CONTRACT**.

The caller may never supply: `accountId`, `account_id`, `profileId`, `profile_id`,
`Authorization`, bearer / access / refresh token, cookies, base URL, host, path,
HTTP method, or a raw provider payload.

### 6.2 How the rule is mechanically enforced for a mutation

1. `authDerivedParams: { accountId: { source: "accountId" } }` on every mutation
   descriptor, with `{accountId}` present in the path template — the registry refuses
   construction otherwise (`operation-registry.ts:138-145`).
2. `scope: "ACCOUNT"` + `auth: "BEARER"`; `ACCOUNT + NONE` and `ACCOUNT` without
   identity are both refused at construction.
3. `resolveCall` refuses any caller key that names an auth-derived param, **before**
   the generic unknown-argument refusal, so the caller is told exactly what it did
   wrong.
4. `bind()` resolves the value from the private active record and registers it as a
   redaction secret before it can be rendered anywhere.
5. `buildRequestUrl` gives auth-derived values precedence over caller params for any
   shared placeholder (`browser-api-backend.ts:41`), and the placeholder/caller-param
   overlap check makes a shared placeholder impossible in the first place.
6. **Identity never appears in a request body.** INV-M6 (§12) forbids a body field
   from referencing an auth-derived param. The legacy client put `account_id` only in
   the path, and BT8 keeps it there. If provider evidence ever demands identity in a
   body, that is a design amendment, not an implementation detail.

### 6.3 New for BT8 — verbatim argument forwarding on mutation tools

**Finding.** BT7's gateway projects arguments: `withDefined({ n: args.n ?? 20, … })`.
Anything the projection does not name is **silently dropped**. For a read that is
tolerable — a caller who passed `account_id` gets data it can inspect. For a write it
is not: the caller would believe it targeted account X while the server wrote to
account Y, and would receive a *success*.

**Ruling.** Mutation tools do **not** project. The gateway forwards the caller's
argument object verbatim to `transport.execute(operation, args)`, so `resolveCall`'s
existing allow-list fires:

- `account_id` / `accountId` / `profile_id` / `profileId` → `CALLER_SUPPLIED_IDENTITY`
- `url`, `path`, `method`, `body`, `headers`, `query`, `host`, `token`,
  `authorization`, `cookie`, or anything else undeclared → `INVALID_ARGUMENTS`

This needs **no new code** — only the discipline of not projecting, plus tests that
prove it. It is possible precisely because no mutation has an optional or defaulted
parameter, so there is nothing to normalize.

**Corollary.** The three published `inputSchema`s gain `additionalProperties: false`,
so the strictness is visible in the contract as well as enforced at the boundary.
(`crunchyroll_login` already sets this precedent, `src/index.ts:214`.)

Any design that weakens §6 is **BT8 DESIGN — BLOCKED**. Nothing in this document does.

---

## 7. Mutation Authorization Model

A mutation is authorized to leave the process only after **every** stage below has
succeeded, in this order. Any failure before stage 7 leaves the state **CERTAIN
unchanged**.

```
INTENT
  1. tool → operation id            content-gateway CONTENT_TOOL_OPERATIONS
  2. migration check                registry.has(operation)      → OPERATION_NOT_MIGRATED
  3. schema validation              resolveCall (verbatim args)  → INVALID_ARGUMENTS
                                                                 / CALLER_SUPPLIED_IDENTITY
  4. mutation authorization gate    backend: descriptor is a REGISTERED, structurally
                                    valid mutation (§12)         → OPERATION_NOT_MIGRATED
  5. auth readiness + identity      reader.bind(call)            → AUTH_NOT_READY
     binding                        (AUTHENTICATED required)     / AUTH_GENERATION_CHANGED
  6. provider request construction  buildRequestUrl + buildRequestBody
                                    (origin re-check)            → INVALID_ARGUMENTS
─────────────── the point of no return is INSIDE stage 7 ───────────────
  7. execution                      runCurrent → openChannel → channel.request
  8. response validation            cap → status → content-type → parse (§14)
  9. postcondition / outcome        APPLIED | ALREADY_IN_DESIRED_STATE | REFUSED | UNKNOWN
 10. audit-safe result              §18
```

**Where a mutation gains authority to leave.** Precisely at the moment
`channel.request` issues `Runtime.callFunctionOn`. Everything before it is local and
reversible; from that instruction onward the design must assume the request **may**
have reached the provider.

**Certainty boundary.** The transport can prove "not sent" only for failures raised
*before* that instruction. `channel.request` performs its own pre-flight checks —
channel closed, parsed origin, generation, lifecycle state
(`browser-session-manager.ts:944-956`) — and all of them precede the CDP send, so
they are CERTAIN not-sent. Everything after is UNKNOWN unless a validated response
comes back.

**Consequence for the deadline.** The deadline races the CDP send
(`Promise.race([connection.send(...), deadline])`). When it wins, the transport has
**no information** about whether the page's `fetch` went out. For a read that is
irrelevant. For a mutation it means **every deadline expiry after dispatch is
`MUTATION_OUTCOME_UNKNOWN`**. There is no cheap fix inside the current boundary; a
send-observation would require the CDP `Network` domain, which is a boundary
expansion this design refuses (§18, and Open Question OQ-5).

---

## 8. `ADD_TO_WATCHLIST` — Design

### 8.1 Public contract

| | |
|---|---|
| Tool | `crunchyroll_add_to_watchlist` |
| Public input | `content_id` — **confirmed** in `src/index.ts:306-315`; the only property, required |
| Caller param | `content_id: contentId` (`/^[A-Za-z0-9_-]{1,64}$/`, required) — reuses the existing predicate, no new id rule |
| Forwarding | **verbatim** (§6.3) |
| Identity | `authDerivedParams: { accountId: { source: "accountId" } }`, `scope: "ACCOUNT"`, `auth: "BEARER"` |
| Mutation class | `"ACCOUNT"` |

### 8.2 Provider operation shape — HYPOTHESIS, NOT CONTRACT

The legacy owner (`src/api.ts:658-666`, dead code, no caller):

```
POST https://www.crunchyroll.com/content/v2/{account_id}/watchlist/{content_id}
Content-Type: application/json
Authorization: Bearer …
body: {}
(no query string — notably no `locale`)
```

**PROVIDER CONTRACT — EVIDENCE REQUIRED.** What is corroborated is only the prefix:
`GET /content/v2/{accountId}/watchlist` answered **123 items live** in BT7 §21, so
the account watchlist collection is routed and the identity segment is correct. The
item sub-path, the method, the empty-object body, the `Content-Type` requirement, the
absence of `locale` and the success status are **all unproven**. F-1 is the standing
precedent that a legacy literal under a live prefix can be unrouted.

### 8.3 Semantics

- **State model:** the watchlist is a **set** of content ids. Adding an element
  already present yields the same set.
- **Duplicate / already-present:** unknown. Candidates are `200`, `204`, `409`, or a
  `4xx` with a body error code. **No mapping is assumed.** Until the probe observes
  it, a non-success status maps to its ordinary closed error kind and the outcome is
  `REFUSED` (CERTAIN not-newly-applied), never a synthesized
  `ALREADY_IN_DESIRED_STATE`.
- **Provider refusal:** `401 → API_UNAUTHORIZED`, `403 → API_FORBIDDEN` (e.g. content
  not addable / region), `404 → API_NOT_FOUND` — and **`404` is not read as anything
  about the item**, because F-1 showed a `404` here can mean "path not routed".
- **Postcondition, verifiable:** `crunchyroll_get_watchlist` — already migrated,
  already proven live. This is the designated resolver for an `UNKNOWN` outcome and
  the verification instrument for the probe.
- **Reversibility:** an unintended add is reversible with a remove, but the remove
  discards `date_added` (a field BT7 §22 observed live), so the reversal is not
  perfectly faithful.

### 8.4 Retry

**`retry-safe: CONDITIONAL` — and therefore, in BT8, NO automatic retry.**
The *end state* is retry-tolerant (set semantics: a second add cannot corrupt the
watchlist). The *response* is not proven, so a retried add may return an
uninterpretable status and be reported as a failure of something that in fact
succeeded. Set semantics make `ADD` the least dangerous of the three and therefore
the first candidate for a bounded retry policy — **after** its duplicate response is
observed, in a stage after BT8.

---

## 9. `REMOVE_FROM_WATCHLIST` — Design

### 9.1 Public contract

| | |
|---|---|
| Tool | `crunchyroll_remove_from_watchlist` |
| Public input | `content_id` — **confirmed** in `src/index.ts:317-326`; the only property, required |
| Caller param | `content_id: contentId` |
| Forwarding | **verbatim** |
| Identity | auth-derived `accountId`, `scope: "ACCOUNT"`, `auth: "BEARER"` |
| Mutation class | `"ACCOUNT"` |
| Body | **none** — the legacy owner sent no body |

### 9.2 Provider operation shape — HYPOTHESIS, NOT CONTRACT

Legacy owner (`src/api.ts:668-676`, dead code, no caller):

```
DELETE https://www.crunchyroll.com/content/v2/{account_id}/watchlist/{content_id}
Content-Type: application/json     ← sent by the legacy client with no body
Authorization: Bearer …
(no body, no query string)
```

**PROVIDER CONTRACT — EVIDENCE REQUIRED.** Same corroboration and same gaps as §8.2.
One additional unknown specific to `DELETE`: whether the provider answers `204 No
Content` (no `Content-Type` at all), which today's backend would reject as
`INVALID_RESPONSE("content-type")`. That is exactly why the response contract must be
descriptor-declared (§14) rather than hardcoded to JSON.

### 9.3 Semantics

- **State model:** set removal. Removing an absent element yields the same set.
- **Item-absent:** **not assumed to be success.** Plausible answers are `204`, `200`,
  `404` or `409`, and `404` is ambiguous between "item not in your watchlist" and
  "path not routed" (F-1). The design therefore **refuses to map `404` to
  `ALREADY_IN_DESIRED_STATE`** unless the probe distinguishes the two — for example
  by a provider error code in the body, or by a `404` on a control id known to be
  present.
- **Destructiveness:** removal destroys `date_added` irrecoverably. `destructiveHint:
  true`.
- **Postcondition, verifiable:** `crunchyroll_get_watchlist`.

### 9.4 Retry

**`retry-safe: CONDITIONAL` — NO automatic retry in BT8.**
End state is retry-tolerant. The hazard is not state corruption but
**misreporting**: a retried remove of an already-removed item may answer `404` and be
surfaced as a failure of an operation that succeeded. Determination-by-read (§16)
resolves this correctly and cheaply; retry does not.

---

## 10. `UPDATE_PLAYHEAD` — Design

### 10.1 Public contract — measured, not assumed

| | |
|---|---|
| Tool | `crunchyroll_update_playhead` |
| Public input | **measured in `src/index.ts:364-375`:** `content_id: {type:"string"}`, `playhead: {type:"number", description:"Position in seconds"}`, both **required** |
| Caller params | `content_id: contentId`; `playhead: requiredIntegerInRange(0, 86_400)` — see §10.3 |
| Forwarding | **verbatim** |
| Identity | auth-derived `accountId`, `scope: "ACCOUNT"`, `auth: "BEARER"` |
| Mutation class | `"PROGRESS"` |

The conceptual expectation (`content_id`, `playhead`) matches the code exactly. No
third property exists, and none is added — in particular **`fully_watched` is not a
caller-settable field**: the legacy body never carried it, and BT7 §22 observed it as
a field the provider *returns*. It is provider-derived and stays that way.

### 10.2 Provider operation shape — HYPOTHESIS, NOT CONTRACT

Legacy owner (`src/api.ts:682-693`, dead code, no caller):

```
POST https://www.crunchyroll.com/content/v2/{account_id}/playheads
Content-Type: application/json
Authorization: Bearer …
body: { "content_id": "<id>", "playhead": <number> }
(no query string — no `locale`, consistent with GET_PLAYHEADS)
```

**PROVIDER CONTRACT — EVIDENCE REQUIRED, and this one carries the sharpest warning.**
The path is the *same path* `GET_PLAYHEADS` uses, and that path is **proven routed
live** (BT7 §21, `array[3]`, 278 ms) — the strongest positive signal of the three.
But it is also the path whose wire contract **F-2 proved had drifted**: the live v2
endpoint renamed `content_ids[]` to a comma-joined `content_ids` and answered
`400 missing_required_field` to the legacy encoding. A routed path with a drifted
contract is precisely this endpoint's demonstrated failure mode. The body key names
(`content_id` singular vs. `content_ids`), the value type and the success status are
all unproven.

### 10.3 Unit, range and type

| Question | Position | Evidence status |
|---|---|---|
| Unit | **seconds** — the published description says "Position in seconds" and the legacy success message renders `${playhead}s` | consistent internally; **not** confirmed against the provider |
| Type | **integer required.** Live playhead entries expose a numeric `playhead` (BT7 §22). Narrower is safer: a float is rejected rather than silently rounded by the provider | provider tolerance unproven |
| Lower bound | `0` | structural |
| Upper bound | `86_400` (24 h) as a **structural sanity ceiling**, not a semantic one | the true bound is the content duration, which the transport does not know |
| Playhead > duration | **UNKNOWN.** May clamp, may reject, may set `fully_watched` | **probe required** |
| Same-value update | expected to be state-idempotent for `playhead`, but observably changes `last_modified` (BT7 §22 saw that field) and possibly `fully_watched` | **probe required** |
| Non-existent content id | **UNKNOWN** — `404`, `400`, or a silent `2xx` are all plausible | **probe required** |

The transport cannot validate `playhead ≤ duration`: duration lives in
`GET_EPISODE`/`GET_SERIES` and cross-operation validation would couple the transport
to the catalog domain. The bound is therefore structural, and the semantic bound is
the provider's to enforce.

### 10.4 Semantics

- **State model:** **not a set.** This is a last-writer-wins assignment of a scalar
  that the provider may use to derive `fully_watched` and drive "continue watching".
- **Destructiveness:** overwriting progress destroys the previous position with no
  restore path unless the previous value was read first. `destructiveHint: true`.
- **The real hazard is a stale write, not a double write.** Re-sending the *same*
  `(content_id, playhead)` is state-idempotent for `playhead`. Re-sending an **older**
  value after the user has watched further silently rewinds their progress. An
  automatic retry is exactly the mechanism that would do this, some seconds later,
  with no way to know the user's player has moved on. This is the single strongest
  argument for the unconditional no-retry rule.
- **Postcondition, verifiable:** `crunchyroll_get_playheads` with
  `content_ids: [content_id]` — already migrated, proven live, and it returns the
  authoritative `playhead`, `fully_watched` and `last_modified`.

### 10.5 Retry

**`retry-safe: NO.**
Not because a repeat corrupts a set — it does not — but because the transport cannot
establish that the value it holds is still the value the user wants written. This is
the one operation where a retry can produce a *worse* state than no retry at all.

---

## 11. Provider Evidence Status

### 11.1 What counts, and what does not

Accepted: provider behaviour already recorded in this project; an old implementation
**proven functional against the live provider**; existing tests that exercise the real
contract; a controlled live probe explicitly authorized; verifiable official
documentation.

Not accepted: an endpoint inferred from a name; an endpoint copied from a third-party
project without validation; a guessed HTTP method; a guessed JSON body; a guessed
response shape.

**Ruling on the legacy client.** `src/api.ts` is *evidence of what an older client
sent*. It is **not** evidence that the provider still accepts it. Two facts from BT7
settle this: F-1 (a legacy path under a live prefix returned the site's HTML shell,
byte-identical for full, partial and absent query strings, while a sibling path
answered `200` on the same channel and identity) and F-2 (a live path whose query
contract had changed). Additionally, the tests that exercise `addToWatchlist`
(`test/refresh-state-machine.test.ts:909-980`) drive it against a **`fetch` double**;
they are evidence about the refresh state machine, not about Crunchyroll.

### 11.2 Classification

| Operation | Class | Known | Unknown |
|---|---|---|---|
| `ADD_TO_WATCHLIST` | **B — PARTIALLY KNOWN** | collection prefix `/content/v2/{accountId}/watchlist` routed live (123 items); identity segment correct; auth model correct | method, item sub-path routing, body (`{}` vs none), `Content-Type` requirement, success status, response body shape, duplicate semantics, whether `locale` is required |
| `REMOVE_FROM_WATCHLIST` | **B — PARTIALLY KNOWN** | same prefix corroboration | method, item sub-path routing, `204` vs `200`, response `Content-Type` (possibly none), item-absent semantics, whether a `Content-Type` header on a bodyless `DELETE` matters |
| `UPDATE_PLAYHEAD` | **B — PARTIALLY KNOWN** | exact path `/content/v2/{accountId}/playheads` **proven routed live** for `GET` | method, body key names and types, unit, success status, response body, clamping, `fully_watched` side effect, non-existent-id behaviour — and the F-2 precedent that *this path's* contract drifts |

No operation is class **A**. No operation is class **C** either — the paths are not
guesses, they are recorded hypotheses with partial corroboration.

### 11.3 The probe required (BT8.0) — specification, NOT executed this round

**Authorization required before any of this runs. Not performed in this round.**

Preconditions: a real interactive session in the dedicated profile; the managed
browser; a control account the user accepts writing to; the BT8.1 primitive built
(so the probe exercises the *real* path, not a script that bypasses it); the Node
egress guard confirmed at 0 blocked attempts.

Method: for each operation, **read → mutate → read**, using the already-migrated
read counterpart as the instrument, so the outcome is established by observed state
and never by trusting the mutation's own response.

| Probe | Setup (read) | Action | Verify (read) | Restore |
|---|---|---|---|---|
| P1 `ADD` — happy path | `get_watchlist`, pick an id **absent** from it | `ADD` | `get_watchlist` contains it | `REMOVE` it |
| P2 `ADD` — duplicate | id known **present** | `ADD` again | list unchanged, membership stable | — |
| P3 `REMOVE` — happy path | id known **present** (capture `date_added`) | `REMOVE` | absent from list | `ADD` back; record that `date_added` is not restored |
| P4 `REMOVE` — absent | id known **absent** | `REMOVE` | list unchanged | — |
| P5 `PLAYHEAD` — happy path | `get_playheads([id])`, **capture the current value** | `UPDATE` to a small, safe value | `get_playheads` shows the new value; record `fully_watched`, `last_modified` | **restore the captured value** |
| P6 `PLAYHEAD` — same value | current value known | `UPDATE` to that same value | value unchanged; record whether `last_modified` moved | — |
| P7 `PLAYHEAD` — bad id | — | `UPDATE` a syntactically valid but non-existent id | `get_playheads` shows nothing new | — |

Recorded for every probe, field names and status classes only: HTTP status,
`Content-Type` (or its absence), response body **shape** (keys, never values), latency,
and whether the verification read confirmed the change. Never recorded: any
materialized URL, `accountId`, bearer, cookie, raw body, or provider error text —
BT7 §23's structural-omission discipline is carried forward verbatim.

**P8 (`playhead` beyond duration) is deliberately excluded** from the first probe: its
plausible outcome is marking content fully watched, which pollutes real user state.
It is raised as OQ-3.

---

## 12. Registry Evolution

The existing guard says *"mutations are impossible"*. BT8 replaces it with *"only
explicitly registered, structurally valid mutations are possible"*. The guard is
**not** removed — it is given a rule to evaluate.

### 12.1 Closed method set

```ts
export type HttpMethod = "GET" | "POST" | "DELETE";
```

**Unchanged.** `types.ts:10` already declares exactly this. `PUT` and `PATCH` are
**not** added: the only evidence in the repository points at `POST` and `DELETE`, and
§12 of the mandate requires including only methods the provider evidence actually
requires. If the probe shows a `PUT`/`PATCH` contract, adding it is a one-line design
amendment plus a registry invariant update — deliberately a decision, not a default.

### 12.2 New descriptor fields

```ts
export type MutationClass = false | "ACCOUNT" | "PROGRESS";        // unchanged, types.ts:31

/** Descriptor-owned request body. The caller supplies VALUES, never keys, never JSON. */
export interface BodySpec {
  readonly contentType: "application/json";
  /** wire key → the DECLARED caller param that fills it. */
  readonly fields: Readonly<Record<string, string>>;
  /** wire key → a constant of THIS BUILD. Never caller-supplied. */
  readonly fixedFields: Readonly<Record<string, string | number | boolean>>;
}

/** What a successful provider answer is allowed to look like. */
export interface ResponseContract {
  readonly successStatuses: readonly number[];
  readonly body: "JSON" | "EMPTY";
}

interface OperationDescriptor {
  // … existing fields unchanged …
  readonly body?: BodySpec;
  readonly response?: ResponseContract;   // absent ⇒ today's implicit "2xx + JSON"
}
```

`response` is optional so that not one existing read descriptor changes shape. Its
absence keeps the current behaviour exactly.

### 12.3 New construction invariants

Enforced in `createOperationRegistry` at runtime, alongside the existing ones and for
the same stated reason (`tsconfig` typechecks `src/` only, so a type-level guarantee
would never be exercised by the suite).

| # | Invariant | Rationale |
|---|---|---|
| **INV-M1** | `mutation` must be exactly `false`, `"ACCOUNT"` or `"PROGRESS"` | Closes the runtime gap found in §2.F. `mutation` becomes the field the authorization decision reads; an unknown value must not fall through to a default that grants. |
| **INV-M2** | `method === "GET"` **⟺** `mutation === false` | A GET may never claim to mutate; a non-GET must declare a class. This single biconditional *is* the substitution of "registered mutation" for "impossible mutation". |
| **INV-M3** | `method` ∈ `{GET, POST, DELETE}` | Closed at runtime, not only by type. |
| **INV-M4** | `mutation !== false` ⇒ `scope === "ACCOUNT"` and `auth === "BEARER"` | A public, unauthenticated mutation has no meaning in this system. |
| **INV-M5** | `body` present ⇒ `method === "POST"` and `mutation !== false` | No body on `GET`; no body on `DELETE` (the legacy owner sent none). |
| **INV-M6** | every `body.fields` value names a declared **caller** param, and **no** body key may reference an `authDerivedParams` name | Identity is path-only (§6.2). Same rule shape as the existing `queryParams` check. |
| **INV-M7** | a body wire key may be filled exactly one way — `fields` and `fixedFields` may not share a key | Direct analogue of the existing fixed/scalar/repeated/joined exclusivity, for the same reason: an ambiguous key is how a constant silently loses to caller input. |
| **INV-M8** | `mutation !== false` ⇒ `response` present, with a non-empty `successStatuses` all in `[200, 299]` | A mutation may not inherit an implicit success contract. It must state what success looks like. |
| **INV-M9** | `mutation !== false` ⇒ `repeatedQueryParams` and `joinedQueryParams` empty | Neither has a mutation use case; forbidding them keeps the mutation surface minimal. |
| **INV-M10** | every registered operation id has a `content-gateway` case | Today enforced only at runtime by the `default` branch (`content-gateway.ts:222`). A structural test makes the two tables provably agree. |

### 12.4 Descriptor factory

Mirrors `publicRead()` / `accountRead()`, so one shape cannot quietly disagree with
another:

```ts
function accountMutation(spec: {
  id: string;
  method: "POST" | "DELETE";
  pathTemplate: string;
  mutation: "ACCOUNT" | "PROGRESS";
  callerParams: Record<string, ParamSpec>;
  body?: BodySpec;
  response: ResponseContract;
}): OperationDescriptor;
// always: authDerivedParams {accountId}, scope ACCOUNT, auth BEARER,
//         fixedQuery {} (the legacy owners sent no query at all — preserved verbatim,
//         subject to BT8.0 confirming the live endpoints accept none),
//         queryParams {}, repeatedQueryParams {}, joinedQueryParams {}
```

Descriptor bodies are written **only at BT8.2–BT8.4**, from probe evidence. BT8.1
registers **none**, so all three stay refused at `content-gateway.ts:124`.

### 12.5 The backend gate replaces, not deletes

```ts
// today (browser-api-backend.ts:138)
if (descriptor.method !== "GET" || descriptor.mutation !== false) {
  throw new TransportError("OPERATION_NOT_MIGRATED", "method");
}

// BT8.1 — an authorization rule, still fail-closed by default
const isRead     = descriptor.method === "GET"  && descriptor.mutation === false;
const isMutation = descriptor.method !== "GET"  && descriptor.mutation !== false
                   && descriptor.scope === "ACCOUNT" && descriptor.auth === "BEARER"
                   && (descriptor.body === undefined || descriptor.method === "POST")
                   && descriptor.response !== undefined;
if (!isRead && !isMutation) {
  throw new TransportError("OPERATION_NOT_MIGRATED", "method");
}
```

The backend re-derives the invariants rather than trusting the registry, exactly as
it re-checks the URL origin the builder just produced. Two independent checks of the
same property is the existing house style, and for a write it is worth the
redundancy.

---

## 13. Body / Query Ownership

**The caller supplies values. The descriptor supplies the wire.**

```
caller param            →   validated structured param        →   descriptor-owned body
content_id: "GE1"           contentId predicate passed            { "content_id": "GE1" }
playhead: 42                requiredIntegerInRange(0, 86400)      { "playhead": 42 }
```

Serialization lives in the backend beside `buildRequestUrl`, as one exported
function that is testable directly:

```ts
export function buildRequestBody(call: ResolvedCall):
  { contentType: string; text: string } | undefined
```

Rules it obeys, all inherited from the F-2 discipline:

1. It knows the **rule**, never an operation name. The moment an operation id appears
   inside it, the registry has stopped owning the wire.
2. It emits `fixedFields` first, then `fields`, over `Object.entries` of the frozen
   descriptor maps — deterministic key order, so a serialization test is meaningful.
3. A declared field whose caller value is `undefined` is **omitted**, never emitted as
   `null`. (All BT8 body params are required, so this is a safety property, not a
   feature.)
4. It returns `undefined` when the descriptor declares no body. `DELETE` therefore
   sends nothing, and the page function sets no `Content-Type` at all.
5. `JSON.stringify` over a plain object built solely from validated primitives. No
   caller-supplied object is ever passed through; the caller cannot express an object
   in the first place, because every declared param predicate admits only a string or
   an integer.

**Never accepted as public parameters, on any tool:** `body`, `headers`, `method`,
`url`, `path`, `host`, `query`, `cookie`, `authorization`, `token`. These need no
denylist — `resolveCall`'s allow-list refuses every undeclared key by construction
(§6.3). What BT8 adds is a **test** that pins this for the mutation tools specifically,
because that is where the consequence is irreversible.

---

## 14. Response Model

### 14.1 Validation order (mutations)

Unchanged in structure from the read path, with two mutation-specific corrections:

```
1. truncated / over-cap        → INVALID_RESPONSE("over-cap")        [see 14.4]
2. status 0 (opaque redirect)  → MUTATION_OUTCOME_UNKNOWN("redirect")
3. status ∉ descriptor.response.successStatuses
                               → closed provider-error mapping (14.3)
4. response.body === "EMPTY"   → body must be empty; NO content-type requirement
   response.body === "JSON"    → isJsonContentType + JSON.parse
5. outcome derivation          → 14.2
```

**Correction 1 (step 4).** Today's backend requires a JSON content type
unconditionally (`browser-api-backend.ts:201`). A `204 No Content` — a very plausible
answer for `DELETE` — carries no `Content-Type`, and today it would be rejected as
`INVALID_RESPONSE("content-type")`, i.e. a *successful* removal reported as a
transport failure. The descriptor's `response.body` decides which check applies.

**Correction 2 (step 2).** With `redirect: "manual"`, a cross-origin redirect yields
an opaque response with `status === 0`. On a read that is harmlessly
`INVALID_RESPONSE`. On a mutation the request **was sent**, so it is `UNKNOWN`.

### 14.2 Outcome vocabulary

| Outcome | Meaning | State certainty |
|---|---|---|
| `APPLIED` | status ∈ `successStatuses`, body validated against the contract | CERTAIN applied |
| `ALREADY_IN_DESIRED_STATE` | the provider signalled *"the state you asked for already holds"* through a mapping the **probe proved** | CERTAIN, no change made |
| `REFUSED` | the provider rejected the request; state unchanged | CERTAIN not applied |
| `UNKNOWN_OUTCOME` | the request may have been sent and no verdict was obtained | **UNKNOWN** |

**`ALREADY_IN_DESIRED_STATE` is never synthesized.** It exists only where BT8.0
observed a distinguishable provider signal. In particular a bare `404` on
`REMOVE_FROM_WATCHLIST` maps to `API_NOT_FOUND`/`REFUSED` — **not** to
"already absent" — because F-1 proved a `404` on this API can mean "path not routed"
(§9.3).

### 14.3 Provider error mapping

| Status | Kind | Outcome | New? |
|---|---|---|---|
| `400` | `API_BAD_REQUEST` | `REFUSED` | **new** — today falls through to `INVALID_RESPONSE("status")`, which misdescribes a definite provider refusal as an unreadable response |
| `401` | `API_UNAUTHORIZED` | `REFUSED` | existing |
| `403` | `API_FORBIDDEN` | `REFUSED` | existing |
| `404` | `API_NOT_FOUND` | `REFUSED` | existing — **never** reinterpreted as an item-state signal |
| `409` | `API_CONFLICT` | `REFUSED`, or `ALREADY_IN_DESIRED_STATE` **only if BT8.0 proves that mapping** | **new** — today falls through to `INVALID_RESPONSE("status")` |
| `429` | `API_RATE_LIMITED` | `REFUSED` | existing — see §15 on why this is still not auto-retried |
| `5xx` | `API_SERVER_ERROR` | **`UNKNOWN`** for mutations | existing kind, **new semantics**: a `5xx` on a write means the provider received the request and may well have applied it before failing |
| other non-success | `INVALID_RESPONSE("status")` | `UNKNOWN` for mutations | existing kind, mutation-specific certainty |

`API_BAD_REQUEST` and `API_CONFLICT` are appended to `TransportErrorKind`, which the
union's own comment (`transport-error.ts:8-11`) explicitly anticipates: *"the union is
written so later frozen names … can be appended by their owning stage."* Their fixed
messages follow the existing discipline — no URL, header, body fragment or identity.

### 14.4 A note on the response cap

`MAX_API_RESPONSE_BYTES` is re-checked in Node after the page already truncated. For a
mutation, an over-cap response means the write may have been applied and its
acknowledgement could not be read: it maps to **`UNKNOWN`**, not to
`INVALID_RESPONSE`. Same byte cap, different certainty — that asymmetry between reads
and writes is the theme of this whole section.

### 14.5 MCP result shape

```json
{
  "tool": "crunchyroll_add_to_watchlist",
  "operation": "ADD_TO_WATCHLIST",
  "mutation": true,
  "mutation_class": "ACCOUNT",
  "content_id": "GY8VEQ95Y",
  "outcome": "APPLIED",
  "outcome_certainty": "CERTAIN",
  "retry_performed": false,
  "verify_with": "crunchyroll_get_watchlist"
}
```

`UPDATE_PLAYHEAD` additionally echoes the `playhead` it sent, and names
`crunchyroll_get_playheads`. `verify_with` is a **name**, not a performed action
(§4.9). The provider's own response body is **not** passed through: none of the three
tools ever published one (the legacy owners returned a synthesized
`{success, message}`), and forwarding an unproven provider payload would be inventing
a public contract at exactly the wrong moment.

---

## 15. Idempotency / Retry Policy

### 15.1 Per-operation analysis

| | `ADD_TO_WATCHLIST` | `REMOVE_FROM_WATCHLIST` | `UPDATE_PLAYHEAD` |
|---|---|---|---|
| Relevant initial state | id ∈ watchlist? | id ∈ watchlist? | current `playhead`, `fully_watched` |
| Desired operation | id ∈ set | id ∉ set | `playhead := v` |
| Expected result | membership | non-membership | assignment |
| State-level idempotence | **YES** (set insert) | **YES** (set delete) | **only for the same `v`**; observably touches `last_modified`, possibly `fully_watched` |
| Response-level idempotence | **UNPROVEN** | **UNPROVEN** | **UNPROVEN** |
| retry-safe | **CONDITIONAL** | **CONDITIONAL** | **NO** |
| Timeout after send | `UNKNOWN` → resolve by `get_watchlist` | `UNKNOWN` → resolve by `get_watchlist` | `UNKNOWN` → resolve by `get_playheads` |
| Worst case if retried blindly | a duplicate add reported as a failure | an absent-item `404` reported as a failure | **a stale value silently rewinds the user's real progress** |
| Reversible | yes, minus `date_added` | yes, minus `date_added` | only if the prior value was captured first |

### 15.2 The rule

> **BT8 performs no automatic retry of any mutation, under any error, ever.**

Three independent reasons, any one of which would suffice:

1. **No proven duplicate contract.** None of the three has an observed
   already-in-desired-state response, so a retry's answer could not be interpreted
   even if the retry were safe.
2. **No idempotency key.** The provider offers no mechanism this project has observed
   for de-duplicating a re-sent write, and the transport must not invent one.
3. **`UPDATE_PLAYHEAD` can be made worse by retrying** (§10.4). A policy that is
   correct for two of three operations and harmful for the third is not a policy;
   the conservative rule that is correct for all three is.

This does not weaken BT3 — it strengthens the same idea. `runCurrent` already
guarantees a result is *"never replayed or reissued under a newer generation"*;
BT8 extends that to *never reissued at all*.

**`429` is explicitly included.** Rate limiting is the classic auto-retry case, and it
is still refused: BT8 cannot prove the rate-limited request was not applied. The
caller may retry after reading — with fresh knowledge of the true state.

### 15.3 Avoiding accidental double application

- No retry loop exists anywhere on the mutation path.
- `runCurrent` is entered **once** per call; a mutation is never re-bound.
- The channel is opened once and closed in `finally`; the close never masks the
  outcome (existing behaviour, `browser-api-backend.ts:186-189`).
- Single-flight de-duplication (as `refreshRequest` does for token refresh) is
  deliberately **not** applied to mutations: two identical user-intended writes are
  two intentions, and collapsing them would be the transport inventing semantics.
- The MCP boundary is stateless; nothing replays a call after a client reconnect.

---

## 16. Unknown-Outcome Semantics

### 16.1 The kind

```ts
| "MUTATION_OUTCOME_UNKNOWN"
// fixed message: "The mutation may or may not have been applied; the outcome is unknown"
```

Appended to `TransportErrorKind`, which is the right home: it is the transport's
closed vocabulary, the union anticipates later names, and the `detail` field carries a
structural cause name (never a value) exactly as every other kind does.

Causes, as `detail`: `"deadline"`, `"disconnect"`, `"page-exception"`,
`"auth-generation"`, `"over-cap"`, `"malformed"`, `"redirect"`, `"server-error"`.

### 16.2 Certain-not-sent vs unknown

| Certain **not sent** — ordinary error kinds | Possibly sent — `MUTATION_OUTCOME_UNKNOWN` |
|---|---|
| `INVALID_ARGUMENTS`, `CALLER_SUPPLIED_IDENTITY` | deadline expiry after the CDP send was dispatched |
| `OPERATION_NOT_MIGRATED` (all three sites) | browser/CDP disconnect after dispatch |
| `AUTH_NOT_READY` (bind failed / not `AUTHENTICATED`) | page exception (pre- vs post-send indistinguishable) |
| `BROWSER_UNAVAILABLE` raised **before** `channel.request` dispatches — channel closed, origin re-check, generation mismatch, lifecycle not `BROWSER_READY` | `runCurrent` post-check failure (§17) |
| `API_BAD_REQUEST`, `API_UNAUTHORIZED`, `API_FORBIDDEN`, `API_NOT_FOUND`, `API_CONFLICT`, `API_RATE_LIMITED` — the provider answered a definite refusal | `5xx`, over-cap, malformed body, opaque redirect |

The dividing line is a single instruction: `connection.send("Runtime.callFunctionOn", …)`.
Every pre-flight check in `channel.request` precedes it, which is why they can be
classified as certain.

### 16.3 UNKNOWN is resolved by reading, never by retrying

This is the design's central answer to §6 of the mandate, and it is only available
because BT7 finished its work:

| Mutation | Resolver (migrated, live-proven) |
|---|---|
| `ADD_TO_WATCHLIST` | `crunchyroll_get_watchlist` |
| `REMOVE_FROM_WATCHLIST` | `crunchyroll_get_watchlist` |
| `UPDATE_PLAYHEAD` | `crunchyroll_get_playheads` with `content_ids: [id]` |

The `UNKNOWN` result therefore carries `verify_with`, and its user-facing meaning is
concrete and actionable: *"the request may have been applied; read X to find out."*
Neither the model nor the user is left to guess, and nothing is re-sent into an
unknown state.

The MCP does not perform the read itself (§4.9): it would double latency on every
mutation, it would still be subject to provider eventual consistency, and — most
importantly — a verification read on an `UNKNOWN` outcome is a decision about what to
do next, which belongs to the caller.

---

## 17. Auth Generation Handling

### 17.1 What exists

`runCurrent` (`auth-context.ts:594-619`) performs a synchronous post-check after the
callback settles. On a generation change it throws `AUTH_CONTEXT_STALE` or
`AUTH_IDENTITY_CHANGED`, which `asTransportError` maps to `AUTH_GENERATION_CHANGED`
("Authentication changed while the request was in flight"). The response is discarded.

For a read that is exactly right. For a mutation it is **insufficient**, and the
reason is subtle enough to state precisely.

### 17.2 The problem, stated precisely

The post-check runs *after* `execute` returned. So on a mutation the transport may be
holding a **validated 2xx** at the very moment it learns the generation changed. Two
naive readings are both wrong:

- *"Report failure / not executed."* False. A `2xx` was observed; the write almost
  certainly landed. This is exactly what §15 of the mandate forbids.
- *"Report `APPLIED`."* Also false, and worse. `AUTH_IDENTITY_CHANGED` means the
  identity itself may have changed. The write may have applied to the **previous
  account**. Reporting `APPLIED` would be a claim about an account the caller is no
  longer talking to.

### 17.3 The ruling

On a mutation, a `runCurrent` post-check failure yields:

```
outcome:            UNKNOWN_OUTCOME
error kind:         MUTATION_OUTCOME_UNKNOWN
detail:             "auth-generation"
auth_generation_consistent: false
user-facing meaning: "The session changed while this write was in flight. It may have
                      been applied, possibly under the previous session. Re-read to
                      confirm; nothing was re-sent."
```

Three properties are preserved simultaneously:

1. **BT3's guarantee is untouched.** The response content is still discarded, still
   not returned, still never replayed under a newer generation. BT8 changes only how
   the *outcome* is labelled.
2. **No false negative.** It never says "not executed" without proof.
3. **No false positive.** It never says "applied" when *which account* is in doubt.

If the generation changes and the mutation is **also** the kind of failure that is
certain-not-sent — i.e. `bind()` itself failed before any request existed — the
ordinary `AUTH_NOT_READY` / `AUTH_GENERATION_CHANGED` applies with CERTAIN certainty.
The distinction is again the dispatch instruction, not the error class.

---

## 18. Browser / CDP Boundary

### 18.1 Preserved integrally

```
Hermes → MCP tool → content gateway → registry/dispatcher → browser API backend
       → closed ApiExecutionChannel → managed page (fixed origin) → Crunchyroll
```

No other route exists, and BT8 adds none. Explicitly still forbidden, with no
exception introduced by this design: `Runtime.evaluate`; arbitrary JS; a generic CDP
send reachable from a caller; manual browser control by the caller; sandbox bypass;
Node-originated Crunchyroll egress (guard remains installed unconditionally); the
`Network` domain; cookie access; following redirects.

### 18.2 The minimal primitive expansion

This is the single largest boundary change in BT8, so its shape is fixed here.

```ts
export interface ApiExecutionRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "DELETE";        // widened from the "GET" literal
  readonly authorization: string;
  readonly deadlineMs: number;
  readonly maxBytes: number;
  /** Descriptor-owned. Absent for every GET and every DELETE. */
  readonly body?: { readonly contentType: string; readonly text: string };
}
```

```js
// still ONE frozen source literal; still never assembled, interpolated or
// influenced by a caller, the registry, the response or anything remote.
async function (url, method, authorization, maxChars, bodyText, bodyContentType) {
  const headers = { Authorization: authorization };
  const init = { method, headers, credentials: "omit", redirect: "manual" };
  if (typeof bodyText === "string") {
    headers["Content-Type"] = bodyContentType;
    init.body = bodyText;
  }
  const response = await fetch(url, init);
  // … cap / status / contentType handling unchanged …
}
```

Why this is the minimum, and why it does not erode the boundary:

- **Two further arguments, both structured.** They cross through
  `Runtime.callFunctionOn`'s `arguments` array exactly as `url`, `method`,
  `authorization` and `maxChars` already do. Nothing is concatenated into source.
- **No header map, ever.** The function sets exactly two header names, both literal in
  its own source. A caller cannot name a header, let alone add one.
- **`Content-Type` is set only when a body exists**, so a bodyless `DELETE` sends no
  content type — closing the silent-wrong-request hazard identified in §2.E.3.
- **`credentials: "omit"` and `redirect: "manual"` are retained verbatim.** A write
  must not carry ambient cookie authority (T8) and must not be followed to an
  unvalidated origin (T9).
- **`method` remains descriptor-derived.** It was already a structured argument; what
  changes is that a value other than `"GET"` becomes expressible — and only for a
  descriptor that passed every invariant in §12.3.
- The origin check, generation check, lifecycle check, deadline, byte cap, `silent`,
  `userGesture: false`, `awaitPromise`, `returnByValue` and the frozen result-shape
  validation are all **unchanged**.

No new primitive is introduced. This is a widening of the existing one, submitted here
as the explicit design §16 of the mandate requires.

---

## 19. Redaction

### 19.1 New values that appear during a mutation

| Value | Class | Handling |
|---|---|---|
| Request body JSON (`content_id`, `playhead`) | public ids / integers | Permitted under the existing public-id policy. Never logged as a raw body; the audit record carries the **fields**, not a serialized body. |
| `Content-Type` header value | build constant | Not sensitive. |
| HTTP method | descriptor constant | Not sensitive. |
| Outcome / certainty / status class | derived | Not sensitive. |

**No new secret class is introduced by BT8.** The mutation surface adds no credential,
no cookie, no session material and no identity that was not already present on the
read path.

### 19.2 Never logged, never returned, never recorded

- Bearer / `Authorization` value (already covered by static patterns and by
  `registerSensitiveValue` at `runCurrent` entry).
- Cookies, session material, refresh/access tokens.
- The real `accountId` — registered as a redaction secret at `bind()` and, more
  importantly, **never structurally assembled into any BT8 output**. BT7 §23's rule
  stands verbatim: identity is omitted *structurally*, not regex-masked.
- **Any materialized URL.** The audit record and every probe log carry the path
  **template** at most (`/content/v2/{accountId}/watchlist/{content_id}`), never a
  rendered path.
- Provider request/response bodies and provider error text. `TransportError` messages
  remain fixed strings with a structural `detail` name.

### 19.3 One BT8-specific rule

The mutation result and the audit record are **constructed field by field from known
values**, never by spreading a provider payload or an internal object. That is what
makes "the accountId never appears" a structural property rather than a filtering
promise — the same reasoning that made `bind()` attach identity as a non-enumerable
property so that spread and `JSON.stringify` cannot emit it.

---

## 20. Failure Matrix

`RESULT` is the closed error kind or the success outcome. `RETRY?` is always
**NO — automatic**; the column records whether the *caller* may safely retry after
determining state.

| # | Condition | MCP result | Retry (caller) | State certainty | User-facing meaning |
|---|---|---|---|---|---|
| 1 | Invalid args (bad `content_id`, non-integer `playhead`, out of range, missing required) | `INVALID_ARGUMENTS` | yes, after fixing | **CERTAIN not applied** | "The arguments were rejected. Nothing was sent." |
| 2 | Caller-supplied identity (`account_id`, `profile_id`, …) | `CALLER_SUPPLIED_IDENTITY` | yes, without that argument | **CERTAIN not applied** | "You may not choose the account. Remove that argument; the server uses your session." |
| 3 | Caller-supplied transport (`url`, `method`, `body`, `headers`, …) | `INVALID_ARGUMENTS` | yes, without it | **CERTAIN not applied** | "Unknown argument. The server owns the request." |
| 4 | Auth not ready (no session / `bind()` refuses / not `AUTHENTICATED`) | `AUTH_NOT_READY` | yes, after login | **CERTAIN not applied** | "Log in first. Nothing was sent." |
| 5 | Browser unavailable **before** dispatch (not `BROWSER_READY`, no page context, channel closed, origin re-check, generation mismatch) | `BROWSER_UNAVAILABLE` | yes | **CERTAIN not applied** | "The managed browser is unavailable. Nothing was sent." |
| 6 | Provider `400` | `API_BAD_REQUEST` → `REFUSED` | no (the request is wrong) | **CERTAIN not applied** | "Crunchyroll rejected the request." |
| 7 | Provider `401` | `API_UNAUTHORIZED` → `REFUSED` | after re-auth | **CERTAIN not applied** | "Your session was rejected. Log in again." |
| 8 | Provider `403` | `API_FORBIDDEN` → `REFUSED` | no | **CERTAIN not applied** | "Crunchyroll refused this operation for this content or account." |
| 9 | Provider `404` | `API_NOT_FOUND` → `REFUSED` | no | **CERTAIN not applied** | "Crunchyroll has no such resource. **Not** to be read as 'already removed'." |
| 10 | Provider `409` (if observed) | `API_CONFLICT` → `REFUSED`, or `ALREADY_IN_DESIRED_STATE` **only if BT8.0 proves it** | no | **CERTAIN** | "The requested state already holds, or conflicts." |
| 11 | Provider `429` | `API_RATE_LIMITED` → `REFUSED` | later, **after reading state** | **CERTAIN not applied** | "Rate limited. Nothing was re-sent; check state before retrying." |
| 12 | Provider `5xx` | **`MUTATION_OUTCOME_UNKNOWN("server-error")`** | only after reading state | **UNKNOWN** | "Crunchyroll failed after receiving the request. It may have applied — read to confirm." |
| 13 | Timeout **before** dispatch | `BROWSER_UNAVAILABLE` | yes | **CERTAIN not applied** | as #5 |
| 14 | Timeout **after** dispatch (deadline wins the race) | **`MUTATION_OUTCOME_UNKNOWN("deadline")`** | only after reading state | **UNKNOWN** | "Timed out after sending. It may have applied — read to confirm." |
| 15 | Connection dropped after dispatch | **`MUTATION_OUTCOME_UNKNOWN("disconnect")`** | only after reading state | **UNKNOWN** | as #14 |
| 16 | Page exception during the fetch | **`MUTATION_OUTCOME_UNKNOWN("page-exception")`** | only after reading state | **UNKNOWN** | as #14 |
| 17 | Malformed / over-cap / non-conforming response body | **`MUTATION_OUTCOME_UNKNOWN("malformed" \| "over-cap")`** | only after reading state | **UNKNOWN** | "The answer could not be read. The write may have applied." |
| 18 | Opaque redirect (`status === 0`) | **`MUTATION_OUTCOME_UNKNOWN("redirect")`** | only after reading state | **UNKNOWN** | as #17 |
| 19 | Auth generation changed (post-check) | **`MUTATION_OUTCOME_UNKNOWN("auth-generation")`** | only after reading state, under the new session | **UNKNOWN** | "The session changed mid-write. It may have applied, possibly under the previous session." (§17) |
| 20 | Operation not migrated | `OPERATION_NOT_MIGRATED` | no | **CERTAIN not applied**, 0 transport calls | "This operation is not served by the browser transport yet." |
| 21 | Node-originated Crunchyroll request (should be unreachable) | `NODE_CRUNCHYROLL_FORBIDDEN` | no | **CERTAIN not applied** | "Blocked: this build may not reach Crunchyroll outside the browser transport." |

Rows 12, 14–19 are the `UNKNOWN` set: **7 of 21 conditions**. Every one of them names
a read that resolves it (§16.3).

---

## 21. Focused Test Plan

Proportional, per §20 of the mandate. BT1–BT7 history is not re-run; the full suite
runs only at candidate closure.

**A. Registry structural tests** (`test/bt8-mutations.test.ts`)
- INV-M1…INV-M10, one focused case each, asserting `TransportError("INVALID_ARGUMENTS")`
  at `createOperationRegistry` time.
- A `GET` declaring `mutation: "ACCOUNT"` is refused (INV-M2, both directions).
- `PUT` / `PATCH` / lowercase `"post"` are refused (INV-M3).
- A body field naming `accountId` is refused (INV-M6).
- A key in both `fields` and `fixedFields` is refused (INV-M7).
- Every `PRODUCTION_OPERATIONS` entry still satisfies every pre-existing BT5/BT6/BT7
  invariant (regression).

**B. Tool schema tests**
- The three tools publish `annotations` with `readOnlyHint: false`, and
  `destructiveHint` matching §11.
- The three publish `additionalProperties: false`.
- No read tool acquires `readOnlyHint: false`.

**C. Identity / auth refusal tests**
- Each mutation tool refuses `account_id`, `accountId`, `profile_id`, `profileId`
  with `CALLER_SUPPLIED_IDENTITY` — **and zero transport calls**.
- Each refuses `url`, `path`, `method`, `body`, `headers`, `query`, `token`,
  `authorization`, `cookie` with `INVALID_ARGUMENTS` — and zero transport calls.
- **Verbatim forwarding proof** (§6.3): the gateway does not project, so an
  undeclared key reaches `resolveCall` and is refused rather than dropped.
- A bound mutation resolves `{accountId}` from the record only; the built URL contains
  the record's value and never a caller value.

**D. Mutation boundary tests**
- Every un-migrated mutation answers `OPERATION_NOT_MIGRATED` with **0** transport
  calls — asserted at the end of **every** stage BT8.1…BT8.4 for the operations that
  stage has not migrated. This is the fail-closed ratchet.
- The backend gate refuses a structurally invalid mutation descriptor even if it
  somehow entered the registry (independent re-derivation, §12.5).
- The Node egress guard records **0** blocked attempts throughout.

**E. Request serialization tests**
- `buildRequestBody` emits exactly the declared keys, deterministic order,
  `fixedFields` first; omits an undefined optional; returns `undefined` with no body
  spec.
- `buildRequestUrl` on a mutation descriptor produces the identity-bearing path and
  **no query string** (the mutation factory declares none).
- `buildRequestBody` contains no operation name (source-level assertion, mirroring the
  existing F-2 discipline test).
- The page-side function receives the body as a **structured argument**; the frozen
  function source contains no interpolation.

**F. Response / error mapping tests**
- `successStatuses` honoured per descriptor; a `200` on a `204`-only contract is not
  silently accepted.
- `response.body: "EMPTY"` accepts a `204` with **no** `Content-Type` (the correction
  in §14.1) and rejects a non-empty body.
- `400 → API_BAD_REQUEST`, `409 → API_CONFLICT`, `404 → API_NOT_FOUND` and **not**
  `ALREADY_IN_DESIRED_STATE`.
- `5xx` on a mutation → `MUTATION_OUTCOME_UNKNOWN`, while `5xx` on a **read** still →
  `API_SERVER_ERROR` (no read regression).
- Result payload shape (§14.5); the provider payload is not passed through.

**G. Retry / unknown-outcome tests**
- Deadline after dispatch → `MUTATION_OUTCOME_UNKNOWN("deadline")`, and the fake
  channel records **exactly one** `request` call.
- Disconnect / page-exception / over-cap / malformed / `status 0` → the matching
  `UNKNOWN` detail, one request each.
- Generation change during a mutation whose fetch returned `2xx` →
  `MUTATION_OUTCOME_UNKNOWN("auth-generation")`, `auth_generation_consistent: false`,
  **not** `APPLIED`, **not** "not executed", one request only (§17).
- A failure raised before dispatch → the ordinary kind with CERTAIN certainty and
  **zero** `request` calls.
- No code path anywhere on the mutation route calls `executeResolved` twice.

**H. Focused live validation** — **one per mutation**, at BT8.5, only if BT8.0
authorized and completed: read → mutate → read → restore, exactly the P1/P3/P5 shape,
with the same structural logging discipline (§11.3). Not a full live regression sweep.

Not repeated: BT1–BT7 gates, the zero-egress bwrap sweep (until closure), the auth
state machine, the ownership/adoption suite.

---

## 22. Implementation Stages

Each stage leaves every not-yet-migrated operation **fail-closed with
`OPERATION_NOT_MIGRATED` and zero transport calls**, and each is independently
reviewable.

| Stage | Content | Descriptors registered | Blocked on evidence |
|---|---|---|---|
| **BT8.0** | **Provider evidence probe** (§11.3). Separate authorized round. Requires BT8.1 built, so the probe exercises the real path. | none | — (it *is* the evidence) |
| **BT8.1** | Structural mutation support: INV-M1…M10; `BodySpec`; `ResponseContract`; `accountMutation()` factory; the widened `ApiExecutionRequest` + page function (§18.2); `buildRequestBody`; the backend authorization gate (§12.5); `MUTATION_OUTCOME_UNKNOWN`, `API_BAD_REQUEST`, `API_CONFLICT`; the outcome/audit shapes; tool `annotations` + `additionalProperties: false`. | **none** | **NO — implementable today** |
| **BT8.2** | `ADD_TO_WATCHLIST`: descriptor + gateway case + outcome mapping; legacy `addToWatchlist` **removed from `src/api.ts` in the same commit** (BT5 rule). | 1 | YES (P1, P2) |
| **BT8.3** | `REMOVE_FROM_WATCHLIST`: same shape; item-absent mapping only if P4 proved it; legacy owner removed in the same commit. | 2 | YES (P3, P4) |
| **BT8.4** | `UPDATE_PLAYHEAD`: same shape; unit/range/type fixed from P5–P7; legacy owner removed in the same commit. | 3 | YES (P5–P7) |
| **BT8.5** | Focused live validation (one per mutation), full-suite run, zero-egress sweep, closure report. | 3 | YES |

**Ordering rationale.** `ADD` first: set semantics make it the only one whose worst
case cannot corrupt state, and it is self-verifiable through a read proven live.
`REMOVE` second: verifiable, and its undo (`ADD`) is already migrated by then.
`UPDATE_PLAYHEAD` last: the only non-set operation, the only one whose retry hazard is
a silent regression of real user data, and the one whose path has a demonstrated
contract-drift history (F-2).

**BT8.1 is the important claim in this table.** It is fully specified, needs no
provider evidence, and ships with *zero* mutation descriptors — so the three tools
remain refused at `content-gateway.ts:124` exactly as they are today, verified by the
same tests that verify it now. The capability to express a mutation arrives before any
mutation exists, which is what makes BT8.2–BT8.4 small, and it makes BT8.0's probe run
through production code rather than around it.

---

## 23. Open Questions

| # | Question | Owner / resolution path |
|---|---|---|
| **OQ-1** | Do the watchlist write endpoints require `locale`? The legacy owners sent none; `GET_WATCHLIST` sends `locale=en-US`; `GET_PLAYHEADS` sends none. | BT8.0 — try without first (verbatim preservation), then with, and record both. |
| **OQ-2** | Is `ADD_TO_WATCHLIST`'s `{}` body required, or does the endpoint accept none? Does it require `Content-Type: application/json`? | BT8.0 P1. |
| **OQ-3** | `UPDATE_PLAYHEAD` with `playhead` beyond content duration — clamp, reject, or set `fully_watched`? **Deliberately excluded from the first probe** because the plausible outcome pollutes real user state. | Needs its own authorization, on a control item the user accepts marking watched. |
| **OQ-4** | Does the provider distinguish "already present" / "already absent" in a machine-readable way (status or body error code)? Without this, `ALREADY_IN_DESIRED_STATE` never fires. | BT8.0 P2, P4. |
| **OQ-5** | Could the CDP `Network` domain let the transport distinguish "timeout before send" from "timeout after send", shrinking the UNKNOWN set from 7 conditions to 6? | **Out of scope.** It is a boundary expansion (§18) and would need its own design gate. Recorded, not adopted. |
| **OQ-6** | Should an `UNKNOWN` outcome optionally trigger a verification read inside the MCP (`verify: true`)? | Deferred past BT8. §4.9 keeps BT8 to naming the resolver. |
| **OQ-7** | Is `playhead` an integer on the wire, or does the provider accept/return fractions? | BT8.0 P5 — the design requires an integer until proven otherwise. |
| **OQ-8** | The watchlist `is_favorite` toggle appears in read shapes with no tool and no legacy owner. Adopt later? | FUTURE. Catalogued in §3, not designed. |
| **OQ-9** | CI's sandboxed-Chromium pendency is transversal and untouched here (§22 of the mandate). Does BT8 closure require it green? | Recorded as a **closure/release dependency**, not a BT8 design dependency. Not fixed in this round. |

---

## 24. Go / No-Go Ruling

### Per operation

**`ADD_TO_WATCHLIST`: BLOCKED — PROVIDER EVIDENCE REQUIRED**
Design complete (§8): contract, identity binding, body ownership, outcome model,
retry ruling, postcondition instrument. Blocked on BT8.0 P1–P2 — method, item
sub-path routing, body requirement, success status and duplicate semantics are all
unproven, and the sole artefact describing them is dead legacy code of the exact class
F-1 proved unreliable.

**`REMOVE_FROM_WATCHLIST`: BLOCKED — PROVIDER EVIDENCE REQUIRED**
Design complete (§9). Blocked on BT8.0 P3–P4 — additionally, `204`-with-no-content-type
would be misreported by today's response validation, and item-absent semantics must not
be inferred from a `404` (F-1).

**`UPDATE_PLAYHEAD`: BLOCKED — PROVIDER EVIDENCE REQUIRED**
Design complete (§10). Blocked on BT8.0 P5–P7 — body key names, unit, type, success
status, clamping and `fully_watched` side effects are unproven, on the one path whose
wire contract F-2 already caught drifting.

### Overall

> ## BT8 DESIGN — PASS WITH DEFERRED OPERATIONS

**What passes.** The design itself is complete and closed on every axis the mandate
required: identity boundary preserved and *strengthened* (§6.3), mutation authority
model, idempotency analysis per operation, unknown-outcome semantics with a concrete
resolution path, auth-generation handling that is neither a false positive nor a false
negative, registry evolution that replaces rather than removes the guard, a minimal and
fully specified browser-boundary expansion, redaction, a 21-row failure matrix and a
proportional test plan. **BT8.1 is implementable immediately and requires no provider
evidence.**

**What is deferred.** All three mutations, each blocked on BT8.0. That is a deliberate
ruling, not an incomplete design: §25 of the mandate permits a design to conclude that
a mutation still needs a probe, and the honest reading of the evidence is that all
three do. Implementing any of them from the legacy literal alone would be exactly the
failure BT7's F-1 and F-2 exist to prevent.

**Consequence.** Nothing changes for the caller in this round. All three tools remain
published and remain `OPERATION_NOT_MIGRATED`, refused locally in ≤1 ms with zero
transport calls, exactly as BT7 left them.
