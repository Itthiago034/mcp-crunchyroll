# ARCHITECTURE — Crunchyroll MCP 2.0

*Portuguese version: [pt-BR](docs/pt-BR/arquitetura.md).*

Native player control, single-flight session recovery and an updated skill.

## 1. Diagnosis (Stage A)

### 1.1 Which code was audited

| Ref | Contents | Matches the observed local environment? |
|---|---|---|
| `main` (`09fe350`, v0.1.0) | 21 tools; **no** `crunchyroll_play`, **no** `callContentTool()`, no skill | **No** |
| `validacao-linux` (`e1c076e`) | 22 tools; `crunchyroll_play`, `callContentTool()`, `skills/crunchyroll/SKILL.md`, desktop recovery, playback tab reuse | **Yes**: it is the tree of `~/mcp-crunchyroll-validacao` |

The work was done on top of `validacao-linux`, because it is the only ref that has the code described in the mission.
Consequence: a PR against `main` also carries the 15 commits from `validacao-linux` (see §6).

### 1.2 Existing components (what was already right)

```
MCP stdio ── index.ts (single composition)
               │
               ├─ AuthContextAuthority (BT3)  ← single source of truth for the session; bearer in memory only
               ├─ AuthProducer / AuthOrchestrator (BT4) ← single-flight login, exclusive logout, readiness
               ├─ BrowserAuthObserver ← intercepts only the token endpoint response
               ├─ ContentGateway → Dispatcher → BrowserApiBackend (BT5–BT8)
               │      └─ closed channel: ONE frozen `fetch` function in the managed page
               └─ BrowserSessionManager (BT2) ← own process, dedicated profile, validated
                      ownership (13 checks), CDP on loopback only, connection generation
```

Controls that already existed and were preserved: dedicated 0700 profile, adoption of own browsers only,
CDP with no generic surface (no `evaluate`, no exposed `send`), per-operation redaction
(`withRedactionScope` + `sanitizeToolResult`), Node egress guard for `crunchyroll.com`,
`MUTATION_OUTCOME_UNKNOWN` with no blind retry, structural tripwires in the tests.

### 1.3 Problems confirmed in the code

| # | Problem | Evidence |
|---|---|---|
| P1 | Cold start: the first query of each process fails with `AUTH_NOT_READY`; the agent has to call `crunchyroll_login` and retry. | `callContentTool()` only recovered when `availability === "READY" && !hasUsableRecord()` (session established **in this** process). |
| P2 | Two simultaneous queries on cold start = two failures + login + two retries. | Same path; no pre-check. |
| P3 | Even in the "expired" case, every call spent one attempt on the gateway before recovering. | try → catch → login → retry. |
| P4 | The guarantee "AUTH_NOT_READY is never post-dispatch" was **implicit** (it depended on where `bind()`/`runCurrent()` throw). | A comment in `callContentTool`; no structural test. |
| P5 | `crunchyroll_play` only navigates. There is no player API → Hermes improvised a terminal, a WebSocket to CDP, `video.play()`, `requestFullscreen()` and simulated clicks, **bypassing** the `BrowserSessionManager`. | `openWatchPage()` does `Page.navigate`/`createTarget` + `activateTarget` and nothing else. |
| P6 | `crunchyroll_status.player_ready` is always `false` (BT4 has no source for the player). | `auth-orchestrator.ts`. Kept: `status` remains strictly read-only; player state now comes from `crunchyroll_player_control {"action":"status"}`. |

## 2. New components

```
crunchyroll_player_control ─┐
crunchyroll_play {autoplay, │
              fullscreen} ──┴─► CrunchyrollPlayerController (player-controller.ts)
                                 · bounded serial queue (BUSY), permission gate at every step
                                 · waits for the right episode + loaded player (optional)
                                 · action → VERIFICATION by a later probe
                                 │
                                 ▼ PlaybackControlChannel (closed)
                              BrowserSessionManager.openPlaybackControlChannel()
                                 · tab: the one opened by openWatchPage, or the ONLY /watch/ tab
                                 · contexts: default worlds only, on allowed origins
                                   (www.crunchyroll.com, static.crunchyroll.com)
                                 · OOPIF via Target.setAutoAttach (flatten)
                                 · ONE frozen function CRUNCHYROLL_PLAYER_FUNCTION(command, waitMs)
                                 · command ∈ {probe, play, pause, enter_fullscreen, exit_fullscreen}
                                 · userGesture only on play/enter_fullscreen
                                 · connection generation + loss (TAB_CLOSED / DISCONNECTED / NAVIGATED_AWAY)

content (17 tools) ─► callWithSession (session-recovery.ts)
                         1. classify(): USABLE | EXPIRED | NEVER_ESTABLISHED | LOGGED_OUT | REVOKED | LOGGING_OUT
                         2. non-USABLE → ensureSession() — ONE shared Promise
                              EXPIRED → silent attempt
                              NEVER_ESTABLISHED → only if the eligibility marker exists
                              LOGGED_OUT / REVOKED / LOGGING_OUT → structured error, no attempt
                         3. dispatches; retries at most 1× and only with structural proof of non-dispatch
                       AuthOrchestrator.establishSilently() — short observation (30 s), joins an
                         in-flight login, is superseded by interactive login, cancelled by logout
                       SessionEligibilityStore (session-eligibility.ts)
                         · silent-reauth-eligible.json (0600, no secret) — written after a human login
                         · logged-out.json (tombstone, fail-closed) — written on logout
```

## 3. Contracts

### 3.1 `crunchyroll_player_control`

Input (closed schema; the server revalidates and rejects any extra field with `-32602`):

```json
{ "action": "play" | "pause" | "fullscreen" | "exit_fullscreen" | "status" }
```

> Why `enum` and not a discriminated `oneOf`: the tool API of several clients (Anthropic's
> included) rejects `oneOf` at the top of `input_schema`. No action has a parameter of its own, so
> the discrimination is done on the server (`action` + "no other key").

Output:

```json
{
  "action": "fullscreen",
  "executed": true,
  "verified": true,
  "success": true,
  "outcome": "CONFIRMED",
  "state": { "playing": true, "paused": false, "ended": false, "buffering": false, "loading": false,
             "fullscreen": true, "muted": false, "current_time": 312.4, "duration": 1420, "ready_state": 4 },
  "message": "The player state was verified."
}
```

| Field | Meaning |
|---|---|
| `action` | Requested action |
| `executed` | The page command was in fact sent (false on no-ops and on refusals that happen beforehand) |
| `verified` | A **later** probe observed the requested state |
| `success` | `outcome === "CONFIRMED"` (implies `verified`) |
| `outcome` | `CONFIRMED`, `NOT_CONFIRMED`, `REFUSED_BY_BROWSER`, `PLAYER_LOADING`, `PLAYER_UNAVAILABLE`, `TAB_NOT_FOUND`, `TAB_CLOSED`, `SESSION_DISCONNECTED`, `TIMEOUT`, `NOT_PERMITTED`, `BUSY` |
| `reason` | Closed name: `ALREADY_IN_STATE`, `AUTOPLAY_BLOCKED_USER_ACTIVATION_REQUIRED`, `USER_ACTIVATION_REQUIRED_OR_DENIED`, `FULLSCREEN_NOT_ALLOWED_IN_FRAME`, `NO_PLAYBACK_TAB`, `AMBIGUOUS_PLAYBACK_TAB`, `NAVIGATION_PENDING`, `VIDEO_NOT_READY`, `NO_VIDEO`, `CONTEXT_LOST`, `NAVIGATED_AWAY`, `CANCELLED`, `PAGE_<error>`, `LOGGING_OUT`, `LOGGED_OUT` |
| `state` | Last observation (primitives; never a stream URL) or `null` |

`isError: true` whenever `success` is false.

### 3.2 `crunchyroll_play`

```json
{ "episode_id": "GE00377814PTBR" }                                  // unchanged
{ "episode_id": "GE00377814PTBR", "autoplay": true, "fullscreen": true }
```

With no options (or with both `false`) the response is **byte for byte** the previous one
(`{opened, episode_id, url}`). With options: `{opened, episode_id, url, success, partial, autoplay?: <report>, fullscreen?: <report>}`,
each step waiting up to 20 s for the requested episode and for the loaded player.

### 3.3 Structured session error (content tools)

```json
{ "error": "Not authenticated: log in before requesting content",
  "code": "LOGIN_REQUIRED", "session_state": "NEVER_ESTABLISHED",
  "hint": "Call crunchyroll_login once (no arguments). ..." }
```

`code` ∈ `LOGIN_REQUIRED`, `REAUTH_REQUIRED`, `LOGGED_OUT`, `LOGGING_OUT`, `SILENT_REAUTH_FAILED`,
`SILENT_REAUTH_COOLDOWN`, `TIMEOUT`, `CANCELLED`. The `LOGIN_REQUIRED` message is the same as before.

## 4. Flows

**"Play X ep 12" (cold start, session already authorized earlier):** `search` → (pre-check: NEVER_ESTABLISHED + marker → 1 shared silent attempt) → response; `get_seasons`, `get_episodes`, `play` with no login call at all.

**"Go fullscreen and play":** `player_control fullscreen` → channel → probe → activates the tab → frozen function with a gesture → probes until `fullscreen === true` → `CONFIRMED`; same for `play`.

**Logout during a player action:** every step re-reads the permission; a logout started between steps aborts with `NOT_PERMITTED` before the command is sent. After a logout (including one in another process, via the tombstone), the player stays refused until a human login.

## 5. What was deliberately NOT done

- No `--autoplay-policy` in production; no fallback through simulated mouse, `Browser.setWindowBounds` or F11.
- No `Runtime.evaluate`, no generic executor, no CDP port exposed to the agent.
- No reading of cookies, storage or headers; no stream URL leaves the page.
- No bypass of DRM, autoplay, fullscreen or human verification.

## 6. Branches

- Developed on `claude/brave-galileo-bnxgp6` (this session's assigned branch), starting from `validacao-linux`.
- The suggested name `feature/crunchyroll-player-controller` was not created, so as not to violate the session's single-branch rule; the PR can be renamed/rebased by the maintainer.
- Draft PR against `main`, as requested: it includes the commits from `validacao-linux`. Recommendation: merge `validacao-linux` first **or** change the PR base to `validacao-linux` in order to review only the 2.0 delta.
