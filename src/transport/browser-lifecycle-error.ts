export type BrowserLifecycleErrorKind =
  | "BROWSER_UNAVAILABLE"
  | "BROWSER_DISCONNECTED"
  | "BROWSER_EXECUTABLE_NOT_FOUND"
  | "PROFILE_INSECURE"
  | "ENDPOINT_UNAVAILABLE"
  | "ENDPOINT_MALFORMED"
  | "OWNERSHIP_INVALID"
  | "LAUNCH_TIMEOUT"
  | "RECOVERY_EXHAUSTED"
  | "BROWSER_STOP_TIMEOUT";

/**
 * Internal evidence about the one browser API request boundary.
 *
 * PRE_DISPATCH is the conservative default for lifecycle failures raised
 * before Runtime.callFunctionOn. POSSIBLY_DISPATCHED is set only by the
 * session manager after that CDP command has been invoked, when a page fetch
 * may already have reached the provider.
 */
export type BrowserRequestDispatchState = "PRE_DISPATCH" | "POSSIBLY_DISPATCHED";

export type BrowserRequestUncertaintyReason =
  | "deadline"
  | "disconnect"
  | "page-exception"
  | "malformed";

const FIXED_MESSAGES: Record<BrowserLifecycleErrorKind, string> = {
  BROWSER_UNAVAILABLE: "Managed browser is not available",
  BROWSER_DISCONNECTED: "Managed browser connection was lost",
  BROWSER_EXECUTABLE_NOT_FOUND: "No supported browser executable was found",
  PROFILE_INSECURE: "Managed browser profile has unsafe permissions",
  ENDPOINT_UNAVAILABLE: "Managed browser did not publish a debugging endpoint",
  ENDPOINT_MALFORMED: "Managed browser published an unusable debugging endpoint",
  OWNERSHIP_INVALID: "Managed browser ownership record could not be validated",
  LAUNCH_TIMEOUT: "Managed browser did not become ready within the deadline",
  RECOVERY_EXHAUSTED: "Managed browser recovery attempts were exhausted",
  BROWSER_STOP_TIMEOUT: "Managed browser did not stop within the deadline",
};

export class BrowserLifecycleError extends Error {
  constructor(
    public readonly kind: BrowserLifecycleErrorKind,
    public readonly detail?: string,
    public readonly dispatchState: BrowserRequestDispatchState = "PRE_DISPATCH",
    public readonly uncertaintyReason?: BrowserRequestUncertaintyReason,
  ) {
    super(FIXED_MESSAGES[kind]);
    this.name = "BrowserLifecycleError";
  }
}
