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
  | "TRANSPORT_FAILURE";

const FIXED_MESSAGES: Record<TransportErrorKind, string> = {
  UNKNOWN_OPERATION: "Unknown transport operation",
  INVALID_ARGUMENTS: "Invalid transport operation arguments",
  CALLER_SUPPLIED_IDENTITY: "Caller may not supply authenticated identity",
  TRANSPORT_FAILURE: "Transport execution failed",
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
