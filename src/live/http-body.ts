// Raw request-body reader for the webhook receiver. A Buffer variant of the
// string `readBody` in sync-daemon: it keeps the EXACT bytes (HMAC must run over
// them before any JSON parse) and adds an idle read timeout, which the string
// reader lacks — untrusted webhook traffic must not be able to hold a socket
// open indefinitely. Soft size cap drops buffered chunks; a runaway stream is
// cut at 4x the cap. Callers map BodyTooLargeError -> 413, BodyTimeoutError ->
// 408.
import type { IncomingMessage } from "node:http";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_BODY_TIMEOUT_MS = 10_000;

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export class BodyTimeoutError extends Error {
  constructor(ms: number) {
    super(`request body read timed out after ${ms} ms`);
    this.name = "BodyTimeoutError";
  }
}

export function readBodyBytes(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
  timeoutMs: number = DEFAULT_BODY_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks: Buffer[] = [];

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      req.destroy();
      finish(() => reject(new BodyTimeoutError(timeoutMs)));
    }, timeoutMs);
    timer.unref();

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) {
        // Keep draining (discarded) so a clean 413 reaches a live socket; cut a
        // runaway stream at 4x the cap.
        if (size > maxBytes * 4) req.destroy();
        return;
      }
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) finish(() => reject(new BodyTooLargeError(maxBytes)));
      else finish(() => resolve(Buffer.concat(chunks)));
    });
    req.on("error", (err) => finish(() => reject(err)));
  });
}
