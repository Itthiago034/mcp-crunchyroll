# SECURITY MODEL — Crunchyroll MCP 2.0

*Portuguese version: [pt-BR](docs/pt-BR/seguranca.md).*

## 1. Assets and actors

| Asset | Where it lives | Rule |
|---|---|---|
| Observed bearer | the authority's memory (BT3) | never on disk, never in a response, registered with the redactor |
| Browser session (cookies) | dedicated profile `~/.strider/crunchyroll/browser-profile` | **never read** by this server |
| CDP endpoint | loopback, ephemeral port, owner process only | never exposed to the agent |
| User account | Crunchyroll | account actions only through explicit tools |

Actors: the **LLM agent** (can be induced by prompt injection into asking for the wrong things), the
**page** (Crunchyroll's code, ads, third-party iframes), **another process of the same user**
(outside the defense scope: it already has access to the profile), the **human user**.

## 2. Threat model and controls

| Threat | Control | Evidence |
|---|---|---|
| Agent obtains a generic JS/CDP executor | No argument is a script; command ∈ closed enum validated in Node **and** in the page; one frozen function; `functionDeclaration` pinned to 2 constants | `playback-channel`: closed function/arguments, unknown command; `browser-api-transport`/`bt8-structural` tripwires |
| Agent connects to an arbitrary debugging port | No port/URL/target parameter; CDP only through the manager's connection | harness: `{action, port}` → `-32602` |
| Command in the wrong tab | Tab recorded by `openWatchPage` or the only `/watch/<ID>`; ambiguous → refusal; managed page excluded; URL compared field by field (lookalike, userinfo, http, invalid ID refused) | `playback-channel` "which tab" |
| Command in the wrong frame (ad, extension, isolated world) | Only `isDefault` on allowlisted origins; child sessions only from `iframe` under the tab itself; workers detached | `playback-channel` "which frames" |
| Stale/reused CDP | Channel bound to the generation; `assertUsable()` before and after each call; a new channel per action | reconnection makes the channel unusable; the controller opens one channel per action |
| Action after the tab is closed | `targetDestroyed`/`detachedFromTarget` → `TAB_CLOSED` | loss tests |
| Token/cookie leak | The player path does not touch the authority; the channel's CDP methods are on an exact allowlist (no `Network.*`, `Storage.*`, cookies); the page function does not reference cookie/storage/fetch; state uses primitives only, no `currentSrc` | method allowlist; "no stream URL travels"; bearer absent from session errors |
| Logs | All output goes through `sanitizeToolResult` inside the redaction scope; session errors have fixed messages | `session-dispatch-integration` |
| Authentication bypass | Silent only for EXPIRED (in this process) or cold start with a marker of a previous **human** login; never for LOGGED_OUT/REVOKED/LOGGING_OUT; the same closed observation as login (no credential, no cookie) | `session-recovery`, `auth-orchestrator-silent` |
| Retry storm / blocked process | Single promise; 120 s cool-down; per-caller deadline (40 s) and per-attempt deadline (30 s); bounded player queue | concurrency tests |
| Duplicated side-effecting request | Retry only with `DispatchProbe.dispatched === false` (set when the provider's channel is opened) — structural proof in the real chain | `session-dispatch-integration` |
| Fullscreen/play reported without confirmation | `success ⇒ verified ⇒ a later probe saw the state` | property in `player-controller` + real Chromium |
| Autoplay/fullscreen/DRM bypass | No production flag; a browser refusal becomes `REFUSED_BY_BROWSER`; no fallback | real Chromium with a strict policy and `allow="fullscreen 'none'"` |
| Control after logout | Gate re-read at every step; the fail-closed tombstone survives a restart | harness "logout survives a process restart" |
| Browser spawn caused by a control action | `start({adoptOnly})` only from `STOPPED` | harness "no browser launch"; `adoptOnly` never spawns |
| Open CDP resources | `close()` in the `finally`, listeners removed, session detached | real Chromium: no attached session (the test fails without the detach) |
| Tests touching the real session | The harness uses a disposable `HOME` when the inherited one is the real home | `_harness-client.ts` |

## 3. Adversarial review (what I tried to break)

| Attempt | Result |
|---|---|
| Authentication × playback race: a silent login navigating the video tab | Does not happen: the login surface uses the managed page; `findReusableManagedPage` excludes `/watch/` tabs and attached tabs; during navigation (URL `""`) the origin does not parse and the tab is ignored. |
| Send a command to the wrong tab | Covered by field-by-field selection and ambiguity refusal (tests). |
| Use a channel after reconnection | Refused (`DISCONNECTED`), test. |
| Leak the bearer through a structured error | Does not appear (test with a sentinel). |
| Player command after logout | Refused in the same process; **failure found**: in a new process it was allowed → fixed with a tombstone (commit `f3cd9ae`) and an E2E test over stdio. |
| Fullscreen reported without confirmation | Property tested over 165 combinations; real Chromium. |
| Mutation retry | Real chain: 1 write per call, even concurrently and on cold start; post-dispatch uncertainty never retries. |
| Adoption concurrent with reconnection (`DEGRADED`) | **Failure found during the review**: `start({adoptOnly})` in `DEGRADED` would race with the reconnection loop → restricted to `STOPPED`. |
| Dangling CDP sessions | Checked in real Chromium with an independent connection. |
| Regressions | Previous suite: 1055/1055 still green (now 1167/1167). |

## 4. Residual risks (accepted and documented)

1. **Transient activation granted to the page.** `userGesture: true` gives user activation to the
   player frame (and, under UAv2, to its ancestors) for a few seconds. The page's own code could
   use it for another action that requires a gesture (e.g. a popup). Scope: only
   `play`/`enter_fullscreen`, only frames from `www`/`static.crunchyroll.com`; cross-origin
   siblings (ads) do not receive it.
2. **Focus.** `play`/`fullscreen` call `Target.activateTarget`: the video tab comes to the front.
3. **An in-flight command is not cancelled by logout.** The gate prevents the next step; a command
   already sent completes.
4. **`player_control` without `expectContentId`** acts on whichever video is in the tab; if called
   during the navigation of a `crunchyroll_play`, it may find `PLAYER_LOADING`/`NO_VIDEO` (never
   another tab). `crunchyroll_play` with options waits for the right episode.
5. **Window on cold start.** With a marker, the first query of a new process may open the dedicated
   browser's window (the same thing `crunchyroll_login` already did).
6. **Marker after manual onboarding.** Anyone who logs in only through `npm run onboard:browser`
   needs a `crunchyroll_login` to write the marker; until then cold start answers
   `LOGIN_REQUIRED`.
7. **MCP logout does not sign the account out in the dedicated browser** (previous behavior,
   unchanged).
8. **The same local user** can create/delete the marker and the tombstone. Creating the marker only
   causes one observation attempt; deleting the tombstone only re-allows controlling the local
   player. Outside the defense model (that actor already controls the profile).
9. **A change in Crunchyroll's player** (iframe origin, sandbox/allow, multiple players) may lead
   to `PLAYER_UNAVAILABLE`/`REFUSED_BY_BROWSER` — fail closed, never a workaround.

## 5. Mission constraints — compliance

Not modified: Hermes, the local installation, Chromium's global configuration, `main`. No global
dependency. No private authentication data accessed. No action on the Crunchyroll account. No user
service restarted. No merge/deployment.
