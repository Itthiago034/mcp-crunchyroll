// BT1 — the closed Operation Registry.
//
// Owns descriptor construction, lookup and the single resolution function.
// Nothing here is wired into an MCP tool in BT1.

import type { CallerParams, OperationDescriptor, ResolvedCall } from "./types.js";
import { TransportError } from "./transport-error.js";

export interface OperationRegistry {
  get(id: string): OperationDescriptor | undefined;
  has(id: string): boolean;
  ids(): readonly string[];
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
    byId.set(d.id, Object.freeze({ ...d }));
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
  return Object.freeze({ descriptor, callerParams: Object.freeze({ ...params }) });
}

/**
 * The production operation table. INTENTIONALLY EMPTY IN BT1.
 *
 * Registry MACHINERY exists in BT1; production endpoint OWNERSHIP is not
 * transferred, because no production descriptor exists yet. At each later
 * migration the path literal leaves src/api.ts AND the descriptor enters here
 * in the SAME auditable stage — never copy-first, remove-later across a closed
 * stage boundary. Catalog at BT6, account at BT7.
 */
export const PRODUCTION_OPERATIONS: readonly OperationDescriptor[] = Object.freeze([]);
