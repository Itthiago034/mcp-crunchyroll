# MCP Crunchyroll — BT3 Design Gate 0 FIX1 Errata

## 1. Purpose

This documentation-only errata closes external-review findings D0-R1 and
D0-R2 and freezes hardening clarification D0-H1. It changes only the future BT3
design. It implements no production or test code, creates no public reachability,
and authorizes no BT4/BT5 work.

The updated `CRUNCHYROLL-BT3-DESIGN-GATE0.md` incorporates these corrections so
future implementers cannot accidentally follow superseded wording. This errata
records the exact semantic delta and remains authoritative for the three review
findings.

## 2. Original design commit

The preserved historical design commit is:

`fd5b818daa5b4a87ee3e284e975b71d598f3ae86`

Its original Design Gate SHA-256 was:

`d4e2a4e9c468578dbab3a745f0a5e34e04b942245defc09d65c6b31b57d88b65`

FIX1 is a descendant commit. There is no amend, reset, rebase, squash, or
history rewrite.

## 3. External review result

| Finding | Severity | Result |
|---|---|---|
| D0-R1 — WeakMap secret-retention coupling | BLOCKING | corrected by issuance-only WeakSet and sole current-state record ownership |
| D0-R2 — abort-before-publication reentrancy | BLOCKING | corrected by publish-before-abort ordering |
| D0-H1 — auth-derived identity redaction | NON-BLOCKING HARDENING | frozen as explicit no-log/non-enumeration/redaction-before-render policy |

No other BT3 or BT2 design area is reopened.

## 4. D0-R1 finding

The original conceptual structure used:

```ts
WeakMap<AuthContext, ActiveAuthRecord>
```

Because the value contained access material and identity, an internal consumer
retaining a stale AuthContext could keep the WeakMap entry and its
secret-bearing value reachable. Currentness rejection prevented reuse but did
not remove this avoidable lifetime coupling.

## 5. D0-R1 authoritative correction

Capability issuance is frozen to:

```ts
class AuthContextAuthority {
  private readonly issuedContexts = new WeakSet<AuthContext>();
  private state: AuthorityState;
}
```

Issuance performs exactly:

1. create a frozen null-prototype opaque handle;
2. add only that object to `issuedContexts`;
3. place the same handle into the new current `ActiveAuthRecord`;
4. publish the READY state according to the ordering in §8.

The WeakSet records only that this authority issued the object. It associates no
token, identity, revision, controller, execution view, or record with the key.
The current `AuthorityState` is the sole authority-owned root of the
secret-bearing `ActiveAuthRecord`.

Runtime acceptance requires all of:

```ts
issuedContexts.has(context) &&
state.kind === "READY" &&
state.record.context === context &&
state.record.abortController.signal.aborted === false &&
recordRemainsUsable(state.record)
```

Forged and cross-authority objects fail issuance. Previously issued stale
handles fail current-record identity. There is no stale-record lookup.

## 6. Security property after correction

A retained stale AuthContext can keep only the opaque handle itself reachable
through the ordinary reference retaining it. It cannot, merely by remaining an
issued handle, keep a historical secret-bearing `ActiveAuthRecord` reachable
through authority capability bookkeeping.

This is deliberately narrow. An old record or access-token string may remain
reachable because an in-flight guarded callback or another ordinary JavaScript
reference still legitimately holds it, or because of runtime/garbage-collector
behavior. `WeakSet` does not zeroize secrets, force collection, or establish an
erasure deadline. BT3 makes none of those claims.

## 7. D0-R2 finding

The original design placed `oldController.abort()` immediately before state
publication. `AbortController.abort()` may synchronously notify listeners, so a
listener could reenter the authority while the old READY state was still
authoritative. The absence of `await` did not close synchronous reentrancy.

## 8. D0-R2 authoritative correction

Every successful state-changing transition uses this exact order:

1. capture the old current record/controller if one exists;
2. validate and completely build the next immutable state;
3. publish `this.state = nextState` — the state and generation linearization
   point;
4. invoke `oldController.abort()` if an old READY controller exists;
5. only after publication and abort may asynchronous cleanup occur.

There is no `await` and no intentionally invoked user callback between steps 3
and 4.

For replacement, the new READY generation and handle are authoritative before
the old abort listener runs. For invalidation, the new UNAVAILABLE revision is
authoritative before notification. An already-UNAVAILABLE invalidation may
publish another UNAVAILABLE generation as an ordering barrier and has no old
controller to abort.

At `Number.MAX_SAFE_INTEGER`, a required transition builds and publishes
EXHAUSTED/UNAVAILABLE at the existing maximum value, aborts the prior READY
controller if present, and returns `AUTH_CONTEXT_UNAVAILABLE`. It never wraps,
resets, or aborts before publishing EXHAUSTED.

A CAS mismatch returns `AUTH_CONTEXT_STALE` with no publication, generation
increment, or controller abort. EXHAUSTED is terminal: even an expected revision
equal to the published maximum cannot commit it back to READY and instead gets
`AUTH_CONTEXT_UNAVAILABLE`.

## 9. Reentrancy semantics

An abort listener that synchronously reenters the authority must observe the
already-published next state:

- replacement: new READY generation/context;
- invalidation: new UNAVAILABLE revision;
- overflow from READY: EXHAUSTED/UNAVAILABLE at the maximum generation.

The old handle fails current-record identity before notification begins.
`AbortSignal` is only cancellation/invalidation notification. It is not the
state publication mechanism, generation linearization point, proof of
currentness, or authority ownership.

`runCurrent` retains pre-side-effect currentness validation, the execution
AbortSignal, post-callback currentness validation, stale-result discard, and no
automatic replay/substitution under a newer generation. No claim is made that
abort can undo a remote effect already sent.

## 10. Required future tests

All tests are deterministic, symbolic, offline, and browser-free.

### Invalidation reentrancy

1. establish generation G READY;
2. attach a listener to G's abort signal;
3. synchronously reenter the authority from that listener;
4. invalidate G;
5. inside the listener prove the authority already reports UNAVAILABLE at the
   new revision, G is stale, acquisition cannot return G, and no G record is
   current.

### Replacement reentrancy

1. establish G;
2. attach a listener to G's abort signal;
3. commit G+1;
4. reenter synchronously from the listener;
5. prove current generation/handle are G+1, G is stale, and G+1 secret material
   is never substituted into G.

### Overflow reentrancy

At a deterministically injected maximum generation, require EXHAUSTED to be
published before the old listener runs, prove no wrap or reused revision, and
prove a same-maximum CAS cannot reopen READY.

### CAS mismatch

Prove a mismatched expected revision performs no state mutation, generation
increment, or abort notification.

### Secret-retention structure

Do not use GC timing. A structural/source assertion requires
`WeakSet<AuthContext>` issuance and rejects every AuthContext-keyed mapping to
`ActiveAuthRecord`, `accessToken`, `AuthExecutionView`, identity, revision,
controller, or another secret-bearing value. A retained old handle must be
stale, retrieve no old material, and have no effect on current-record execution.

## 11. D0-H1 hardening

`accountId` and `profileId` in `AuthorizedCall.authDerivedParams` are sensitive
auth identity, not credentials and not public diagnostic data.

They may not enter logs, Error messages/details, tracing attributes, generic
debug serialization, or tool-visible failure text. They may enter public tool
output only when already an explicit part of the unchanged 21-tool contract;
BT3 adds no identity output. The future wrapper defines
`context` and `authDerivedParams` as read-only, non-enumerable own properties
before freezing, so generic JSON/object serialization does not emit them.

Before future BT5 code renders either identity into a URL/path/request or passes
it to code that may surface request material, it must register the value with
the current redaction scope through the existing `registerSensitiveValue`
mechanism, unless a separately approved gate proves an equally strong closed
mechanism. No new redaction dependency is required.

Tests use only `SENSITIVE_ACCOUNT_SENTINEL` and
`SENSITIVE_PROFILE_SENTINEL` and prove absence from logs, errors, diagnostics,
generic `AuthorizedCall` serialization, and tool-visible failures, plus
registration before future request rendering.

## 12. Affected design sections

The incorporated design corrections were reviewed across:

- executive summary;
- §9 AuthContext authoritative design;
- §10 authGeneration and overflow;
- §12 context ownership;
- §13 transport boundary;
- §14 ResolvedCall relationship;
- §15 stale-context semantics;
- §16 concurrency, linearization, CAS, and reentrancy;
- §18 secret lifetime;
- §19 logging/redaction;
- §21 fail-closed rules;
- §22 threat model;
- §23 invariant table;
- §24 test strategy;
- §25 future TDD tasks;
- §27 BT3→BT4 interface;
- §28 BT3→BT5 interface;
- §30 dependency statement;
- §31 open questions;
- §32 external-review checklist.

## 13. Scope preservation

FIX1 changes documentation only. It does not authorize or implement login,
refresh HTTP, logout persistence integration, cookies, browser credential
extraction, `Fetch.*`, `Network.*`, `Runtime.evaluate`, live Crunchyroll,
transport cutover, operation registration, dispatcher wiring, public MCP
changes, BT3 source/test work, BT4, or BT5.

The frozen BT2 head and its lifecycle/security properties remain unchanged. The
Auth Map remains byte-identical. No package, lockfile, TypeScript/build, workflow,
source, or test path changes.

## 14. Before/after semantic table

| Property | Before | After |
|---|---|---|
| capability registry | `WeakMap<AuthContext, ActiveAuthRecord>` | issuance-only `WeakSet<AuthContext>` |
| historical secret association | retained old handle could remain associated with secret-bearing record | only current `AuthorityState` owns the secret-bearing record; issuance has no record association |
| runtime acceptance | WeakMap membership plus current handle | issuance membership + current READY identity + non-aborted current signal + usability |
| mutation order | abort old → publish next | build next → publish next → abort old |
| linearization point | state assignment, but preceded by reentrant abort notification | state assignment occurs before abort notification |
| reentrant listener | could observe old state as authoritative | must observe new READY/UNAVAILABLE/EXHAUSTED state |
| CAS mismatch | no intended change, ordering not fully explicit | no mutation, increment, or abort |
| overflow | abort/drop before exhausted state | publish EXHAUSTED before abort, never wrap |
| auth-derived identity | classified sensitive, later rendering redaction obligation implicit | explicit no-log/no-error/no-trace/non-enumeration plus redaction-before-render obligation |

## 15. External-review checklist

- [ ] No authority map associates AuthContext with `ActiveAuthRecord` or secret
  material.
- [ ] Issuance registry is exactly `WeakSet<AuthContext>` and contains only
  opaque handles.
- [ ] Current `AuthorityState` is the sole authority-owned root of the
  secret-bearing record.
- [ ] Retaining a stale handle cannot retain its historical record solely
  through capability bookkeeping.
- [ ] Every successful transition publishes next state before prior-controller
  abort.
- [ ] Reentrant abort listeners see only new READY/UNAVAILABLE/EXHAUSTED state.
- [ ] AbortSignal is notification, never currentness or linearization.
- [ ] CAS mismatch neither mutates nor aborts.
- [ ] Overflow never wraps and publishes EXHAUSTED before abort.
- [ ] `runCurrent` keeps pre/post checks and rejects stale results without replay.
- [ ] Account/profile derived values remain sensitive, non-enumerated, unlogged,
  and registered before future rendering/use.
- [ ] No zeroization, immediate GC, malicious-code prevention, or remote rollback
  claim is made.
- [ ] OQ-1 and OQ-2 remain non-blocking.
- [ ] Public MCP, BT2, Auth Map, source, tests, packages, and BT4+ remain unchanged.

### Required self-review answers

1. **Does any authority map AuthContext → ActiveAuthRecord?** NO.
2. **Does any issuance registry contain accessToken?** NO.
3. **Can retaining a stale handle keep its historical secret record alive solely
   through capability bookkeeping?** NO.
4. **Is next AuthorityState published before old AbortSignal notification?**
   YES.
5. **Can an abort listener reenter and observe the old state as authoritative?**
   NO.
6. **Does CAS mismatch mutate or abort state?** NO.
7. **Does overflow wrap generation?** NO.
8. **Are account/profile auth-derived values explicitly sensitive?** YES.
9. **Does FIX1 change public MCP?** NO.
10. **Does FIX1 authorize BT3 implementation?** NO.

## 16. Final candidate status

D0-R1 and D0-R2 are corrected in the authoritative design text. D0-H1 is
frozen with mechanical non-enumeration, no-log/no-error rules, redaction-before-
future-rendering, and symbolic test obligations. Blocking open questions remain
zero; the two existing non-blocking questions remain unchanged.

The FIX1 documentation candidate is ready for external review. It is not formal
Design Gate closure and authorizes no implementation.
