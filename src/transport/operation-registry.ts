// BT1 — the closed Operation Registry.
//
// Owns descriptor construction, lookup and the single resolution function.
// Nothing here is wired into an MCP tool in BT1.

import type {
  AuthDerivedParamSpec, BodySpec, CallerParams, JoinedQueryParam, OperationDescriptor, OperationId,
  ParamSpec, ResolvedCall, ResponseContract,
} from "./types.js";
import {
  contentId, contentIdList, HTTP_METHODS, MUTATION_CLASSES, optionalBoolean, optionalOneOf,
  requiredIntegerInRange, searchText, slugList,
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
/** F-2. Joined specs are two-field objects, so each entry is frozen with them. */
function freezeJoined(
  joined: Readonly<Record<string, JoinedQueryParam>> | undefined
): Readonly<Record<string, JoinedQueryParam>> {
  const captured: Record<string, JoinedQueryParam> = {};
  for (const [key, spec] of Object.entries(joined ?? {})) {
    captured[key] = Object.freeze({ callerParam: spec.callerParam, separator: spec.separator });
  }
  return Object.freeze(captured);
}

/**
 * BT8.1. A body spec is two flat maps, so each is frozen with the spec itself —
 * hand-written for this known shape, exactly like `freezeJoined` above.
 */
function freezeBody(spec: BodySpec): BodySpec {
  return Object.freeze({
    contentType: spec.contentType,
    fields: Object.freeze({ ...spec.fields }),
    fixedFields: Object.freeze({ ...spec.fixedFields }),
  });
}

/** BT8.1. Same reasoning; the status list is copied, never aliased. */
function freezeResponse(contract: ResponseContract): ResponseContract {
  return Object.freeze({
    successStatuses: Object.freeze([...contract.successStatuses]),
    body: contract.body,
    ...(contract.determinedNotFound === undefined
      ? {}
      : { determinedNotFound: contract.determinedNotFound }),
  });
}

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
    repeatedQueryParams: Object.freeze({ ...(d.repeatedQueryParams ?? {}) }),
    joinedQueryParams: freezeJoined(d.joinedQueryParams),
    scope: d.scope,
    auth: d.auth,
    mutation: d.mutation,
    // BT8.1. Absence is meaningful for both — a DELETE has no body, a read has
    // no declared response contract — so an absent one stays ABSENT rather than
    // becoming a present `undefined`, and the frozen copy of a read descriptor
    // keeps exactly the key set it has always had.
    ...(d.body === undefined ? {} : { body: freezeBody(d.body) }),
    ...(d.response === undefined ? {} : { response: freezeResponse(d.response) }),
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
    // ── BT8.1 (INV-M1 / INV-M3) ───────────────────────────────────────────
    //
    // The SAME closure BT5-FIX1 gave `auth` and `scope`, for the same stated
    // reason, now applied to the two dimensions BT8 turns into decisions.
    //
    // `mutation` matters most: from BT8 onwards it is the field the execution
    // gate READS to decide whether a request may leave. An unchecked value —
    // `true`, `1`, `"ACCOUNT "`, an object — must never reach a comparison that
    // could grant by accident, and `!== false` is precisely such a comparison.
    if (!MUTATION_CLASSES.includes(d.mutation)) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} declares no closed mutation class`
      );
    }
    if (!HTTP_METHODS.includes(d.method)) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} declares no closed method`
      );
    }
    // INV-M2. The biconditional IS the substitution the design asked for: it
    // replaces "mutations are impossible" with "only explicitly registered,
    // structurally valid mutations are possible". A GET may never claim to
    // change state, and a state-changing method may never pose as a read —
    // which is the shape a mutation would have to take to slip past a gate that
    // only inspects one of the two fields.
    if ((d.method === "GET") !== (d.mutation === false)) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} disagrees about whether it mutates: method ${d.method}`
      );
    }
    // INV-M4. An anonymous or public write has no meaning in this system: every
    // mutation this project can express addresses the authenticated account.
    if (d.mutation !== false && (d.scope !== "ACCOUNT" || d.auth !== "BEARER")) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} mutates without being an authenticated account operation`
      );
    }
    // INV-M5. A body belongs to a POST and to nothing else. The legacy DELETE
    // sent none, a GET body is meaningless here, and allowing one anyway would
    // widen the wire for no operation that exists.
    if (d.body !== undefined && (d.method !== "POST" || d.mutation === false)) {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} declares a body on a non-mutating or non-POST method`
      );
    }
    // INV-M8. A mutation may not INHERIT the read path's implicit "any 2xx,
    // JSON" contract. It has to say what success looks like, because a write
    // that answers 204 and a write that answers 200 with a document are
    // different contracts and only the provider knows which one this is.
    if (d.mutation !== false) {
      const contract = d.response;
      if (
        contract === undefined ||
        !Array.isArray(contract.successStatuses) ||
        contract.successStatuses.length === 0 ||
        (contract.body !== "JSON" && contract.body !== "EMPTY")
      ) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${String(d.id)} mutates without a closed response contract`
        );
      }
      for (const status of contract.successStatuses) {
        if (!Number.isInteger(status) || status < 200 || status > 299) {
          throw new TransportError(
            "INVALID_ARGUMENTS",
            `operation ${String(d.id)} declares a non-success status as success`
          );
        }
      }
      if (
        contract.determinedNotFound !== undefined &&
        contract.determinedNotFound !== "watchlist-item-absent"
      ) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${String(d.id)} declares no closed determined not-found outcome`
        );
      }
      // INV-M9. Neither encoding has a mutation use case, and the smallest
      // mutation surface is the one worth defending.
      if (
        Object.keys(d.repeatedQueryParams ?? {}).length > 0 ||
        Object.keys(d.joinedQueryParams ?? {}).length > 0
      ) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${String(d.id)} declares a list-valued query on a mutation`
        );
      }
    } else if (d.response !== undefined) {
      // A read declaring one would be claiming a contract nothing enforces for
      // it, and would quietly diverge from every other read in the table.
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${String(d.id)} is a read but declares a mutation response contract`
      );
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
      if (key in (d.queryParams ?? {})) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} declares query key ${key} both fixed and caller-filled`
        );
      }
    }
    // BT7. A repeated key must name a declared caller param, and a wire key may
    // be rendered exactly one way — an ambiguous key is how an array silently
    // becomes a scalar, or a constant silently loses to caller input.
    for (const [key, param] of Object.entries(d.repeatedQueryParams ?? {})) {
      if (!(param in d.callerParams)) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} maps repeated query ${key} to undeclared parameter ${param}`
        );
      }
      if (key in (d.queryParams ?? {})) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} declares query key ${key} both repeated and scalar`
        );
      }
      if (key in (d.fixedQuery ?? {})) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} declares query key ${key} both repeated and fixed`
        );
      }
    }
    // F-2. Same rule for joined keys, plus one more: the separator is part of
    // the wire, so an empty one is not a formatting preference, it is a
    // different request.
    for (const [key, spec] of Object.entries(d.joinedQueryParams ?? {})) {
      if (!(spec.callerParam in d.callerParams)) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} maps joined query ${key} to undeclared parameter ${spec.callerParam}`
        );
      }
      for (const [other, where] of [
        [d.queryParams, "scalar"],
        [d.fixedQuery, "fixed"],
        [d.repeatedQueryParams, "repeated"],
      ] as Array<[Readonly<Record<string, unknown>> | undefined, string]>) {
        if (key in (other ?? {})) {
          throw new TransportError(
            "INVALID_ARGUMENTS",
            `operation ${d.id} declares query key ${key} both joined and ${where}`
          );
        }
      }
      if (typeof spec.separator !== "string" || spec.separator.length === 0) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} declares joined query ${key} without a separator`
        );
      }
    }
    // ── BT8.1 (INV-M6 / INV-M7) — the body is the registry's, not the caller's ──
    //
    // The same two rules the query already lives by, because a body is the same
    // kind of thing: a wire key must name something DECLARED, and a wire key may
    // be filled exactly one way.
    //
    // The identity clause is the one that is specific to a write. `bind()`
    // resolves identity for whatever a descriptor declares, so a body field
    // naming `accountId` really would be served — and identity in a body is
    // identity outside the path, which is the one place BT7 proved it belongs.
    for (const [key, param] of Object.entries(d.body?.fields ?? {})) {
      if (param in d.authDerivedParams) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} maps body ${key} to authenticated identity ${param}`
        );
      }
      if (!(param in d.callerParams)) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} maps body ${key} to undeclared parameter ${param}`
        );
      }
    }
    for (const key of Object.keys(d.body?.fixedFields ?? {})) {
      if (key in (d.body?.fields ?? {})) {
        throw new TransportError(
          "INVALID_ARGUMENTS",
          `operation ${d.id} declares body key ${key} both fixed and caller-filled`
        );
      }
    }
    if (d.body !== undefined && d.body.contentType !== "application/json") {
      throw new TransportError(
        "INVALID_ARGUMENTS",
        `operation ${d.id} declares an unsupported body content type`
      );
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

/** An unbounded id list is an unbounded URL; this is the ceiling. */
export const MAX_CONTENT_IDS = 100;

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
    repeatedQueryParams: Object.freeze({}),
    joinedQueryParams: Object.freeze({}),
    scope: "PUBLIC",
    auth: "BEARER",
    mutation: false,
  }) as OperationDescriptor;
}

/**
 * BT7. An ACCOUNT read: the path addresses the authenticated account, so it
 * declares `accountId` as auth-derived and the value is resolved by BT3's
 * `bind()` — never by a caller, never by this table.
 *
 * `locale` is included by default because every one of these endpoints sent it,
 * with ONE exception: `GET_PLAYHEADS` sent none, and `withLocale: false` keeps
 * that faithful rather than tidy.
 */
function accountRead(spec: {
  id: string;
  pathTemplate: string;
  callerParams?: Record<string, ParamSpec>;
  queryParams?: Record<string, string>;
  repeatedQueryParams?: Record<string, string>;
  joinedQueryParams?: Record<string, JoinedQueryParam>;
  withLocale?: boolean;
}): OperationDescriptor {
  return Object.freeze({
    id: spec.id as OperationId,
    method: "GET",
    pathTemplate: spec.pathTemplate,
    callerParams: Object.freeze({ ...(spec.callerParams ?? {}) }),
    authDerivedParams: Object.freeze({ accountId: Object.freeze({ source: "accountId" }) }),
    fixedQuery: Object.freeze(spec.withLocale === false ? {} : { locale: CATALOG_LOCALE }),
    queryParams: Object.freeze({ ...(spec.queryParams ?? {}) }),
    repeatedQueryParams: Object.freeze({ ...(spec.repeatedQueryParams ?? {}) }),
    joinedQueryParams: freezeJoined(spec.joinedQueryParams),
    scope: "ACCOUNT",
    auth: "BEARER",
    mutation: false,
  }) as OperationDescriptor;
}

/**
 * BT8.1. An ACCOUNT MUTATION: the one sanctioned way to construct a
 * state-changing descriptor.
 *
 * It exists for the reason `publicRead`/`accountRead` exist — writing the
 * invariant shape ONCE removes the chance of one descriptor quietly disagreeing
 * with the rest — and it exists NOW, ahead of any consumer, because registry
 * machinery has always preceded the descriptors that use it: BT1 shipped the
 * whole registry with an empty production table.
 *
 * Every field a caller must not influence is fixed here rather than passed in:
 * identity is auth-derived, the scope and auth requirement are settled, and the
 * query maps are empty because the legacy owners of all three BT8 operations
 * sent no query string at all. That last point is preserved VERBATIM and is
 * itself subject to BT8.0 confirming the live endpoints accept none.
 *
 * BT8.2 uses this factory for ADD_TO_WATCHLIST; later BT8 stages may add the
 * other mutation descriptors only when their own provider contract is adopted.
 */
export function accountMutation(spec: {
  id: string;
  method: "POST" | "DELETE";
  pathTemplate: string;
  mutation: "ACCOUNT" | "PROGRESS";
  callerParams: Record<string, ParamSpec>;
  body?: BodySpec;
  response: ResponseContract;
}): OperationDescriptor {
  return Object.freeze({
    id: spec.id as OperationId,
    method: spec.method,
    pathTemplate: spec.pathTemplate,
    callerParams: Object.freeze({ ...spec.callerParams }),
    authDerivedParams: Object.freeze({ accountId: Object.freeze({ source: "accountId" }) }),
    fixedQuery: Object.freeze({}),
    queryParams: Object.freeze({}),
    repeatedQueryParams: Object.freeze({}),
    joinedQueryParams: Object.freeze({}),
    scope: "ACCOUNT",
    auth: "BEARER",
    mutation: spec.mutation,
    ...(spec.body === undefined ? {} : { body: spec.body }),
    response: spec.response,
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
 *
 * BT8.1 taught this registry to express mutations. BT8.2–BT8.4 register the
 * three operations from their respective BT8.0 contracts. Each descriptor
 * belongs to its own auditable stage and provider contract.
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

  // ── BT7: account reads. Identity is a PATH parameter resolved by bind(). ──
  accountRead({
    id: "GET_SIMILAR",
    pathTemplate: "/content/v2/discover/{accountId}/similar_to/{series_id}",
    callerParams: { series_id: contentId, n: requiredIntegerInRange(1, 100) },
    queryParams: { n: "n" },
  }),
  accountRead({
    id: "GET_RECOMMENDATIONS",
    pathTemplate: "/content/v2/discover/{accountId}/recommendations",
    callerParams: { n: requiredIntegerInRange(1, 100) },
    queryParams: { n: "n" },
  }),
  accountRead({
    id: "GET_WATCHLIST",
    pathTemplate: "/content/v2/{accountId}/watchlist",
    callerParams: { n: requiredIntegerInRange(1, 100), order: optionalOneOf(["desc", "asc"]) },
    queryParams: { n: "n", order: "order" },
  }),
  accountRead({
    id: "GET_HISTORY",
    pathTemplate: "/content/v2/{accountId}/watch-history",
    callerParams: { n: requiredIntegerInRange(1, 100) },
    queryParams: { n: "n" },
  }),
  // GET_CONTINUE_WATCHING is DEFERRED (F-1). BT7's live smoke proved the legacy
  // endpoint unrouted: 404 carrying the site's HTML shell, byte-identical with a
  // full query, a partial query and no query at all, while a sibling path under
  // the same prefix answered 200 on the same channel and the same identity. A
  // descriptor here would promise something the provider no longer serves, so
  // the tool stays published and answers OPERATION_NOT_MIGRATED. Where the
  // capability went is a later question, and a matter of evidence.
  accountRead({
    id: "GET_PLAYHEADS",
    pathTemplate: "/content/v2/{accountId}/playheads",
    // The legacy request sent NO locale here. Preserved verbatim.
    withLocale: false,
    callerParams: { content_ids: contentIdList(MAX_CONTENT_IDS) },
    // F-2. The live v2 endpoint names `content_ids`, answers 400
    // `missing_required_field` to the legacy `content_ids[]`, and keeps only the
    // first value when the bare key is repeated. Comma-joined is the one
    // encoding that resolved more than one id, so it is the contract.
    joinedQueryParams: { content_ids: { callerParam: "content_ids", separator: "," } },
  }),
  accountMutation({
    id: "ADD_TO_WATCHLIST",
    method: "POST",
    pathTemplate: "/content/v2/{accountId}/watchlist",
    mutation: "ACCOUNT",
    callerParams: { content_id: contentId },
    body: {
      contentType: "application/json",
      fields: { content_id: "content_id" },
      fixedFields: {},
    },
    response: { successStatuses: [204], body: "EMPTY" },
  }),
  accountMutation({
    id: "REMOVE_FROM_WATCHLIST",
    method: "DELETE",
    pathTemplate: "/content/v2/{accountId}/watchlist/{content_id}",
    mutation: "ACCOUNT",
    callerParams: { content_id: contentId },
    // BT8.0 proved this exact DELETE route succeeds for a present item (204)
    // and returns 404 when the item is absent. The opaque HTML response itself
    // is never parsed; the descriptor carries the operation-specific meaning.
    response: {
      successStatuses: [204],
      body: "EMPTY",
      determinedNotFound: "watchlist-item-absent",
    },
  }),
  accountMutation({
    id: "UPDATE_PLAYHEAD",
    method: "POST",
    pathTemplate: "/content/v2/{accountId}/playheads",
    mutation: "PROGRESS",
    callerParams: {
      content_id: contentId,
      playhead: requiredIntegerInRange(0, 86_400),
    },
    body: {
      contentType: "application/json",
      fields: { content_id: "content_id", playhead: "playhead" },
      fixedFields: {},
    },
    response: { successStatuses: [204], body: "EMPTY" },
  }),
]);
