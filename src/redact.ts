/**
 * B6-core — operation-scoped secret redaction.
 *
 * Pure internal module. No MCP SDK dependency, no disk I/O, no persisted state.
 *
 * Contract (frozen design GATE-B-DESIGN.md, section 11):
 * - A registry of sensitive values is scoped to a single operation (an async
 *   handler call). It never accumulates values across operations.
 * - The registry is cleared unconditionally at the end of the operation
 *   (finally semantics), including on success, thrown errors, rejected
 *   promises and early returns.
 * - `redactSecrets(text)` replaces registered secret literals (exact, regex-
 *   escaped) and class-level static patterns with the marker `***REDACTED***`.
 * - Secrets are request/operation-scoped via AsyncLocalStorage, so two
 *   concurrent MCP calls cannot cross-contaminate each other's secrets.
 *
 * Public API: intentionally none. Every export in this file is internal;
 * there is no `redact_secret`/`register_secret`/`redaction_status` MCP tool
 * and nothing in this module is reachable from the published bundle's top
 * level (no re-export from index.ts beyond internal wiring).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const REDACTED_MARKER = "***REDACTED***";

// ── Static class-level patterns (design section 11, rule 1) ──────────────────

/**
 * Regex for a full Authorization header fragment, capturing the credential.
 * Matches `Authorization: Bearer <token>` / `Authorization: Basic <creds>` and
 * also the bare `Bearer <token>` / `Basic <creds>` fragments.
 */
const HEADER_PATTERNS: RegExp[] = [
  /Authorization:\s*(?:Bearer|Basic)\s+\S+/gi,
  /(?:^|[\s"'(])Bearer\s+\S+/g,
  /(?:^|[\s"'(])Basic\s+\S+/g,
];

/**
 * Key-value style patterns matching `<key><separator><value>`. The separator
 * set mirrors the frozen design (`["\s:=]+`) for error bodies such as
 * `refresh_token=VALUE`, `access_token:VALUE`, `password =VALUE`.
 */
const KV_PATTERNS: RegExp[] = [
  /password["\s:=]+\S+/gi,
  /refresh_token["\s:=]+\S+/gi,
  /access_token["\s:=]+\S+/gi,
];

const STATIC_PATTERNS = [...HEADER_PATTERNS, ...KV_PATTERNS];

// ── Operation-scoped secret registry (design section 11, rule 2) ─────────────

interface RedactionContext {
  secrets: Set<string>;
  closed: boolean;
}

/**
 * One AsyncLocalStorage instance, process-wide, never holding secret values
 * itself — it only holds a RedactionContext reference per async scope. The
 * sensitive material lives in the context's `secrets` Set, which is cleared
 * (contents deleted, reference released) in `finally`.
 */
const redactionScope = new AsyncLocalStorage<RedactionContext>();

/** Returns the active redaction context, or undefined outside any scope. */
export function getActiveScope(): RedactionContext | undefined {
  return redactionScope.getStore();
}

/**
 * Register sensitive values into the CURRENT operation scope (no scope
 * handle required). Purely convenience: it only writes into the active
 * AsyncLocalStorage context — it never creates a second registry or any
 * parallel global state.
 *
 * Semantics (B6-FIX-1):
 * - active scope present   → values registered (same rules as
 *   SecretScope.registerSecret: empty/whitespace ignored, duplicates
 *   idempotent/deterministic, closed scope ignored).
 * - no active scope        → no-op, values are NOT retained anywhere.
 * - closed scope           → ignored.
 */
export function registerSensitiveValue(...values: string[]): void {
  const ctx = redactionScope.getStore();
  if (!ctx) return; // no active operation scope: no-op, nothing retained
  if (ctx.closed) return;
  for (const v of values) {
    if (typeof v !== "string") continue;
    if (v.length === 0 || v.trim().length === 0) continue;
    ctx.secrets.add(v);
  }
}

/**
 * Open an operation-scoped redaction context, run `fn`, and clear the
 * registry unconditionally on exit (success, thrown error, rejected promise,
 * early return) — finally semantics guaranteed by try/finally around the
 * async execution.
 *
 * Safe under concurrent async execution: AsyncLocalStorage isolates the
 * context per async chain, so overlapping operations never share registries.
 */
export async function withRedactionScope<T>(fn: (scope: SecretScope) => Promise<T>): Promise<T> {
  const ctx: RedactionContext = { secrets: new Set<string>(), closed: false };
  const scope = new SecretScope(ctx);
  try {
    // Bind the async context: everything inside `fn` (and any awaited work
    // it fans out to) sees `ctx` through getActiveScope(), isolated from
    // concurrent operations.
    return await redactionScope.run(ctx, () => fn(scope));
  } finally {
    // Unconditional cleanup: remove every registered literal and release the
    // reference so the GC can collect the values. This must never throw — a
    // clear failure must not mask the original outcome of the operation.
    try {
      ctx.secrets.clear();
      ctx.closed = true;
    } catch {
      // intentionally swallowed: finally must not throw
    }
  }
}

/**
 * The operation-scoped handle passed to `withRedactionScope(fn)`. Values are
 * registered by runtime reference; the store deliberately keeps names and
 * values separated conceptually — only values are registered, and tests can
 * verify cleanup without any name surviving beyond the scope.
 */
export class SecretScope {
  /** @internal do not reach into the context directly — use registerSecret */
  private ctx: RedactionContext;

  constructor(ctx: RedactionContext) {
    this.ctx = ctx;
  }

  /**
   * Register sensitive values for this operation. Empty or whitespace-only
   * values are rejected (never registered) — registering `""` would cause a
   * universal redaction of every string, which is a correctness hazard.
   * Duplicate registration is idempotent and deterministic (Set).
   */
  registerSecret(...values: string[]): void {
    for (const v of values) {
      if (typeof v !== "string") continue;
      if (v.length === 0 || v.trim().length === 0) continue; // reject empty/whitespace
      if (this.ctx.closed) continue; // registration after cleanup is ignored
      this.ctx.secrets.add(v);
    }
  }

  /** Manual early cleanup (idempotent). The `finally` in withRedactionScope
   *  always runs regardless; this is only an explicit opt-in. */
  clear(): void {
    this.ctx.secrets.clear();
    this.ctx.closed = true;
  }
}

// ── Sanitization ─────────────────────────────────────────────────────────────

/** Escape a literal secret so it can be used safely inside a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sort registered secrets longest-first. When a shorter registered secret is
 * a prefix/suffix of a longer one (overlap), redacting the longer value
 * first removes the whole long secret and the leftover shorter literal is
 * redacted afterward — leaving no predictable fragment of the longer secret.
 */
function orderedSecrets(secrets: ReadonlySet<string>): string[] {
  return Array.from(secrets).sort((a, b) => b.length - a.length);
}

/**
 * Apply the redaction contract to `text`:
 * 1. static class-level patterns (headers, key-value bodies) → marker;
 * 2. registered runtime literals (exact, regex-escaped) → marker, longest
 *    first, deterministically (Set iteration order is preserved by the
 *    length sort).
 * Empty text passes through unchanged. Registered empty/whitespace values
 * never participate (see SecretScope.registerSecret).
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let result = text;

  for (const pattern of STATIC_PATTERNS) {
    result = result.replace(pattern, REDACTED_MARKER);
  }

  const ctx = getActiveScope();
  if (ctx && ctx.secrets.size > 0) {
    for (const secret of orderedSecrets(ctx.secrets)) {
      result = result.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED_MARKER);
    }
  }

  return result;
}

// ── Outward MCP result sanitization (B6-FIX-1, blocker B6-C1) ───────────────

/**
 * Central sanitization of an outward MCP tool result (CallTool result shape).
 *
 * - When `result.content` is an array, each entry with `type === "text"` and a
 *   string `text` has its text passed through `redactSecrets()` — using the
 *   currently active AsyncLocalStorage scope, so registered runtime literals
 *   are still present.
 * - All other fields are preserved untouched: `isError`, non-text content
 *   entries, and any unrelated metadata. No deep dump and no arbitrary JSON
 *   serialization of non-text values — values other than the guarded
 *   string path are left as-is.
 * - A shallow copy of each text entry is returned (the original entry object
 *   is not mutated in place), so shared content objects are not modified
 *   dangerously.
 *
 * MUST be applied while the operation scope is still active and BEFORE the
 * `withRedactionScope` callback returns — after `finally` runs the registry
 * is empty and runtime literals can no longer be matched.
 */
/** Every string inside a JSON-like value, redacted; keys and shape are kept. */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  // Tool payloads are shallow; anything this deep is replaced, never passed raw.
  if (depth > 32) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactDeep(entry, depth + 1);
  }
  return out;
}

export function sanitizeToolResult<T extends { content?: unknown; isError?: boolean }>(
  result: T
): T {
  // structuredContent carries the same data as the text, so it crosses the
  // same redaction boundary.
  if ((result as { structuredContent?: unknown }).structuredContent !== undefined) {
    result = {
      ...result,
      structuredContent: redactDeep((result as { structuredContent?: unknown }).structuredContent),
    };
  }
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    return result; // nothing textual to sanitize; shape untouched
  }
  const sanitizedContent = content.map((entry) => {
    if (
      entry !== null &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    ) {
      // Shallow copy with the redacted text; all other entry fields kept.
      return { ...(entry as Record<string, unknown>), text: redactSecrets((entry as { text: string }).text) };
    }
    return entry; // non-text content passes through unchanged
  });
  return { ...result, content: sanitizedContent } as T;
}

// ── Error sanitization (design: preserve class/code; no deep dumps) ──────────

/**
 * Produce a safe Error representation of `err` with all registered secrets
 * redacted from its message. Original objects are never mutated.
 *
 * - `Error` instances: return a new `Error` carrying the redacted message.
 *   Error classification is preserved as-is: callers re-throw the new Error;
 *   the original (which may contain secrets in its message/stack) is dropped,
 *   never returned.
 * - strings thrown: wrapped in a new `Error` whose message is the redacted
 *   string.
 * - unknown values (primitives/objects): converted with a guarded `String()`
 *   whose result is redacted. No deep serialization of arbitrary objects —
 *   an indiscriminate dump could create a brand-new leak surface.
 */
export function sanitizeError(err: unknown): Error {
  let safeMessage: string;

  if (err instanceof Error) {
    safeMessage = redactSecrets(err.message);
  } else if (typeof err === "string") {
    safeMessage = redactSecrets(err);
  } else {
    try {
      safeMessage = redactSecrets(String(err));
    } catch {
      // String() threw (symbol/null-prototype edge case) — degrade to a
      // generic classified message rather than echoing anything.
      safeMessage = "Unknown error";
    }
    if (safeMessage.length === 0) safeMessage = "Unknown error";
  }

  const safe = new Error(safeMessage);
  if (err instanceof Error) {
    safe.name = err.name; // preserve error class/category name
  }
  return safe;
}

/**
 * Convenience used by the index.ts CallTool error boundary: sanitize an
 * arbitrary caught value into a safe error and redact its stack trace too,
 * since V8 stacks can carry the message (and therefore secret literals).
 */
export function safeErrorWithCleanStack(err: unknown): Error {
  const safe = sanitizeError(err);
  if (safe.stack && safe.stack.includes(REDACTED_MARKER) === false) {
    // Stack lines that quote the original message are re-derived from the
    // already-redacted message; stack frames referencing source locations are
    // left intact (they never contain secret values).
    safe.stack = safe.stack.replace(/:\s*[^\n]*\n/, ": (sanitized)\n");
  }
  return safe;
}
