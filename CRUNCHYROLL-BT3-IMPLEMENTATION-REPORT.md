# MCP Crunchyroll — BT3 Implementation Report

Candidate for external review. This report records what was implemented, what
was observed, and what was deliberately not done. It authorizes nothing.

## 1. Outcome

| Property | Value |
|---|---|
| Branch | `bt3-auth-context-design` |
| Frozen BT2 head | `ef05d3d4e1f577fcb28a908c3fdc33593c3f8b58` |
| Design Gate 0 head at start | `6b2a6bddf71aaaa5e9d04f47cbdf6c96676f6b82` |
| Tasks executed | 0, 1, 2, 3, 4, 5 |
| Production files added | 1 (`src/transport/auth-context.ts`, 733 lines) |
| Test files added | 1 (`test/auth-context.test.ts`, 1629 lines) |
| Existing source/test/package files changed | 0 |
| Dependencies added | 0 |
| Public MCP tools | 21, unchanged |
| `PRODUCTION_OPERATIONS` | `Object.freeze([])`, unchanged |
| Full suite | 526 tests, 526 pass, 0 fail, 0 skipped |
| Live Crunchyroll access | none |

## 2. Commits

One commit per task, in order, no rewrite, no merge, no push:

| Commit | Task | Subject |
|---|---|---|
| `eb58489` | 1 | `BT3: define opaque auth context revisions` |
| `5afc238` | 2 | `BT3: own auth context lifecycle and generation` |
| `ee0c87b` | 3 | `BT3: reject stale auth work across async boundaries` |
| `9035e02` | 4 | `BT3: bind resolved calls to current auth identity` |
| (this commit) | 5 | `BT3: verify auth context boundary remains internal` |

The two design commits `fd5b818` and `6b2a6bd` remain their ancestors, unaltered.

## 3. Per-task RED → GREEN record

Test totals are the whole repository suite after each task.

| Task | RED observed | GREEN | Suite |
|---|---|---|---|
| 0 | n/a — precondition gate | baseline recorded | 388 |
| 1 | `ERR_MODULE_NOT_FOUND`, then 11 vocabulary assertions | 11/11 | 399 |
| 2 | 41 behavioural failures (no authority transitions) | 52/52 | 440 |
| 3 | 19 behavioural failures (no CAS, no guarded execution) | 76/76 | 464 |
| 4 | 30 behavioural failures (no wrappers, no binder) | 109/109 | 497 |
| 5 | 1 failure — see §5 | 138/138 | 526 |

Every task ran typecheck (`tsc --noEmit`), build (`node build.js`), the full
suite and a forbidden-path diff before its commit. All exit codes were 0.

## 4. Task 0 evidence pendency — closed

Task 0 reported one open item: `test/mcp-harness.test.ts:108`, a frozen BT0/BT1
characterization test, drives `crunchyroll_login` with the reserved-domain
address `audit-test@example.invalid`, and that path reaches
`src/api.ts:25 — AUTH_BASE = "https://auth.crunchyroll.com"`. Design §17
required this to be reported rather than silently accepted.

It is now closed by evidence rather than by a code change (Task 0 forbids test
edits; BT3 forbids touching `src/api.ts`):

- the entire suite was executed inside a `bwrap --unshare-net` namespace with
  `BT2_NET_ISOLATED=1` — the project's own network-isolation convention — and
  produced **526 tests, 526 pass, 0 fail, 0 skipped**, identical to the
  unisolated run;
- isolation was verified as genuine from inside the same sandbox: DNS returns
  `ENOTFOUND` and an outbound TCP connect returns `ENETUNREACH`;
- the real-browser BT2 suite still executed there (8/8), because it uses only a
  loopback server.

A suite that passes identically with egress physically impossible performs no
live Crunchyroll access. The characterization test passes *because*
authentication does not succeed. No credentials, account, session, token or
browser navigation to Crunchyroll were involved at any point.

The outbound path itself remains carry-forward work for the gate that owns
`src/api.ts`; BT3 neither repaired nor widened it.

## 5. Task 5 observation, recorded honestly

Task 5 requires writing the security assertions first and reporting the result
without fabricating a defect. Of 29 new closure assertions, **one was RED**:

> `no map of any kind is keyed by an AuthContext`

The cause was the assertion, not the product. The regex `Record<\s*AuthContext`
matched `Record<AuthContextErrorKind, string>` — the table of three fixed error
messages, keyed by an error-kind string union, not a handle-to-secret
association. The assertion was tightened to require the key type to be
`AuthContext` itself (`/(?:Map|Record)<\s*AuthContext\s*[,>]/`). **No production
code was changed in Task 5.** No omission in Tasks 1–4 was found.

## 6. Design decisions worth a reviewer's attention

Three points where the frozen text needed interpretation. Each is implemented as
described and commented at the call site.

1. **The post-execution check is currentness-only, not usability.** §13.6 puts
   "usable expiration" in the pre-check; §13.8 defines the post-check against a
   generation change while the consumer was awaiting, and §13.9 gives its
   failure the `AUTH_CONTEXT_STALE` name. Including expiry in the post-check
   would discard an authorized result because the token expired after the
   request already succeeded, which protects nothing. Pre-check: identity,
   non-aborted, usable. Post-check: identity, non-aborted.

2. **Expiry is not an authority transition.** §21.6 says the authority
   "invalidates as required and refuses execution", while §10 lists
   "an operation acquisition/currentness check" among the things that must not
   increment, and §15 says acquisition "still fails closed if the material is
   expired". Implemented as: expired material fails acquisition, binding and
   execution with `AUTH_CONTEXT_UNAVAILABLE`, and changes no state. Only a
   trusted producer mutates the authority.

3. **`REFRESH` cannot bootstrap an identity.** A refresh against a non-READY
   authority has no continuity to verify, so it is refused as
   `AUTH_CONTEXT_UNAVAILABLE` rather than silently becoming an establish.

One hardening goes beyond the letter of the design in the safe direction:
`bind` registers the resolved account/profile values with the active redaction
scope immediately. D0-H1 obliges the eventual renderer to register them before
they can surface; discharging it at bind time is strictly earlier and removes
the need for a future stage to remember. Outside an operation scope
`registerSensitiveValue` is a documented no-op and retains nothing.

## 7. Invariant coverage

| Invariant | Where it is proven |
|---|---|
| BT3-I1 | no exported constructor/brand; forged and rehydrated lookalikes rejected |
| BT3-I2 | 11 caller-injection cases rejected by the registry with backend call count 0 |
| BT3-I3 | source scan: one `WeakSet<AuthContext>`, no second record root |
| BT3-I4 | generation table across install, refresh, invalidate, identity change |
| BT3-I5 | overflow publishes EXHAUSTED at the maximum; cross-epoch inequality |
| BT3-I6 | T3: generation-2 material never substituted into a generation-1 handle |
| BT3-I7 | three reentrancy tests: invalidation, replacement, overflow |
| BT3-I8 | post-check discards results from invalidated and replaced generations |
| BT3-I9 | frozen null-prototype handle; `JSON.stringify` yields `{}` |
| BT3-I10 | token registered before the callback, on success and failure paths |
| BT3-I11 | non-enumerable wrapper properties; frozen map; never in `callerParams` |
| BT3-I12 | account change and profile add/remove/change each yield `AUTH_IDENTITY_CHANGED` |
| BT3-I13 | 16 rejected candidate shapes produce no context and no transition |
| BT3-I14 | no BT2 symbol, CDP token or lifecycle import exists in the module |
| BT3-I15 | forbidden-path diff empty against the frozen BT2 head |
| BT3-I16 | source and bundle harness: 21 names, byte-equivalent schemas |
| BT3-I17 | all six reachable failure paths swept for token/identity/epoch sentinels |
| BT3-I18 | network-isolated full suite; source scan for network/browser/fs capability |
| BT3-I19 | issuance-only WeakSet; retained stale handle retrieves nothing |

## 8. Unreachability

Mechanically asserted in the suite, not merely by inspection:

- a transitive import walk from `src/index.ts` never reaches
  `auth-context.ts` (the walker is sanity-checked against a module it does
  reach);
- no other file under `src/` imports `auth-context.js`;
- `dist/index.js` contains none of the module's markers — the three fixed error
  messages, `AuthContextAuthority`, `issuedContexts`;
- `PRODUCTION_OPERATIONS` is still empty and frozen;
- the 21 baseline schemas admit no `Authorization`, `bearer`, `cookie`,
  `token`, `accountId`, `profileId`, `epoch`, `authGeneration`, `context`, CDP
  or browser key;
- `package.json` dependencies, devDependencies and engine floor are unchanged.

## 9. Not done, deliberately

No login, refresh HTTP, logout persistence migration, cookie or bearer
extraction, `Fetch.*`, `Network.*`, `Runtime.evaluate`, CDP expansion, browser
launch, endpoint migration, operation registration, dispatcher or backend
cutover, public MCP change, composition-root instantiation, BT4 or BT5 work. No
push, no merge, no change to `main`, no dependency remediation, no `npm audit
fix`. The nine carried-forward npm advisories remain a separate gate.

## 10. Verdict

BT3 implementation candidate complete and ready for external review. Approval of
this report authorizes nothing beyond it: BT4 and BT5 remain closed.

---

## External Review FIX1 — BT3-R1

One surgical fix commit on top of the Task 5 candidate `a66672d`. The Task 1–5
history above is unchanged and remains the record of how the module was built.

### The finding

`AuthMaterialCandidate` is an ordinary JavaScript object at runtime, so its
properties may be getters or Proxy traps — every read is a call into
producer-controlled code that can synchronously reenter the authority. The
committed implementation read each field two to four times (validation, refresh
continuity, record construction) with no revision re-check afterwards.
`AuthCommitMode` and `AuthInvalidationCause` were TypeScript unions only, with
no runtime enforcement.

### Reproduced before the fix

A candidate whose `accessToken` getter calls `invalidate("LOGOUT")` and then
returns a syntactically valid token, committed with the revision captured
before the call:

| Observation | Pre-fix | Post-fix |
|---|---|---|
| commit outcome | **committed, no rejection** | `Authentication context is stale` |
| authority afterwards | **READY at generation 3** — the logout was overwritten | UNAVAILABLE at generation 2 — the logout stands |
| reads per field | `accessToken` 2, `tokenType` 2, `expiresAt` 4, `accountId` 2, `profileId` 2 | 1, 1, 1, 1, 1 |
| `commitAuthenticatedMaterial(rev, "UNKNOWN_MODE", …)` | **accepted**, fell through as ESTABLISH, generation 1 | rejected `AUTH_CONTEXT_UNAVAILABLE`, no mutation |
| `invalidate("UNKNOWN_CAUSE")` | **accepted**, widened `lastCause`, generation 2 | rejected `AUTH_CONTEXT_UNAVAILABLE`, no mutation |

21 of the 23 new assertions were RED before the correction.

### The correction

`commitAuthenticatedMaterial` now runs a fixed seven-step order:

- **A** terminal EXHAUSTED check;
- **B** compare-and-swap against the expected revision — whose own two fields
  are also read exactly once, since it is producer-supplied too;
- **C** runtime `AuthCommitMode` allowlist, before the candidate is touched at
  all;
- **D** snapshot: the five authorized fields read **at most once each**, by
  explicit property access — no spread, no `Object.assign`, no enumeration, no
  serialization, and no unknown field copied;
- **E** validation of the local snapshot only, returning frozen validated
  primitives;
- **F** a second EXHAUSTED check and a second compare-and-swap against the same
  captured expected revision;
- **G** refresh continuity and publication, from local values only.

Step F is the last untrusted-object boundary: between it and the state
assignment nothing reads the producer's object and no producer-controlled code
is invoked. A stale commit therefore installs nothing, increments nothing,
aborts nothing and overwrites nothing.

`invalidate` validates its cause against a runtime allowlist first, so an
unrecognised cause cannot widen `lastCause`, mutate state, increment the
generation or abort the current controller. Neither rejection introduces a
fourth error kind — both use the existing `AUTH_CONTEXT_UNAVAILABLE`.

### New tests

23 added, all deterministic and barrier-based (no timing, no sleeps): R1-A
reentrant invalidation in both ESTABLISH and REFRESH mode; R1-B read-once
accounting for successful ESTABLISH, successful REFRESH and rejected candidates;
R1-C a getter that changes its answer between reads; R1-D a getter that commits
a newer generation; R1-E seven invalid runtime modes; R1-F six invalid runtime
causes; a legitimate-value regression for both enums; a secret-free rejection
sweep; and an adversarial Proxy test proving the fix does not depend on ordinary
property descriptors — exactly five `get` traps fire, and `refreshToken`,
`cookie` and `password` on the same object are never read.

### Results

| Check | Result |
|---|---|
| Focused BT3 suite | 161 tests, 161 pass, 0 fail, 0 skip, exit 0 |
| Full suite | 549 tests, 549 pass, 0 fail, 0 skip, exit 0 |
| Typecheck / build | exit 0 / exit 0 |
| Network-isolated full suite | 549 pass, 0 fail, egress blocked (`ENOTFOUND`, `ENETUNREACH`) |
| Public MCP | 21 tools, source and bundle schemas unchanged |
| `PRODUCTION_OPERATIONS` | empty and frozen |
| Public reachability of `auth-context.ts` | none; bundle carries no marker |
| Dependencies / lockfile | unchanged |
| Changed paths | `src/transport/auth-context.ts`, `test/auth-context.test.ts`, this report |

Everything preserved from the accepted candidate: issuance-only
`WeakSet<AuthContext>`, no handle-to-record mapping, publish-before-abort,
reentrant listeners observing the new state, CAS mismatch mutating nothing,
terminal EXHAUSTED, pre-check usability with currentness-only post-check, no
replay, identity-change invalidation, and bind-time redaction of sensitive
identity. `src/redact.ts` was not touched.
