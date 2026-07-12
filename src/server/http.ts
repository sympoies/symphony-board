// Shared HTTP response helpers for the read-only API surfaces (the standalone
// app-server and the Docker `api` sidecar). Kept dependency-free and tiny.

import type { ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";

// Accept gzip only when its quality value is positive. Browsers normally send
// a bare token, but API clients may explicitly refuse it with `gzip;q=0`; in
// that case identity is the compatible response.
export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : acceptEncoding;
  if (!header) return false;
  return header.split(",").some((entry) => {
    const [coding, ...parameters] = entry.split(";").map((part) => part.trim());
    if (coding?.toLowerCase() !== "gzip") return false;
    const quality = parameters.find((parameter) => /^q\s*=/i.test(parameter));
    if (!quality) return true;
    const value = Number(quality.slice(quality.indexOf("=") + 1).trim());
    return Number.isFinite(value) && value > 0 && value <= 1;
  });
}

// Write a JSON body, gzipping on the fly when the client accepts it. Used for
// the dynamic /api/range envelope (6mo/1yr selections are large), bringing the
// standalone app-server to parity with the nginx-fronted compose path, which
// already gzips the same route. `Vary: Accept-Encoding` keeps shared caches
// honest; the body is `no-store` (recomputed per request), so there is no cache
// to key — unlike the mtime-cached /contract.json buffer in app-server.ts.
//
// `X-Encoded-Length` advertises the exact compressed wire size. A client that
// transparently decodes the gzip body (browser, Tauri native fetch) loses
// Content-Length and has no Resource Timing for this route, so without this
// header the Diagnostics TRANSFER / COMPRESSION readouts degrade to "unknown"
// for any windowed (/api/range) board scope. A custom header survives decoding
// (unlike Content-Length), so the client reads the encoded size directly. The
// static /contract.json keeps its own .gz-probe path and never reaches here.
export function sendJsonMaybeGzip(
  res: ServerResponse,
  status: number,
  body: unknown,
  acceptEncoding: string | string[] | undefined,
): void {
  const text = JSON.stringify(body) + "\n";
  if (acceptsGzip(acceptEncoding)) {
    const gz = gzipSync(text);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Encoding": "gzip",
      "X-Encoded-Length": String(gz.length),
      Vary: "Accept-Encoding",
    });
    res.end(gz);
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Encoded-Length": String(Buffer.byteLength(text)),
    Vary: "Accept-Encoding",
  });
  res.end(text);
}
