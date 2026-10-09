// The MCP SDK inherits only a small set of shell variables. Chromium also
// needs the desktop session and any explicitly selected browser/sandbox.
// Keep the rest of the caller's environment (including secrets) out of MCP.
const BROWSER_ENVIRONMENT_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
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
