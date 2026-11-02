// Player control — the native playback controller.
//
// Owns the ORCHESTRATION of one player action: the permission gate, one-at-a-
// time execution, waiting for a verifiable player, the action itself and the
// verification of its effect. It owns no CDP: everything it does in the browser
// goes through the closed PlaybackControlChannel the session manager opens, so
// it cannot reach another tab, another target, a debugging port or a cookie.
//
// The rule that shapes every report: an action is `verified` only when a probe
// AFTER the action observed the requested state. Sending a command is never
// evidence that it worked.

import { BrowserLifecycleError } from "./browser-lifecycle-error.js";
import type {
  PlaybackControlChannel,
  PlayerCommand,
  PlayerCommandResult,
  PlayerFrameState,
  PlayerMediaError,
} from "./browser-lifecycle-types.js";

/** The closed public action set of `crunchyroll_player_control`. */
export type PlayerAction = "play" | "pause" | "fullscreen" | "exit_fullscreen" | "status";

export const PLAYER_ACTIONS: readonly PlayerAction[] = Object.freeze([
  "play",
  "pause",
  "fullscreen",
  "exit_fullscreen",
  "status",
]);

/**
 * The closed outcome set. Each one answers a different question, so a caller
 * never has to infer from a message which of them happened.
 */
export type PlayerOutcome =
  /** The requested state was observed after the action (or was already true). */
  | "CONFIRMED"
  /** The command ran but the requested state was not observed in time. */
  | "NOT_CONFIRMED"
  /** The page refused: autoplay policy, missing activation, fullscreen disallowed. */
  | "REFUSED_BY_BROWSER"
  /** A playback tab exists but its video is not ready to be controlled yet. */
  | "PLAYER_LOADING"
  /** No controllable video in the playback tab's allowed frames. */
  | "PLAYER_UNAVAILABLE"
  /** No playback tab (or more than one, with none opened by this server). */
  | "TAB_NOT_FOUND"
  /** The playback tab closed while the action was running. */
  | "TAB_CLOSED"
  /** The managed browser is not running, or its CDP connection was replaced. */
  | "SESSION_DISCONNECTED"
  /** The action did not finish within its deadline. */
  | "TIMEOUT"
  /** Playback control is refused right now (logout in progress, or logged out). */
  | "NOT_PERMITTED"
  /** Too many player actions are already queued. */
  | "BUSY";

export interface PublicPlayerState {
  /** Legacy instantaneous flag only; use report.playback for verified progress. */
  readonly playing: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  /** Playing but without enough data to advance (readyState below HAVE_FUTURE_DATA). */
  readonly buffering: boolean;
  /** No source attached yet, or no metadata loaded. */
  readonly loading: boolean;
  readonly fullscreen: boolean;
  readonly muted: boolean;
  readonly current_time: number;
  readonly duration: number;
  readonly ready_state: number;
}

/** Playback evidence, distinct from the legacy instantaneous `state` flags. */
export interface PlaybackEvidence {
  readonly state: "playing" | "paused" | "loading" | "error" | "unknown";
  readonly current_time: number | null;
  readonly fullscreen: boolean | null;
  readonly audio_locale?: string;
  readonly player_error: PlayerMediaError | null;
  readonly playing_verified: boolean;
}

export interface PlayerControlReport {
  /** The action the caller asked for. */
  readonly action: PlayerAction;
  /** Whether the page-side command was actually sent (false for a no-op or an early refusal). */
  readonly executed: boolean;
  /** Whether a probe AFTER the action observed the requested state. */
  readonly verified: boolean;
  readonly success: boolean;
  readonly outcome: PlayerOutcome;
  /** A closed reason name when the outcome needs one. Never page text. */
  readonly reason?: string;
  /** The last observed player state, or null when none could be observed. */
  readonly state: PublicPlayerState | null;
  /** Reusable evidence; `verified` alone means the requested action, not playback. */
  readonly playback: PlaybackEvidence;
  readonly message: string;
}

export type PlaybackPermission = "OK" | "LOGGING_OUT" | "LOGGED_OUT";

export interface PlayerControllerPorts {
  /** The session manager's closed channel. Never a generic CDP surface. */
  openChannel(): Promise<PlaybackControlChannel>;
  /** Whether playback control may run right now; re-read before every step. */
  permission(): PlaybackPermission;
  now(): number;
  sleep(ms: number): Promise<void>;
  readonly timing?: Partial<PlayerTiming>;
}

export interface PlayerTiming {
  /** Upper bound for one whole action, waits included. */
  readonly actionDeadlineMs: number;
  /** How long a command's effect may take to become observable. */
  readonly verifyTimeoutMs: number;
  readonly pollIntervalMs: number;
  /** Upper bound for one channel command. */
  readonly commandDeadlineMs: number;
  /** Maximum actions waiting behind the running one. */
  readonly maxQueued: number;
}

export const DEFAULT_PLAYER_TIMING: PlayerTiming = Object.freeze({
  actionDeadlineMs: 15_000,
  verifyTimeoutMs: 3_000,
  pollIntervalMs: 150,
  commandDeadlineMs: 6_000,
  maxQueued: 4,
});

export interface PerformOptions {
  /** Act only once the tab is on THIS content id (crunchyroll_play's own episode). */
  readonly expectContentId?: string;
  /** Wait up to this long for the player to load before acting. Default: no wait. */
  readonly waitForReadyMs?: number;
  readonly signal?: AbortSignal;
}

export interface PlayerController {
  perform(action: PlayerAction, options?: PerformOptions): Promise<PlayerControlReport>;
}

const COMMAND_FOR: Record<Exclude<PlayerAction, "status">, PlayerCommand> = {
  play: "play",
  pause: "pause",
  fullscreen: "enter_fullscreen",
  exit_fullscreen: "exit_fullscreen",
};

/** The predicate a probe must satisfy for the action to count as verified. */
const REACHED: Record<Exclude<PlayerAction, "status">, (state: PlayerFrameState) => boolean> = {
  play: (state) => !state.paused && !state.ended,
  pause: (state) => state.paused,
  fullscreen: (state) => state.fullscreen,
  exit_fullscreen: (state) => !state.fullscreen,
};

const MESSAGES: Record<PlayerOutcome, string> = {
  CONFIRMED: "The player state was verified.",
  NOT_CONFIRMED: "The command was sent, but the requested player state was not observed.",
  REFUSED_BY_BROWSER: "The browser refused the request.",
  PLAYER_LOADING: "The player is still loading; try again in a moment.",
  PLAYER_UNAVAILABLE: "No controllable video player was found in the playback tab.",
  TAB_NOT_FOUND: "No playback tab is open. Open an episode with crunchyroll_play first.",
  TAB_CLOSED: "The playback tab was closed during the action.",
  SESSION_DISCONNECTED: "The managed browser is not connected.",
  TIMEOUT: "The player action did not finish in time.",
  NOT_PERMITTED: "Playback control is not permitted while logging out or after logout.",
  BUSY: "Too many player actions are already queued.",
};

function isLoading(state: PlayerFrameState): boolean {
  return !state.hasSource || state.readyState < 1;
}

export function toPublicState(state: PlayerFrameState): PublicPlayerState {
  const playing = !state.paused && !state.ended;
  return Object.freeze({
    playing,
    paused: state.paused,
    ended: state.ended,
    buffering: playing && state.readyState < 3,
    loading: isLoading(state),
    fullscreen: state.fullscreen,
    muted: state.muted,
    current_time: Math.round(state.currentTime * 10) / 10,
    duration: Math.round(state.duration * 10) / 10,
    ready_state: state.readyState,
  });
}

function playbackEvidence(state: PlayerFrameState | undefined, playingVerified: boolean, outcome: PlayerOutcome): PlaybackEvidence {
  return Object.freeze({
    state: !state ? (outcome === "PLAYER_LOADING" ? "loading" : "unknown")
      : state.playerError ? "error"
      : isLoading(state) || state.readyState < 3 ? "loading"
      : state.paused || state.ended ? "paused"
      : playingVerified ? "playing" : "unknown",
    current_time: state?.currentTime ?? null,
    fullscreen: state?.fullscreen ?? null,
    ...(state?.audioLocale ? { audio_locale: state.audioLocale } : {}),
    player_error: state?.playerError ?? null,
    playing_verified: playingVerified,
  });
}

/** Thrown internally to unwind an action into one report; never escapes. */
class Stop extends Error {
  constructor(readonly outcome: PlayerOutcome, readonly reason?: string) {
    super(outcome);
  }
}

export function createPlayerController(ports: PlayerControllerPorts): PlayerController {
  const timing: PlayerTiming = { ...DEFAULT_PLAYER_TIMING, ...ports.timing };
  /** One action at a time: actions run in arrival order, never interleaved. */
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;

  const report = (
    action: PlayerAction,
    outcome: PlayerOutcome,
    fields: { executed: boolean; verified: boolean; state: PlayerFrameState | undefined; reason?: string; playingVerified?: boolean },
  ): PlayerControlReport => {
    const success = outcome === "CONFIRMED";
    return Object.freeze({
      action,
      executed: fields.executed,
      verified: fields.verified,
      success,
      outcome,
      ...(fields.reason ? { reason: fields.reason } : {}),
      state: fields.state ? toPublicState(fields.state) : null,
      playback: playbackEvidence(fields.state, fields.playingVerified === true, outcome),
      message: MESSAGES[outcome],
    });
  };

  const run = async (action: PlayerAction, options: PerformOptions): Promise<PlayerControlReport> => {
    const started = ports.now();
    const totalBudget = timing.actionDeadlineMs + Math.max(0, options.waitForReadyMs ?? 0);
    const remaining = () => totalBudget - (ports.now() - started);
    let executed = false;
    let lastState: PlayerFrameState | undefined;

    /** Re-checked before every step: a logout, a cancel or the deadline stops the action. */
    const checkpoint = () => {
      const permission = ports.permission();
      if (permission !== "OK") throw new Stop("NOT_PERMITTED", permission);
      if (options.signal?.aborted) throw new Stop("TIMEOUT", "CANCELLED");
      if (remaining() <= 0) throw new Stop("TIMEOUT");
    };

    try {
      checkpoint();
    } catch (error) {
      const stop = error as Stop;
      return report(action, stop.outcome, { executed, verified: false, state: undefined, reason: stop.reason });
    }
    let channel: PlaybackControlChannel;
    try {
      channel = await ports.openChannel();
    } catch (error) {
      const detail = error instanceof BrowserLifecycleError ? error.detail : undefined;
      if (detail === "no-playback-tab") return report(action, "TAB_NOT_FOUND", { executed, verified: false, state: undefined, reason: "NO_PLAYBACK_TAB" });
      if (detail === "ambiguous-playback-tab") return report(action, "TAB_NOT_FOUND", { executed, verified: false, state: undefined, reason: "AMBIGUOUS_PLAYBACK_TAB" });
      if (detail === "player-control-unconfigured") return report(action, "PLAYER_UNAVAILABLE", { executed, verified: false, state: undefined, reason: "UNCONFIGURED" });
      return report(action, "SESSION_DISCONNECTED", { executed, verified: false, state: undefined });
    }

    const checkContent = async () => {
      if (options.expectContentId !== undefined && (await channel.currentContentId()) !== options.expectContentId) {
        lastState = undefined;
        throw new Stop("PLAYER_LOADING", "NAVIGATION_PENDING");
      }
      checkpoint();
    };

    const command = async (name: PlayerCommand, budgetMs = remaining()): Promise<PlayerCommandResult | undefined> => {
      checkpoint();
      await checkContent();
      const result = await channel.run(name, Math.max(1, Math.min(timing.commandDeadlineMs, remaining(), budgetMs)));
      await checkContent();
      if (result) lastState = result.state;
      return result;
    };

    /** Read-only evidence shared by status and play; never trust paused=false alone. */
    const observeProgress = async (initial: PlayerFrameState, status: boolean) => {
      const verifyUntil = ports.now() + timing.verifyTimeoutMs;
      let observed = initial;
      let previousTime = initial.currentTime;
      for (;;) {
        if (observed.playerError) break;
        if (status && (observed.paused || observed.ended || isLoading(observed))) break;
        if (ports.now() >= verifyUntil) break;
        await ports.sleep(Math.min(timing.pollIntervalMs, verifyUntil - ports.now()));
        const after = await command("probe", verifyUntil - ports.now());
        if (ports.now() > verifyUntil) throw new Stop("TIMEOUT");
        if (!after) throw new Stop("PLAYER_UNAVAILABLE", "CONTEXT_LOST");
        observed = after.state;
        if (!observed.playerError && !isLoading(observed) && observed.readyState >= 3 &&
            !observed.paused && !observed.ended && observed.currentTime > previousTime) {
          return { observed, playingVerified: true };
        }
        previousTime = observed.currentTime;
      }
      return { observed, playingVerified: false };
    };

    try {
      // 1. When the caller just navigated, act only on THAT page — never on the
      //    previous episode's player that is still being torn down.
      if (options.expectContentId !== undefined) {
        const waitUntil = ports.now() + Math.max(0, options.waitForReadyMs ?? 0);
        for (;;) {
          checkpoint();
          if ((await channel.currentContentId()) === options.expectContentId) break;
          if (ports.now() >= waitUntil) throw new Stop("PLAYER_LOADING", "NAVIGATION_PENDING");
          await ports.sleep(timing.pollIntervalMs);
        }
      }

      // 2. Find a player. Status does not wait for readiness (it separately
      //    samples clock progress); an action waits for readiness only when asked.
      const readyUntil = ports.now() + Math.max(0, options.waitForReadyMs ?? 0);
      let probe: PlayerCommandResult | undefined;
      for (;;) {
        probe = await command("probe");
        const controllable = probe !== undefined && (action === "status" || probe.state.playerError !== undefined || !isLoading(probe.state));
        if (controllable || ports.now() >= readyUntil) break;
        await ports.sleep(timing.pollIntervalMs);
      }
      if (!probe) throw new Stop("PLAYER_UNAVAILABLE", "NO_VIDEO");
      if (action === "status") {
        const { observed, playingVerified } = await observeProgress(probe.state, true);
        return report(action, "CONFIRMED", { executed: false, verified: true, state: observed, playingVerified });
      }
      if (action === "play" && probe.state.playerError) throw new Stop("NOT_CONFIRMED", "MEDIA_ERROR");
      if (isLoading(probe.state)) throw new Stop("PLAYER_LOADING", "VIDEO_NOT_READY");

      // 3. Already there: nothing is sent, and the observation is the evidence.
      const reached = REACHED[action];
      const alreadyReached = reached(probe.state);
      if (action !== "play" && alreadyReached) {
        return report(action, "CONFIRMED", { executed: false, verified: true, state: probe.state, reason: "ALREADY_IN_STATE" });
      }

      // 4. The action itself.
      executed = !alreadyReached;
      const result = alreadyReached ? probe : await command(COMMAND_FOR[action]);
      if (!result) throw new Stop("PLAYER_UNAVAILABLE", "CONTEXT_LOST");
      const refusal = refusalReason(action, result);
      if (refusal) throw new Stop("REFUSED_BY_BROWSER", refusal);
      if (result.error === "NO_VIDEO") throw new Stop("PLAYER_UNAVAILABLE", "NO_VIDEO");

      if (action === "play") {
        const { observed, playingVerified } = await observeProgress(result.state, false);
        return report(action, playingVerified ? "CONFIRMED" : "NOT_CONFIRMED", {
          executed, verified: playingVerified, state: observed, playingVerified,
          reason: playingVerified ? (alreadyReached ? "ALREADY_IN_STATE" : undefined)
            : result.error ? `PAGE_${result.error}` : "STATE_NOT_OBSERVED",
        });
      }

      // 5. Verification: only a later observation of the requested state counts.
      const verifyUntil = ports.now() + timing.verifyTimeoutMs;
      let observed = result.state;
      for (;;) {
        if (reached(observed)) {
          return report(action, "CONFIRMED", { executed, verified: true, state: observed });
        }
        if (ports.now() >= verifyUntil) break;
        await ports.sleep(timing.pollIntervalMs);
        const after = await command("probe");
        if (!after) throw new Stop("PLAYER_UNAVAILABLE", "CONTEXT_LOST");
        observed = after.state;
      }
      return report(action, "NOT_CONFIRMED", {
        executed,
        verified: false,
        state: observed,
        reason: result.error ? `PAGE_${result.error}` : "STATE_NOT_OBSERVED",
      });
    } catch (error) {
      if (error instanceof Stop) {
        return report(action, error.outcome, { executed, verified: false, state: lastState, reason: error.reason });
      }
      if (error instanceof BrowserLifecycleError) {
        if (error.detail === "deadline") return report(action, "TIMEOUT", { executed, verified: false, state: lastState });
        if (error.detail === "TAB_CLOSED") return report(action, "TAB_CLOSED", { executed, verified: false, state: lastState });
        if (error.detail === "NAVIGATED_AWAY") return report(action, "PLAYER_UNAVAILABLE", { executed, verified: false, state: lastState, reason: "NAVIGATED_AWAY" });
        if (error.detail === "context-lost") return report(action, "PLAYER_UNAVAILABLE", { executed, verified: false, state: lastState, reason: "CONTEXT_LOST" });
        return report(action, "SESSION_DISCONNECTED", { executed, verified: false, state: lastState });
      }
      return report(action, "SESSION_DISCONNECTED", { executed, verified: false, state: lastState, reason: "UNEXPECTED" });
    } finally {
      await channel.close().catch(() => undefined);
    }
  };

  return {
    perform(action, options = {}) {
      if (!PLAYER_ACTIONS.includes(action)) {
        return Promise.reject(new TypeError("unknown player action"));
      }
      if (queued > timing.maxQueued) {
        return Promise.resolve(report(action, "BUSY", { executed: false, verified: false, state: undefined }));
      }
      queued += 1;
      const next = tail.then(() => run(action, options)).finally(() => { queued -= 1; });
      // The chain must survive a failed action; the caller still sees its own result.
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

/** Which page errors mean the BROWSER said no, and how to name it. */
function refusalReason(action: PlayerAction, result: PlayerCommandResult): string | undefined {
  switch (result.error) {
    case "NOT_ALLOWED":
      return action === "play" ? "AUTOPLAY_BLOCKED_USER_ACTIVATION_REQUIRED" : "USER_ACTIVATION_REQUIRED_OR_DENIED";
    case "FULLSCREEN_DISABLED":
      return "FULLSCREEN_NOT_ALLOWED_IN_FRAME";
    case "NOT_SUPPORTED":
      return action === "play" ? "SOURCE_NOT_SUPPORTED" : "FULLSCREEN_NOT_SUPPORTED";
    default:
      return undefined;
  }
}
