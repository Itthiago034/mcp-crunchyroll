import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface LocalRequestRecord {
  readonly method: string;
  readonly url: string;
}

export interface LocalServer {
  readonly origin: string;
  readonly requests: readonly LocalRequestRecord[];
  waitForRequest(
    predicate: (request: LocalRequestRecord) => boolean,
    timeoutMs?: number,
  ): Promise<LocalRequestRecord>;
  close(): Promise<void>;
}

interface RequestWaiter {
  readonly predicate: (request: LocalRequestRecord) => boolean;
  readonly resolve: (request: LocalRequestRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export async function startLocalServer(): Promise<LocalServer> {
  const requests: LocalRequestRecord[] = [];
  const waiters = new Set<RequestWaiter>();

  const server: Server = createServer((req, res) => {
    const record: LocalRequestRecord = Object.freeze({
      method: req.method ?? "",
      url: req.url ?? "",
    });
    requests.push(record);
    for (const waiter of [...waiters]) {
      try {
        if (!waiter.predicate(record)) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      } catch (error) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(error instanceof Error ? error : new Error("Request predicate failed"));
      }
    }

    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>bt2-ok</title><p>BT2_LOOPBACK_OK</p>");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    get requests() { return Object.freeze([...requests]); },
    waitForRequest(predicate, timeoutMs = 5_000) {
      const seen = requests.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise<LocalRequestRecord>((resolve, reject) => {
        let waiter: RequestWaiter;
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for local request after ${timeoutMs}ms`));
        }, timeoutMs);
        waiter = { predicate, resolve, reject, timer };
        waiters.add(waiter);
      });
    },
    close: async () => {
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Local server closed before matching request"));
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
