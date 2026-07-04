import type { ServerResponse } from "node:http";

export type LiveCapabilityStatus = "unsupported" | "unreachable" | "empty" | "ready";

export interface CapabilitiesWebhookSetup {
  provider: string;
  public_url?: string;
  events?: string[];
}

export interface ServerCapabilities {
  schema: "symphony-board-capabilities/1";
  generated_at: string;
  server: {
    mode: string;
    contract: boolean;
    range: boolean;
    stats: boolean;
    activity_daily: boolean;
    review_candidates: boolean;
    actionable: boolean;
  };
  live: {
    reads: boolean;
    snapshot: boolean;
    stream: boolean;
    transport: string[];
    provider_webhooks: string[];
    status: LiveCapabilityStatus;
    latest_seq: number | null;
    latest_event_at: string | null;
    snapshot_generated_at: string | null;
    webhook_setup?: CapabilitiesWebhookSetup;
    allowlist?: {
      enabled: boolean;
      count: number;
    };
  };
}

export interface CapabilitiesOptions {
  serverMode: string;
  liveReadBaseUrl?: string | null;
  providerWebhooks?: string[];
  allowlistProjects?: string[];
  webhookSetup?: {
    provider?: string | null;
    publicUrl?: string | null;
    events?: string[];
  } | null;
  now?: () => string;
  fetchImpl?: typeof fetch;
  liveProbeTimeoutMs?: number;
}

interface LiveSnapshotProbe {
  schema?: string;
  events?: unknown[];
  max_seq?: unknown;
  generated_at?: unknown;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body) + "\n");
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function liveSnapshotUrl(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("api/live-snapshot?limit=1", base).toString();
}

function eventInstant(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const v = event as Record<string, unknown>;
  for (const key of ["received_at", "occurred_at"]) {
    const value = v[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function isLiveSnapshotProbe(value: unknown): value is LiveSnapshotProbe & { events: unknown[]; max_seq: number } {
  if (!value || typeof value !== "object") return false;
  const body = value as LiveSnapshotProbe;
  return (
    typeof body.schema === "string" &&
    body.schema.startsWith("live-snapshot/1") &&
    Array.isArray(body.events) &&
    typeof body.max_seq === "number" &&
    Number.isFinite(body.max_seq)
  );
}

async function probeLiveSnapshot(opts: Pick<CapabilitiesOptions, "liveReadBaseUrl" | "fetchImpl" | "liveProbeTimeoutMs">): Promise<{
  status: Exclude<LiveCapabilityStatus, "unsupported">;
  latestSeq: number | null;
  latestEventAt: string | null;
  generatedAt: string | null;
}> {
  const baseUrl = nonEmpty(opts.liveReadBaseUrl);
  if (!baseUrl) {
    return { status: "unreachable", latestSeq: null, latestEventAt: null, generatedAt: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, opts.liveProbeTimeoutMs ?? 3000));
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(liveSnapshotUrl(baseUrl), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return { status: "unreachable", latestSeq: null, latestEventAt: null, generatedAt: null };
    const body = (await res.json()) as unknown;
    if (!isLiveSnapshotProbe(body)) {
      return { status: "unreachable", latestSeq: null, latestEventAt: null, generatedAt: null };
    }
    const latestEventAt = eventInstant(body.events[0] ?? null);
    const generatedAt = typeof body.generated_at === "string" ? body.generated_at : null;
    return {
      status: body.max_seq > 0 ? "ready" : "empty",
      latestSeq: body.max_seq,
      latestEventAt,
      generatedAt,
    };
  } catch {
    return { status: "unreachable", latestSeq: null, latestEventAt: null, generatedAt: null };
  } finally {
    clearTimeout(timeout);
  }
}

function webhookSetup(opts: CapabilitiesOptions): CapabilitiesWebhookSetup | undefined {
  const setup = opts.webhookSetup ?? null;
  const publicUrl = nonEmpty(setup?.publicUrl);
  const explicitProvider = nonEmpty(setup?.provider);
  const events = (setup?.events ?? []).filter(Boolean);
  if (!publicUrl && !explicitProvider && events.length === 0) return undefined;
  const provider = explicitProvider ?? opts.providerWebhooks?.[0] ?? "unknown";
  return {
    provider,
    ...(publicUrl ? { public_url: publicUrl } : {}),
    ...(events.length > 0 ? { events } : {}),
  };
}

export function capabilitiesOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  defaults: { serverMode: string },
): CapabilitiesOptions {
  return {
    serverMode: env.SYMPHONY_SERVER_MODE?.trim() || defaults.serverMode,
    liveReadBaseUrl: nonEmpty(env.LIVE_READ_BASE_URL),
    providerWebhooks: csv(env.LIVE_PROVIDER_WEBHOOKS),
    allowlistProjects: csv(env.LIVE_PROJECT_ALLOWLIST),
    webhookSetup: {
      provider: nonEmpty(env.LIVE_WEBHOOK_PROVIDER),
      publicUrl: nonEmpty(env.LIVE_WEBHOOK_PUBLIC_URL),
      events: csv(env.LIVE_WEBHOOK_EVENTS),
    },
  };
}

export async function buildCapabilities(opts: CapabilitiesOptions): Promise<ServerCapabilities> {
  const liveReadBaseUrl = nonEmpty(opts.liveReadBaseUrl);
  const allowlistProjects = opts.allowlistProjects ?? [];
  const providerWebhooks = opts.providerWebhooks ?? [];
  const liveBase = {
    reads: liveReadBaseUrl !== null,
    snapshot: liveReadBaseUrl !== null,
    stream: liveReadBaseUrl !== null,
    transport: liveReadBaseUrl ? ["sse"] : [],
    provider_webhooks: providerWebhooks,
    webhook_setup: webhookSetup(opts),
    allowlist: { enabled: allowlistProjects.length > 0, count: allowlistProjects.length },
  };
  const probe = liveReadBaseUrl
    ? await probeLiveSnapshot(opts)
    : { status: "unsupported" as const, latestSeq: null, latestEventAt: null, generatedAt: null };
  return {
    schema: "symphony-board-capabilities/1",
    generated_at: opts.now?.() ?? new Date().toISOString(),
    server: {
      mode: opts.serverMode,
      contract: true,
      range: true,
      stats: true,
      activity_daily: true,
      review_candidates: true,
      actionable: true,
    },
    live: {
      ...liveBase,
      status: probe.status,
      latest_seq: probe.latestSeq,
      latest_event_at: probe.latestEventAt,
      snapshot_generated_at: probe.generatedAt,
    },
  };
}

export async function handleCapabilitiesRequest(opts: CapabilitiesOptions, res: ServerResponse): Promise<void> {
  try {
    json(res, 200, await buildCapabilities(opts));
  } catch (error) {
    json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
}
