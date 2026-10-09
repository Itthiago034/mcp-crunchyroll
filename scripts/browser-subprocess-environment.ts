import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

// The MCP SDK inherits only a small set of shell variables. Chromium also
// needs the desktop session and any explicitly selected browser/sandbox.
// Keep the rest of the caller's environment (including secrets) out of MCP.
const BROWSER_ENVIRONMENT_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  // Desktop identification can select the Linux password/key storage backend.
  // Preserve it across the manual -> MCP restart, along with XDG paths.
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "KDE_SESSION_VERSION",
  "KDE_FULL_SESSION",
  "GNOME_DESKTOP_SESSION_ID",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "CRUNCHYROLL_BROWSER_EXECUTABLE",
  "CHROME_DEVEL_SANDBOX",
] as const;

export function browserSubprocessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of BROWSER_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value && !value.startsWith("()")) selected[key] = value;
  }
  return selected;
}
/** Match the SDK's baseline plus the explicit browser environment. */
export function browserLaunchEnvironment(): Record<string, string> {
  return { ...getDefaultEnvironment(), ...browserSubprocessEnvironment() };
}
