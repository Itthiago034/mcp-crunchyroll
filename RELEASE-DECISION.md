# RELEASE DECISION — Crunchyroll MCP 2.0

*Portuguese version: [pt-BR](docs/pt-BR/decisao-final.md).*

## Classification

**READY_FOR_INDEPENDENT_AUDIT**

No production approval is implied. No merge or deployment had been performed at the time of this report.

## 1. Completion criteria

| Criterion | Status | Evidence |
|---|---|---|
| Native playback control | Done | `crunchyroll_player_control`; `openPlaybackControlChannel`; real Chromium 8/8 |
| Deterministic concurrent authentication | Done | Single-flight; 20 callers → 1 attempt; real chain: mutations written 1× |
| Updated skill | Done | `skills/crunchyroll/SKILL.md` 2.0.0 |
| Relevant tests pass | Done | 1167/1167 (unprivileged, CfT 131 and Chromium 141); previously 1055/1055 |
| New security controls verified | Done | [SECURITY-MODEL.md](SECURITY-MODEL.md) §2–3 |
| Compatibility preserved | Done | [IMPLEMENTATION.md](IMPLEMENTATION.md) §3; `crunchyroll_play` without options is identical |
| Fullscreen/autoplay limitations documented | Done | [SECURITY-MODEL.md](SECURITY-MODEL.md) §4, [TESTING.md](TESTING.md) §6, skill's “Player responses” section |
| Draft PR available | Done | See the link in the PR |

## 2. Why this is not a broader approval

- No tests against the real Crunchyroll service were performed for this report (prohibited without authorization). The real player (Vilos iframe
  on `static.crunchyroll.com`) is the main unknown: origin, `allowfullscreen`, multiple `<video>` elements.
- GitHub CI still needed to run on this branch when this report was written.
- The PR against `main` also carries the `validacao-linux` commits (see [ARCHITECTURE.md](ARCHITECTURE.md) §6).

## 3. Recommended next validation (requires explicit user authorization)

1. Run CI (Node 18/20/22) on the PR.
2. Independently audit the 2.0 diff (`git diff e1c076e..HEAD`), focusing on `browser-session-manager.ts`
   (channel), `session-recovery.ts`, and `index.ts`.
3. Validate **locally, with the user's account and explicit authorization**, in visible mode:
   - Run `crunchyroll_play {"episode_id": <previously watched episode>, "autoplay": true}` and check `verified`.
   - Run `crunchyroll_player_control` with `pause`, `play`, `fullscreen`, `exit_fullscreen`, and `status`.
   - Record the `outcome`/`reason` of each step; if `PLAYER_UNAVAILABLE` occurs, record the actual origin of
     the player frame (without page content) to adjust `CRUNCHYROLL_PLAYER_FRAME_ORIGINS`.
   - Restart the MCP and repeat a query: it should work without `crunchyroll_login` (marker).
   - Run `crunchyroll_logout`, restart, then `player_control status` → `NOT_PERMITTED`.
4. Repeat with Hermes and measure actual MCP/terminal calls against the “MODELED” table in [BENCHMARK.md](BENCHMARK.md).
