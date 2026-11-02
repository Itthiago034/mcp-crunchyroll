---
name: crunchyroll
description: "Use when the user asks about anime, Crunchyroll, watching something, or its player: playing episodes or movies, choosing seasons, dubbed or subtitled versions, resuming, the next episode, play/pause/fullscreen, title discovery, recommendations, seasonal releases, history, or the watchlist."
version: 2.0.0
author: Thiago
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Anime, Crunchyroll, Streaming, MCP, Media]
---

# Crunchyroll (MCP `crunchyroll`)

*Portuguese reference: [pt-BR](../../docs/pt-BR/crunchyroll-skill.md).*

This skill explains how to use the `crunchyroll` MCP server to find and **play** anime
on the user's Crunchyroll account. Video opens in a new tab of the dedicated browser,
which is already signed in. You need neither your own browser nor passwords or cookies.

Tools appear with the `mcp__crunchyroll__` prefix, for example
`mcp__crunchyroll__crunchyroll_play`. This document uses their short names
(`crunchyroll_play`), but **always call the full name**. If the environment uses
`tool_describe`/`tool_call`, describe only the tools you need and call them by their full names.

## Golden rules

1. **Never open Crunchyroll in another browser** (`browser_exec`, `browser_navigate`, curl,
   web fetch). It does not have the user's session and encounters Cloudflare verification
   (“Just a moment…”, “Verify you are human”). Use **only** `crunchyroll_play` for playback.
2. **Control the player only through `crunchyroll_player_control`** (play, pause, fullscreen,
   exit fullscreen, status). Improvisation is **forbidden**: no terminal, `ps`/`find` to locate
   the browser, JavaScript scripts, direct WebSocket, debugging port (`9222`, `DevToolsActivePort`),
   standalone CDP, `xdotool`, or simulated clicks. If the official tool fails, **tell the user
   what it returned** (see “Player responses”) instead of bypassing the security boundary.
3. **Never ask the user for an email address, password, or code.** The user signs in directly
   in the dedicated browser window.
4. **Do not invent IDs.** Every series, season, or episode ID comes from a tool response.
   IDs use uppercase letters and digits: `G8DHV78ZM`, `GS00377802ENUS`, `GE00377814ENUS`.
5. **Do not repeat the same call with the same arguments** after an error. Read the error
   and follow the error table below.
6. `crunchyroll_continue_watching` and `crunchyroll_get_subscription` **do not work** (they
   always return `OPERATION_NOT_MIGRATED`). Do not call them. To resume, use history (Recipe C).
7. Reply briefly in the user's language; use English when no language preference is known.
   Say what you opened (anime, season, episode, title, and audio language). Do not dump JSON.

## ID types (do not confuse them)

| Type | Example | Source | Used by |
|---|---|---|---|
| Series | `G8DHV78ZM` | `crunchyroll_search`, `crunchyroll_browse`, history's `parent_id` | `crunchyroll_get_seasons`, `crunchyroll_get_series`, `crunchyroll_get_similar` |
| Season | `GS00377802ENUS` | `crunchyroll_get_seasons` → `seasons[].id` or a value from `seasons[].audio_versions` | `crunchyroll_get_episodes` |
| Episode | `GE00377814ENUS` | `crunchyroll_get_episodes` → `episodes[].id` or a value from `episodes[].audio_versions` | `crunchyroll_play`, `crunchyroll_get_episode`, `crunchyroll_get_playheads` |

`crunchyroll_play` accepts only an **episode ID** (or movie ID). Never pass a series or season ID.

## First: the session

You **do not** need to check login or call `crunchyroll_login` before querying. Content
tools re-establish the session automatically, **once for all simultaneous calls**, when
this merely reuses a session the user has already authorized in the dedicated browser
(including the first query in a new conversation). Therefore:

- **Do not** make “test” queries or repeat the first query as a precaution.
- **Do not** request history and recommendations in parallel “to save time”: first decide
  which one the request needs (Recipe F).

When automatic recovery is unavailable, the response includes `code` and `hint`. Follow `code`:

| `code` | Action |
|---|---|
| `LOGIN_REQUIRED`, `SILENT_REAUTH_FAILED`, `SILENT_REAUTH_COOLDOWN`, `REAUTH_REQUIRED` | Call `crunchyroll_login` (no arguments) **once**, then retry the failed call **once**. |
| `LOGGED_OUT` | The user signed out. Ask whether they want to sign in again before calling `crunchyroll_login`. |
| `LOGGING_OUT` | Logout is in progress. Do not retry automatically. |
| `TIMEOUT` / `CANCELLED` | Inform the user; retry only if they ask. |

If `crunchyroll_login` takes a long time and returns `LOGIN_REQUIRED`, or times out,
the browser session has expired. Tell the user, without retrying on your own:
“Your Crunchyroll session has expired. Run `npm run onboard:browser` in your MCP
Crunchyroll checkout, sign in, close the window with its close button, and ask me again.”
The original local setup used `~/mcp-crunchyroll-validacao`; other installations should
use their own checkout directory.
(Cloudflare verification inside the window opened by the MCP requires the same manual
sign-in procedure.)

`crunchyroll_status` only reports state. It never repairs anything.

## Recipe A — “Play <anime> [season N] episode M”

Example: “play Clevatess season 2 episode 12”.

1. Call `crunchyroll_search` with `{"query": "Clevatess"}`.
   - The response is `{"count", "results": [{"type", "id", "title", "description"}]}` (series
     and movies only).
   - Choose the `type: "series"` result whose `title` matches the request. If two different
     anime are plausible, ask which one. For a movie, look for `type: "movie_listing"`.
   - No results: try the English or Japanese title (e.g. “Frieren”, “Sousou no Frieren”)
     before saying you could not find it.
2. Call `crunchyroll_get_seasons` with `{"series_id": "<series ID>"}`.
   - Each `seasons` item has `id`, `title` (e.g. “Clevatess II”), `season_number`,
     `number_of_episodes`, `subtitle_locales`, `original_audio`, and `audio_versions`.
   - **Long series with continuous numbering** (One Piece, Naruto Shippuden, Boruto…):
     `episode_number` is the absolute episode number and the season `title` shows its range,
     e.g. “Land of Wano (892-1088)”, “Egghead (1089-1155)”. For “One Piece ep 1100”, select
     the season whose range contains 1100. For these series, `season_number` does not
     correspond to what the user calls a “season”.
   - “Season 2” means the item with `season_number: 2`. If no season is specified, use
     season 1 if it contains the episode; if the user said only “ep M” and the series has
     several seasons, prefer the most recent season containing episode M **only if** history
     clearly shows they are following that series; otherwise ask.
   - Ignore items outside the main series seasons (e.g. specials, recaps) unless requested.
3. Call `crunchyroll_get_episodes` with `{"season_id": "<season ID>", "episode_number": M}`.
   - Providing `episode_number` returns **only** that episode (`count: 1`) and the season
     total in `season_episode_count`. Always use it when you know the number to keep responses small.
   - Each episode has `id`, `episode_number`, `title`, `is_premium_only`, `availability_status`,
     `next_episode_id`, `duration_ms`, `original_audio`, and `audio_versions`.
   - `count: 0` → the season may **continue the previous season's numbering** (e.g. Kaiju No. 8
     season 2 starts at episode 13). If `M <= season_episode_count`, query again **without**
     `episode_number`, sort by `episode_number`, and select the Mth episode of the season
     (Kaiju's “season 2 episode 5” has `episode_number` 16). Tell the user both numbers
     (“5th of the season, episode 16”). If `M > season_episode_count`, state the season's episode count.
   - Without a number (e.g. “what is in this season?”), omit `episode_number` to list all episodes.
4. Choose the audio language (see “Languages and versions”) and call `crunchyroll_play` with
   `{"episode_id": "<selected episode ID>"}`.
   - Success: `{"opened": true, "episode_id", "url"}`. The player opens in a dedicated
     browser tab; if an episode is already open, the same tab navigates to the new one.
   - If the user requests immediate playback and/or fullscreen (“open and play it”, “in
     fullscreen”), pass the options in the **same** call: `{"episode_id": "...", "autoplay": true}`
     and/or `"fullscreen": true`. The response includes `autoplay`/`fullscreen` with each
     step's result and `partial: true` if any step was not confirmed. Without the options,
     behavior is unchanged.
5. Reply: “Opened **Clevatess II – ep. 12: The Millennium of a Dark Beast Lord**
   (Portuguese dub, pt-BR) in the Crunchyroll browser.”

## Recipe B — Next episode

1. Identify the current episode: the one you just opened, or the first history item (Recipe C).
2. Call `crunchyroll_get_episode` with that ID → read `next_episode_id` (it may be in any
   language, e.g. `...ENUS`).
3. To preserve the current audio language, call `crunchyroll_get_episode` with `next_episode_id`
   and select the `guid` in `versions` whose `audio_locale` matches the requested language
   (`crunchyroll_get_episode` returns full versions: a list of `{audio_locale, guid, original, ...}`).
   **Do not construct an ID by manually changing its suffix** (`ENUS` → `PTBR`): not every
   episode has every dub, and the invented ID may not exist.
4. Call `crunchyroll_play` with that `guid`. Without `next_episode_id`, the season has ended:
   say so and offer the next season (`crunchyroll_get_seasons`).

## Recipe C — “Resume where I left off” / “What was I watching?”

1. Call `crunchyroll_get_history` with `{"n": 10}`.
   - `items[]` runs from newest to oldest. Each item has `id` (episode, e.g.
     `GE00377814PTBR`), `title` (episode title), `parent_id` (series), `playhead` (seconds
     watched), `fully_watched`, `date_played`, and `episode_metadata` with `series_title`,
     `season_title`, `season_number`, `episode_number`, `duration_ms`, `original_audio`,
     and `audio_versions`.
   - Several entries may refer to the same episode or series; the first is the most recent.
2. Take the first item (or the first item for the series the user named, comparing `parent_id`).
   - `fully_watched: false` → open **that same** `id` with `crunchyroll_play`; the player
     resumes from `playhead`. “Continue the anime” requests playback: use
     `{"episode_id": "<id>", "autoplay": true}` in the same call (do not call player control afterward).
   - `fully_watched: true` → open the next episode (Recipe B, starting at step 2).
   - “Resume” means the same unfinished episode. “Next” always means the following episode
     (Recipe B), even if the current one is unfinished.
3. The history `id` suffix indicates the user's usual audio language (`...PTBR` = Portuguese
   dub; `...JAJP` = Japanese original). Use that as the default preference.

## Recipe F — “Put on some anime” (without naming one)

Choose one query based on context — **do not** request history and recommendations together:

1. If the conversation already shows what the user is following, or they said “again”,
   “that one”, or “what I was watching”: use `crunchyroll_get_history {"n": 5}` and Recipe C.
2. If they request something new (“surprise me”, “something different”, a genre): Recipe D,
   **one** tool.
3. With no clues: `crunchyroll_get_history {"n": 5}`. If the first item is unfinished
   (`fully_watched: false`), offer to resume (“Continue **X**, episode N?”); only if history
   is empty, use `crunchyroll_get_recommendations {"n": 5}`.
4. Open (`crunchyroll_play`) only after the user chooses, unless they said “you can choose”;
   in that case, open the first candidate and name it.

## Recipe G — Player control (“play”, “pause”, “fullscreen”)

The episode must already be open through `crunchyroll_play`. One call per request:

| Request | Call |
|---|---|
| “play”, “continue”, “resume playback” | `crunchyroll_player_control {"action": "play"}` |
| “pause”, “stop for a moment” | `crunchyroll_player_control {"action": "pause"}` |
| “fullscreen”, “maximize the video” | `crunchyroll_player_control {"action": "fullscreen"}` |
| “exit fullscreen” | `crunchyroll_player_control {"action": "exit_fullscreen"}` |
| “is it playing?”, “what minute is it at?” | `crunchyroll_player_control {"action": "status"}` |
| “fullscreen and play” | `fullscreen`, then `play` (two calls, in that order) |

**Claim success only when `success: true` and `verified: true`.** The `state` field reports
observations (`playing`, `paused`, `fullscreen`, `current_time`, `duration`).

### Player responses

| `outcome` | What to say / do |
|---|---|
| `CONFIRMED` | Confirm (“Playing in fullscreen.”). `reason: "ALREADY_IN_STATE"` means it was already in that state. |
| `REFUSED_BY_BROWSER` | The browser refused (`reason` explains why, e.g. `AUTOPLAY_BLOCKED_USER_ACTIVATION_REQUIRED`, `FULLSCREEN_NOT_ALLOWED_IN_FRAME`). Tell the user and suggest clicking the player / pressing `F` in the window. **Do not** try another method. |
| `NOT_CONFIRMED` | The command was sent but the state did not change. Say so; retry **once** only if the user asks. |
| `PLAYER_LOADING` | The video is still loading. Wait a few seconds and retry **once**. |
| `PLAYER_UNAVAILABLE` | No controllable player in the tab (e.g. notice page, ad, another page). Say so. |
| `TAB_NOT_FOUND` | No episode is open: open one with `crunchyroll_play` first (or ask which episode). |
| `TAB_CLOSED`, `SESSION_DISCONNECTED` | The tab/browser closed. Open it again with `crunchyroll_play` if the user wants. |
| `NOT_PERMITTED` | Player control is unavailable during/after logout. Say so. |
| `TIMEOUT`, `BUSY` | Inform the user and do not keep looping. |

## Languages and versions (dubbed vs. subtitled)

In lists (`crunchyroll_get_seasons`, `crunchyroll_get_episodes`, `crunchyroll_get_history`),
each item has `original_audio` and `audio_versions`, a map of **audio locale → playback ID**.
Real example (Clevatess II, ep. 12):

```json
"original_audio": "ja-JP",
"audio_versions": {"ja-JP": "GE00377814JAJP", "en-US": "GE00377814ENUS", "pt-BR": "GE00377814PTBR"}
```

- Explicit audio language → use the corresponding `audio_versions` entry. For example,
  “in Portuguese” → `audio_versions["pt-BR"]`; “English dub” → `audio_versions["en-US"]`.
- “Subtitled”, “original”, or “in Japanese” → `audio_versions[original_audio]` (usually `ja-JP`).
  The player handles subtitle selection according to its settings; response language alone
  does not select an audio locale or guarantee a subtitle language.
- The user **already specified** the language → use it directly; **do not** query history.
- “Dubbed” without an explicit language → use an audio preference already known from context
  or history; if none is known, ask which dub. For Portuguese requests, “dublado” / “em português”
  can refer to `audio_versions["pt-BR"]` as in the example below.
- No audio preference in the request → use history's preference (Recipe C, step 3) if already
  available; otherwise use the episode `id` as returned (Crunchyroll applies the account preference).
- Requested locale missing from the map → explain that the requested dub is unavailable
  and use the original audio, making that choice clear. For missing `pt-BR`, for example:
  “There is no Portuguese dub; I opened the original version.”

## Recipe D — Discover what to watch

| Request | Tool | Arguments |
|---|---|---|
| “recommend something” | `crunchyroll_get_recommendations` | `{"n": 5}` |
| “similar to X” | `crunchyroll_search` → `crunchyroll_get_similar` | `{"series_id": "...", "n": 5}` |
| “popular”, “new arrivals” | `crunchyroll_browse` | `{"sort_by": "popularity"}` or `{"sort_by": "newly_added"}` |
| “romance/action anime…” | `crunchyroll_get_categories`, then `crunchyroll_browse` | `{"categories": "romance", "sort_by": "popularity"}` (use the category `id`) |
| “this season's releases” | `crunchyroll_get_simulcast_seasons`, then `crunchyroll_browse` | `{"seasonal_tag": "fall-2026"}` (the first item is the current season) |
| “tell me about X” | `crunchyroll_search` → `crunchyroll_get_series` | `{"series_id": "..."}` |

Present 3 to 5 choices with a title and one-sentence synopsis in the user's language,
and offer to open one. Recommendations may include non-anime items (e.g. “The Crunchyroll
Anime Awards”): skip those.

## Recipe E — Watchlist

- Read: `crunchyroll_get_watchlist` with `{"n": 10}`. Each item already has `id`, `title`,
  `type` (`series` or `movie_listing`), `is_favorite`, and `date_added`, newest first.
  List the titles directly; **do not** call `crunchyroll_get_series` for each item. If the
  user asks for “the whole list”, use `{"n": 50}` (maximum).
- Add: find the series and call `crunchyroll_add_to_watchlist` with `{"content_id": "<series ID>"}`.
- Remove: `crunchyroll_remove_from_watchlist` with `{"content_id": "<series ID>"}`.
- These two operations modify the account. Perform them only when the user clearly asks.
  If the response is `MUTATION_OUTCOME_UNKNOWN`, **do not repeat**: check with `crunchyroll_get_watchlist`.

## Progress

- Read: `crunchyroll_get_playheads` with `{"content_ids": ["GE..."]}` → `playhead` in seconds
  and `fully_watched`.
- `crunchyroll_update_playhead` modifies the account: use it only when the user explicitly
  asks to mark progress.

## Error table

| Response | Action |
|---|---|
| `Not authenticated: log in before requesting content` (with `code`) | Follow the session `code` table. Without `code`: `crunchyroll_login` once, then retry the call once. |
| `OPERATION_NOT_MIGRATED` | Disabled tool. Use the alternative (history instead of continue_watching). Do not repeat. |
| `crunchyroll_play takes episode_id ...` | Wrong ID (series/season, lowercase, URL) or a non-boolean option. Get the `id` from `crunchyroll_get_episodes`. |
| `crunchyroll_player_control takes exactly one argument, action...` | Use only `{"action": "play" \| "pause" \| "fullscreen" \| "exit_fullscreen" \| "status"}`. |
| `Upstream has no such resource` | The ID does not exist. Go back one step (search/seasons) and take the ID from the response. |
| `Upstream is rate limiting this client` | Wait before trying again; inform the user. |
| `The managed browser is unavailable` / `BROWSER_UNAVAILABLE` | The dedicated browser closed or is busy. Call `crunchyroll_login` once (it reopens it); if the issue persists, tell the user to close Crunchyroll profile windows and try again. |
| `MCP server 'crunchyroll' lost its stdio subprocess` / timeout | The server restarted. Call `crunchyroll_status` once; if it responds, retry the request. Otherwise ask the user to run `/reload-mcp`. |
| `MUTATION_OUTCOME_UNKNOWN` | Do not repeat the change. Check the state (watchlist/playheads) and report it. |

## Complete example (real)

Request: “Play Clevatess season 2 episode 12 with the Portuguese dub.”

1. `crunchyroll_search {"query":"Clevatess"}` → series `G8DHV78ZM` “Clevatess”.
2. `crunchyroll_get_seasons {"series_id":"G8DHV78ZM"}` → `season_number: 2` = `GS00377802ENUS`
   “Clevatess II”, 13 episodes.
3. `crunchyroll_get_episodes {"season_id":"GS00377802ENUS","episode_number":12}` → “The Millennium
   of a Dark Beast Lord”; `audio_versions["pt-BR"]` = `GE00377814PTBR`.
4. `crunchyroll_play {"episode_id":"GE00377814PTBR"}` → `{"opened": true, ...}`.
5. Reply: “Opened **Clevatess II – ep. 12: The Millennium of a Dark Beast Lord**, with the
   Portuguese dub (pt-BR), in the Crunchyroll browser.”

Four calls, no login, no separate browser.

Follow-up request: “Can you put it in fullscreen and play it?”

1. `crunchyroll_player_control {"action":"fullscreen"}` → `{"success": true, "verified": true, "state": {"fullscreen": true, ...}}`.
2. `crunchyroll_player_control {"action":"play"}` → `{"success": true, "verified": true, "state": {"playing": true, ...}}`.
3. Reply: “Playing in fullscreen.”

Two calls, no terminal, no scripts.
