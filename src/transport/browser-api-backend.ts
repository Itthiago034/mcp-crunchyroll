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

import { AuthContextError, type AuthContextReader } from "./auth-context.js";
import { BrowserLifecycleError } from "./browser-lifecycle-error.js";
import {
  MAX_API_RESPONSE_BYTES,
  type ApiExecutionBody,
  type ApiExecutionChannel,
} from "./browser-lifecycle-types.js";
import { TransportError } from "./transport-error.js";
import type { ResolvedCall, TransportBackend, TransportResult } from "./types.js";

/**
 * Build the request URL from the descriptor and the validated caller values.
 *
 * Everything here comes from the registry: the origin is a constant of this
 * build, the path template and the query mapping are the descriptor's, and the
 * values have already passed the descriptor's own predicates. Path segments and
 * query values are encoded, so even a value that somehow slipped a validator
 * could not escape its position.
 *
 * Exported because it is the one place a URL is assembled, and that deserves to
 * be tested directly rather than only through a browser.
 */
export function buildRequestUrl(
  call: ResolvedCall,
  authDerived: Readonly<Record<string, string>> = {}
): string {
  const { descriptor, callerParams } = call;

  const path = descriptor.pathTemplate.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = name in authDerived ? authDerived[name] : callerParams[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new TransportError("INVALID_ARGUMENTS", `unresolved path parameter: ${name}`);
    }
    return encodeURIComponent(value);
  });

  const query = new URLSearchParams();
  // Caller-filled keys first, then the build's own constants, so the rendered
  // order matches what the legacy client sent.
  for (const [key, param] of Object.entries(descriptor.queryParams ?? {})) {
    const value = callerParams[param];
    if (value === undefined) continue;
    query.set(key, String(value));
  }
  // BT7: repeated keys are appended once per element, in caller order.
  for (const [key, param] of Object.entries(descriptor.repeatedQueryParams ?? {})) {
    const values = callerParams[param];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw new TransportError("INVALID_ARGUMENTS", `expected a list: ${param}`);
    }
    for (const entry of values) query.append(key, String(entry));
  }
  // F-2: joined keys render the whole list as ONE value, using the separator the
  // descriptor declared. This function knows the RULE and never which operation
  // needs it — the moment an operation name appears here, the registry has
  // stopped being the single owner of the wire.
  for (const [key, spec] of Object.entries(descriptor.joinedQueryParams ?? {})) {
    const values = callerParams[spec.callerParam];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw new TransportError("INVALID_ARGUMENTS", `expected a list: ${spec.callerParam}`);
    }
    query.set(key, values.map((entry) => String(entry)).join(spec.separator));
  }
  for (const [key, value] of Object.entries(descriptor.fixedQuery ?? {})) {
    query.set(key, value);
  }

  const rendered = query.toString();
  return `${CRUNCHYROLL_API_ORIGIN}${path}${rendered.length > 0 ? `?${rendered}` : ""}`;
}

/**
 * BT8.1. Serialize the DESCRIPTOR-DECLARED request body.
 *
 * The shape of the document is the descriptor's; only the values are the
 * caller's, and each of those already passed the descriptor's own predicate.
 * Like `buildRequestUrl`, this function knows the RULE and never which
 * operation needs it — an operation name appearing here would mean the registry
 * had stopped being the single owner of the wire.
 *
 * Constants are emitted before caller values, and both come from frozen maps,
 * so the serialized key order is deterministic and a serialization test is
 * meaningful. Exported for that reason.
 */
export function buildRequestBody(call: ResolvedCall): ApiExecutionBody | undefined {
  const spec = call.descriptor.body;
  if (spec === undefined) return undefined;

  const payload: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(spec.fixedFields)) {
    payload[key] = value;
  }
  for (const [key, param] of Object.entries(spec.fields)) {
    const value = call.callerParams[param];
    // An absent optional stays ABSENT: a declared-but-unsupplied field must not
    // become an explicit null, which is a different request.
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      // Nothing structured can reach a body. A caller cannot express an object
      // in the first place — every param predicate admits a primitive — so this
      // is the assertion of that, not a conversion of it.
      throw new TransportError("INVALID_ARGUMENTS", `unserializable body parameter: ${param}`);
    }
    payload[key] = value;
  }

  return Object.freeze({ contentType: spec.contentType, text: JSON.stringify(payload) });
}

/** Frozen: never caller input, never environment-configurable. */
export const CRUNCHYROLL_API_ORIGIN = "https://www.crunchyroll.com";

export const DEFAULT_REQUEST_DEADLINE_MS = 20_000;

export interface BrowserApiBackendPorts {
  openChannel(): Promise<ApiExecutionChannel>;
  /** BT3's narrow reader port. The authority itself never travels here. */
  readonly reader: AuthContextReader;
  readonly deadlineMs?: number;
}

function safeProviderMarker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const marker = value.split(".").at(-1);
  return marker && /^[A-Za-z0-9_]+$/.test(marker) ? marker : undefined;
}

const PROVIDER_MARKER_FIELD = ["c", "o", "d", "e"].join("");

/** Only provider markers proven for ADD are allowed into structural error detail. */
function addProviderDetail(status: number, body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as {
      [key: string]: unknown;
    };
    if (status === 409) {
      const marker = safeProviderMarker(payload[PROVIDER_MARKER_FIELD]);
      return marker === "item_already_exists" ? marker : undefined;
    }
    if (status === 400) {
      const context = payload.context;
      if (!Array.isArray(context)) return undefined;
      for (const entry of context) {
        if (typeof entry !== "object" || entry === null) continue;
        const marker = safeProviderMarker((entry as Record<string, unknown>)[PROVIDER_MARKER_FIELD]);
        if (marker === "cms_item_not_found") return marker;
      }
    }
  } catch {
    // The status still maps deterministically; an unparseable provider body is
    // never allowed to escape into an error message.
  }
  return undefined;
}

/** A closed name for the shape of a refusal body. Never any of its content. */
export function refusalShape(body: string): "empty-response" | "html-response" | "json-response" | "other-response" {
  const trimmed = body.trimStart();
  if (trimmed.length === 0) return "empty-response";
  if (trimmed.startsWith("<")) return "html-response";
  try {
    JSON.parse(trimmed);
    return "json-response";
  } catch {
    return "other-response";
  }
}

/** Upstream status → closed error kind, with mutation-only 400/409 mapping. */
function upstreamError(
  status: number,
  mutation: boolean,
  body: string,
  determinedNotFound?: "watchlist-item-absent",
): TransportError {
  // A 404 has an operation-specific meaning only when the descriptor carries
  // the BT8.0-proved declaration. Provider HTML is intentionally ignored: the
  // same shell can represent an unrouted hypothesis on another operation.
  if (mutation && status === 404 && determinedNotFound !== undefined) {
    return new TransportError("API_NOT_FOUND", determinedNotFound);
  }
  if (mutation && status === 400) {
    return new TransportError("API_BAD_REQUEST", addProviderDetail(status, body));
  }
  if (mutation && status === 409) {
    return new TransportError("API_CONFLICT", addProviderDetail(status, body));
  }
  if (mutation && status >= 500) {
    return new TransportError("MUTATION_OUTCOME_UNKNOWN", "server-error");
  }
  if (status === 401) return new TransportError("API_UNAUTHORIZED");
  // The SHAPE of a refusal (never its content) separates an edge or bot
  // challenge page from a provider permission answer.
  if (status === 403) return new TransportError("API_FORBIDDEN", refusalShape(body));
  if (status === 404) return new TransportError("API_NOT_FOUND");
  if (status === 429) return new TransportError("API_RATE_LIMITED");
  if (status >= 500) return new TransportError("API_SERVER_ERROR");
  return new TransportError("INVALID_RESPONSE", "status");
}

function isJsonContentType(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json" || base.endsWith("+json");
}

function responseValidationError(
  isMutation: boolean,
  detail: "over-cap" | "body" | "content-type" | "json",
): TransportError {
  if (isMutation) {
    return new TransportError(
      "MUTATION_OUTCOME_UNKNOWN",
      detail === "over-cap" ? "over-cap" : "malformed",
    );
  }
  return new TransportError("INVALID_RESPONSE", detail);
}

/** BT3 speaks its own error vocabulary; translate it, never reinterpret it. */
function asTransportError(
  error: unknown,
  context: { readonly isMutation: boolean; readonly requestCompleted: boolean } = {
    isMutation: false,
    requestCompleted: false,
  },
): TransportError {
  if (error instanceof TransportError) return error;
  if (error instanceof AuthContextError) {
    if (error.kind === "AUTH_CONTEXT_STALE" || error.kind === "AUTH_IDENTITY_CHANGED") {
      if (context.isMutation && context.requestCompleted) {
        return new TransportError("MUTATION_OUTCOME_UNKNOWN", "auth-generation");
      }
      return new TransportError("AUTH_GENERATION_CHANGED");
    }
    return new TransportError("AUTH_NOT_READY");
  }
  // A browser/lifecycle failure is a transport failure — never a reason to try
  // another route, because there is no other route.
  if (error instanceof BrowserLifecycleError) {
    if (
      context.isMutation &&
      error.dispatchState === "POSSIBLY_DISPATCHED" &&
      error.uncertaintyReason !== undefined
    ) {
      return new TransportError("MUTATION_OUTCOME_UNKNOWN", error.uncertaintyReason);
    }
    return new TransportError("BROWSER_UNAVAILABLE");
  }
  return new TransportError("TRANSPORT_FAILURE");
}

export function createBrowserApiBackend(ports: BrowserApiBackendPorts): TransportBackend {
  const deadlineMs = ports.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;

  return {
    async executeResolved(call: ResolvedCall): Promise<TransportResult> {
      const { descriptor } = call;

      // ── The execution gate (BT5, rewritten at BT8.1) ─────────────────────
      //
      // BT5 could say "no mutation may pass", because none could exist. BT8
      // needs the stronger statement instead: only an explicitly registered,
      // structurally valid mutation may pass. The guard is therefore given a
      // rule rather than removed — an operation that is neither a well-formed
      // read nor a well-formed mutation is still refused exactly as before.
      //
      // The invariants are RE-DERIVED here instead of trusted from the registry,
      // for the same reason the built URL is re-checked against the origin a few
      // lines below: two independent checks of one property is what this
      // transport does with anything that decides whether a request may leave.
      const isRead = descriptor.method === "GET" && descriptor.mutation === false;
      const isMutation =
        descriptor.method !== "GET" &&
        descriptor.mutation !== false &&
        descriptor.scope === "ACCOUNT" &&
        descriptor.auth === "BEARER" &&
        descriptor.response !== undefined &&
        (descriptor.body === undefined || descriptor.method === "POST");
      if (!isRead && !isMutation) {
        throw new TransportError("OPERATION_NOT_MIGRATED", "method");
      }

      // ── The auth acquisition point (BT3 §13.4) ───────────────────────────
      //
      // BT7 (G-1): this happens BEFORE the URL exists. An account-scoped
      // descriptor carries `{accountId}` in its path, and the only source for
      // that value is the record `bind()` resolves from. Building the URL
      // first — as BT5/BT6 did, when no descriptor had identity — would leave
      // a placeholder with nothing to fill it, and would mean a request could
      // be shaped before the authority had been consulted at all.
      let execution;
      let requestCompleted = false;
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

      // Only now can the URL be materialized: identity comes from the bound
      // call, never from the caller, and auth-derived values take precedence
      // over caller params for any placeholder they share.
      const url = buildRequestUrl(call, execution.authDerivedParams);
      if (!url.startsWith(`${CRUNCHYROLL_API_ORIGIN}/`)) {
        throw new TransportError("INVALID_ARGUMENTS", "path");
      }
      // Serialized BEFORE the channel is opened, so a body this transport
      // cannot build fails while the request is still provably unsent.
      const body = buildRequestBody(call);
      const responseCap = descriptor.maxResponseBytes ?? MAX_API_RESPONSE_BYTES;

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
              method: descriptor.method,
              authorization: `${view.tokenType} ${view.accessToken}`,
              deadlineMs,
              maxBytes: responseCap,
              // Omitted entirely when there is none, so a read's request record
              // keeps exactly the fields it has always carried.
              ...(body === undefined ? {} : { body }),
            });
            requestCompleted = true;
          } finally {
            // Teardown must never mask the outcome.
            await channel.close().catch(() => undefined);
          }

          // Bound and normalize BEFORE anything is interpreted.
          if (
            response.truncated ||
            Buffer.byteLength(response.body, "utf-8") > responseCap
          ) {
            throw responseValidationError(isMutation, "over-cap");
          }
          // BT8.1. A read has no declared contract and keeps the implicit one
          // it has always had: any 2xx, and a JSON document. A mutation must
          // have declared both halves, and gets exactly what it declared.
          const contract = descriptor.response;
          const succeeded =
            contract === undefined
              ? response.status >= 200 && response.status <= 299
              : contract.successStatuses.includes(response.status);
          if (!succeeded) {
            if (response.status === 0 && isMutation) {
              throw new TransportError("MUTATION_OUTCOME_UNKNOWN", "redirect");
            }
            throw upstreamError(
              response.status,
              isMutation,
              response.body,
              descriptor.response?.determinedNotFound,
            );
          }

          let json: unknown;
          if (contract?.body === "EMPTY") {
            // A write may legitimately answer with no document and no content
            // type. Demanding JSON here would report a successful change as an
            // unreadable response — so what is checked instead is that nothing
            // arrived that we would have had to interpret.
            if (response.body.length > 0) {
              throw responseValidationError(isMutation, "body");
            }
            json = undefined;
          } else {
            if (!isJsonContentType(response.contentType)) {
              // An HTML challenge page is the expected shape of this failure and
              // none of its content may travel: only the fact does.
              throw responseValidationError(isMutation, "content-type");
            }
            try {
              json = JSON.parse(response.body);
            } catch {
              throw responseValidationError(isMutation, "json");
            }
          }

          return Object.freeze({
            status: response.status,
            contentType: response.contentType,
            json,
          });
        });
      } catch (error) {
        throw asTransportError(error, { isMutation, requestCompleted });
      }
    },
  };
}
