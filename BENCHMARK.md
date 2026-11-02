# BENCHMARK — previous × Crunchyroll MCP 2.0

*Portuguese version: [pt-BR](docs/pt-BR/benchmark.md).*

Three kinds of number appear here and they are **never mixed**:

- **REAL** — measured in this session, in a real Chromium (CfT 131, headless), against the synthetic loopback fixture. It is not Crunchyroll.
- **SYNTHETIC** — measured by running real code (the previous logic, copied, and the new one) against identical authority/login/gateway fakes. Login/network latencies are simulated.
- **MODELED** — call count derived from the skill's recipes and the reported incident. Not measured; Hermes did not run here.

Raw data: `docs/validation-results/benchmark-player.json` (generated at 2026-10-22T23:46Z).
Reproduce: `CRUNCHYROLL_BROWSER_EXECUTABLE=<chrome> npx tsx scripts/benchmark-player.ts 15` (unprivileged user).

## 1. Player control — REAL

15 iterations per action, same tab, same browser. "Ad hoc" is an **approximation** of the path
Hermes improvised: a new Node process per action that reads `DevToolsActivePort`, opens its own
CDP WebSocket, attaches to the tab and runs `Runtime.evaluate` with `userGesture`. It does **not**
include the dominant cost of the real incident — the LLM turns spent looking for files and
processes and writing scripts.

| Action | Native p50 / p95 (ms) | Native verified | Ad hoc p50 / p95 (ms) | Ad hoc self-reported "ok" |
|---|---|---:|---|---:|
| play | 4.9 / 11.5 | 15/15 | 60.2 / 70.8 | 15/15 |
| pause | 4.3 / 7.1 | 15/15 | 60.4 / 78.3 | 15/15 |
| fullscreen | 7.4 / 13.9 | 15/15 | 65.6 / 82.3 | 15/15 |
| exit_fullscreen | 13.7 / 20.0 | 15/15 | 67.6 / 90.8 | 15/15 |
| status | 3.1 / 4.6 | 15/15 | — | — |

Notes:
- The native path verifies through an independent **follow-up probe**; the ad hoc "ok" is the return
  value of the script itself (what Hermes would have had). Both worked here because the fixture used in
  the comparison has the video in the top-level document — the ad hoc script **does not reach** a
  player in a cross-site iframe (the real suite's case), the native one does.
- `crunchyroll_play`-equivalent with `autoplay` (open + wait for player + verified play): **219 ms** on the fixture.
- Node process CPU per native action: **2.38 ms** (average over 75 actions).
- Total browser RSS (MiB): 1128 before → 1156 after 75 actions → 1157 after 5 s idle → 1166 after
  another 75 actions; 1163 after the ad hoc round. There is modest growth (+28, then +10) that we do
  **not** prove to be zero; the absence of attached CDP sessions was verified separately
  (`player-real-browser`, test 7). Small sample; do not extrapolate.

## 2. Authentication — SYNTHETIC

Same fakes (simulated login 120 ms, request 20 ms; eligibility marker present). In the
"previous" column, the recovery calls that the old skill told the agent to make (login + retry
each failure) are included.

| Scenario | Impl. | MCP calls | Error results | Auth attempts | Gateway attempts | Dispatches to the provider |
|---|---|---:|---:|---:|---:|---:|
| Cold start, 1 query | previous | 3 | 1 | 1 | 2 | 1 |
| | **new** | **1** | **0** | 1 | **1** | 1 |
| Cold start, 2 concurrent queries | previous | 5 | 2 | 1 | 4 | 2 |
| | **new** | **2** | **0** | 1 | **2** | 2 |
| Expired session, 1 query | previous | 1 | 0 | 1 | 2 | 1 |
| | **new** | 1 | 0 | 1 | **1** | 1 |
| Expired, 10 concurrent | previous | 10 | 0 | 1 | 20 | 10 |
| | **new** | 10 | 0 | 1 | **10** | 10 |

Wall-clock latency: ~141 ms in every case, because the fake does not model the LLM turn; the real
cold-start gain is **eliminating 2 MCP calls and 1 error result per query** (each one costs a model
turn). We do not claim an end-to-end latency gain.

Automatic content retries: previous 1 per expired call (post-failure); new 0 in the scenarios
above (the pre-check avoids them) and at most 1, only pre-dispatch.

## 3. Agent flows — MODELED

| # | Scenario | Previous (MCP / terminal) | New (MCP / terminal) |
|---|---|---|---|
| 1 | Open an episode after a cold start ("put on X ep 12") | 6 / 0 (search fails, login, search, seasons, episodes, play) | 4 / 0 |
| 2 | Resume from history ("continue") | 4 / 0 (history fails, login, history, play) + manual play | 2 / 0 (history, play with `autoplay`) |
| 3 | Start playback | 1 + improvisation: ≥4 terminal calls observed in the incident (searching for files/processes, discovering CDP, creating and running a script) | 1 / 0 |
| 4 | Pause | improvisation through the terminal | 1 / 0 |
| 5 | Fullscreen | improvisation through the terminal + simulated mouse | 1 / 0, with verification |
| 6 | Expired session | 1 / 0 (automatic recovery, 2 gateway attempts) | 1 / 0 (1 attempt) |
| 7 | Two concurrent queries on a cold start | 5 / 0 | 2 / 0 |

Player state confirmation rate: previously **there was none** (the improvisation did not verify
independently); new **100% across the 75 real actions measured** (all `verified: true`).

## 4. What was not measured

- End-to-end latency with Hermes and with the real Crunchyroll.
- Real Vilos player, visible mode, DRM.
- Hermes CPU/RAM consumption.
