# MCP Crunchyroll — BT4-N6 Documentation Errata

Append-only. It corrects operator-facing documentation that still described the
retired credential contract, and records one technical precision about a
sentence in `CRUNCHYROLL-BT4-N5-ONBOARDING-ERRATA.md`. It rewrites no earlier
document, changes no source, test, fixture or package file, and authorizes no
BT5 work.

| | |
|---|---|
| Branch | `bt4-auth-producer` |
| Base | `d4027600537c83e19b6056067a4246c919cf7ef3` (BT4-N5 Option B, external review PASS) |
| Scope | `README.md`, `manifest.yaml`, this document |
| Source / test / fixture / package changes | **none** |
| Public schema changes | **none** |
| Runtime changes | **none** |

## 1. The defect

BT4 broke the authentication contract on purpose: `crunchyroll_login` accepts no
arguments, credentials never reach the server, and the observed bearer is never
persisted. Two operator-facing files were never brought along.

**`README.md`** told operators to hand credentials to the agent:

- *"ask Hermes to do it — it will request your email and password, and tokens are saved locally"*
- `crunchyroll_login(email: "you@example.com", password: "your-password")`
- *"Tokens are saved to `~/.strider/crunchyroll/` and automatically refreshed"*
- tool table: *"Log in with email + password"*, *"Clear saved session"*
- notes: *"Tokens are stored locally … and auto-refreshed"*

**`manifest.yaml`** carried the same instruction in the one place an agent
actually reads at runtime:

- *"use the crunchyroll_login tool once with your Crunchyroll account email and password. Tokens are stored locally in `~/.strider/crunchyroll/` and auto-refreshed."*

The manifest case is the serious one. That note is agent-directed metadata, so
it could induce an assistant to ask the operator for their Crunchyroll password
— a credential no supported path can consume, for a flow that no longer exists.
The code would have rejected the resulting call; the harm would already have
been done at the prompt.

## 2. What the documentation now states

Both files were aligned to the contract as implemented and reviewed:

1. `crunchyroll_login({})` takes zero credentials.
2. The operator never gives an email or password to the agent or the server.
3. Sign-in happens in Crunchyroll's own UI.
4. When the managed browser completes the flow, the operator authenticates
   there, by hand.
5. When the provider's human verification does not complete in the managed
   window, the supported fallback is **Supported Human Onboarding** of the same
   dedicated profile, `~/.strider/crunchyroll/browser-profile`.
6. No personal profile is copied or imported.
7. No cookie or storage value is extracted or injected.
8. Human onboarding creates only browser-resident session state.
9. A page that looks signed in grants no readiness.
10. `ACCOUNT_READY` / `PROFILE_READY` follow only from material the server
    observed and validated, installed through `establishFromObservedMaterial`
    into the BT3 authority.
11. The observed bearer is not persisted to `tokens.json`.
12. The BT4 flow is no longer described as "tokens saved locally" or
    "auto-refreshed".
13. Nothing says the agent requests or receives credentials; the README states
    the opposite explicitly, as a red flag for the operator.
14. Human verification is solved by the human, never automated or bypassed.
15. An existing session in the dedicated profile may be reused.
16. Logout invalidates the authority; the documentation does **not** promise
    that browser-resident session state was also cleared, and says plainly that
    a later stage owns that.

## 3. `auth: none` — investigated, deliberately left intact

`auth:` in the hermes-agent optional-mcps manifest format is **host
installation metadata**: it tells the host whether to collect credentials or
environment values at install time. Sibling manifests on this machine show both
shapes — `type: none` and `type: api_key` with an `env:` list of prompts.

It is not a Crunchyroll credential field, and `none` is not merely still
accurate — it is *more* accurate under BT4 than before, because the host must
never prompt for anything. Left unchanged.

Observation, not a change: this manifest uses the scalar shorthand
`auth: none` where the sibling manifests use the mapping `auth: { type: none }`.
Both appear in the wild; normalising it would be an installer-parsing question
outside this errata's scope, so it was not touched.

## 4. Technical precision on the BT4-N5 errata

`CRUNCHYROLL-BT4-N5-ONBOARDING-ERRATA.md` §9 says credential exposure to the
model or the MCP is *"impossible by contract"*. The intent is right and the
defences behind it are real, but stated absolutely the sentence overclaims: it
can be read as "no credential-shaped value can ever arrive", when what the
system actually guarantees is that no such value is ever *accepted, consumed or
stored*.

The precise statement, which supersedes the absolute reading:

> **The supported MCP contract never accepts credentials. Any out-of-contract
> credential-shaped argument that reaches `tools/call` is rejected and
> redacted; no accepted login path consumes or stores it.**

Three mechanisms back it, in order:

1. the published input schema admits zero properties
   (`{type:"object", properties:{}, additionalProperties:false}`), so a
   conforming client cannot send one;
2. the handler independently rejects **any** supplied argument with a typed
   `InvalidParams` error, naming no key and echoing no value — a malformed or
   hostile client fails closed on this second surface;
3. every string argument reaching the login tool is registered in the redaction
   scope before the refusal, so it cannot survive in an error path crossing the
   MCP boundary.

The BT4-N5 errata is **not** edited: its history stays append-only, and this
section is the qualification of record.

## 5. Verification

Documentation only, so contractual checks stand in for test runs. The 739-test
suite and the live smoke were not repeated, because no code changed.

| Check | Result |
|---|---|
| Files changed from the base | `README.md`, `manifest.yaml`, and this new document — nothing else |
| `src/**`, `test/**`, fixtures, `package.json`, `package-lock.json`, `build.js`, `tsconfig.json` | byte-identical to the base |
| Public MCP schemas | untouched |
| `manifest.yaml` structure | parses; all keys preserved; only the obsolete note replaced |
| Credential-bearing examples remaining | none |
| Agent instructed to request credentials | nowhere — the manifest now instructs the opposite |

## 6. Status

BT4-R1: closed (external review PASS). BT4-N5: Option B, closed (external
review PASS). BT4-N2, BT4-N3, BT4-N4: open, non-blocking. BT4-N6: resolved by
this errata, submitted for external review.

BT4 is **not** declared closed here.
