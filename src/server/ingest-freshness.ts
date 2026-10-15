// GET /api/ingest-freshness: whether the Live receiver is still ingesting
// webhooks, judged against the sync loop's newest polled GitHub activity. The
// sync loop keeps polling when webhooks fail, so its activity is an
// independent "something happened" signal: lag grows only while there is
// polled activity Live did not ingest, and quiet hours stay healthy.
//
// Operational surface, not part of the versioned contract. It always returns
// the raw values. Only when the caller passes `max_lag_seconds` does it also
// return a verdict and answer 503 when unhealthy, so a status-code-only
// monitor can use it as a probe while the threshold stays with the caller.
//
// The route is not under /api/live*: the web edge sends that prefix to the
// Live receiver, while this one needs the canonical store (api process only).

import type { ServerResponse } from "node:http";
import type { AppConfig } from "../config.ts";
import type { RepoActivityBoundsRow } from "../db/store.ts";
import { openConfiguredStoreReadOnly } from "../db/factory.ts";
import { sendJson } from "./http.ts";
import { GITHUB_SOURCE_ID } from "../live/github.ts";

const MAX_LAG_SECONDS_LIMIT = 7 * 24 * 3600;

export interface LiveStatusBody {
  schema: string;
  started_at?: string | null;
  webhooks?: {
    last_accepted_at?: string | null;
    accepted_in_window?: number;
    rejected_in_window?: number;
  };
  latest_event_received_at?: string | null;
  // Source ids the receiver's webhook routes are wired to.
  sources?: string[];
}

export type IngestUnhealthyReason = "live_unreachable" | "lag_exceeded" | "only_rejected_deliveries";

export interface IngestFreshnessEvaluation {
  sync_latest_activity_at: string | null;
  live_latest_ingest_at: string | null;
  lag_seconds: number | null;
  max_lag_seconds: number | null;
  healthy: boolean | null;
  unhealthy_reasons: IngestUnhealthyReason[];
}

export interface IngestFreshnessOptions {
  liveReadBaseUrl?: string | null;
  allowlistProjects?: string[];
  fetchImpl?: typeof fetch;
  liveProbeTimeoutMs?: number;
  now?: () => string;
  // Test seam; defaults to the configured store's cached per-repo bounds.
  activityBounds?: (cfg: AppConfig) => Promise<RepoActivityBoundsRow[]>;
}

function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function latest(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    const ms = instant(v);
    if (ms !== null && ms > bestMs) {
      best = v!;
      bestMs = ms;
    }
  }
  return best;
}

export function evaluateIngestFreshness(input: {
  live: LiveStatusBody | null;
  activity: RepoActivityBoundsRow[];
  allowlistProjects?: string[];
  maxLagSeconds: number | null;
}): IngestFreshnessEvaluation {
  const allow = new Set((input.allowlistProjects ?? []).filter(Boolean));
  // Compare only activity Live can ingest: the sources its routes are wired
  // to (github.com when an older receiver does not declare them).
  const sources = new Set(
    Array.isArray(input.live?.sources) && input.live.sources.length > 0 ? input.live.sources : [GITHUB_SOURCE_ID],
  );
  const syncLatest = latest(
    input.activity
      .filter((r) => sources.has(r.source_id))
      .filter((r) => allow.size === 0 || (r.project_path !== null && allow.has(r.project_path)))
      .map((r) => r.last_activity_at),
  );
  const liveLatest = input.live
    ? latest([input.live.latest_event_received_at, input.live.webhooks?.last_accepted_at])
    : null;
  // An empty Live store has seen nothing since it started; measure from there.
  const baseline = instant(liveLatest) ?? instant(input.live?.started_at);
  const syncMs = instant(syncLatest);
  const lagSeconds =
    input.live && syncMs !== null && baseline !== null
      ? Math.max(0, Math.floor((syncMs - baseline) / 1000))
      : input.live
        ? 0
        : null;

  const reasons: IngestUnhealthyReason[] = [];
  if (input.maxLagSeconds !== null) {
    if (!input.live) reasons.push("live_unreachable");
    else {
      if (lagSeconds !== null && lagSeconds > input.maxLagSeconds) {
        reasons.push("lag_exceeded");
        // Rejections are counted before signature verification, so anyone can
        // fabricate them. They only explain an exceeded lag, never decide it.
        const w = input.live.webhooks ?? {};
        if ((w.rejected_in_window ?? 0) > 0 && (w.accepted_in_window ?? 0) === 0) {
          reasons.push("only_rejected_deliveries");
        }
      }
    }
  }
  return {
    sync_latest_activity_at: syncLatest,
    live_latest_ingest_at: liveLatest,
    lag_seconds: lagSeconds,
    max_lag_seconds: input.maxLagSeconds,
    healthy: input.maxLagSeconds === null ? null : reasons.length === 0,
    unhealthy_reasons: reasons,
  };
}

async function fetchLiveStatus(opts: IngestFreshnessOptions): Promise<LiveStatusBody | null> {
  const baseUrl = opts.liveReadBaseUrl?.trim();
  if (!baseUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, opts.liveProbeTimeoutMs ?? 3000));
  try {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const res = await (opts.fetchImpl ?? fetch)(new URL("api/live-status", base).toString(), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") return null;
    const status = body as LiveStatusBody;
    return typeof status.schema === "string" && status.schema.startsWith("live-status/1") ? status : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function storeActivityBounds(cfg: AppConfig): Promise<RepoActivityBoundsRow[]> {
  const store = await openConfiguredStoreReadOnly(cfg);
  try {
    return await store.listRepoActivityBounds();
  } finally {
    await store.close();
  }
}

export async function handleIngestFreshnessRequest(
  opts: IngestFreshnessOptions,
  cfg: AppConfig,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const raw = url.searchParams.get("max_lag_seconds");
  let maxLagSeconds: number | null = null;
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_LAG_SECONDS_LIMIT) {
      sendJson(res, 400, {
        error: "invalid_max_lag_seconds",
        message: `max_lag_seconds must be an integer from 1 to ${MAX_LAG_SECONDS_LIMIT}`,
      });
      return;
    }
    maxLagSeconds = Number(raw);
  }
  const now = opts.now?.() ?? new Date().toISOString();
  let activity: RepoActivityBoundsRow[];
  try {
    activity = await (opts.activityBounds ?? storeActivityBounds)(cfg);
  } catch (error) {
    sendJson(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  const live = await fetchLiveStatus(opts);
  const evaluation = evaluateIngestFreshness({
    live,
    activity,
    allowlistProjects: opts.allowlistProjects,
    maxLagSeconds,
  });
  sendJson(res, evaluation.healthy === false ? 503 : 200, {
    schema: "ingest-freshness/1",
    observed_at: now,
    ...evaluation,
    live,
  });
}
