import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Some MCP clients (Hermes Agent among them) start stdio servers with a
 * filtered environment that keeps HOME, PATH and XDG_* but drops DISPLAY,
 * WAYLAND_DISPLAY and DBUS_SESSION_BUS_ADDRESS. Without them the visible
 * login browser cannot open. When the caller supplied no display at all,
 * recover the user's own desktop session from sockets that belong to the
 * current user. Variables the caller did set are never replaced.
 */
export interface DesktopSessionProbe {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  list(dir: string): readonly string[];
  /** Owner uid of a socket at `path`, or undefined if it is not a socket. */
  socketOwner(path: string): number | undefined;
}

const REAL_PROBE: DesktopSessionProbe = {
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  list(dir) {
    try { return readdirSync(dir); } catch { return []; }
  },
  socketOwner(path) {
    try {
      const stat = statSync(path);
      return stat.isSocket() ? stat.uid : undefined;
    } catch {
      return undefined;
    }
  },
};

const X11_SOCKET_DIR = "/tmp/.X11-unix";

function lowestNumbered(names: readonly string[], pattern: RegExp): string | undefined {
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => Number(a.match![1]) - Number(b.match![1]))[0]?.name;
}

export function desktopSessionEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  probe: DesktopSessionProbe = REAL_PROBE,
): NodeJS.ProcessEnv {
  if (probe.platform !== "linux" || probe.uid === undefined) return environment;
  if (environment.DISPLAY || environment.WAYLAND_DISPLAY) return environment;

  const recovered: NodeJS.ProcessEnv = {};
  const runtimeDir = environment.XDG_RUNTIME_DIR;
  const ownedByUser = (path: string) => probe.socketOwner(path) === probe.uid;

  if (runtimeDir) {
    const wayland = lowestNumbered(
      probe.list(runtimeDir).filter((name) => ownedByUser(join(runtimeDir, name))),
      /^wayland-(\d+)$/,
    );
    if (wayland) recovered.WAYLAND_DISPLAY = wayland;
    const bus = join(runtimeDir, "bus");
    if (!environment.DBUS_SESSION_BUS_ADDRESS && ownedByUser(bus)) {
      recovered.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
    }
  }

  // X sockets are owned by the X server's user; on desktops that is the
  // session user, so the same ownership check applies.
  const x11 = lowestNumbered(
    probe.list(X11_SOCKET_DIR).filter((name) => ownedByUser(join(X11_SOCKET_DIR, name))),
    /^X(\d+)$/,
  );
  if (x11) recovered.DISPLAY = `:${x11.slice(1)}`;

  if (!recovered.WAYLAND_DISPLAY && !recovered.DISPLAY) return environment;
  return { ...environment, ...recovered };
}
