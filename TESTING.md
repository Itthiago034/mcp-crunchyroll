# TESTING — Crunchyroll MCP 2.0

*Portuguese version: [pt-BR](docs/pt-BR/testes.md).*

## 1. Environment

| Item | Value |
|---|---|
| Container | Claude Code Cloud, Linux 6.18, Node v22.22.0, session as `root` |
| Unprivileged test user | `tester` (created in the container), so the Chromium sandbox works **without** `--no-sandbox` |
| Browsers | Chrome for Testing **131.0.6778.85** (the same version pinned in CI) and Chromium 141 (Playwright build 1194) |
| Mode | headless (`--headless=new`), sandbox active |
| Crunchyroll account | **none**. No test touches the real Crunchyroll, the account or the real session |

## 2. Commands executed

```bash
npm ci
npm run typecheck            # tsc --noEmit — clean
npm run build                # dist/index.js
# full suite, unprivileged, with the CI browser:
su tester -c 'HOME=/home/tester CI=true CRUNCHYROLL_BROWSER_EXECUTABLE=/opt/cft-131/chrome-linux64/chrome npm test'
# same with Chromium 141:
su tester -c 'HOME=/home/tester CI=true CRUNCHYROLL_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm test'
# full suite as root (for comparison):
CI=true npm test
# stability of the real-browser test (5× Chromium 141, 3× CfT 131):
npx tsx --test test/player-real-browser.test.ts
```

## 3. Results

| Run | Tests | Passed | Failed |
|---|---:|---:|---:|
| **Before** (`validacao-linux@e1c076e`), `tester`, CfT 131 | 1055 | 1055 | 0 |
| **After**, `tester`, CfT 131 | **1167** | **1167** | **0** |
| **After**, `tester`, Chromium 141 | **1167** | **1167** | **0** |
| After, `root` (reference) | 1150 | 1145 | 5 |
| `player-real-browser` repeated | 8 runs | 8/8 green | 0 |

The 5 failures as `root` are environmental and **also occur before the change**: Chromium refuses to
run as root without `--no-sandbox` (3 real-browser suites, including the new one) and root ignores
file permissions (2 B2/B5 storage tests that expect `EACCES`/a different owner). In CI
(user `runner`, SUID sandbox) they run normally.

## 4. New tests (+112)

| File | Tests | Covers |
|---|---:|---|
| `test/player-controller.test.ts` | 26 | play/pause, fullscreen/exit, `ALREADY_IN_STATE` no-op, status without command, nonexistent player, video loading (with and without waiting), refusal by autoplay policy, missing activation, frame without fullscreen permission, command with no effect (`NOT_CONFIRMED`), pending `play()`, nonexistent/ambiguous/unconfigured tab, tab closed mid-way, CDP reconnection, per-command and total-budget timeout, waiting for the right episode, two concurrent actions in order, `BUSY`, logout before/during, cancellation, unknown action, **property: no success without verification** (11 scripts × 3 states × 5 actions) |
| `test/playback-channel.test.ts` | 22 | tab selection (recorded, single, ambiguous, none, origin/userinfo/http/invalid-ID lookalikes, empty URL during navigation), default worlds only on allowed origins (extension and isolated world never), frozen function + closed-over arguments, gesture only on play/fullscreen, unknown command refused before being sent, stream URL never leaves, OOPIF via auto-attach and detached worker, frame from a foreign origin never probed, **OOPIF regression on the first command**, reconnection makes the channel stale, destroyed tab, deadline, `currentContentId` validated, `close` releases listeners and session, channel surface, **exact allowlist of CDP methods**, `adoptOnly` never spawns |
| `test/session-recovery.test.ts` | 20 | classification of the 6 states (includes tombstone), reuse, cold start with/without marker, expired without reading the marker, logout/revocation/logout-in-progress never undone, **20 callers → 1 attempt and 1 marker read**, cool-down against storms, recovery after cool-down, human login clears the cool-down, timeout/cancellation per caller without affecting the others, logout during the attempt, `callWithSession`: pre-check, structured error, 1 retry only pre-dispatch, **never retries post-dispatch**, other errors never retry, no loop, 10 concurrent calls → 1 attempt and 10 dispatches |
| `test/auth-orchestrator-silent.test.ts` | 10 | short deadline only in the silent path, a silent failure neither installs nor writes the marker, flights do not stack, joins an interactive login, an interactive login during a failed silent one waits for the human, logout cancels and late material does not install, no attempt during logout/after revocation, `recordLogout` → producer ordering, a failing store does not block logout |
| `test/session-eligibility.test.ts` | 7 | path, write/read/clear without secret, loose permission not trusted, symlink never followed and `clear` does not delete the target, malformed content, tombstone written/cleared by login, fail-closed tombstone |
| `test/session-dispatch-integration.test.ts` | 9 | **real chain** registry→dispatcher→backend→authority: without a session no channel is opened; with a session the probe is marked before the request; mutation on cold start written **1×**; 3 concurrent mutations = 1 establishment + 3 distinct writes; uncertain write never retried; concurrent probes do not leak; bearer never in the error; classification with the real authority (fresh/usable/expired/logout/revoked) |
| `test/player-real-browser.test.ts` | 8 | **real Chromium** + loopback fixture with a cross-site iframe (OOPIF) and strict autoplay policy (flag **only in the test**): autoplay without a gesture from the page itself refused (`NotAllowedError`) and the controller's confirmed; `currentTime` advances; pause; fullscreen and exit in the OOPIF; frame with `allow="fullscreen 'none'"` → `REFUSED_BY_BROWSER`; top-level player after navigation in the same tab; **no CDP session stays attached** (verified with an independent connection; the test fails if the detach is removed) |
| `test/mcp-harness.test.ts` | +10 (5 × tsx/bundle) | over stdio: strict player schema (unknown action, `script`, `port`, empty, wrong type → `-32602`, nothing echoed); no tab → structured refusal and **no browser started**; non-boolean options/extra fields/invalid ID in `crunchyroll_play` → `-32602`; cold start without marker → structured `LOGIN_REQUIRED` and no browser; **logout survives a process restart** (player `NOT_PERMITTED`, content `LOGGED_OUT`) |

## 5. Bugs found by the tests and fixed before delivery

1. The controller's first permission check was outside the `try` → a refusal became an exception instead of a report (`player-controller`).
2. **Real Chromium:** already existing OOPIF frames only registered contexts after the first probe → false `NO_VIDEO`. Fixed by waiting for the children's `Runtime.enable`; regression reproduced in the fake (it fails without the fix).
3. **Real Chromium:** during navigation the tab reports URL `""` → false `TAB_NOT_FOUND`. The tab we opened ourselves is still ours during that interval; any other URL is not.
4. A fixture that only worked where `localhost` resolves to `::1` first (it would clash in CI). Replaced with `127.0.0.2`.
5. A harness adjustment that broke tests which relocate `HOME` — refined (it only replaces the real `HOME`).
6. Audit: logout did not survive a process restart (see SECURITY-MODEL.md).

## 6. Test limitations

- **No test against the real Crunchyroll** (forbidden without authorization). The real player (Vilos, at
  `static.crunchyroll.com`) was not exercised: frame selection, the iframe's `allowfullscreen` and the
  player's behavior with DRM are left to the authorized validation (RELEASE-DECISION.md §3).
- Headless only. In visible mode fullscreen affects the real window; the behavior is the same as the
  Fullscreen API's, but it was not measured here.
- Synthetic media (WAV); EME/Widevine are not in the tested path.
- GitHub CI had not yet run on this branch at the time of writing (see PR).
- Nested OOPIF frames (iframe inside a cross-site iframe) are not auto-attached.
