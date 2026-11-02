import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  desktopSessionEnvironment,
  type DesktopSessionProbe,
} from "../src/transport/desktop-session.js";

const UID = 1000;

function probe(
  sockets: Record<string, number>,
  overrides: Partial<DesktopSessionProbe> = {},
): DesktopSessionProbe {
  return {
    platform: "linux",
    uid: UID,
    managerEnvironment: () => "",
    list(dir) {
      const prefix = `${dir}/`;
      return Object.keys(sockets)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
    },
    socketOwner: (path) => sockets[path],
    ...overrides,
  };
}

const FILTERED = { HOME: "/home/u", PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" };

describe("desktop session recovery for filtered MCP environments", () => {
  test("recovers Wayland, X11 and the session bus from user-owned sockets", () => {
    const env = desktopSessionEnvironment(FILTERED, probe({
      "/run/user/1000/wayland-1": UID,
      "/run/user/1000/wayland-0": UID,
      "/run/user/1000/bus": UID,
      "/tmp/.X11-unix/X0": UID,
    }));
    assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
    assert.equal(env.DISPLAY, ":0");
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
    assert.equal(env.HOME, "/home/u");
  });

  test("never replaces a display the caller supplied", () => {
    const given = { ...FILTERED, WAYLAND_DISPLAY: "wayland-9" };
    const env = desktopSessionEnvironment(given, probe({ "/tmp/.X11-unix/X0": UID }, {
      managerEnvironment: () => "DISPLAY=:0\nXAUTHORITY=/run/user/1000/xauth_x\nKDE_SESSION_VERSION=6\n",
    }));
    assert.equal(env.WAYLAND_DISPLAY, "wayland-9");
    assert.equal(env.DISPLAY, undefined);
    assert.equal(env.XAUTHORITY, undefined);
    assert.equal(env.KDE_SESSION_VERSION, "6");
  });

  test("recovers the desktop identity so Chromium keeps the same password store", () => {
    const env = desktopSessionEnvironment(FILTERED, probe({}, {
      managerEnvironment: () => [
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
        "DESKTOP_SESSION=/usr/share/wayland-sessions/plasma.desktop",
        "DISPLAY=:0",
        "KDE_FULL_SESSION=true",
        "KDE_SESSION_VERSION=6",
        "WAYLAND_DISPLAY=wayland-0",
        "XDG_CURRENT_DESKTOP=KDE",
        "SSH_AUTH_SOCK=/run/user/1000/ssh-agent",
        "GITHUB_TOKEN=secret",
        "",
      ].join("\n"),
    }));
    assert.equal(env.KDE_SESSION_VERSION, "6");
    assert.equal(env.KDE_FULL_SESSION, "true");
    assert.equal(env.DESKTOP_SESSION, "/usr/share/wayland-sessions/plasma.desktop");
    assert.equal(env.XDG_CURRENT_DESKTOP, "KDE");
    assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
    assert.equal(env.DISPLAY, ":0");
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
  });

  test("keeps a desktop identity the caller supplied", () => {
    const env = desktopSessionEnvironment(
      { ...FILTERED, XDG_CURRENT_DESKTOP: "GNOME" },
      probe({}, { managerEnvironment: () => "XDG_CURRENT_DESKTOP=KDE\nKDE_SESSION_VERSION=6\n" }),
    );
    assert.equal(env.XDG_CURRENT_DESKTOP, "GNOME");
  });

  test("ignores sockets owned by other users and lock files", () => {
    const env = desktopSessionEnvironment(FILTERED, probe({
      "/run/user/1000/wayland-0": 0,
      "/run/user/1000/wayland-0.lock": UID,
      "/tmp/.X11-unix/X1": 1001,
    }));
    assert.equal(env, FILTERED);
  });

  test("keeps an existing session bus address", () => {
    const env = desktopSessionEnvironment(
      { ...FILTERED, DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom" },
      probe({ "/run/user/1000/wayland-0": UID, "/run/user/1000/bus": UID }),
    );
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/custom");
  });

  test("does nothing outside Linux", () => {
    const env = desktopSessionEnvironment(
      FILTERED,
      probe({ "/run/user/1000/wayland-0": UID }, { platform: "darwin" }),
    );
    assert.equal(env, FILTERED);
  });
});
