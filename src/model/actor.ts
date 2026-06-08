// Canonical actor identity (LAYER 2 helper). One place that turns the raw
// per-record actor signals a source can see — a provider username/login, a
// commit author email, a raw display name — into a stable identity KEY used to
// group one human's work across records. It is pure and deterministic, so it is
// replayable against stored raw exactly like `normalize`.
//
// Precedence (documented in docs/DESIGN.md "Actor identity"):
//   1. provider username   -> `provider-user:<source_id>:<username>`
//   2. commit author email -> `email:<hash>`
//   3. raw display name    -> `name:<normalized>`
//
// Username wins over email on purpose. A person's issues, PRs/MRs, and pushes
// only ever carry a provider username, and an account-linked commit carries one
// too — keying those by username groups them under one identity. Email is the
// fallback for commit records with no linked account (anonymous git authorship),
// where it collapses the many commit author-NAME variants for one address into a
// single actor. Raw name is the last resort.
//
// The email is HASHED, never stored or exposed verbatim. The hash is enough to
// group records sharing an address; the raw address never enters the canonical
// store or the contract. See docs/CONTRACT.md "Repo Metrics".

import { createHash } from "node:crypto";

export interface ActorSignals {
  // The owning source's id, so a `provider-user` key is unique per source.
  sourceId: string;
  // Provider login/username, when the record carries one.
  username?: string | null;
  // Commit author/committer email, when the record carries one.
  email?: string | null;
  // Raw display name (git author name, provider display name).
  name?: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Lowercase + collapse internal whitespace so "Alice  W" and "alice w" share a
// name-fallback key.
function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

// 64-bit (16 hex) SHA-256 prefix. We only need a stable, low-collision token
// that does not reveal the address — not a cryptographic commitment — so a
// prefix is enough and keeps the contract compact.
function hashEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

// Derive the stable actor identity key from the signals one record exposes, or
// null when the record names no actor at all.
export function deriveActorKey(signals: ActorSignals): string | null {
  const username = clean(signals.username);
  // Usernames are case-insensitive at every provider we model; lowercasing keeps
  // a "Alice" login from splitting from an "alice" login.
  if (username) return `provider-user:${signals.sourceId}:${username.toLowerCase()}`;
  const email = clean(signals.email);
  if (email) return `email:${hashEmail(email.toLowerCase())}`;
  const name = clean(signals.name);
  if (name) return `name:${normalizeName(name)}`;
  return null;
}
