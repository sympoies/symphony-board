// The least-privilege live receiver request layer. Holds ONLY the live store
// and the webhook secrets (passed in by value, read from env by name upstream):
// no canonical store handle, no provider token, no config mount. Webhook intake
// verifies over the raw bytes, dedupes/appends DURABLY, acks 202, then
// broadcasts the freshly-appended rows from memory (so a crash after ack cannot
// silently drop a delivery GitHub will not retry, and a redelivery — which
// appends nothing new — is never rebroadcast).
//
// Defense-in-depth (#313): the receiver is served on TWO listeners that share
// one store + broadcaster but expose disjoint routes:
//   - webhookServer: POST /webhooks/<provider> (+ /healthz). The ONLY public
//     surface — the host Tailscale Funnel targets this listener's loopback port
//     directly, so even a "funnel the whole port" misconfig cannot reach the
//     event stream, and no Funnel path-rewrite is needed.
//   - readServer: GET /api/live (SSE) + /api/live-snapshot (+ /healthz). The
//     tailnet-only reads, proxied by the web sidecar over the compose network.
// Neither listener serves the other's routes (a webhook POST to readServer or an
// /api/live GET to webhookServer is a 404), so the public/tailnet split is
// enforced in-app, not only by out-of-repo proxy config.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { log } from "../log.ts";
import { sendJsonMaybeGzip } from "../server/http.ts";
import type { LiveStore } from "./store.ts";
import type { LiveEvent } from "./types.ts";
import type { ActorProfileObserver } from "./actor-profiles.ts";
import { headerValue, type AdaptCtx, type WebhookProvider } from "./provider.ts";
import {
  BodyTimeoutError,
  BodyTooLargeError,
  DEFAULT_MAX_BODY_BYTES,
  readBodyBytes,
} from "./http-body.ts";
import { Broadcaster, DEFAULT_MAX_CONNECTIONS } from "./broadcaster.ts";

export interface ProviderRoute {
  // Path segment under /webhooks (e.g. "github" -> POST /webhooks/github).
  pathSegment: string;
  provider: WebhookProvider;
  // Canonical source vocabulary, e.g. "github:github.com".
  sourceId: string;
  // Accepted secrets (current + previous) for rotation. Empty => reject all.
  secrets: readonly string[];
}

export interface ReceiverOptions {
  store: LiveStore;
  routes: ProviderRoute[];
  // Optional owner/repo allowlist. Empty/absent => accept all (an org webhook
  // fans in every repo; an allowlist drops out-of-scope ones before persist).
  projectAllowlist?: readonly string[];
  maxBodyBytes?: number;
  // Idle read timeout for the request body (ms); defaults to readBodyBytes'.
  bodyTimeoutMs?: number;
  // SSE connection cap (enforced via broadcaster.hasCapacity -> 503).
  maxConnections?: number;
  snapshotLimit?: number;
  maxSnapshotLimit?: number;
  // SSE resume replay bound; beyond it a `reset` re-snapshot is signalled.
  replayLimit?: number;
  // Public webhook listener abuse controls. An unauthenticated POST flood on the
  // Funnel must not be able to hold sockets open or exhaust the process.
  webhookRequestTimeoutMs?: number;
  headersTimeoutMs?: number;
  maxWebhookConnections?: number;
  actorProfiles?: ActorProfileObserver;
}

export interface LiveReceiver {
  // Public webhook ingress (the only Funnel-facing surface).
  webhookServer: Server;
  // Tailnet-only SSE + snapshot reads (proxied by the web sidecar).
  readServer: Server;
  broadcaster: Broadcaster;
}

const DEFAULT_SNAPSHOT_LIMIT = 200;
const DEFAULT_MAX_SNAPSHOT_LIMIT = 1000;
// SSE resume replay bound. Beyond this many backlog rows we re-snapshot via a
// `reset` sentinel instead of a partial replay that would drop the gap's middle.
const REPLAY_LIMIT = 1000;
const DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_WEBHOOK_CONNECTIONS = 256;
// Path parsing never needs the client-supplied Host header; a fixed base means a
// syntactically invalid `Host:` can never throw out of the request listener and
// take the (public) receiver down. Only pathname/searchParams are read.
const LOCAL_BASE = "http://localhost";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body) + "\n");
}

export function createLiveReceiver(opts: ReceiverOptions): LiveReceiver {
  const { store } = opts;
  const routes = new Map(opts.routes.map((r) => [r.pathSegment, r]));
  const allowlist = new Set((opts.projectAllowlist ?? []).filter(Boolean));
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const snapshotLimit = opts.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT;
  const maxSnapshotLimit = opts.maxSnapshotLimit ?? DEFAULT_MAX_SNAPSHOT_LIMIT;
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const replayLimit = opts.replayLimit ?? REPLAY_LIMIT;
  const broadcaster = new Broadcaster(maxConnections);

  async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    route: ProviderRoute,
  ): Promise<void> {
    let rawBody: Buffer;
    try {
      rawBody = await readBodyBytes(req, maxBodyBytes, opts.bodyTimeoutMs);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "payload_too_large" });
      } else if (err instanceof BodyTimeoutError) {
        sendJson(res, 408, { error: "request_timeout" });
      } else {
        sendJson(res, 400, { error: "bad_request" });
      }
      return;
    }

    // Verify over the raw bytes BEFORE any parse. No permissive fallback.
    const verdict = route.provider.verify(rawBody, req.headers, route.secrets);
    if (!verdict.ok) {
      sendJson(res, 401, { error: "invalid_signature" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    if (route.provider.isControlEvent(req.headers, parsed)) {
      sendJson(res, 200, { ok: true });
      return;
    }

    const deliveryId = route.provider.deliveryId(req.headers);
    if (deliveryId === null) {
      sendJson(res, 400, { error: "missing_delivery_id" });
      return;
    }

    const ctx: AdaptCtx = {
      sourceId: route.sourceId,
      deliveryId,
      receivedAt: new Date().toISOString(),
      eventHeader: headerValue(req.headers, route.provider.eventHeaderName) ?? "",
      hookId: route.provider.hookIdHeaderName
        ? headerValue(req.headers, route.provider.hookIdHeaderName)
        : null,
    };

    const events = route.provider.toLiveEvents(parsed, ctx);
    const scoped =
      allowlist.size === 0
        ? events
        : events.filter(
            (e) =>
              e.target?.project_path != null &&
              allowlist.has(e.target.project_path),
          );

    // Verified but nothing to store (unknown/unhandled action, or out of scope):
    // ack with no content.
    if (scoped.length === 0) {
      res.writeHead(204);
      res.end();
      return;
    }

    // Durable append BEFORE the ack. append() returns the persisted event for a
    // NEW row and null for a redelivery, so `appended` is exactly the fresh rows
    // to broadcast — no re-query, and a redelivery is never rebroadcast.
    const appended: LiveEvent[] = [];
    scoped.forEach((input, i) => {
      const ev = store.append(input, i);
      if (ev) appended.push(ev);
    });
    sendJson(res, 202, { ok: true });

    // Profile lookup and broadcast both happen after the ack. Neither can reject
    // a delivery GitHub will not retry.
    const broadcastEvents = store.hydrateEvents(appended);
    for (let i = 0; i < appended.length; i++) {
      const ev = appended[i]!;
      const broadcastEvent = broadcastEvents[i] ?? ev;
      try {
        opts.actorProfiles?.observe(ev, (updated) => {
          try {
            broadcaster.broadcast(updated, { replace: true });
          } catch (err) {
            log.warn(`[live] actor profile update broadcast failed: ${(err as Error).message}`);
          }
        });
      } catch (err) {
        log.warn(`[live] actor profile observer failed: ${(err as Error).message}`);
      }
      try {
        broadcaster.broadcast(broadcastEvent);
      } catch (err) {
        log.warn(`[live] broadcast failed: ${(err as Error).message}`);
      }
    }
  }

  function writeSseHead(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
  }

  // Tell the client to re-seed from the snapshot, then stream live from the
  // current max. Used when the resume cursor is ahead of what we retain or the
  // backlog is larger than we will replay (see handleSse).
  function sendReset(
    req: IncomingMessage,
    res: ServerResponse,
    reason: "stale_cursor" | "gap",
    maxSeq: number,
  ): void {
    writeSseHead(res);
    const sub = broadcaster.add(res, maxSeq);
    res.write(`id: ${maxSeq}\nevent: reset\ndata: ${JSON.stringify({ reason, max_seq: maxSeq })}\n\n`);
    req.on("close", () => broadcaster.remove(sub.id));
  }

  function handleSse(req: IncomingMessage, res: ServerResponse): void {
    if (!broadcaster.hasCapacity()) {
      sendJson(res, 503, { error: "too_many_connections" });
      return;
    }
    const url = new URL(req.url ?? "/", LOCAL_BASE);
    // Resume cursor: Last-Event-ID on auto-reconnect; ?since= for the initial
    // connect seeded from the snapshot's max_seq (EventSource cannot set the
    // header on first connect, so the gap is closed via the query param).
    const lastEventId = headerValue(req.headers, "last-event-id");
    const sinceParam = url.searchParams.get("since");
    let cursor = 0;
    if (lastEventId !== null && /^\d+$/.test(lastEventId)) {
      cursor = Number(lastEventId);
    } else if (sinceParam !== null && /^\d+$/.test(sinceParam)) {
      cursor = Number(sinceParam);
    }

    const maxSeq = store.maxSeq();
    // The client is ahead of everything retained (receiver restarted / pruned
    // below the cursor): re-seed rather than stream nothing forever.
    if (cursor > maxSeq) {
      sendReset(req, res, "stale_cursor", maxSeq);
      return;
    }
    // More backlog than the resume cap: a partial replay would silently drop the
    // middle of the gap, so signal a re-snapshot instead.
    const backlog = store.since(cursor, replayLimit + 1);
    if (backlog[0] && backlog[0].seq > cursor + 1) {
      sendReset(req, res, "gap", maxSeq);
      return;
    }
    if (backlog.length > replayLimit) {
      sendReset(req, res, "gap", maxSeq);
      return;
    }

    writeSseHead(res);
    // Register BEFORE replaying so an event appended concurrently is never lost
    // between replay and subscribe; send() dedupes by seq.
    const sub = broadcaster.add(res, cursor);
    for (const ev of backlog) broadcaster.send(sub, ev);
    req.on("close", () => broadcaster.remove(sub.id));
  }

  function handleSnapshot(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", LOCAL_BASE);
    const raw = Number(url.searchParams.get("limit"));
    const limit =
      Number.isFinite(raw) && raw > 0
        ? Math.min(Math.trunc(raw), maxSnapshotLimit)
        : snapshotLimit;
    const sinceParam = url.searchParams.get("since");
    const since =
      sinceParam !== null && /^\d+$/.test(sinceParam)
        ? Number(sinceParam)
        : null;
    const maxSeq = store.maxSeq();
    const events =
      since === null || since > maxSeq
        ? store.recent(limit)
        : since >= maxSeq
          ? []
          : store.sinceDesc(since, limit);
    sendJsonMaybeGzip(
      res,
      200,
      {
        schema: "live-snapshot/1",
        events,
        max_seq: maxSeq,
        generated_at: new Date().toISOString(),
      },
      req.headers["accept-encoding"],
    );
  }

  // Public webhook ingress: POST /webhooks/<provider> (+ /healthz) only. No read
  // routes, so this listener can face the Funnel directly. Abuse controls bound
  // an unauthenticated POST flood (per-request + headers timeouts, conn cap).
  const webhookServer = createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", LOCAL_BASE).pathname;
    if (method === "GET" && path === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && path.startsWith("/webhooks/")) {
      const route = routes.get(path.slice("/webhooks/".length));
      if (!route) {
        sendJson(res, 404, { error: "unknown_provider" });
        return;
      }
      void handleWebhook(req, res, route).catch((err: unknown) => {
        log.error(`[live] webhook handler error: ${(err as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      });
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });
  webhookServer.requestTimeout =
    opts.webhookRequestTimeoutMs ?? DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS;
  webhookServer.headersTimeout =
    opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  webhookServer.maxConnections =
    opts.maxWebhookConnections ?? DEFAULT_MAX_WEBHOOK_CONNECTIONS;

  // Tailnet-only reads: GET /api/live (SSE) + /api/live-snapshot (+ /healthz).
  const readServer = createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", LOCAL_BASE).pathname;
    if (method === "GET" && path === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && path === "/api/live") {
      handleSse(req, res);
      return;
    }
    if (method === "GET" && path === "/api/live-snapshot") {
      handleSnapshot(req, res);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });
  // SSE streams are long-lived: a per-request timeout would kill an open stream,
  // so disable it here (the headers timeout still bounds a slow header send).
  readServer.requestTimeout = 0;
  readServer.headersTimeout =
    opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  // Allow the SSE cap plus a little slack for concurrent snapshot requests.
  readServer.maxConnections = maxConnections + 32;

  return { webhookServer, readServer, broadcaster };
}
