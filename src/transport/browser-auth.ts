// BT4 — bounded browser authentication observation.
//
// The human logs in to Crunchyroll in the managed browser. This module watches
// ONE endpoint, at response stage, reads a bounded body, validates it into the
// closed BT3 candidate shape, and always lets the browser's own response
// proceed untouched.
//
// It performs no navigation, no request modification, no arbitrary
// interception, no script evaluation and no cookie access. It never reads a
// form field, never types a credential and never automates a challenge — a
// CAPTCHA or device verification is the human's own browser activity.
//
// Frozen design: CRUNCHYROLL-BT4-COMPLETION-ERRATA.md §7, §9.

import type { PausedResponse, ResponseInterception } from "./browser-lifecycle-types.js";

// ── Fixed, closed origins (errata §7) ───────────────────────────────────────
//
// Hard-coded by the implementation. Never caller input, never environment
// configurable, never assembled from a caller-supplied fragment.

export const CRUNCHYROLL_LOGIN_URL = "https://www.crunchyroll.com/login";

/** Origins the human's login may legitimately traverse. */
export const CRUNCHYROLL_AUTH_ORIGINS: readonly string[] = Object.freeze([
  "https://www.crunchyroll.com",
  "https://sso.crunchyroll.com",
]);

export const CRUNCHYROLL_TOKEN_ENDPOINT = "https://www.crunchyroll.com/auth/v1/token";

const TOKEN_ENDPOINT_HOST = "www.crunchyroll.com";
const TOKEN_ENDPOINT_PATH = "/auth/v1/token";

/** An HTML challenge page must never become a multi-megabyte anything. */
export const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

/** How long one interactive login waits for a mint before giving up. */
export const DEFAULT_OBSERVATION_DEADLINE_MS = 300_000;

// ── Outcomes ────────────────────────────────────────────────────────────────

/** Exactly the closed BT3 candidate. Nothing else is ever carried out. */
export interface ObservedAuthMaterial {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresAt: number;
  readonly accountId: string;
  readonly profileId?: string;
}

export type AuthObservationOutcome =
  | {
      readonly kind: "OBSERVED";
      readonly material: ObservedAuthMaterial;
      readonly connectionGeneration: number;
    }
  | { readonly kind: "TIMED_OUT" }
  | { readonly kind: "CANCELLED" }
  | { readonly kind: "UNAVAILABLE" };

export interface BrowserAuthPorts {
  /** Opens the closed response-stage channel; the pattern is fixed by us. */
  openInterception(urlPattern: string): Promise<ResponseInterception>;
  now(): number;
  schedule(callback: () => void, ms: number): { cancel(): void };
}

export interface BrowserAuthObserver {
  observeNextAuthMaterial(options?: {
    readonly deadlineMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<AuthObservationOutcome>;
}

// ── Validation ──────────────────────────────────────────────────────────────

function isUsableString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The observed URL must be the token endpoint itself — parsed and compared
 * field by field, never by prefix. A lookalike host, a userinfo prefix, plain
 * http or any other path is refused here.
 */
function isTokenEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === TOKEN_ENDPOINT_HOST &&
    parsed.pathname === TOKEN_ENDPOINT_PATH &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * Reduce a provider payload to validated local primitives.
 *
 * Each authorized field is read exactly once (the BT3-R1 lesson: a provider
 * object may be a getter or a Proxy, so validating one read and using another
 * would be the same hazard one layer out). Everything not named here —
 * refresh_token, cookies, id tokens, the raw payload itself — is never read
 * and never carried out.
 */
function validateTokenPayload(payload: unknown, now: number): ObservedAuthMaterial | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;

  const source = payload as Record<string, unknown>;
  const accessToken: unknown = source["access_token"];
  const tokenType: unknown = source["token_type"];
  const expiresIn: unknown = source["expires_in"];
  const accountId: unknown = source["account_id"];
  const profileId: unknown = source["profile_id"];

  if (!isUsableString(accessToken)) return undefined;
  if (!isUsableString(tokenType)) return undefined;
  if (!isUsableString(accountId)) return undefined;

  let profile: string | undefined;
  if (profileId !== undefined) {
    if (!isUsableString(profileId)) return undefined;
    profile = profileId;
  }

  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }

  return Object.freeze(
    profile === undefined
      ? { accessToken, tokenType, expiresAt: now + expiresIn * 1000, accountId }
      : { accessToken, tokenType, expiresAt: now + expiresIn * 1000, accountId, profileId: profile }
  );
}

// ── Observer ────────────────────────────────────────────────────────────────

export function createBrowserAuthObserver(ports: BrowserAuthPorts): BrowserAuthObserver {
  return {
    async observeNextAuthMaterial(options = {}): Promise<AuthObservationOutcome> {
      const signal = options.signal;
      if (signal?.aborted) return Object.freeze({ kind: "CANCELLED" as const });

      let interception: ResponseInterception;
      try {
        interception = await ports.openInterception(CRUNCHYROLL_TOKEN_ENDPOINT);
      } catch {
        // A browser that cannot arm the channel is honestly unavailable. No
        // provider detail, no cause and no path is carried out of here.
        return Object.freeze({ kind: "UNAVAILABLE" as const });
      }

      if (signal?.aborted) {
        await interception.close();
        return Object.freeze({ kind: "CANCELLED" as const });
      }

      return new Promise<AuthObservationOutcome>((resolve) => {
        let settled = false;

        const finish = (outcome: AuthObservationOutcome): void => {
          if (settled) return;
          settled = true;
          deadline.cancel();
          signal?.removeEventListener("abort", onAbort);
          void interception.close().then(
            () => resolve(outcome),
            () => resolve(outcome)
          );
        };

        const onAbort = (): void => finish(Object.freeze({ kind: "CANCELLED" as const }));

        const deadline = ports.schedule(
          () => finish(Object.freeze({ kind: "TIMED_OUT" as const })),
          options.deadlineMs ?? DEFAULT_OBSERVATION_DEADLINE_MS
        );

        signal?.addEventListener("abort", onAbort, { once: true });

        interception.onPaused((event: PausedResponse) => {
          void handlePaused(event);
        });

        const handlePaused = async (event: PausedResponse): Promise<void> => {
          // The browser's own response ALWAYS proceeds, whatever we decide
          // about it — observation must never break the user's login.
          let material: ObservedAuthMaterial | undefined;
          try {
            material = await inspect(event);
          } catch {
            material = undefined;
          } finally {
            try {
              await interception.continueResponse(event.requestId);
            } catch {
              // the channel is gone; the deadline or abort will settle this
            }
          }
          if (material && !settled) {
            finish(
              Object.freeze({
                kind: "OBSERVED" as const,
                material,
                connectionGeneration: interception.connectionGeneration,
              })
            );
          }
        };

        const inspect = async (event: PausedResponse): Promise<ObservedAuthMaterial | undefined> => {
          if (settled) return undefined;
          if (!isTokenEndpoint(event.url)) return undefined;
          const status = event.responseStatusCode;
          if (typeof status !== "number" || status < 200 || status > 299) return undefined;

          const raw = await interception.getResponseBody(event.requestId);
          const decoded = raw.base64Encoded
            ? Buffer.from(raw.body, "base64").toString("utf-8")
            : raw.body;
          if (Buffer.byteLength(decoded, "utf-8") > MAX_AUTH_RESPONSE_BYTES) return undefined;

          let parsed: unknown;
          try {
            parsed = JSON.parse(decoded);
          } catch {
            // A challenge page is not a mint. Nothing about the body is kept.
            return undefined;
          }
          return validateTokenPayload(parsed, ports.now());
        };
      });
    },
  };
}
