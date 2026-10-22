// Loopback player fixture shared by the real-Chromium test and the benchmark.
//
// Serves synthetic watch pages only: a page whose player lives in a CROSS-SITE
// iframe (127.0.0.1 → 127.0.0.2: for IP hosts the site is the whole address,
// so Chromium isolates the player in its own process),
// one whose embedder denies fullscreen, and one with a top-level player. The
// media is a generated PCM tone, so nothing depends on a codec or the network.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** A mono 8-bit PCM tone: a real, decodable media resource with no codec dependency. */
export function toneWav(seconds = 30, rate = 8000): Buffer {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i += 1) buffer[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return buffer;
}

export interface PlayerFixture {
  readonly port: number;
  readonly watchBase: string;
  readonly origins: readonly string[];
  /** What the player page's own, gesture-less autoplay attempt reported. */
  readonly autoplayReports: string[];
  close(): Promise<void>;
}

export async function startPlayerFixture(): Promise<PlayerFixture> {
  const wav = toneWav();
  const autoplayReports: string[] = [];
  const sockets = new Set<Socket>();
  let port = 0;
  let playerPort = 0;
  const page = (body: string) =>
    `<!doctype html><meta charset="utf-8"><title>fixture</title><body style="margin:0">${body}</body>`;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    const html = (body: string) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(page(body)); };
    if (url.pathname.startsWith("/watch/GFRAME")) {
      return html(`<iframe src="http://127.0.0.2:${playerPort}/player" allow="fullscreen" style="width:640px;height:360px;border:0"></iframe>`);
    }
    if (url.pathname.startsWith("/watch/GNOFS")) {
      return html(`<iframe src="http://127.0.0.2:${playerPort}/player" allow="fullscreen 'none'" style="width:640px;height:360px;border:0"></iframe>`);
    }
    if (url.pathname.startsWith("/watch/GTOP")) {
      return html(`<div><video src="/tone.wav" preload="auto" style="width:640px;height:360px"></video></div>`);
    }
    if (url.pathname === "/player") {
      // The page's OWN autoplay attempt: no user gesture, so a strict policy refuses it.
      return html(`<video src="/tone.wav" preload="auto" style="width:640px;height:360px"></video>
        <script>
          const v = document.querySelector("video");
          v.addEventListener("loadedmetadata", () => {
            v.play().then(() => fetch("/report?autoplay=started"), (e) => fetch("/report?autoplay=" + e.name));
          });
        </script>`);
    }
    if (url.pathname === "/tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Accept-Ranges": "none" });
      return res.end(wav);
    }
    if (url.pathname === "/report") {
      autoplayReports.push(url.searchParams.get("autoplay") ?? "");
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  };
  const track = (server: Server) =>
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const ipv4 = track(createServer(handler));
  await new Promise<void>((resolve) => ipv4.listen(0, "127.0.0.1", resolve));
  port = (ipv4.address() as AddressInfo).port;
  // The player frame is served from a second loopback address: a second site.
  // Linux routes all of 127.0.0.0/8 to loopback, so nothing leaves the host.
  const named = track(createServer(handler));
  await new Promise<void>((resolve, reject) => {
    named.once("error", reject);
    named.listen(0, "127.0.0.2", resolve);
  });
  playerPort = (named.address() as AddressInfo).port;
  return {
    port,
    watchBase: `http://127.0.0.1:${port}/watch/`,
    origins: [`http://127.0.0.1:${port}`, `http://127.0.0.2:${playerPort}`],
    autoplayReports,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => ipv4.close(() => resolve()));
      await new Promise<void>((resolve) => named.close(() => resolve()));
    },
  };
}
