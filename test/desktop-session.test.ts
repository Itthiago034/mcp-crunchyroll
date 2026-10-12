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
    const env = desktopSessionEnvironment(given, probe({ "/tmp/.X11-unix/X0": UID }));
    assert.equal(env, given);
    assert.equal(env.DISPLAY, undefined);
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
