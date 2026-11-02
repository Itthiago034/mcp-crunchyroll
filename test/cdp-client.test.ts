import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { createCdpConnector } from "../src/transport/cdp-client.js";
import { startLocalServer } from "./_local-server.js";

async function withServer(
  handler: (message: Record<string, unknown>, reply: (value: unknown) => void) => void,
  run: (url: string) => Promise<void>,
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const { port } = server.address() as { port: number };
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      handler(JSON.parse(String(data)) as Record<string, unknown>, (value) => {
        socket.send(JSON.stringify(value));
      });
    });
  });
  try {
    await run(`ws://127.0.0.1:${port}/devtools/browser/test`);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("BT2 minimal CDP client", () => {
  test("valid JSON primitives and arrays cannot crash the frame parser", async () => {
    await withServer((message, reply) => {
      for (const invalid of [null, true, 1, "noise", []]) reply(invalid);
      reply({ id: message.id, result: { ok: true } });
    }, async (url) => {
      const connection = await createCdpConnector(500).connect(url);
      assert.deepEqual(await connection.send("Browser.getVersion"), { ok: true });
      connection.close();
    });
  });

  test("pending-command capacity rejects before dispatch and recovers after timeout", async () => {
    let received = 0;
    await withServer((message, reply) => {
      received += 1;
      if (received > 1) reply({ id: message.id, result: {} });
    }, async (url) => {
      const connection = await createCdpConnector(100, {
        maxPendingCommands: 1, maxPayloadBytes: 1024,
      }).connect(url);
      const first = assert.rejects(connection.send("First"), BrowserLifecycleError);
      await assert.rejects(connection.send("Excess"), (error: unknown) =>
        error instanceof BrowserLifecycleError && error.detail === "cdp-capacity");
      await first;
      assert.equal(received, 1);
      assert.deepEqual(await connection.send("Next"), {});
      connection.close();
    });
  });

  test("oversized CDP frames disconnect and reject pending work", async () => {
    await withServer((message, reply) => {
      reply({ id: message.id, result: { body: "x".repeat(512) } });
    }, async (url) => {
      const connection = await createCdpConnector(500, {
        maxPendingCommands: 2, maxPayloadBytes: 128,
      }).connect(url);
      await assert.rejects(connection.send("Read"), BrowserLifecycleError);
      await assert.rejects(connection.send("AfterClose"), BrowserLifecycleError);
    });
  });

  test("explicit close settles locally without waiting for the peer", async () => {
    await withServer(() => undefined, async (url) => {
      const connection = await createCdpConnector(500).connect(url);
      let closed = 0;
      connection.onClose(() => { closed += 1; });
      const pending = assert.rejects(connection.send("Pending"), BrowserLifecycleError);
      connection.close();
      assert.equal(closed, 1);
      await pending;
      await assert.rejects(connection.send("AfterClose"), BrowserLifecycleError);
    });
  });

  test("a peer that never completes the WebSocket handshake hits the deadline", {
    timeout: 2000,
  }, async () => {
    const sockets = new Set<Socket>();
    const server = createServer();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", () => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      await assert.rejects(createCdpConnector(50).connect(`ws://127.0.0.1:${port}`),
        BrowserLifecycleError);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("invalid limits fail before opening a socket", () => {
    for (const timeout of [0, -1, Infinity, NaN, 0.5]) {
      assert.throws(() => createCdpConnector(timeout), RangeError);
    }
  });

  test("a command response is correlated by id", async () => {
    await withServer(
      (message, reply) => reply({ id: message.id, result: { product: "TestBrowser/1.0" } }),
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        const result = (await connection.send("Browser.getVersion")) as { product: string };
        assert.equal(result.product, "TestBrowser/1.0");
        connection.close();
      },
    );
  });

  test("concurrent commands resolve to their own responses", async () => {
    await withServer(
      (message, reply) => setTimeout(
        () => reply({ id: message.id, result: { echo: message.method } }),
        message.method === "A" ? 30 : 1,
      ),
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        const [a, b] = await Promise.all([connection.send("A"), connection.send("B")]);
        assert.deepEqual(a, { echo: "A" });
        assert.deepEqual(b, { echo: "B" });
        connection.close();
      },
    );
  });

  test("an event without an id reaches its subscriber", async () => {
    await withServer(
      (message, reply) => {
        reply({
          method: "Target.targetDestroyed",
          params: { targetId: "t1" },
        });
        reply({ id: message.id, result: {} });
      },
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        const seen = new Promise<unknown>((resolve) => {
          connection.on("Target.targetDestroyed", resolve);
        });
        const command = connection.send("Anything");
        assert.deepEqual(await seen, { targetId: "t1" });
        await command;
        connection.close();
      },
    );
  });

  test("a command that never answers rejects on the bounded timeout", async () => {
    await withServer(
      () => undefined,
      async (url) => {
        const connection = await createCdpConnector(50).connect(url);
        await assert.rejects(
          () => connection.send("Browser.getVersion"),
          (error: unknown) =>
            error instanceof BrowserLifecycleError && error.kind === "BROWSER_DISCONNECTED",
        );
        connection.close();
      },
    );
  });

  test("closing the socket rejects every pending command", async () => {
    await withServer(
      () => undefined,
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        const first = connection.send("Browser.getVersion");
        const second = connection.send("Target.getTargets");
        connection.close();
        for (const pending of [first, second]) {
          await assert.rejects(
            () => pending,
            (error: unknown) =>
              error instanceof BrowserLifecycleError && error.kind === "BROWSER_DISCONNECTED",
          );
        }
      },
    );
  });

  test("onClose fires when the socket closes", async () => {
    await withServer(
      () => undefined,
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        const closed = new Promise<void>((resolve) => connection.onClose(resolve));
        connection.close();
        await closed;
      },
    );
  });

  test("late onClose registration receives one asynchronous sticky replay", async () => {
    await withServer(
      () => undefined,
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        connection.close();
        await new Promise<void>((resolve) => connection.onClose(resolve));
        let calls = 0;
        connection.onClose(() => { calls += 1; });
        assert.equal(calls, 0, "late replay is asynchronous");
        await Promise.resolve();
        assert.equal(calls, 1);
      },
    );
  });

  test("unsubscribe before queued sticky replay suppresses the callback", async () => {
    await withServer(
      () => undefined,
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        connection.close();
        await new Promise<void>((resolve) => connection.onClose(resolve));
        let calls = 0;
        const unsubscribe = connection.onClose(() => { calls += 1; });
        unsubscribe();
        unsubscribe();
        await Promise.resolve();
        assert.equal(calls, 0);
      },
    );
  });

  test("duplicate close paths produce one logical close", async () => {
    await withServer(
      () => undefined,
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        let calls = 0;
        const closed = new Promise<void>((resolve) => {
          connection.onClose(() => {
            calls += 1;
            resolve();
          });
        });
        connection.close();
        connection.close();
        await closed;
        await Promise.resolve();
        assert.equal(calls, 1);
      },
    );
  });

  test("the connection exposes no arbitrary-JS or navigation surface", async () => {
    await withServer(
      (message, reply) => reply({ id: message.id, result: {} }),
      async (url) => {
        const connection = await createCdpConnector(5_000).connect(url);
        assert.deepEqual(Object.keys(connection).sort(), ["close", "on", "onClose", "send"]);
        connection.close();
      },
    );
  });
});

describe("BT2 local test server", () => {
  test("binds loopback on an ephemeral port and serves the marker page", async () => {
    const server = await startLocalServer();
    try {
      assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      const ok = await fetch(`${server.origin}/ok`);
      assert.equal(ok.status, 200);
      assert.match(await ok.text(), /BT2_LOOPBACK_OK/);
      const missing = await fetch(`${server.origin}/nope`);
      assert.equal(missing.status, 404);
    } finally { await server.close(); }
  });

  test("waitForRequest resolves a request already in history", async () => {
    const server = await startLocalServer();
    try {
      await fetch(`${server.origin}/ok`);
      const request = await server.waitForRequest(
        (r) => r.method === "GET" && r.url === "/ok", 100,
      );
      assert.deepEqual(request, { method: "GET", url: "/ok" });
      assert.deepEqual(Object.keys(request).sort(), ["method", "url"]);
    } finally { await server.close(); }
  });

  test("waitForRequest resolves a future request and cleans its timer", async () => {
    const server = await startLocalServer();
    try {
      const waiting = server.waitForRequest((r) => r.url === "/ok", 1_000);
      await fetch(`${server.origin}/ok`);
      assert.equal((await waiting).url, "/ok");
    } finally { await server.close(); }
  });

  test("waitForRequest rejects deterministically after its bounded timeout", async () => {
    const server = await startLocalServer();
    try {
      await assert.rejects(
        () => server.waitForRequest((r) => r.url === "/never", 20),
        /Timed out waiting for local request after 20ms/,
      );
    } finally { await server.close(); }
  });
});
