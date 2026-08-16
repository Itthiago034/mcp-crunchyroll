// BT5 — the permanent Node egress assertion.
//
// After the cutover, Crunchyroll is reachable ONLY from the managed browser.
// This guard makes that a property of the runtime rather than of release
// discipline: a Node-originated request to Crunchyroll fails closed, before a
// socket is opened, whatever code path attempted it.
//
// It is scoped by DESTINATION HOST, not by environment, not by stack shape and
// not by build flag. Every other destination — a loopback fixture server, a
// local test double, anything unrelated — passes through untouched.

import { TransportError } from "./transport-error.js";

/** The registrable domain this build may not contact from Node. */
const GUARDED_DOMAIN = "crunchyroll.com";

/**
 * Host match is exact or a true subdomain — never a substring.
 *
 * `crunchyroll.com.evil.invalid` and `notcrunchyroll.com` are different hosts
 * and are none of this guard's business; treating them as matches would be a
 * bug in the other direction.
 */
export function isGuardedCrunchyrollUrl(candidate: unknown): boolean {
  let host: string;
  try {
    if (typeof candidate === "string") host = new URL(candidate).hostname;
    else if (candidate instanceof URL) host = candidate.hostname;
    else if (typeof candidate === "object" && candidate !== null && "url" in candidate) {
      host = new URL(String((candidate as { url: unknown }).url)).hostname;
    } else return false;
  } catch {
    return false;
  }
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return normalized === GUARDED_DOMAIN || normalized.endsWith(`.${GUARDED_DOMAIN}`);
}

export interface NodeCrunchyrollGuard {
  /** How many blocked attempts were made. Evidence, not telemetry. */
  attempts(): number;
  uninstall(): void;
}

/**
 * Wrap a global `fetch` so Crunchyroll cannot be reached from Node.
 *
 * The target is a parameter so this is testable deterministically against a
 * fake global instead of the process's own.
 */
export function installNodeCrunchyrollGuard(
  target: typeof globalThis = globalThis
): NodeCrunchyrollGuard {
  const original = target.fetch;
  let blocked = 0;

  const guarded = (async (input: unknown, init?: unknown) => {
    if (isGuardedCrunchyrollUrl(input)) {
      blocked += 1;
      // One structural line, no URL, no header, no body — enough to notice,
      // not enough to leak.
      console.error("[node-egress-guard] blocked a Node-originated Crunchyroll request");
      throw new TransportError("NODE_CRUNCHYROLL_FORBIDDEN");
    }
    return (original as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as typeof fetch;

  target.fetch = guarded;

  return {
    attempts: () => blocked,
    uninstall: () => {
      // Only restore what we replaced: if something else wrapped fetch after
      // us, stomping it would be worse than leaving the chain intact.
      if (target.fetch === guarded) target.fetch = original;
    },
  };
}
