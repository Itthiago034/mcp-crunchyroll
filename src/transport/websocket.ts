import WebSocket from "ws";

/**
 * The single binding site for the WebSocket dependency. BT1 introduces it so
 * Node-18 resolution and bundling are proven now; BT2 uses it to speak CDP.
 * BT1 opens NO connection: no CDP URL, no localhost port, no browser launch,
 * no socket lifecycle, no reconnect.
 */
export type WebSocketClient = WebSocket;

export function createWebSocketClient(url: string): WebSocketClient {
  return new WebSocket(url);
}

/** Lets a test prove the dependency loaded and bundled without connecting. */
export const WEBSOCKET_OPEN: number = WebSocket.OPEN;
