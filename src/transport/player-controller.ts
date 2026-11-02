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
  /** The video element's own media error, or null. */
  readonly player_error: MediaErrorName | null;
}

export type MediaErrorName =
  | "MEDIA_ERR_ABORTED"
  | "MEDIA_ERR_NETWORK"
  | "MEDIA_ERR_DECODE"
  | "MEDIA_ERR_SRC_NOT_SUPPORTED";

const MEDIA_ERRORS: Record<number, MediaErrorName> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/**
 * Whether playback was seen MOVING: `ADVANCING` means current_time grew between
 * two observations, `STALLED` means it did not within the bounded wait, and
 * `NOT_CHECKED` means the caller did not ask for the check.
 */
export type PlaybackProgress = "ADVANCING" | "STALLED" | "NOT_CHECKED";

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
  /** Only on a confirmed play when PerformOptions.confirmProgressMs was given. */
  readonly progress?: PlaybackProgress;
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
  /**
   * For `play`: after the state is reached, watch current_time for up to this
   * long and report whether it advanced. Returns as soon as it does, so a
   * healthy stream costs one or two probes. Default: no check.
   */
  readonly confirmProgressMs?: number;
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

const STALLED_MESSAGE =
  "The player is not paused, but current_time did not advance yet (buffering, an ad, or a stalled stream). Check again with crunchyroll_player_control status.";

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
    player_error: MEDIA_ERRORS[state.mediaError ?? 0] ?? null,
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
    fields: {
      executed: boolean;
      verified: boolean;
      state: PlayerFrameState | undefined;
      reason?: string;
      progress?: PlaybackProgress;
    },
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
      ...(fields.progress ? { progress: fields.progress } : {}),
      message: fields.progress === "STALLED" ? MESSAGES.CONFIRMED + " " + STALLED_MESSAGE : MESSAGES[outcome],
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

    const command = async (name: PlayerCommand): Promise<PlayerCommandResult | undefined> => {
      checkpoint();
      const result = await channel.run(name, Math.max(1, Math.min(timing.commandDeadlineMs, remaining())));
      if (result) lastState = result.state;
      return result;
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

      // 2. Find a player. `status` never waits; an action waits only when asked.
      const readyUntil = ports.now() + Math.max(0, options.waitForReadyMs ?? 0);
      let probe: PlayerCommandResult | undefined;
      for (;;) {
        probe = await command("probe");
        const controllable = probe !== undefined && (action === "status" || !isLoading(probe.state));
        if (controllable || ports.now() >= readyUntil) break;
        await ports.sleep(timing.pollIntervalMs);
      }
      if (!probe) throw new Stop("PLAYER_UNAVAILABLE", "NO_VIDEO");
      if (action === "status") {
        return report(action, "CONFIRMED", { executed: false, verified: true, state: probe.state });
      }
      if (isLoading(probe.state)) throw new Stop("PLAYER_LOADING", "VIDEO_NOT_READY");

      // 3. Already there: nothing is sent, and the observation is the evidence.
      const reached = REACHED[action];

      /** For a confirmed play: did current_time actually move? Bounded, early exit. */
      const progressOf = async (
        from: PlayerFrameState,
      ): Promise<{ progress?: PlaybackProgress; state: PlayerFrameState }> => {
        const budget = action === "play" ? Math.max(0, options.confirmProgressMs ?? 0) : 0;
        if (budget === 0) return { state: from };
        const until = ports.now() + Math.min(budget, Math.max(0, remaining()));
        let state = from;
        for (;;) {
          if (ports.now() >= until) return { progress: "STALLED", state };
          await ports.sleep(timing.pollIntervalMs);
          const next = await command("probe");
          if (!next) throw new Stop("PLAYER_UNAVAILABLE", "CONTEXT_LOST");
          if (next.state.currentTime > from.currentTime) return { progress: "ADVANCING", state: next.state };
          state = next.state;
          if (state.paused || state.ended || (state.mediaError ?? 0) !== 0) return { progress: "STALLED", state };
        }
      };

      if (reached(probe.state)) {
        const checked = await progressOf(probe.state);
        return report(action, "CONFIRMED", {
          executed: false, verified: true, state: checked.state, reason: "ALREADY_IN_STATE", progress: checked.progress,
        });
      }

      // 4. The action itself.
      executed = true;
      const result = await command(COMMAND_FOR[action]);
      if (!result) throw new Stop("PLAYER_UNAVAILABLE", "CONTEXT_LOST");
      const refusal = refusalReason(action, result);
      if (refusal) throw new Stop("REFUSED_BY_BROWSER", refusal);
      if (result.error === "NO_VIDEO") throw new Stop("PLAYER_UNAVAILABLE", "NO_VIDEO");

      // 5. Verification: only a later observation of the requested state counts.
      const verifyUntil = ports.now() + timing.verifyTimeoutMs;
      let observed = result.state;
      for (;;) {
        if (reached(observed)) {
          const checked = await progressOf(observed);
          return report(action, "CONFIRMED", {
            executed, verified: true, state: checked.state, progress: checked.progress,
          });
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
