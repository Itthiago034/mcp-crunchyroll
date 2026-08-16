import { BrowserLifecycleError } from "./browser-lifecycle-error.js";
import type { CdpConnection, CdpConnector } from "./browser-lifecycle-types.js";
import { createWebSocketClient, WEBSOCKET_OPEN } from "./websocket.js";

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface CdpFrame {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  /** Present on frames belonging to a flattened target session (BT4). */
  readonly sessionId?: unknown;
}

export function createCdpConnector(commandTimeoutMs: number): CdpConnector {
  return {
    connect(webSocketDebuggerUrl: string): Promise<CdpConnection> {
      return new Promise<CdpConnection>((resolve, reject) => {
        const socket = createWebSocketClient(webSocketDebuggerUrl);
        let opened = false;
        let closed = false;
        let nextId = 1;
        const pending = new Map<number, PendingCommand>();
        const eventListeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
        const closeListeners = new Set<() => void>();

        const disconnectError = () => new BrowserLifecycleError("BROWSER_DISCONNECTED");

        const finishClose = () => {
          if (closed) return;
          closed = true;
          for (const command of pending.values()) {
            clearTimeout(command.timer);
            command.reject(disconnectError());
          }
          pending.clear();
          for (const listener of [...closeListeners]) listener();
          closeListeners.clear();
          if (!opened) reject(disconnectError());
        };

        socket.on("message", (data) => {
          let frame: CdpFrame;
          try {
            frame = JSON.parse(String(data)) as CdpFrame;
          } catch {
            return;
          }

          if (typeof frame.id === "number") {
            const command = pending.get(frame.id);
            if (!command) return;
            pending.delete(frame.id);
            clearTimeout(command.timer);
            if (frame.error !== undefined) command.reject(disconnectError());
            else command.resolve(frame.result);
            return;
          }

          if (typeof frame.method === "string") {
            // BT4: a flattened session tags its frames; the second argument is
            // additive, so listeners that take one parameter are unchanged.
            const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : undefined;
            for (const listener of eventListeners.get(frame.method) ?? []) {
              listener(frame.params, sessionId);
            }
          }
        });
        socket.on("close", finishClose);
        socket.on("error", finishClose);
        socket.once("open", () => {
          if (closed) return;
          opened = true;
          const connection: CdpConnection = {
            send(method, params, sessionId) {
              if (closed || socket.readyState !== WEBSOCKET_OPEN) {
                return Promise.reject(disconnectError());
              }
              const id = nextId++;
              return new Promise<unknown>((resolveCommand, rejectCommand) => {
                const timer = setTimeout(() => {
                  pending.delete(id);
                  rejectCommand(disconnectError());
                }, commandTimeoutMs);
                pending.set(id, {
                  resolve: resolveCommand,
                  reject: rejectCommand,
                  timer,
                });
                try {
                  socket.send(
                    JSON.stringify({
                      id,
                      method,
                      ...(params ? { params } : {}),
                      ...(sessionId ? { sessionId } : {}),
                    })
                  );
                } catch {
                  const command = pending.get(id);
                  if (command) {
                    pending.delete(id);
                    clearTimeout(command.timer);
                    command.reject(disconnectError());
                  }
                }
              });
            },
            on(event, listener) {
              let listeners = eventListeners.get(event);
              if (!listeners) {
                listeners = new Set();
                eventListeners.set(event, listeners);
              }
              listeners.add(listener);
            },
            close() {
              if (!closed) socket.close();
            },
            onClose(listener) {
              let active = true;
              if (closed) {
                queueMicrotask(() => {
                  if (active) listener();
                });
              } else {
                closeListeners.add(listener);
              }
              return () => {
                if (!active) return;
                active = false;
                closeListeners.delete(listener);
              };
            },
          };
          resolve(connection);
        });
      });
    },
  };
}
