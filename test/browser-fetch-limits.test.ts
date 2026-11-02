import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CRUNCHYROLL_FETCH_FUNCTION } from "../src/transport/browser-session-manager.js";

async function execute(response: Response, maxBytes: number) {
  const call = runInNewContext(`(${CRUNCHYROLL_FETCH_FUNCTION})`, {
    fetch: async () => response,
    TextDecoder,
  });
  return call("https://www.crunchyroll.com/fixture", "GET", "synthetic", maxBytes);
}

test("browser fetch caps UTF-8 bytes rather than UTF-16 characters", async () => {
  const result = await execute(new Response("😀😀"), 4);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.body, "utf8") <= 4);
});

test("oversized streamed responses stop reading and cancel the source", async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(8).fill(120));
      if (pulls === 100) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await execute(new Response(stream), 16);
  assert.equal(result.truncated, true);
  assert.equal(pulls, 3, "only read through the first chunk exceeding the budget");
  assert.equal(cancelled, true);
  assert.equal(result.body, "x".repeat(16));
});

test("streaming preserves Unicode split across chunks and exact-size responses", async () => {
  const encoded = new TextEncoder().encode("a😀é");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const result = await execute(new Response(stream), encoded.length);
  assert.equal(result.body, "a😀é");
  assert.equal(result.truncated, false);
});

test("bodyless responses retain their status without manufacturing a body", async () => {
  const result = await execute(new Response(null, { status: 204 }), 16);
  assert.equal(result.status, 204);
  assert.equal(result.body, "");
  assert.equal(result.truncated, false);
});
