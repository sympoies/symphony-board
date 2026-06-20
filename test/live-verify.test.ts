// Sprint 2 acceptance for the GitHub raw-body HMAC verifier. Pure unit tests:
// constant-time sha256= verification over the RAW bytes, no permissive
// fallback, legacy sha1 rejected, non-UTF-8 safe, dual-secret rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyGithubSignature } from "../src/live/verify.ts";

const SECRET = "topsecret";
const PREV = "oldsecret";

function sign(body: Buffer | string, secret: string): string {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return "sha256=" + createHmac("sha256", secret).update(buf).digest("hex");
}

test("a valid signature over the raw body verifies", () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.deepEqual(verifyGithubSignature(body, sign(body, SECRET), [SECRET]), {
    ok: true,
  });
});

test("a one-byte payload mutation flips the verdict to reject", () => {
  const body = Buffer.from('{"hello":"world"}');
  const sig = sign(body, SECRET);
  const tampered = Buffer.from('{"hello":"workd"}');
  assert.deepEqual(verifyGithubSignature(tampered, sig, [SECRET]), {
    ok: false,
    reason: "mismatch",
  });
});

test("a wrong secret rejects", () => {
  const body = Buffer.from("payload");
  assert.deepEqual(verifyGithubSignature(body, sign(body, "different"), [SECRET]), {
    ok: false,
    reason: "mismatch",
  });
});

test("a missing or empty signature header rejects as missing_signature", () => {
  const body = Buffer.from("payload");
  assert.deepEqual(verifyGithubSignature(body, undefined, [SECRET]), {
    ok: false,
    reason: "missing_signature",
  });
  assert.deepEqual(verifyGithubSignature(body, "", [SECRET]), {
    ok: false,
    reason: "missing_signature",
  });
});

test("a legacy SHA-1 signature is rejected; only sha256= is accepted", () => {
  const body = Buffer.from("payload");
  const sha1 = "sha1=" + createHmac("sha1", SECRET).update(body).digest("hex");
  assert.deepEqual(verifyGithubSignature(body, sha1, [SECRET]), {
    ok: false,
    reason: "bad_format",
  });
});

test("verification uses raw bytes; a non-UTF-8 byte does not break it", () => {
  const body = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
  assert.deepEqual(verifyGithubSignature(body, sign(body, SECRET), [SECRET]), {
    ok: true,
  });
});

test("dual-secret: a delivery signed with the previous secret still verifies", () => {
  const body = Buffer.from("rotation");
  assert.deepEqual(
    verifyGithubSignature(body, sign(body, PREV), [SECRET, PREV]),
    { ok: true },
  );
  assert.deepEqual(
    verifyGithubSignature(body, sign(body, SECRET), [SECRET, PREV]),
    { ok: true },
  );
});

test("no configured secret is a hard reject, never an accept", () => {
  const body = Buffer.from("x");
  assert.deepEqual(verifyGithubSignature(body, sign(body, SECRET), []), {
    ok: false,
    reason: "bad_format",
  });
});

test("an array-valued signature header uses the first value", () => {
  const body = Buffer.from("x");
  assert.deepEqual(verifyGithubSignature(body, [sign(body, SECRET)], [SECRET]), {
    ok: true,
  });
});
