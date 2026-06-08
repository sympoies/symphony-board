import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveActorKey } from "../src/model/actor.ts";

const SRC = "github:github.com";

test("deriveActorKey prefers a provider username over email and name", () => {
  const key = deriveActorKey({ sourceId: SRC, username: "Alice", email: "alice@example.com", name: "Alice Wong" });
  assert.equal(key, "provider-user:github:github.com:alice");
});

test("deriveActorKey lowercases usernames so case drift does not split an identity", () => {
  assert.equal(
    deriveActorKey({ sourceId: SRC, username: "Alice" }),
    deriveActorKey({ sourceId: SRC, username: "alice" }),
  );
});

test("deriveActorKey scopes provider-user keys per source", () => {
  assert.notEqual(
    deriveActorKey({ sourceId: "github:github.com", username: "alice" }),
    deriveActorKey({ sourceId: "gitlab:gitlab.com", username: "alice" }),
  );
});

test("deriveActorKey hashes the email and never exposes the raw address", () => {
  const key = deriveActorKey({ sourceId: SRC, email: "alice@example.com", name: "Alice Wong" });
  assert.match(key ?? "", /^email:[0-9a-f]{16}$/);
  assert.ok(!key?.includes("alice@example.com"), "raw email must not appear in the key");
});

test("deriveActorKey collapses display-name variants of one address (case-insensitive)", () => {
  const a = deriveActorKey({ sourceId: SRC, email: "Alice@Example.com", name: "Alice" });
  const b = deriveActorKey({ sourceId: SRC, email: "alice@example.com", name: "Alice Wong" });
  assert.equal(a, b, "same address, different display names -> one identity");
});

test("deriveActorKey separates different emails even with the same display name", () => {
  assert.notEqual(
    deriveActorKey({ sourceId: SRC, email: "alice@example.com", name: "Pat" }),
    deriveActorKey({ sourceId: SRC, email: "bob@example.com", name: "Pat" }),
  );
});

test("deriveActorKey falls back to a normalized name, then to null", () => {
  assert.equal(deriveActorKey({ sourceId: SRC, name: "  Alice   Wong " }), "name:alice wong");
  assert.equal(deriveActorKey({ sourceId: SRC }), null);
  assert.equal(deriveActorKey({ sourceId: SRC, username: "  ", email: "", name: null }), null);
});
