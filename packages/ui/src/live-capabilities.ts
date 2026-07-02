import type { LiveSnapshot, ServerCapabilities } from "./model.ts";

export type LiveCapabilitiesRowKind = "ok" | "warn" | "muted";

export interface LiveCapabilitiesStatusRow {
  kind: LiveCapabilitiesRowKind;
  text: string;
}

function latestLine(caps: ServerCapabilities): string {
  const seq = caps.live.latest_seq;
  const when = caps.live.latest_event_at;
  if (typeof seq === "number" && when) return `Live receiver reachable, latest seq ${seq} at ${when}.`;
  if (typeof seq === "number") return `Live receiver reachable, latest seq ${seq}.`;
  return "Live receiver reachable.";
}

export function liveCapabilitiesStatusRows(caps: ServerCapabilities | null): LiveCapabilitiesStatusRow[] {
  if (!caps) return [{ kind: "muted", text: "Live capabilities unavailable on this server." }];
  const rows: LiveCapabilitiesStatusRow[] = [];
  const status = caps.live.status ?? (caps.live.reads ? "unreachable" : "unsupported");
  if (!caps.live.reads || status === "unsupported") {
    rows.push({ kind: "warn", text: "Live reads unavailable on this server." });
  } else if (status === "unreachable") {
    rows.push({ kind: "warn", text: "Live read routes are advertised, but the receiver is not reachable right now." });
  } else if (status === "empty") {
    rows.push({ kind: "ok", text: "Live receiver reachable, no events in retention window." });
  } else {
    rows.push({ kind: "ok", text: latestLine(caps) });
  }

  const setup = caps.live.webhook_setup ?? null;
  if (setup && (setup.public_url || setup.provider || (setup.events?.length ?? 0) > 0)) {
    const provider = setup.provider ?? "provider";
    const url = setup.public_url ? ` ${setup.public_url}` : "";
    const events = setup.events?.length ? ` (${setup.events.join(", ")})` : "";
    rows.push({ kind: "muted", text: `Webhook setup hint: ${provider}${url}${events}.` });
  }

  const allowlist = caps.live.allowlist;
  if (allowlist?.enabled) {
    rows.push({
      kind: "muted",
      text: `Allowlist enabled for ${allowlist.count} ${allowlist.count === 1 ? "project" : "projects"}.`,
    });
  }
  return rows;
}

export function capabilitiesFromLiveSnapshot(snapshot: LiveSnapshot): ServerCapabilities {
  const latest = snapshot.events[0] ?? null;
  const latestAt = latest?.received_at ?? latest?.occurred_at ?? null;
  return {
    schema: "symphony-board-capabilities/1",
    generated_at: snapshot.generated_at,
    server: {
      mode: "unknown",
      contract: true,
      range: true,
      stats: true,
    },
    live: {
      reads: true,
      snapshot: true,
      stream: true,
      transport: ["sse"],
      provider_webhooks: [],
      status: snapshot.max_seq > 0 ? "ready" : "empty",
      latest_seq: snapshot.max_seq,
      latest_event_at: latestAt,
      snapshot_generated_at: snapshot.generated_at,
    },
  };
}
