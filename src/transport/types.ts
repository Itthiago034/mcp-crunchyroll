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
  readonly pathTemplate: string;
  readonly callerParams: Readonly<Record<string, ParamSpec>>;
  readonly authDerivedParams: Readonly<Record<string, AuthDerivedParamSpec>>;
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
