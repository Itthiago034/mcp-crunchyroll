import type { PlayerController, PlayerControlReport, PerformOptions } from "./player-controller.js";

/** Internal closed workflow after navigation; never a generic browser surface. */
export async function observeOpenedPlayback(
  controller: PlayerController,
  episodeId: string,
  options: Omit<PerformOptions, "expectContentId"> & { readonly autoplay?: boolean; readonly fullscreen?: boolean },
) {
  const performOptions: PerformOptions = {
    expectContentId: episodeId,
    waitForReadyMs: options.waitForReadyMs,
    signal: options.signal,
  };
  const controls: { autoplay?: PlayerControlReport; fullscreen_control?: PlayerControlReport } = {};
  if (options.autoplay === true) controls.autoplay = await controller.perform("play", performOptions);
  if (options.fullscreen === true) controls.fullscreen_control = await controller.perform("fullscreen", performOptions);
  // Always observe, even with neither option. Fullscreen verification is not
  // playback verification and may not replace the final read-only status.
  const observation = await controller.perform("status", performOptions);
  const success = Object.values(controls).every((report) => report.success) && observation.success;
  return {
    ...observation.playback,
    ...controls,
    ...(Object.keys(controls).length ? { success, partial: !success } : {}),
    observation,
    message: observation.playback.playing_verified
      ? "The watch page opened and playback was verified by an advancing player clock."
      : "The watch page opened, but playback was not verified; opening the page alone does not mean it is playing.",
  };
}
