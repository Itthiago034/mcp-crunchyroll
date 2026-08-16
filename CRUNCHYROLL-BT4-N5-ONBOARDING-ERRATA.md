# MCP Crunchyroll — BT4-N5 Onboarding Errata

Append-only design resolution for the single open blocker on the BT4 candidate.
It rewrites nothing: `CRUNCHYROLL-BT4-COMPLETION-ERRATA.md`,
`CRUNCHYROLL-BT4-DESIGN.md` and `CRUNCHYROLL-BT4-IMPLEMENTATION-REPORT.md`
(Parts I–III) all stand exactly as written, including their records of failure.
It authorizes no BT5 work and reopens no closed item.

| | |
|---|---|
| Branch | `bt4-auth-producer` |
| Base for this errata | `59f5650af6b9b0340079c5ff63d0b81252826d4e` (BT4-R1 FIX1, external review PASS) |
| Decision | **OPTION B — Supported Human Onboarding of the Dedicated Profile** |
| Public schema change | **none** |
| Source change | **none** |
| Blocking questions | 0 |

## 1. The problem BT4-N5 records

The frozen contract (`CRUNCHYROLL-BT4-COMPLETION-ERRATA.md` §7) describes cold
interactive login as:

```
crunchyroll_login({})
  → ensure the managed browser is available
  → open the FIXED Crunchyroll login surface
  → the HUMAN types credentials directly into Crunchyroll
  → observe a bounded auth transition at the token endpoint
  → install through the producer → BT3 writer
  → return SAFE readiness only
```

Every step of that is implemented and tested. One step could not be *performed*
by the operator: inside the managed browser window, the provider's human
verification did not complete, so no credentials were ever submitted and no
token was ever minted.

BT4-N5 is therefore not a code defect. It is the observation that a step the
contract assigns to a human could not be carried out where the contract assumed
it would happen.

## 2. Evidence — runs 1 and 2 (preserved as failures)

Both attempts used the managed browser with CDP attached, the operator at the
keyboard, on a freshly created dedicated profile.

| | Run 1 | Run 2 |
|---|---|---|
| Duration to timeout | 301 s | 300 s |
| Browser | launched (Brave, dedicated 0700 profile) | adopted the still-running browser from run 1, same PID |
| States | `LOGIN_REQUIRED` → `AUTHENTICATING` → `LOGIN_REQUIRED` | identical |
| Login outcome | `accepted: false` | `accepted: false` |
| Material installed | none | none |
| Token store | nothing written | unchanged |

Operator report: the legitimate Crunchyroll login page was reached, then the
Cloudflare human verification never completed — it looped. No login was
submitted; no mint occurred.

**These two runs remain FAILURES in the record.** Nothing in this errata makes
them successes, and no later result is allowed to overwrite them.

## 3. The A/B diagnostic

| | Configuration | Outcome |
|---|---|---|
| **A** | the same dedicated profile, the same Brave binary, **no `--remote-debugging-port`, no CDP, no MCP**, operator at the keyboard | human verification **PASS**, login **PASS**, window closed normally |
| **B** | the same dedicated profile, managed browser with CDP attached, operator at the keyboard | challenge loop, twice (301 s, 300 s) |

Before A, the managed browser's identity was revalidated against BT2's own
ownership record (live pid, uid, runtime executable, start-time ticks, canonical
`--user-data-dir`, main process, `SingletonLock` = `hostname-pid`) and then
terminated with `SIGTERM` only. A used the benign BT2 flags and omitted the
debugging port entirely.

After A, the unmodified production bundle was run again on the same profile:

```
status before        LOGIN_REQUIRED, browser_running: false
crunchyroll_login {} accepted: true after 3 s
final                auth_state: PROFILE_READY, profile_ready: true
token store          nothing written — only browser-profile exists
ownership record     new 0600 record for a freshly launched pid; BT2 rejected
                     the dead-pid record, cleared it and the stale endpoint
```

## 4. Confounds — stated, not minimised

The A/B is a **diagnostic lead, not a controlled experiment**:

- n = 1 against n = 2, unblinded, single machine, single provider account;
- A ran on a profile already warmed by the two earlier sessions;
- A and B differ in more than CDP attachment — window provenance, timing and
  interaction pattern all vary;
- the provider's mitigation is adaptive and not observable from here.

Consequently this errata does **not** claim "CDP causes the challenge loop". It
claims only what was observed: the managed-window path did not complete twice,
the direct-window path completed once, and the resulting session was usable.

## 5. E1 and E2 — kept distinct

| | Claim | Basis |
|---|---|---|
| **E1** | the dedicated profile carried the human-established session across the manual → managed handoff | **inferred** from a profile-scoped mint arriving seconds after load with nobody logging in. No cookie or storage was read; the visual confirmation of a logged-in page belongs to the operator |
| **E2** | the full BT4 chain works against a real provider response: fixed login surface → response-stage interception of the fixed token endpoint → bounded body → validated closed candidate → `establishFromObservedMaterial` → BT3 `ESTABLISH` CAS | **proven** at the authority level. The authority was `UNAVAILABLE` at step 1 of that same process and no `tokens.json` exists for bootstrap, so no other path to `PROFILE_READY` is reachable |

E1 is never promoted to E2. A page that looks authenticated is not authority.

## 6. What BT4-N5 still does not prove

A human completing a **cold first login inside the managed browser window**.
Run 3 did not answer that question; it made the question unnecessary for that
session by establishing the browser session elsewhere first. That distinction is
the reason this errata exists rather than a claim of closure.

## 7. Why this is not anti-bot circumvention

The frozen upstream design (`/tmp/CRUNCHYROLL-BROWSER-TRANSPORT-DESIGN-P1.1-ERRATA.md`,
SHA-256 `02ce03e2620c53d3279cdc060788a9e1bdf01deec7e6447d96c2cc2f3a388213`, §3.1)
forbids "TLS spoofing, browser-header imitation from Node, `cf_clearance` reuse,
CAPTCHA automation, anti-bot replay". Its login table (§17-series) states:
*"CAPTCHA / bot challenge — user resolves in the browser; never automated."*

Supported Human Onboarding does exactly that and nothing more:

| Prohibited technique | Present here? |
|---|---|
| CAPTCHA / challenge automation | **No.** A human solves it, by hand, in a browser window |
| Fingerprint alteration or automation-signal suppression | **No.** No flag, no patch, no property override. The launch vector is unchanged |
| `cf_clearance` reuse, token replay, header imitation | **No.** Nothing is read from or replayed into the challenge |
| Cookie extraction, import, injection or seeding | **No.** No code reads or writes cookies; verified by scan — every `cookie` occurrence under `src/` is prose in a comment |
| Personal-profile import or copy | **No.** The operator's ordinary browser profile is never opened, read or referenced |
| Credentials to the MCP or the model | **No.** `crunchyroll_login` publishes `{type:"object", properties:{}, additionalProperties:false}` and refuses any supplied argument |

The only change is **where the human sits when they satisfy the provider's own
challenge**: in a window of the same dedicated profile, launched directly,
instead of a window of the same dedicated profile, launched by us. The provider
sees a real human in a real browser either way, which is precisely what the
challenge is for.

## 8. Normative operational contract

**SUPPORTED HUMAN ONBOARDING OF THE DEDICATED PROFILE.**

The dedicated profile is the session's home — the upstream design already says
so: *"The persistent profile holds a durable session … created by our software,
so we own the disclosure."* Onboarding is the human act of establishing that
browser-resident session for the first time, or after it expires.

### 8.1 Procedure (normative)

1. **No managed browser may hold the profile.** Verify no process is using
   `~/.strider/crunchyroll/browser-profile`. If the MCP's browser is running,
   stop it gracefully (`SIGTERM`, never `SIGKILL`); a hard kill leaves a stale
   `SingletonLock`.
2. **Launch the same profile with the same browser, without automation:**

   ```
   /usr/bin/brave \
     --user-data-dir="$HOME/.strider/crunchyroll/browser-profile" \
     --no-first-run \
     --no-default-browser-check \
     --disable-background-networking \
     --disable-background-mode \
     https://www.crunchyroll.com/login
   ```

   `--remote-debugging-port` is **omitted deliberately**: this window is not
   automated and must not be attachable. The binary must be the one
   `resolveBrowserExecutable()` will choose, including any
   `CRUNCHYROLL_BROWSER_EXECUTABLE` override in the MCP's environment —
   BT2's adoption check compares the launcher path.
3. **The operator satisfies the provider's challenge and logs in by hand**, in
   Crunchyroll's own UI. No agent, no automation, no assistance.
4. **Decline every import, sync or account-linking prompt.** Accepting one
   would pull the operator's personal browser data into the dedicated profile
   and break the separation this design depends on. This is the only step where
   a human click can violate the contract.
5. **Close the window normally** so the browser flushes its state and releases
   `SingletonLock`.
6. The MCP is then used as before. Nothing else is done by hand — no file is
   copied, edited or exported.

### 8.2 What the MCP does afterwards

Unchanged, and this is the point: `crunchyroll_login({})` starts or adopts the
managed browser on the same profile, and readiness is granted **only** when BT4
observes and validates a real mint at the fixed token endpoint. The onboarding
supplies a browser session; it never supplies an `AuthContext`.

### 8.3 Operator-facing state guidance

| Situation | Contract |
|---|---|
| First use, or the browser session has expired | the operator may be instructed to perform onboarding on the dedicated profile |
| A usable browser session exists | `crunchyroll_login({})` may reach `ACCOUNT_READY`/`PROFILE_READY` without asking for credentials again — because a real mint is observed, not because a cookie exists |
| A challenge appears in the managed window | never bypassed, never automated. The attempt ends bounded at `LOGIN_REQUIRED`, and the operator is directed to onboarding |
| Onboarding completed | the next managed run reuses the same profile. Readiness is still granted only on observed, validated material |

## 9. Threat model

| Concern | Position |
|---|---|
| Credential exposure to the model or the MCP | impossible by contract: the login schema admits no property and the handler refuses any argument. Credentials exist only between the operator's keyboard and Crunchyroll's page |
| Personal-profile contamination | prevented by procedure (step 4) and by code: nothing under `src/` references any other profile, `~/.config`, `Cookies`, `Local State` or `Login Data` |
| Durable session on disk | accepted and pre-existing. The upstream design already states the persistent profile holds `etp_rt` under the user's account, "the same exposure a normal browser profile carries, but created by our software, so we own the disclosure" |
| Same-UID CDP reachability | unchanged and already documented upstream as a residual risk. Onboarding neither widens nor narrows it; the onboarding window itself has **no** debugging port |
| A hostile local process seeding the profile | out of scope and unchanged: any same-UID process could already write that directory. BT4 still refuses to grant readiness on anything but an observed, validated mint, so seeding a cookie grants nothing |
| Provider terms | the operator authenticates as themselves, by hand, in a real browser, through the provider's own UI. No automated account creation, no credential stuffing, no challenge solving on their behalf |

## 10. Secret invariants (unchanged, restated)

1. No credential, cookie, bearer, refresh token or storage value crosses the MCP
   or model boundary, in either direction.
2. No public tool result carries a token, an account id, a profile id, an epoch,
   a generation or an `AuthContext`.
3. The browser-observed bearer is **never persisted**; the hardened store is not
   written by this path — verified live in run 3.
4. Only five closed fields are ever read from a provider response:
   `access_token`, `token_type`, `expires_in`, `account_id`, `profile_id`.
5. No provider body, header or request id enters an error, log, diagnostic or
   result.

## 11. Profile lifecycle

| Phase | Owner | Rule |
|---|---|---|
| Creation | BT2 | `ensureBrowserProfile` creates it `0700`, refuses a symlink, refuses a foreign uid |
| Onboarding | operator | same directory, same binary, no debugging port, no import |
| Managed use | BT2 | launch or adopt; adoption requires all thirteen checks including canonical profile and `SingletonLock` = `hostname-pid` |
| Permissions | BT2 | `0700` asserted on every start; a drift fails closed with `PROFILE_INSECURE` |
| Control files | BT2 | `.mcp-browser-owner.json` (`0600`), `DevToolsActivePort`, `SingletonLock` are BT2's. The operator never edits them; stale ones are invalidated by BT2 itself |
| Session expiry | provider | the browser session dies on its own schedule; the MCP does not extend it and cannot fabricate it |

## 12. Logout and re-authentication

Unchanged by this errata, and deliberately so:

- `crunchyroll_logout` invalidates the authority **before** any cleanup and
  returns the structured `LogoutResult` verbatim;
- BT4 does **not** clear browser-stored state — that is BT8's
  `BROWSER_SESSION_CLEAR` (upstream §17B). So after a BT4 logout the dedicated
  profile may still hold a live browser session;
- that residual session **must never resurrect the authority**, and cannot: the
  only path back to ready is an explicit `crunchyroll_login({})` that observes a
  **new** mint. BT4-R1 FIX1 guarantees the old attempt's material can never
  install, whatever its timing;
- `REAUTH_REQUIRED` is reported only on an explicit signal from a semantic
  `invalid_grant`, never inferred from the browser.

Until BT8 lands, "log out of the browser too" is a manual act in the dedicated
profile. This is a known, recorded gap — not a claim of completeness.

## 13. Acceptance criteria for OPTION B

| # | Criterion | Status |
|---|---|---|
| 1 | the profile used is exclusively `~/.strider/crunchyroll/browser-profile` | met — single source `browserProfileDir()`, no environment override, no second path under `src/` |
| 2 | no data is copied from any personal browser | met — zero references to other profiles or their artifacts under `src/` |
| 3 | the operator uses Crunchyroll's legitimate UI | met by procedure §8.1 |
| 4 | credentials never cross the MCP or the model | met — closed login schema plus local refusal, proven end to end in the harness on both source and bundle |
| 5 | no API returns a cookie, password or storage value | met — the readiness report is seven booleans and one closed enum; sentinel sweeps green |
| 6 | onboarding is only a human bootstrap of browser-resident session state | met — no code participates in it at all |
| 7 | all authority material still enters through the reviewed BT4 chain | met — proven live (E2) and structurally: `establishFromObservedMaterial` is the only install path |
| 8 | no second authority and no second token store | met — one `createAuthContextAuthority()` call site in the composition root; the transport exposes no save |
| 9 | the profile stays `0700` and BT2-preserved | met — asserted on every start |
| 10 | logout still invalidates; onboarding cannot resurrect authority | met — BT4-R1 family, including the failed-cleanup case |
| 11 | BT4-R1 FIX1 remains valid in full | met — untouched by this errata |
| 12 | no content operation becomes caller-reachable before BT5 | met — `PRODUCTION_OPERATIONS` is `Object.freeze([])` |

## 14. Explicitly NOT required

- cold managed-window first login is **not** required for BT4 acceptance under
  Option B;
- no evidence of defeating, shortening or influencing a provider challenge is
  required, permitted or accepted;
- no automated credential entry, no headless login, no challenge solver;
- no proof about a personal profile, since none is used;
- no repetition of the live E2 run to validate this document.

## 15. Relationship to BT4-R1

BT4-R1 (FIX1, `749ab45`) is what makes Option B safe rather than merely
convenient. A durable browser session means observations can arrive at awkward
times; FIX1 guarantees that only the current login attempt, on the current BT2
connection, with no logout in between, may install anything. Onboarding raises
the value of that guarantee and does not weaken it.

## 16. Relationship to BT5

None. `PRODUCTION_OPERATIONS` stays empty, no content or account operation is
migrated, no `TransportBackend` becomes caller-reachable, `bind`/`runCurrent`
stay unused in production, and every content tool keeps its legacy token path.
Onboarding changes no operation surface whatsoever.

## 17. Rollback

This errata adds one document and changes no source, test, fixture or package
file. Reverting it removes the operational contract and returns BT4-N5 to its
open state; nothing else moves. There is no code to roll back and no data
migration to undo.

## 18. Open notes

- **BT4-N5 remains partially open by design.** Cold managed-window first login
  is unproven and is now explicitly *not required*; if a future provider or
  browser change makes it work, that is an improvement, not a new obligation.
- **BT4-N6 (new).** `README.md` still documents the retired credential contract
  (`crunchyroll_login(email, password)`, "tokens are saved locally"). That is
  operator-facing documentation contradicting both the BT4 public contract and
  this errata. `README.md` is outside the frozen file map of
  `CRUNCHYROLL-BT4-COMPLETION-ERRATA.md` §12, so it was **not** edited here.
  Correcting it — and adding the §8.1 onboarding procedure to it — is required
  before any release and is submitted for review as a separate decision.
- **BT4-N2, BT4-N3, BT4-N4** are unchanged and remain open, non-blocking.
- BT8 owns browser-session clearing on logout (§12 above).

## 19. Decision

**BT4-N5 is resolved as OPTION B — Supported Human Onboarding of the Dedicated
Profile**, as an operational contract, with **no source change and no public
schema change**.

Cold managed-window first login stays implemented and stays the default path;
it is no longer an acceptance requirement, because the provider's human
verification — not this code — determines whether it can complete, and the
alternative is a human authenticating themselves in the same dedicated profile
through the provider's own interface.

This is a candidate resolution submitted for external review. BT4 is **not**
declared closed here.
