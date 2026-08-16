// BT1 — the closed Operation Registry.
//
// Owns descriptor construction, lookup and the single resolution function.
// Nothing here is wired into an MCP tool in BT1.

import type {
  AuthDerivedParamSpec, CallerParams, OperationDescriptor, OperationId, ParamSpec, ResolvedCall,
} from "./types.js";
import {
  contentId, optionalBoolean, optionalOneOf, requiredIntegerInRange, searchText, slugList,
} from "./types.js";
import { TransportError } from "./transport-error.js";

export interface OperationRegistry {
  get(id: string): OperationDescriptor | undefined;
  has(id: string): boolean;
  ids(): readonly string[];
}

/**
 * Deep capture.
 *
 * The registry owns an immutable COPY of every descriptor, down to each param
 * spec. Mutating the objects the caller passed in must never change registry
 * policy afterwards. Validate predicates stay as function references by design:
 * a function IS the policy, and cloning it is neither possible nor meaningful.
 * Hand-written for this known shape — no recursive deep-freeze helper, no
 * structuredClone, no proxy, no immutable-collection dependency.
 */
function captureDescriptor(d: OperationDescriptor): OperationDescriptor {
  const callerParams: Record<string, ParamSpec> = {};
  for (const [name, spec] of Object.entries(d.callerParams)) {
    callerParams[name] = Object.freeze({ required: spec.required, validate: spec.validate });
  }
  const authDerivedParams: Record<string, AuthDerivedParamSpec> = {};
  for (const [name, spec] of Object.entries(d.authDerivedParams)) {
    authDerivedParams[name] = Object.freeze({ source: spec.source });
  }
  return Object.freeze({
    id: d.id,
    method: d.method,
    pathTemplate: d.pathTemplate,
    callerParams: Object.freeze(callerParams),
    authDerivedParams: Object.freeze(authDerivedParams),
    // Absent maps are normalized to empty: an operation with no query really
    // has none, and the frozen copy keeps registry policy immune to later
    // mutation of the object the caller passed in.
    fixedQuery: Object.freeze({ ...(d.fixedQuery ?? {}) }),
    queryParams: Object.freeze({ ...(d.queryParams ?? {}) }),
    scope: d.scope,
    auth: d.auth,
    mutation: d.mutation,
  });
}

/**
 * Build a frozen registry. Descriptor invariants are enforced HERE, at
 * construction, because tsconfig.json typechecks only src/ — a type-level
 * guarantee would never be exercised by the suite.
 */
export function createOperationRegistry(
  descriptors: readonly OperationDescriptor[]
): OperationRegistry {
  const byId = new Map<string, OperationDescriptor>();
  for (const d of descriptors) {
    // BT5-FIX1. The two dimensions are closed at runtime, not merely typed:
    // tsconfig checks src/ only, and an unknown value must never fall through
    // to a default that grants or withholds material by accident.
    if (d.auth !== "NONE" && d.auth !== "BEARER") {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} declares no closed auth requirement`
      );
    }
    if (d.scope !== "PUBLIC" && d.scope !== "ACCOUNT") {
      throw new TransportError("INVALID_ARGUMENTS", `operation ${String(d.id)} declares no closed scope`);
    }
    // An account-scoped endpoint resolves identity from the current record, so
    // it cannot be served without material. The combination has no meaning and
    // is refused rather than silently reinterpreted.
    if (d.scope === "ACCOUNT" && d.auth === "NONE") {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} is account-scoped but declares no auth material`
      );
    }
    // BT5-FIX2. The scope must AGREE with the identity the descriptor actually
    // resolves, or the label means nothing:
    //
    //   PUBLIC  claims "this addresses nobody's account", so resolving an
    //           accountId or profileId contradicts it — and `bind()` resolves
    //           whatever a descriptor declares, independently of scope, so an
    //           unchecked PUBLIC descriptor really would consume identity while
    //           claiming not to;
    //   ACCOUNT claims "this addresses someone's account", so a descriptor with
    //           no identity parameter is the pre-FIX1 overload — ACCOUNT used
    //           only to obtain a bearer — wearing a new label.
    //
    // A genuinely account-scoped endpoint with no identity parameter would need
    // an explicit decision, not a quietly weakened invariant here.
    const identityCount = Object.keys(d.authDerivedParams).length;
    if (d.scope === "PUBLIC" && identityCount > 0) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} is public but resolves authenticated identity`
      );
    }
    if (d.scope === "ACCOUNT" && identityCount === 0) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} is account-scoped but resolves no identity`
      );
    }
    if (byId.has(d.id)) {
      throw new TransportError("INVALID_ARGUMENTS", `duplicate operation id: ${d.id}`);
    }
    const overlap = Object.keys(d.callerParams).filter((k) => k in d.authDerivedParams);
    if (overlap.length > 0) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${d.id} declares overlapping caller/auth-derived params: ${overlap.join(", ")}`
      );
    }
    for (const name of Object.keys(d.authDerivedParams)) {
      if (!d.pathTemplate.includes(`{${name}}`)) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} declares auth-derived param ${name} absent from its path template`
        );
      }
    }
    // BT6. Path and query are transport knowledge, so the registry is where
    // they are checked for coherence — before any of it can reach a URL.
    if (d.pathTemplate.includes("?")) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${d.id} carries a query string in its path template`
      );
    }
    for (const placeholder of d.pathTemplate.matchAll(/\{([^}]+)\}/g)) {
      const name = placeholder[1];
      if (!(name in d.callerParams) && !(name in d.authDerivedParams)) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} has an undeclared path placeholder: ${name}`
        );
      }
    }
    for (const [key, param] of Object.entries(d.queryParams ?? {})) {
      if (!(param in d.callerParams)) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} maps query ${key} to undeclared parameter ${param}`
        );
      }
    }
    for (const key of Object.keys(d.fixedQuery ?? {})) {
      if (key in d.queryParams) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} declares query key ${key} both fixed and caller-filled`
        );
      }
    }
    byId.set(d.id, captureDescriptor(d));
  }
  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    ids: () => Object.freeze([...byId.keys()]),
  };
}

/**
 * The single resolution function. The dispatcher is its only production caller;
 * no backend calls it, and no backend may skip it.
 */
export function resolveCall(
  registry: OperationRegistry,
  operation: string,
  params: CallerParams = {}
): ResolvedCall {
  const descriptor = registry.get(operation);
  if (!descriptor) {
    throw new TransportError("UNKNOWN_OPERATION", `no such operation: ${String(operation)}`);
  }
  // Allow-list, not blacklist: only declared callerParams are accepted, so a
  // key nobody declared can never reach a backend regardless of its name.
  for (const key of Object.keys(params)) {
    // Identity first: a caller passing accountId deserves the precise reason,
    // not a generic "unexpected argument".
    if (key in descriptor.authDerivedParams) {
      throw new TransportError("CALLER_SUPPLIED_IDENTITY", `auth-derived parameter: ${key}`);
    }
    if (!(key in descriptor.callerParams)) {
      throw new TransportError("INVALID_ARGUMENTS", `unexpected argument: ${key}`);
    }
  }
  for (const [name, spec] of Object.entries(descriptor.callerParams)) {
    if (!(name in params)) {
      if (spec.required) {
        throw new TransportError("INVALID_ARGUMENTS", `missing required argument: ${name}`);
      }
      continue;
    }
    if (!spec.validate(params[name])) {
      throw new TransportError("INVALID_ARGUMENTS", `invalid argument: ${name}`);
    }
  }
  return Object.freeze({ descriptor, callerParams: Object.freeze({ ...params }) });
}

/** The locale this build requests. A constant, never a caller argument. */
export const CATALOG_LOCALE = "en-US";

/**
 * Every BT5/BT6 operation is the same shape: a public catalog READ that still
 * carries a bearer, resolves no identity, mutates nothing, and asks for one
 * fixed locale. Writing that once removes the chance of one descriptor
 * quietly disagreeing with the rest.
 */
function publicRead(spec: {
  id: string;
  pathTemplate: string;
  callerParams?: Record<string, ParamSpec>;
  queryParams?: Record<string, string>;
}): OperationDescriptor {
  return Object.freeze({
    id: spec.id as OperationId,
    method: "GET",
    pathTemplate: spec.pathTemplate,
    callerParams: Object.freeze({ ...(spec.callerParams ?? {}) }),
    authDerivedParams: Object.freeze({}),
    fixedQuery: Object.freeze({ locale: CATALOG_LOCALE }),
    queryParams: Object.freeze({ ...(spec.queryParams ?? {}) }),
    scope: "PUBLIC",
    auth: "BEARER",
    mutation: false,
  }) as OperationDescriptor;
}

/**
 * The production operation table.
 *
 * Registry MACHINERY arrived in BT1; endpoint OWNERSHIP transfers one operation
 * at a time. At each migration the path literal leaves `src/api.ts` AND the
 * descriptor enters here in the SAME auditable stage — never copy-first,
 * remove-later across a closed stage boundary.
 *
 * BT5 (cutover) migrates `GET_CATEGORIES` and nothing else. The remaining
 * catalog reads follow at BT6, account reads at BT7, mutations at BT8. Every
 * content operation absent from this table is refused with
 * `OPERATION_NOT_MIGRATED` and can no longer reach Node.
 *
 * `GET_CATEGORIES` declares no caller params — the tool takes none — and no
 * auth-derived params: it needs a bearer, not an identity. BT5-FIX1 gives that
 * its own field, so the descriptor states both facts without either standing in
 * for the other: `scope: PUBLIC` (addresses nobody's account) and
 * `auth: BEARER` (still needs a live AuthContext).
 *
 * BT5-FIX1 superseded the earlier ACCOUNT-with-no-identity shape, which
 * overloaded ACCOUNT and would have made PROFILE_READY enforcement ambiguous
 * for the real account operations arriving at BT7.
 */
export const PRODUCTION_OPERATIONS: readonly OperationDescriptor[] = Object.freeze([
  publicRead({
    id: "GET_CATEGORIES",
    pathTemplate: "/content/v2/discover/categories",
  }),
  publicRead({
    id: "SEARCH",
    pathTemplate: "/content/v2/discover/search",
    callerParams: { q: searchText, n: requiredIntegerInRange(1, 100), type: optionalOneOf(["series", "movie_listing"]) },
    queryParams: { q: "q", n: "n", type: "type" },
  }),
  publicRead({
    id: "GET_SERIES",
    pathTemplate: "/content/v2/cms/series/{series_id}",
    callerParams: { series_id: contentId },
  }),
  publicRead({
    id: "GET_SEASONS",
    // The legacy request sent series_id in BOTH the path and the query; that
    // is preserved verbatim rather than tidied into one of the two.
    pathTemplate: "/content/v2/cms/series/{series_id}/seasons",
    callerParams: { series_id: contentId },
    queryParams: { series_id: "series_id" },
  }),
  publicRead({
    id: "GET_EPISODES",
    pathTemplate: "/content/v2/cms/seasons/{season_id}/episodes",
    callerParams: { season_id: contentId },
  }),
  publicRead({
    id: "GET_EPISODE",
    pathTemplate: "/content/v2/cms/episodes/{episode_id}",
    callerParams: { episode_id: contentId },
  }),
  publicRead({
    id: "GET_SIMULCAST_SEASONS",
    pathTemplate: "/content/v2/discover/seasonal_tags",
  }),
  publicRead({
    id: "BROWSE",
    pathTemplate: "/content/v2/discover/browse",
    callerParams: {
      n: requiredIntegerInRange(1, 100),
      start: requiredIntegerInRange(0, 10_000),
      sort_by: optionalOneOf(["popularity", "newly_added", "updated", "alphabetical"]),
      categories: slugList,
      seasonal_tag: { validate: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) },
      is_subbed: optionalBoolean,
      is_dubbed: optionalBoolean,
    },
    queryParams: {
      n: "n",
      start: "start",
      sort_by: "sort_by",
      categories: "categories",
      seasonal_tag: "seasonal_tag",
      is_subbed: "is_subbed",
      is_dubbed: "is_dubbed",
    },
  }),
]);
