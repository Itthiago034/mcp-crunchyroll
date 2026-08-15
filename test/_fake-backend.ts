// BT1 — test-only transport backend double.
//
// Implements ONLY the backend contract. It never validates and never sees raw
// caller input — the dispatcher does that — so `calls.length === 0` after a
// rejected call proves the architectural seam, not fake discipline.
//
// It does not imitate Chromium, CDP, WebSocket frames, auth minting or browser
// lifecycle. Never imported by production code.

import type {
  ResolvedCall, TransportBackend, TransportResult,
} from "../src/transport/types.js";
import { TransportError } from "../src/transport/transport-error.js";

export interface FakeBackendOptions {
  readonly result?: TransportResult;
  /** When set, executeResolved rejects with this AFTER dispatch. */
  readonly failWith?: TransportError;
}

export class FakeTransportBackend implements TransportBackend {
  readonly calls: ResolvedCall[] = [];

  constructor(private readonly options: FakeBackendOptions = {}) {}

  async executeResolved(call: ResolvedCall): Promise<TransportResult> {
    this.calls.push(call);
    if (this.options.failWith) throw this.options.failWith;
    return (
      this.options.result ?? { status: 200, contentType: "application/json", json: { ok: true } }
    );
  }
}
