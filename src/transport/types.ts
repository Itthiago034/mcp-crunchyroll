// BT1 — Browser Transport shared types.
//
// Pure types plus a few parameter predicates. This module imports nothing and
// is the vocabulary every other transport module and every future backend
// speaks. It is NOT wired into any MCP tool in BT1.

/** Closed set of transport operations. Extended only when an endpoint migrates. */
export type OperationId = string & { readonly __brand: "OperationId" };

export type HttpMethod = "GET" | "POST" | "DELETE";

/**
 * BT8.1. The SAME closed set, available at runtime.
 *
 * `tsconfig` typechecks `src/` only, so a union alone is never exercised by the
 * suite — the identical reasoning BT5-FIX1 gave for closing `auth` and `scope`
 * at registry construction. `PUT` and `PATCH` are deliberately absent: no
 * provider evidence in this project asks for either, and BT8's design admits a
 * method only when evidence requires it.
 */
export const HTTP_METHODS: readonly HttpMethod[] = Object.freeze(["GET", "POST", "DELETE"]);

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

/**
 * WHETHER an operation changes account state, and of which kind.
 *
 * `false` is a read. `ACCOUNT` changes stored account state (watchlist
 * membership); `PROGRESS` changes viewing progress. The distinction is not
 * decoration: progress is a last-writer-wins scalar with no set semantics, so
 * it carries a different retry hazard from a membership change (BT8 design §15).
 */
export type MutationClass = false | "ACCOUNT" | "PROGRESS";

/** BT8.1. The same closed set at runtime, for the reason given on HTTP_METHODS. */
export const MUTATION_CLASSES: readonly MutationClass[] = Object.freeze([
  false,
  "ACCOUNT",
  "PROGRESS",
]);

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

/**
 * F-2. How one array-valued caller param becomes one query value. Both halves
 * are descriptor-owned: a caller supplies elements, never the key and never the
 * separator.
 */
export interface JoinedQueryParam {
  readonly callerParam: string;
  readonly separator: string;
}

/**
 * BT8.1. A DESCRIPTOR-OWNED request body.
 *
 * The caller supplies VALUES; it never supplies a key, a type, a content type
 * or a document. This is the body analogue of `queryParams`/`fixedQuery`, and
 * it exists so that "the registry owns the wire" survives the arrival of
 * request bodies — a caller-supplied JSON blob would end that guarantee in one
 * step.
 *
 * `contentType` is a single literal rather than a free string: one encoding is
 * the only one any BT8 operation needs, and a widened field is an invitation to
 * a second one arriving without a decision.
 */
export interface BodySpec {
  readonly contentType: "application/json";
  /** wire key → the DECLARED caller param that fills it. */
  readonly fields: Readonly<Record<string, string>>;
  /** wire key → a constant of THIS BUILD. Never caller-supplied. */
  readonly fixedFields: Readonly<Record<string, string | number | boolean>>;
}

/**
 * BT8.1. What a SUCCESSFUL provider answer is allowed to look like.
 *
 * Reads leave this absent and keep the implicit "any 2xx, JSON" contract they
 * have always had. A mutation must declare it, because a write may legitimately
 * answer `204 No Content` — which carries no content type at all, and which the
 * read path would otherwise reject as an unreadable response, reporting a
 * successful write as a transport failure.
 */
export interface ResponseContract {
  readonly successStatuses: readonly number[];
  readonly body: "JSON" | "EMPTY";
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
  /**
   * BT7. Query key → a DECLARED, array-valued caller param, emitted once per
   * element in caller order (`wire[]=A&wire[]=B`).
   *
   * A separate map rather than a flag on `queryParams`, because the two render
   * differently and conflating them would let an array silently become a scalar.
   *
   * F-2 note: this shipped believing `GET_PLAYHEADS` needed it. Live evidence
   * said otherwise, and that operation now uses `joinedQueryParams`. The
   * capability is kept because it is general, closed and proven — an encoding a
   * provider may still ask for — not because anything currently consumes it.
   */
  readonly repeatedQueryParams: Readonly<Record<string, string>>;
  /**
   * F-2. Query key → a DECLARED, array-valued caller param rendered as ONE
   * scalar, its elements joined by a separator the DESCRIPTOR owns
   * (`content_ids=A,B,C`).
   *
   * This is the encoding the live provider actually accepts for playheads: it
   * names `content_ids`, rejects `content_ids[]` outright, and keeps only the
   * first value when the bare key is repeated. The separator lives here, never
   * in the URL builder and never in caller input, so no operation can be
   * special-cased by name downstream.
   */
  readonly joinedQueryParams: Readonly<Record<string, JoinedQueryParam>>;
  readonly scope: AuthScope;
  readonly auth: AuthMaterialRequirement;
  readonly mutation: MutationClass;
  /**
   * BT8.1. Present ONLY on a mutation that carries a body. Its absence is
   * meaningful — a `DELETE` sends no body and no content type — so it is left
   * undefined rather than normalized to an empty spec.
   */
  readonly body?: BodySpec;
  /** BT8.1. Required of every mutation, absent on every read. */
  readonly response?: ResponseContract;
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

/**
 * A bounded list of content ids, for a repeated query parameter.
 *
 * It reuses the SAME id rule as `contentId` rather than restating it: one
 * definition of "what an id looks like" is the point. The bound exists because
 * an unbounded list is an unbounded URL.
 */
export function contentIdList(maxEntries: number): ParamSpec {
  return {
    required: true,
    validate: (v) =>
      Array.isArray(v) &&
      v.length >= 1 &&
      v.length <= maxEntries &&
      v.every((entry) => contentId.validate(entry)),
  };
}

export function requiredIntegerInRange(min: number, max: number): ParamSpec {
  return {
    required: true,
    validate: (v) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max,
  };
}
