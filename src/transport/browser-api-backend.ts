// BT5 — the production transport backend.
//
// Turns a validated ResolvedCall into ONE browser-context request and a
// bounded, normalized TransportResult.
//
// The auth lifecycle is NOT reimplemented here. BT3 already owns it: `bind()`
// is the acquisition point, `runCurrent()` snapshots the record, registers the
// bearer as a secret before the first instruction that could render it, and
// performs the final generation commit check AFTER the callback returns. This
// module borrows that guarantee instead of building a second one, so there is
// exactly one place in the system that decides whether a response may be
// released.
//
// It performs no I/O of its own: no fetch, no socket, no CDP. The only way out
// is the closed execution channel it is handed.

import type { AuthContextReader } from "./auth-context.js";
import { MAX_API_RESPONSE_BYTES, type ApiExecutionChannel } from "./browser-lifecycle-types.js";
import { TransportError } from "./transport-error.js";
import type { ResolvedCall, TransportBackend, TransportResult } from "./types.js";

/** Frozen: never caller input, never environment-configurable. */
export const CRUNCHYROLL_API_ORIGIN = "https://www.crunchyroll.com";

export const DEFAULT_REQUEST_DEADLINE_MS = 20_000;

export interface BrowserApiBackendPorts {
  openChannel(): Promise<ApiExecutionChannel>;
  /** BT3's narrow reader port. The authority itself never travels here. */
  readonly reader: AuthContextReader;
  readonly deadlineMs?: number;
}

/** Upstream status → closed error kind. No body ever accompanies these. */
function upstreamError(status: number): TransportError {
  if (status === 401) return new TransportError("API_UNAUTHORIZED");
  if (status === 403) return new TransportError("API_FORBIDDEN");
  if (status === 404) return new TransportError("API_NOT_FOUND");
  if (status === 429) return new TransportError("API_RATE_LIMITED");
  if (status >= 500) return new TransportError("API_SERVER_ERROR");
  return new TransportError("INVALID_RESPONSE", "status");
}

function isJsonContentType(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json" || base.endsWith("+json");
}

/** BT3 speaks its own error vocabulary; translate it, never reinterpret it. */
function asTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (name === "AuthContextError") {
    if (kind === "AUTH_CONTEXT_STALE" || kind === "AUTH_IDENTITY_CHANGED") {
      return new TransportError("AUTH_GENERATION_CHANGED");
    }
    return new TransportError("AUTH_NOT_READY");
  }
  // A browser/lifecycle failure is a transport failure — never a reason to try
  // another route, because there is no other route.
  if (name === "BrowserLifecycleError") return new TransportError("BROWSER_UNAVAILABLE");
  return new TransportError("TRANSPORT_FAILURE");
}

export function createBrowserApiBackend(ports: BrowserApiBackendPorts): TransportBackend {
  const deadlineMs = ports.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;

  return {
    async executeResolved(call: ResolvedCall): Promise<TransportResult> {
      const { descriptor } = call;

      // BT5 migrates one read. A mutation reaching here would be a wiring
      // error, and refusing costs less than trusting the table.
      if (descriptor.method !== "GET" || descriptor.mutation !== false) {
        throw new TransportError("OPERATION_NOT_MIGRATED", "method");
      }

      // The URL is built from the descriptor alone and revalidated. The caller
      // contributes nothing: the registry already refused every key it did not
      // declare, and this operation declares none.
      const url = `${CRUNCHYROLL_API_ORIGIN}${descriptor.pathTemplate}`;
      if (!url.startsWith(`${CRUNCHYROLL_API_ORIGIN}/`)) {
        throw new TransportError("INVALID_ARGUMENTS", "path");
      }

      // ── The auth acquisition point (BT3 §13.4) ───────────────────────────
      let execution;
      try {
        execution = ports.reader.bind(call);
      } catch (error) {
        throw asTransportError(error);
      }
      if (execution.kind !== "AUTHENTICATED") {
        // Every Crunchyroll API call needs a bearer. A descriptor that binds
        // without one cannot be served, and inventing a bearer-less request
        // would just produce a 401 with extra steps.
        throw new TransportError("AUTH_NOT_READY", "no-bearer");
      }

      try {
        // runCurrent snapshots the record ONCE, and re-checks it after the
        // callback: a response obtained under a generation that is no longer
        // current is discarded by BT3 before it can be returned.
        return await ports.reader.runCurrent(execution, async (view) => {
          const channel = await ports.openChannel();
          let response;
          try {
            response = await channel.request({
              url,
              method: "GET",
              authorization: `${view.tokenType} ${view.accessToken}`,
              deadlineMs,
              maxBytes: MAX_API_RESPONSE_BYTES,
            });
          } finally {
            // Teardown must never mask the outcome.
            await channel.close().catch(() => undefined);
          }

          // Bound and normalize BEFORE anything is interpreted.
          if (
            response.truncated ||
            Buffer.byteLength(response.body, "utf-8") > MAX_API_RESPONSE_BYTES
          ) {
            throw new TransportError("INVALID_RESPONSE", "over-cap");
          }
          if (response.status < 200 || response.status > 299) {
            throw upstreamError(response.status);
          }
          if (!isJsonContentType(response.contentType)) {
            // An HTML challenge page is the expected shape of this failure and
            // none of its content may travel: only the fact does.
            throw new TransportError("INVALID_RESPONSE", "content-type");
          }
          let json: unknown;
          try {
            json = JSON.parse(response.body);
          } catch {
            throw new TransportError("INVALID_RESPONSE", "json");
          }

          return Object.freeze({
            status: response.status,
            contentType: response.contentType,
            json,
          });
        });
      } catch (error) {
        throw asTransportError(error);
      }
    },
  };
}
