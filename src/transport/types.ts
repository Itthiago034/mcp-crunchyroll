// BT1 — Browser Transport shared types.
//
// Pure types plus a few parameter predicates. This module imports nothing and
// is the vocabulary every other transport module and every future backend
// speaks. It is NOT wired into any MCP tool in BT1.

/** Closed set of transport operations. Extended only when an endpoint migrates. */
export type OperationId = string & { readonly __brand: "OperationId" };

export type HttpMethod = "GET" | "POST" | "DELETE";

/**
 * WHOSE data an endpoint addresses — an identity question.
 *
 * `PUBLIC`: the path carries no account or profile identity.
 * `ACCOUNT`: it does, and BT7 will require PROFILE_READY before such an
 * operation becomes caller-reachable.
 */
export type AuthScope = "PUBLIC" | "ACCOUNT";

/**
 * WHETHER the request needs authentication material — a separate question
 * (BT5-FIX1).
 *
 * Conflating the two is what made `GET_CATEGORIES` look account-scoped: it
 * addresses nobody's account, yet every Crunchyroll API call carries a bearer.
 * `PUBLIC + BEARER` says exactly that, and `ACCOUNT + NONE` is meaningless and
 * refused at registry construction.
 */
export type AuthMaterialRequirement = "NONE" | "BEARER";
export type MutationClass = false | "ACCOUNT" | "PROGRESS";

/**
 * Runtime contract for one caller-supplied parameter. A predicate rather than a
 * schema library: the project has one runtime dependency and BT1 is not the
 * place to add a validator framework.
 */
export interface ParamSpec {
  readonly required?: boolean;
  readonly validate: (value: unknown) => boolean;
}

/**
 * Declares that a path parameter is filled from authenticated identity.
 * BT1 stores POLICY ONLY — it cannot resolve a value. BT3 owns the AuthContext
 * that eventually does, and no BT1 backend receives a resolved identity.
 */
export interface AuthDerivedParamSpec {
  readonly source: "accountId" | "profileId";
}

export interface OperationDescriptor {
  readonly id: OperationId;
  readonly method: HttpMethod;
  /**
   * Path only — never a query string. `{name}` placeholders are filled from
   * declared caller params or auth-derived params, both validated first.
   */
  readonly pathTemplate: string;
  readonly callerParams: Readonly<Record<string, ParamSpec>>;
  readonly authDerivedParams: Readonly<Record<string, AuthDerivedParamSpec>>;
  /**
   * BT6. Query keys whose value is a constant of THIS BUILD — `locale`, for
   * instance. A caller can neither add one nor change one.
   */
  readonly fixedQuery: Readonly<Record<string, string>>;
  /**
   * BT6. Query key → the DECLARED caller param that fills it. Explicit rather
   * than inferred, because one value may legitimately appear in both the path
   * and the query (`GET_SEASONS` sends `series_id` in both), and a rule that
   * guessed would silently drop or duplicate it.
   */
  readonly queryParams: Readonly<Record<string, string>>;
  readonly scope: AuthScope;
  readonly auth: AuthMaterialRequirement;
  readonly mutation: MutationClass;
}

/** Raw caller arguments, before validation. */
export type CallerParams = Readonly<Record<string, unknown>>;

/** The validated unit handed to a backend. A backend never sees anything else. */
export interface ResolvedCall {
  readonly descriptor: OperationDescriptor;
  readonly callerParams: CallerParams;
}

/**
 * BT1 contract shape only. Runtime semantics (size caps, 401 recovery,
 * generation commit check, Cloudflare classification) belong to BT2+.
 */
export interface TransportResult {
  readonly status: number;
  readonly contentType: string;
  readonly json: unknown;
}

/** Implemented by every backend — the fake in BT1, the browser transport in BT2+. */
export interface TransportBackend {
  executeResolved(call: ResolvedCall): Promise<TransportResult>;
}

/** The only surface a domain caller ever touches. */
export interface CrunchyrollTransport {
  execute(operation: OperationId, params?: CallerParams): Promise<TransportResult>;
}

// ── Reusable parameter predicates ───────────────────────────────────────────

export const nonEmptyString: ParamSpec = {
  required: true,
  validate: (v) => typeof v === "string" && v.trim().length > 0,
};

export function optionalIntegerInRange(min: number, max: number): ParamSpec {
  return {
    validate: (v) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max,
  };
}

export function optionalOneOf(allowed: readonly string[]): ParamSpec {
  return { validate: (v) => typeof v === "string" && allowed.includes(v) };
}

/**
 * A Crunchyroll content id, as it appears in a path segment. The legacy client
 * interpolated these raw; nothing but an id can reach a URL now, so traversal
 * and separator injection are refused before encoding is even considered.
 */
export const contentId: ParamSpec = {
  required: true,
  validate: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v),
};

/** A non-empty free-text query value. It is encoded, never interpolated. */
export const searchText: ParamSpec = {
  required: true,
  validate: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 256,
};

/** A comma-separated slug list, e.g. "action,fantasy". */
export const slugList: ParamSpec = {
  validate: (v) => typeof v === "string" && /^[a-z0-9-]+(,[a-z0-9-]+)*$/.test(v),
};

export const optionalBoolean: ParamSpec = {
  validate: (v) => typeof v === "boolean",
};

export function requiredIntegerInRange(min: number, max: number): ParamSpec {
  return {
    required: true,
    validate: (v) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max,
  };
}
