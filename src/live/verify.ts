// GitHub webhook signature verification. Computes the `sha256=` HMAC-SHA256 hex
// over the RAW request bytes and compares constant-time. No permissive fallback:
// a missing/malformed/length-mismatched/wrong-digest signature rejects. The
// legacy `X-Hub-Signature` (SHA-1) is never the basis of validation. Supports a
// list of secrets (current + previous) for zero-downtime rotation. Pure: no IO.
import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "bad_format" | "mismatch" };

function githubDigest(rawBody: Buffer, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | string[] | undefined,
  secrets: readonly string[],
): VerifyResult {
  const header = Array.isArray(signatureHeader)
    ? signatureHeader[0]
    : signatureHeader;
  if (typeof header !== "string" || header.length === 0) {
    return { ok: false, reason: "missing_signature" };
  }
  // Only the SHA-256 scheme is accepted; legacy sha1= is rejected outright.
  if (!header.startsWith("sha256=")) return { ok: false, reason: "bad_format" };

  const candidates = secrets.filter((s) => s.length > 0);
  // A misconfigured receiver with no secret must reject, never accept.
  if (candidates.length === 0) return { ok: false, reason: "bad_format" };

  const provided = Buffer.from(header, "utf8");
  let matched = false;
  for (const secret of candidates) {
    const expected = Buffer.from(githubDigest(rawBody, secret), "utf8");
    // Length-check first (timingSafeEqual requires equal length), then a
    // constant-time compare. OR across secrets without an early return so the
    // loop does not leak which secret matched via timing.
    if (
      expected.length === provided.length &&
      timingSafeEqual(expected, provided)
    ) {
      matched = true;
    }
  }
  return matched ? { ok: true } : { ok: false, reason: "mismatch" };
}
