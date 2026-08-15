// BT1 — the mandatory transport dispatcher.
//
// Not wired into any MCP tool: BT1 remains caller-unreachable.

import { resolveCall, type OperationRegistry } from "./operation-registry.js";
import type {
  CallerParams, CrunchyrollTransport, OperationId, TransportBackend, TransportResult,
} from "./types.js";

/**
 * The ONLY caller-facing transport implementation.
 *
 * Structural guarantee: a backend implements `executeResolved(ResolvedCall)`,
 * so it is not type-compatible with raw caller input and cannot receive an
 * unvalidated argument bag even by mistake. Validation is therefore a property
 * of the module graph rather than of backend discipline — which is exactly the
 * failure mode this stage exists to make impossible.
 */
export function createTransportDispatcher(
  registry: OperationRegistry,
  backend: TransportBackend
): CrunchyrollTransport {
  return {
    async execute(operation: OperationId, params: CallerParams = {}): Promise<TransportResult> {
      const resolved = resolveCall(registry, operation, params);
      return backend.executeResolved(resolved);
    },
  };
}
