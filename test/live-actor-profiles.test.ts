import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGithubActorProfileObserver,
  fetchGithubActorProfile,
} from "../src/live/actor-profiles.ts";
import type { LiveActorProfileInput, LiveStore } from "../src/live/store.ts";
import type { LiveEvent } from "../src/live/types.ts";

test("fetchGithubActorProfile maps the GitHub user shape without requiring a token", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(
      JSON.stringify({
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
        html_url: "https://github.com/octocat",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const profile = await fetchGithubActorProfile("octocat", {
    fetchFn,
    now: () => new Date("2026-06-21T00:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/users/octocat");
  assert.equal(calls[0]?.headers.has("authorization"), false);
  assert.equal(profile.login, "octocat");
  assert.equal(profile.display_name, "The Octocat");
  assert.equal(profile.avatar_url, "https://avatars.githubusercontent.com/u/583231?v=4");
  assert.equal(profile.profile_url, "https://github.com/octocat");
  assert.equal(profile.last_error, null);
  assert.match(profile.expires_at, /^2026-06-28T/);
});

test("fetchGithubActorProfile records a short-lived negative cache result on HTTP failure", async () => {
  const profile = await fetchGithubActorProfile("missing-user", {
    fetchFn: (async () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    now: () => new Date("2026-06-21T00:00:00.000Z"),
  });

  assert.equal(profile.login, "missing-user");
  assert.equal(profile.avatar_url, null);
  assert.equal(profile.profile_url, null);
  assert.match(profile.last_error ?? "", /HTTP 404/);
  assert.match(profile.expires_at, /^2026-06-21T00:15:/);
});

test("closed actor profile observer drops in-flight lookup results", async () => {
  let resolveFetch!: (response: Response) => void;
  const writes: LiveActorProfileInput[] = [];
  const store = {
    upsertActorProfile(profile: LiveActorProfileInput) {
      writes.push(profile);
    },
    hasFreshActorProfile() {
      return false;
    },
  } as Pick<LiveStore, "upsertActorProfile" | "hasFreshActorProfile"> as LiveStore;
  const fetchFn = (async () =>
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as typeof fetch;
  const observer = createGithubActorProfileObserver(store, { fetchFn });

  observer.observe({
    schema: "live-event/1",
    seq: 1,
    source_id: "github:github.com",
    event_id: "delivery",
    provider: "github",
    received_at: "2026-06-21T00:00:00.000Z",
    occurred_at: null,
    event_type: "issues",
    action: "opened",
    category: "issue",
    actor: {
      login: "octocat",
      display_name: null,
      avatar_url: null,
      profile_url: null,
    },
    target: null,
    title: null,
    body: null,
    url: null,
    review_state: null,
    delivery: {
      delivery_id: "delivery",
      event_header: "issues",
      signature_status: "verified",
    },
    provider_details: null,
    raw: null,
  } satisfies LiveEvent);
  observer.close?.();
  resolveFetch(
    new Response(JSON.stringify({
      login: "octocat",
      avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
      html_url: "https://github.com/octocat",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(writes.length, 0);
});
