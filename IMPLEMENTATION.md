# IMPLEMENTATION — Crunchyroll MCP 2.0

*Portuguese version: [pt-BR](docs/pt-BR/implementacao.md).*

## 1. Commits (branch `claude/brave-galileo-bnxgp6`, on top of `validacao-linux@e1c076e`)

| Commit | Scope |
|---|---|
| `834f43c` feat(player): closed playback control channel | `browser-lifecycle-types.ts`, `browser-session-manager.ts`, tripwires |
| `f714a5e` feat(player): native player controller | `player-controller.ts` |
| `6ba590d` feat(auth): single-flight session recovery | `auth-orchestrator.ts`, `session-recovery.ts`, `session-eligibility.ts` |
| `55aa0f9` feat(mcp): player_control + play options | `index.ts`, tools fixture, harness |
| `fca58b1`, `765c5fe` test(player): real Chromium | `player-real-browser.test.ts`, `_player-fixture.ts` |
| `95092a9` bench | `scripts/benchmark-player.ts`, `docs/validation-results/benchmark-player.json` |
| `b6eb3bd` docs(skill) | `skills/crunchyroll/SKILL.md` 2.0.0 |
| `f3cd9ae` fix(auth): logout across restarts | finding from the adversarial audit |
| `0c46f42` test(audit) | non-dispatch proof on the real chain, CDP allowlist |
| `342b87e` docs | README, manifest |

## 2. Files and rationale

### `src/transport/browser-lifecycle-types.ts`
- `playerFrameOrigins` in the config (a build constant, like `watchPageBaseUrl`).
- Closed types: `PlayerCommand`, `PLAYER_COMMANDS`, `PlayerFrameState`, `PlayerPageError`,
  `PlayerCommandResult`, `PlaybackChannelLoss`, `PlaybackControlChannel`.

### `src/transport/browser-session-manager.ts`
- `CRUNCHYROLL_PLAYER_FUNCTION`: the second (and only other) page function, a frozen literal,
  with structured arguments `(command, playWaitMs)`. It touches only its own frame's `<video>` and
  the Fullscreen API; it returns primitives; `play()` is bounded by `playWaitMs` (→ `PENDING`).
- `openPlaybackControlChannel()`:
  - Tab selection: `playbackTargetId` (recorded by `openWatchPage`) if it is still a watch tab or
    is mid-navigation (URL `""`, found on real Chromium); otherwise the **only**
    `/watch/<ID>` tab (URL compared field by field, never by prefix); 0 → `no-playback-tab`, >1 → `ambiguous-playback-tab`.
    The managed page (login/API) is never chosen.
  - `flatten` session + `Runtime.enable` + `Target.setAutoAttach` (OOPIF). Workers are detached.
    It waits for `Runtime.enable` on the frames that already exist (found on real Chromium: without
    this, the first probe did not see the player).
  - Accepted contexts: `auxData.isDefault === true` **and** an origin on the allowlist; removed on
    `executionContextDestroyed`/`executionContextsCleared`/`detachedFromTarget`.
  - Loss: `Target.targetDestroyed` → `TAB_CLOSED`; `onClose`/changed generation → `DISCONNECTED`;
    URL outside watch → `NAVIGATED_AWAY`. Every operation revalidates the generation, the state and `stopRequested`.
  - `run(command, deadlineMs)`: probes every context, picks the frame with a video (one with a
    source first), aggregates `fullscreen` across all frames; `Target.activateTarget` + `userGesture: true`
    only for `play`/`enter_fullscreen`; `exit_fullscreen` exits on every frame that is in fullscreen.
    It has its own deadline.
  - `close()`: removes every listener and detaches the session (children go down with it — verified on real Chromium).
- `start({ adoptOnly: true })`: adopts an already running own browser, never spawns.
  A normal `start()` that finds an in-flight `adoptOnly` call redoes the start if the adoption fails.
- `openWatchPage()` records `playbackTargetId` (cleared on `targetDestroyed` and on dispose).

### `src/transport/player-controller.ts` (new)
`createPlayerController(ports)`; serial queue (`maxQueued` 4 → `BUSY`); per-action budget
(15 s + optional wait); `checkpoint()` before every step (permission, cancellation, deadline);
`expectContentId` (acts only on the episode that was just opened); wait for a loaded player
(`hasSource && readyState ≥ 1`); confirmed no-op when it is already in the state; mapping of
page refusals; verification by probes (3 s); the channel is always closed in the `finally`.

### `src/transport/session-recovery.ts` (new)
`classify()`, `ensureSession()` (a single Promise; per-caller deadline and `AbortSignal`; 120 s
cool-down after a failure; cleanup in the `finally`), `callWithSession()` (pre-check + at most 1 retry
and only with `DispatchProbe.dispatched === false`), `SessionRequiredError`, `SESSION_HINTS`.

### `src/transport/session-eligibility.ts` (new)
The `silent-reauth-eligible.json` marker and the `logged-out.json` tombstone in
`~/.strider/crunchyroll/` (next to the profile, never inside it). Atomic 0600 write with `wx` +
`rename`; symlinks are refused; the marker is only trusted if it is a regular 0600 file owned by
the process's own uid; the tombstone is **fail-closed** (any entry counts as a logout).

### `src/transport/auth-orchestrator.ts`
`establishSilently({observationDeadlineMs})`; `startAttempt()` extracted (no change to the
semantics of the interactive `login()`); a `login()` that finds a silent in-flight call waits and, if it
fails, starts the interactive one; optional `eligibility` port (`record` after ESTABLISHED, `recordLogout`
before the producer on logout, `clear` on revocation). A store failure never blocks logout.

### `src/index.ts`
Player origins as constants; eligibility store; `sessionRecovery`; `dispatchScope`
(`AsyncLocalStorage`) marked by the backend's `openChannel`; `callContentTool` → `callWithSession`
with the MCP request's `AbortSignal`; `playerController` (adoption only from `STOPPED`; gate:
`LOGGING_OUT` or `LOGGED_OUT`); `crunchyroll_player_control` tool; `crunchyroll_play` options;
`SessionRequiredError` → `{error, code, session_state, hint}`.

## 3. Compatibility

| Surface | Before | After | Compatible? |
|---|---|---|---|
| `crunchyroll_play {"episode_id"}` | `{opened, episode_id, url}` | identical | Yes |
| `crunchyroll_play` schema | 1 property | +2 optional booleans | Yes (additive) |
| tools/list | 22 | 23 (+`crunchyroll_player_control`) | Yes (additive) |
| Content error with no session | `{error, hint}` | `{error, code, session_state, hint}`, same `error` | Yes (additive) |
| `crunchyroll_status` | — | unchanged (`player_ready` is still `false`) | Yes |
| `crunchyroll_login/logout` | — | contract unchanged; logout now writes a tombstone | Yes |
| Cold start with marker | used to fail | re-establishes on its own (may open the dedicated browser window) | Intentional behavior change |
| Logout → new process | player allowed | player refused until login | Intentional change (security) |
| `BrowserSessionManager` | 13 keys | +`openPlaybackControlChannel`, `start(options?)` | Yes (additive) |

Tripwires updated deliberately (not removed): the set of `Runtime.*` methods (+2 read-only
events), a new `functionDeclaration` pin on both constants, tool count 22→23, the manager's
keys, the cutover's `browserTools`, the `baseline-tools.json` fixture regenerated (only
`crunchyroll_play` changed and `crunchyroll_player_control` added).

Test infrastructure: `McpClient` now uses a disposable `HOME` when the inherited `HOME` is still the
account's real home (tests that relocate `HOME` keep their own).

## 4. Dependencies

No new dependencies. No global installation. No changes to Hermes, to the local installation
or to Chromium's global configuration.
