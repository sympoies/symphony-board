import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import { sendJsonMaybeGzip } from "../src/server/http.ts";

// A minimal ServerResponse double capturing the status, headers, and body the
// helper writes — no socket bound (mirrors test/live-broadcaster + test/stats).
function fakeRes(): { res: ServerResponse; out: { status: number; headers: Record<string, string>; body: Buffer | string | null } } {
  const out = { status: 0, headers: {} as Record<string, string>, body: null as Buffer | string | null };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status;
      out.headers = headers ?? {};
      return this;
    },
    end(body?: Buffer | string) {
      out.body = body ?? null;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

// The dynamic /api/range payload is gzipped on the wire, but a client that
// decodes it (browser, Tauri native fetch) loses Content-Length and has no
// Resource Timing, so Diagnostics could not show TRANSFER / COMPRESSION. The
// server therefore advertises the exact compressed size via X-Encoded-Length so
// the client can read it directly.
test("sendJsonMaybeGzip advertises the gzip byte length via X-Encoded-Length", () => {
  const { res, out } = fakeRes();
  const body = { hello: "world", items: [1, 2, 3, 4, 5] };
  sendJsonMaybeGzip(res, 200, body, "gzip");

  const text = JSON.stringify(body) + "\n";
  const gz = gzipSync(text);
  assert.equal(out.headers["Content-Encoding"], "gzip");
  assert.equal(out.headers["X-Encoded-Length"], String(gz.length));
  assert.equal((out.body as Buffer).length, gz.length, "body is the gzip buffer");
});

test("sendJsonMaybeGzip reports the identity byte length when the client does not accept gzip", () => {
  const { res, out } = fakeRes();
  const body = { hello: "world" };
  sendJsonMaybeGzip(res, 200, body, undefined);

  const text = JSON.stringify(body) + "\n";
  assert.equal(out.headers["Content-Encoding"], undefined, "no gzip when not accepted");
  assert.equal(out.headers["X-Encoded-Length"], String(Buffer.byteLength(text)));
});
