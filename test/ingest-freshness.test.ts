// GET /api/ingest-freshness: Live webhook ingestion compared with the sync
// loop's newest polled GitHub activity. Raw values always; a caller-supplied
// max_lag_seconds turns the response into a 200/503 probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  evaluateIngestFreshness,
  handleIngestFreshnessRequest,
  type IngestFreshnessOptions,
} from "../src/server/ingest-freshness.ts";
import type { AppConfig } from "../src/config.ts";
import type { RepoActivityBoundsRow } from "../src/db/store.ts";

const NOW = "2026-10-15T08:00:00.000Z";
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

function liveStatus(o: {
  lastAccepted?: string | null;
  latestEvent?: string | null;
  accepted?: number;
  rejected?: number;
  started?: string;
}) {
  return {
    schema: "live-status/1",
    observed_at: NOW,
    started_at: o.started ?? minutesAgo(600),
    window_seconds: 3600,
    webhooks: {
      last_accepted_at: o.lastAccepted ?? null,
      last_rejected_at: null,
      last_rejected_status: null,
      last_rejected_status_class: null,
      accepted_in_window: o.accepted ?? 0,
      rejected_in_window: o.rejected ?? 0,
    },
    latest_event_received_at: o.latestEvent ?? null,
  };
}

function bounds(rows: Array<[string, string | null, string | null]>): RepoActivityBoundsRow[] {
  return rows.map(([source_id, project_path, last_activity_at]) => ({
    source_id,
    project_path,
    observed_since: null,
    last_activity_at,
  }));
}

test("lag is relative to polled GitHub activity, so quiet hours stay healthy", () => {
  const quiet = evaluateIngestFreshness({
    live: liveStatus({ latestEvent: minutesAgo(300) }),
    activity: bounds([["github:github.com", "example/repo", minutesAgo(301)]]),
    maxLagSeconds: 1800,
  });
  assert.equal(quiet.lag_seconds, 0);
  assert.equal(quiet.sync_latest_activity_at, minutesAgo(301));
  assert.equal(quiet.live_latest_ingest_at, minutesAgo(300));
  assert.deepEqual(quiet.unhealthy_reasons, []);
  assert.equal(quiet.healthy, true);
});

test("polled activity newer than Live by more than the threshold is unhealthy", () => {
  const stale = evaluateIngestFreshness({
    live: liveStatus({ latestEvent: minutesAgo(120), lastAccepted: minutesAgo(90) }),
    activity: bounds([
      ["github:github.com", "example/repo", minutesAgo(10)],
      ["github:github.com", "example/other", minutesAgo(50)],
    ]),
    maxLagSeconds: 1800,
  });
  // Live's newest ingest is the later of the stored event and the last accepted delivery.
  assert.equal(stale.live_latest_ingest_at, minutesAgo(90));
  assert.equal(stale.lag_seconds, 80 * 60);
  assert.deepEqual(stale.unhealthy_reasons, ["lag_exceeded"]);
  assert.equal(stale.healthy, false);
});

test("non-GitHub sources and repos outside the allowlist do not count as activity", () => {
  const r = evaluateIngestFreshness({
    live: liveStatus({ latestEvent: minutesAgo(120) }),
    activity: bounds([
      ["gitlab:gitlab.example.com", "group/project", minutesAgo(1)],
      ["github:github.com", "example/untracked", minutesAgo(1)],
      ["github:github.com", "example/repo", minutesAgo(121)],
    ]),
    allowlistProjects: ["example/repo"],
    maxLagSeconds: 1800,
  });
  assert.equal(r.sync_latest_activity_at, minutesAgo(121));
  assert.equal(r.lag_seconds, 0);
  assert.equal(r.healthy, true);
});

test("an hour with only rejected deliveries is unhealthy; mixed is not", () => {
  const onlyRejected = evaluateIngestFreshness({
    live: liveStatus({ latestEvent: minutesAgo(5), rejected: 3 }),
    activity: [],
    maxLagSeconds: 1800,
  });
  assert.deepEqual(onlyRejected.unhealthy_reasons, ["only_rejected_deliveries"]);
  const mixed = evaluateIngestFreshness({
    live: liveStatus({ latestEvent: minutesAgo(5), rejected: 3, accepted: 1 }),
    activity: [],
    maxLagSeconds: 1800,
  });
  assert.deepEqual(mixed.unhealthy_reasons, []);
});

test("unreachable Live is unhealthy; no threshold means no verdict", () => {
  const down = evaluateIngestFreshness({ live: null, activity: [], maxLagSeconds: 1800 });
  assert.deepEqual(down.unhealthy_reasons, ["live_unreachable"]);
  const raw = evaluateIngestFreshness({
    live: liveStatus({ latestEvent: minutesAgo(120) }),
    activity: bounds([["github:github.com", "example/repo", minutesAgo(1)]]),
    maxLagSeconds: null,
  });
  assert.equal(raw.lag_seconds, 119 * 60);
  assert.equal(raw.healthy, null);
  assert.deepEqual(raw.unhealthy_reasons, []);
});

test("an empty Live store falls back to the receiver start time", () => {
  const r = evaluateIngestFreshness({
    live: liveStatus({ started: minutesAgo(40) }),
    activity: bounds([["github:github.com", "example/repo", minutesAgo(1)]]),
    maxLagSeconds: 1800,
  });
  assert.equal(r.live_latest_ingest_at, null);
  assert.equal(r.lag_seconds, 39 * 60);
  assert.deepEqual(r.unhealthy_reasons, ["lag_exceeded"]);
});

function listen(server: Server): Promise<string> {
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

async function serve(opts: IngestFreshnessOptions, activity: RepoActivityBoundsRow[]) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleIngestFreshnessRequest(
      { ...opts, activityBounds: async () => activity },
      {} as AppConfig,
      url,
      res,
    );
  });
  const base = await listen(server);
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("the route returns 503 only when a threshold is requested and fails", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(liveStatus({ latestEvent: minutesAgo(120) })), { status: 200 })) as typeof fetch;
  const s = await serve(
    { liveReadBaseUrl: "http://live.invalid:8090", fetchImpl, now: () => NOW },
    bounds([["github:github.com", "example/repo", minutesAgo(1)]]),
  );
  try {
    const raw = await fetch(`${s.base}/api/ingest-freshness`);
    assert.equal(raw.status, 200);
    const body = (await raw.json()) as any;
    assert.equal(body.schema, "ingest-freshness/1");
    assert.equal(body.observed_at, NOW);
    assert.equal(body.lag_seconds, 119 * 60);
    assert.equal(body.max_lag_seconds, null);
    assert.equal(body.live.schema, "live-status/1");

    const probe = await fetch(`${s.base}/api/ingest-freshness?max_lag_seconds=1800`);
    assert.equal(probe.status, 503);
    const verdict = (await probe.json()) as any;
    assert.equal(verdict.healthy, false);
    assert.deepEqual(verdict.unhealthy_reasons, ["lag_exceeded"]);

    const loose = await fetch(`${s.base}/api/ingest-freshness?max_lag_seconds=86400`);
    assert.equal(loose.status, 200);
    assert.equal(((await loose.json()) as any).healthy, true);

    const bad = await fetch(`${s.base}/api/ingest-freshness?max_lag_seconds=-1`);
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});

test("the route reports Live unreachable without throwing", async () => {
  const fetchImpl = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  const s = await serve({ liveReadBaseUrl: "http://live.invalid:8090", fetchImpl, now: () => NOW }, []);
  try {
    const res = await fetch(`${s.base}/api/ingest-freshness?max_lag_seconds=1800`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as any;
    assert.equal(body.live, null);
    assert.deepEqual(body.unhealthy_reasons, ["live_unreachable"]);
  } finally {
    await s.close();
  }
});
