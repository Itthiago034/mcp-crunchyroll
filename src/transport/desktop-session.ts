import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Some MCP clients (Hermes Agent among them) start stdio servers with a
 * filtered environment that keeps HOME, PATH and XDG_* but drops DISPLAY,
 * WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS and the desktop identity
 * (KDE_SESSION_VERSION, DESKTOP_SESSION, ...). Without the display the
 * visible login browser cannot open; without the desktop identity Chromium
 * picks a different password store (for example `basic` instead of
 * KWallet 6) and cannot decrypt the cookies saved by the manual sign-in in
 * the same profile, so every launch looks signed out and is challenged
 * again. Recover these values from the user's own session: first the
 * systemd user manager environment, then user-owned sockets. Variables the
 * caller did set are never replaced, and nothing outside this list is added.
 */
export const DESKTOP_SESSION_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "DESKTOP_SESSION",
  "KDE_SESSION_VERSION",
  "KDE_FULL_SESSION",
  "GNOME_DESKTOP_SESSION_ID",
] as const;

export interface DesktopSessionProbe {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  /** `systemctl --user show-environment` output, or "" if unavailable. */
  managerEnvironment(): string;
  list(dir: string): readonly string[];
  /** Owner uid of a socket at `path`, or undefined if it is not a socket. */
  socketOwner(path: string): number | undefined;
}

const REAL_PROBE: DesktopSessionProbe = {
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  managerEnvironment() {
    try {
      return execFileSync("systemctl", ["--user", "show-environment"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
    } catch {
      return "";
    }
  },
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

function parseManagerEnvironment(output: string): Record<string, string> {
  const allowed = new Set<string>(DESKTOP_SESSION_KEYS);
  const parsed: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    // systemd quotes values with special characters; desktop values never need them.
    if (allowed.has(key) && value && !/^[$'"]/.test(value)) parsed[key] = value;
  }
  return parsed;
}

export function desktopSessionEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  probe: DesktopSessionProbe = REAL_PROBE,
): NodeJS.ProcessEnv {
  if (probe.platform !== "linux" || probe.uid === undefined) return environment;
  const missing = DESKTOP_SESSION_KEYS.filter((key) => !environment[key]);
  if (missing.length === 0) return environment;
  // A caller that chose a display keeps it; only the identity is filled in.
  const callerHasDisplay = Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);

  const recovered: Record<string, string> = {};
  const manager = parseManagerEnvironment(probe.managerEnvironment());
  for (const key of missing) {
    if (callerHasDisplay && (key === "DISPLAY" || key === "WAYLAND_DISPLAY" || key === "XAUTHORITY")) continue;
    if (manager[key]) recovered[key] = manager[key];
  }

  const runtimeDir = environment.XDG_RUNTIME_DIR;
  const ownedByUser = (path: string) => probe.socketOwner(path) === probe.uid;
  if (!callerHasDisplay && !recovered.WAYLAND_DISPLAY && !recovered.DISPLAY) {
    if (runtimeDir) {
      const wayland = lowestNumbered(
        probe.list(runtimeDir).filter((name) => ownedByUser(join(runtimeDir, name))),
        /^wayland-(\d+)$/,
      );
      if (wayland) recovered.WAYLAND_DISPLAY = wayland;
    }
    // X sockets are owned by the X server's user; on desktops that is the
    // session user, so the same ownership check applies.
    const x11 = lowestNumbered(
      probe.list(X11_SOCKET_DIR).filter((name) => ownedByUser(join(X11_SOCKET_DIR, name))),
      /^X(\d+)$/,
    );
    if (x11) recovered.DISPLAY = `:${x11.slice(1)}`;
  }
  if (!environment.DBUS_SESSION_BUS_ADDRESS && !recovered.DBUS_SESSION_BUS_ADDRESS && runtimeDir) {
    const bus = join(runtimeDir, "bus");
    if (ownedByUser(bus)) recovered.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  }

  if (Object.keys(recovered).length === 0) return environment;
  return { ...environment, ...recovered };
}
