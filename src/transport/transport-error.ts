// BT1 — typed transport failures.
//
// Follows the project's existing convention (StorageError.state,
// RefreshError.kind): a readonly discriminant, a fixed secret-free message,
// and an explicit `name`.

/**
 * BT1 needs four kinds. The union is written so later frozen names
 * (OPERATION_NOT_ALLOWED, AUTH_IDENTITY_UNAVAILABLE, OPERATION_NOT_MIGRATED,
 * TRANSPORT_TIMEOUT, …) can be appended by their owning stage without changing
 * this class or any signature. BT1 adds none of them.
 */
export type TransportErrorKind =
  | "UNKNOWN_OPERATION"
  | "INVALID_ARGUMENTS"
  | "CALLER_SUPPLIED_IDENTITY"
  | "TRANSPORT_FAILURE"
  // ── BT5 (cutover) ─────────────────────────────────────────────────────────
  | "OPERATION_NOT_MIGRATED"
  | "AUTH_NOT_READY"
  | "AUTH_GENERATION_CHANGED"
  | "BROWSER_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "SCHEMA_MISMATCH"
  | "NODE_CRUNCHYROLL_FORBIDDEN"
  | "API_UNAUTHORIZED"
  | "API_FORBIDDEN"
  | "API_NOT_FOUND"
  | "API_RATE_LIMITED"
  | "API_SERVER_ERROR";

/**
 * Fixed, secret-free and deliberately uninformative about the provider: no
 * URL, header, body fragment or identity may ever appear in one of these.
 */
const FIXED_MESSAGES: Record<TransportErrorKind, string> = {
  UNKNOWN_OPERATION: "Unknown transport operation",
  INVALID_ARGUMENTS: "Invalid transport operation arguments",
  CALLER_SUPPLIED_IDENTITY: "Caller may not supply authenticated identity",
  TRANSPORT_FAILURE: "Transport execution failed",
  OPERATION_NOT_MIGRATED:
    "OPERATION_NOT_MIGRATED: this operation is not served by the browser transport yet",
  AUTH_NOT_READY: "Not authenticated: log in before requesting content",
  AUTH_GENERATION_CHANGED: "Authentication changed while the request was in flight",
  BROWSER_UNAVAILABLE: "The managed browser is unavailable",
  INVALID_RESPONSE: "The response could not be validated",
  SCHEMA_MISMATCH: "The response did not match the expected shape",
  NODE_CRUNCHYROLL_FORBIDDEN:
    "Blocked: this build may not reach Crunchyroll outside the browser transport",
  API_UNAUTHORIZED: "Upstream rejected the request as unauthorized",
  API_FORBIDDEN: "Upstream refused the request",
  API_NOT_FOUND: "Upstream has no such resource",
  API_RATE_LIMITED: "Upstream is rate limiting this client",
  API_SERVER_ERROR: "Upstream reported a server error",
};

export class TransportError extends Error {
  constructor(
    public readonly kind: TransportErrorKind,
    /** Structural detail only — a NAME, never a value, secret or raw body. */
    public readonly detail?: string
  ) {
    super(FIXED_MESSAGES[kind]);
    this.name = "TransportError";
  }
}
