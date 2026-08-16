// BT1 — the closed Operation Registry.
//
// Owns descriptor construction, lookup and the single resolution function.
// Nothing here is wired into an MCP tool in BT1.

import type {
  AuthDerivedParamSpec, CallerParams, OperationDescriptor, OperationId, ParamSpec, ResolvedCall,
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
    scope: d.scope,
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
 * auth-derived params: it needs a bearer, not an identity.
 *
 * DEVIATION, DECLARED: the external ruling labelled this operation
 * `scope: PUBLIC` while stating that PUBLIC does not mean anonymous and that a
 * bearer is still required. In BT3's closed vocabulary those two things cannot
 * both be true: `bind()` answers a PUBLIC descriptor with no context and no
 * material at all, so a PUBLIC operation is unable to carry a bearer. ACCOUNT
 * with ZERO auth-derived params is the shape that means exactly what the ruling
 * described — a live AuthContext is required, no identity is resolved, and
 * ACCOUNT_READY suffices because nothing here needs a profile id. Choosing
 * PUBLIC instead would have meant reading material outside BT3's reader and
 * duplicating the §13A commit check, which is worse. Submitted for review.
 */
export const PRODUCTION_OPERATIONS: readonly OperationDescriptor[] = Object.freeze([
  Object.freeze({
    id: "GET_CATEGORIES" as OperationId,
    method: "GET",
    pathTemplate: "/content/v2/discover/categories?locale=en-US",
    callerParams: Object.freeze({}),
    authDerivedParams: Object.freeze({}),
    scope: "ACCOUNT",
    mutation: false,
  }) as OperationDescriptor,
]);
