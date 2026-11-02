import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserLifecycleError } from "../src/transport/browser-lifecycle-error.js";
import { wireFakes } from "./_fake-browser-seams.js";

test("100 API channels release their context listeners on the retained CDP connection", async () => {
  const h = wireFakes();
  try {
    await h.manager.start();
    const connection = h.connector.connections[0];
    for (let i = 0; i < 100; i++) {
      const channel = await h.manager.openApiExecutionChannel();
      assert.equal(connection.listenerCount("Runtime.executionContextCreated"), 0);
      await channel.close();
    }
    assert.equal(h.connector.connections.length, 1);
  } finally {
    await h.manager.stop();
    h.cleanup();
  }
});

test("response interception releases subscribers on every close", async () => {
  const h = wireFakes();
  try {
    await h.manager.start();
    const connection = h.connector.connections[0];
    for (let i = 0; i < 100; i++) {
      const interception = await h.manager.openResponseInterception("https://www.crunchyroll.com/auth/*");
      assert.equal(connection.listenerCount("Fetch.requestPaused"), 1);
      await interception.close();
      await interception.close();
      assert.equal(connection.listenerCount("Fetch.requestPaused"), 0);
    }
  } finally {
    await h.manager.stop();
    h.cleanup();
  }
});

for (const method of ["Runtime.enable", "Fetch.enable"]) {
  test(`${method} failure releases its subscriber and detaches its target`, async () => {
    const h = wireFakes();
    try {
      await h.manager.start();
      const connection = h.connector.connections[0];
      const original = connection.send.bind(connection);
      connection.send = async (...args) => {
        if (args[0] === method) throw new BrowserLifecycleError("BROWSER_DISCONNECTED");
        return original(...args);
      };
      await assert.rejects(method === "Runtime.enable"
        ? h.manager.openApiExecutionChannel()
        : h.manager.openResponseInterception("https://www.crunchyroll.com/auth/*"),
      BrowserLifecycleError);
      assert.equal(connection.listenerCount(method === "Runtime.enable"
        ? "Runtime.executionContextCreated" : "Fetch.requestPaused"), 0);
      assert.equal(connection.calls.filter((call) => call.method === "Target.detachFromTarget").length, 1);
    } finally {
      await h.manager.stop();
      h.cleanup();
    }
  });
}

test("alternate provider ports are rejected before any page request is dispatched", async () => {
  const h = wireFakes();
  try {
    await h.manager.start();
    const channel = await h.manager.openApiExecutionChannel();
    for (const url of [
      "https://www.crunchyroll.com:8443/fixture",
      "https://www.crunchyroll.com.evil.invalid/fixture",
      "https://user:password@www.crunchyroll.com/fixture",
    ]) {
      await assert.rejects(channel.request({
        url, method: "GET", authorization: "synthetic", deadlineMs: 100, maxBytes: 1024,
      }), (error: unknown) => error instanceof BrowserLifecycleError &&
        error.dispatchState === "PRE_DISPATCH");
    }
    assert.equal(h.connector.connections[0].calls.filter(
      (call) => call.method === "Runtime.callFunctionOn").length, 0);
    const response = await channel.request({
      url: "https://www.crunchyroll.com:443/fixture", method: "GET",
      authorization: "synthetic", deadlineMs: 100, maxBytes: 1024,
    });
    assert.equal(response.status, 204, "explicit default port denotes the approved origin");
    await channel.close();
  } finally {
    await h.manager.stop();
    h.cleanup();
  }
});
