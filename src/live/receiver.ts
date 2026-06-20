// The least-privilege live receiver request layer. Holds ONLY the live store
// and the webhook secrets (passed in by value, read from env by name upstream):
// no canonical store handle, no provider token, no config mount. Webhook intake
// verifies over the raw bytes, dedupes/appends DURABLY, acks 202, then
// broadcasts (so a crash after ack cannot silently drop a delivery GitHub will
// not retry). SSE/snapshot are tailnet-only reads served from the same process.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { log } from "../log.ts";
import { sendJsonMaybeGzip } from "../server/http.ts";
import type { LiveStore } from "./store.ts";
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
  maxConnections?: number;
  snapshotLimit?: number;
  maxSnapshotLimit?: number;
}

export interface LiveReceiver {
  server: Server;
  broadcaster: Broadcaster;
}

const DEFAULT_SNAPSHOT_LIMIT = 200;
const DEFAULT_MAX_SNAPSHOT_LIMIT = 1000;

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
  const broadcaster = new Broadcaster(
    opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
  );

  async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    route: ProviderRoute,
  ): Promise<void> {
    let rawBody: Buffer;
    try {
      rawBody = await readBodyBytes(req, maxBodyBytes);
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

    // Durable append BEFORE the ack. `since(preMax)` then yields exactly the
    // newly-inserted rows (redeliveries keep their old, lower seq).
    const preMax = store.maxSeq();
    scoped.forEach((input, i) => store.append(input, i));
    sendJson(res, 202, { ok: true });

    // Broadcast the fresh rows after the ack (best-effort; ephemeral fan-out).
    try {
      for (const ev of store.since(preMax)) broadcaster.broadcast(ev);
    } catch (err) {
      log.warn(`[live] broadcast failed: ${(err as Error).message}`);
    }
  }

  function handleSse(req: IncomingMessage, res: ServerResponse): void {
    if (!broadcaster.hasCapacity()) {
      sendJson(res, 503, { error: "too_many_connections" });
      return;
    }
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
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

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Register BEFORE replaying so an event appended concurrently is never lost
    // between replay and subscribe; send() dedupes by seq.
    const sub = broadcaster.add(res, cursor);
    res.write("retry: 3000\n\n");
    for (const ev of store.since(cursor)) broadcaster.send(sub, ev);
    req.on("close", () => broadcaster.remove(sub.id));
  }

  function handleSnapshot(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const raw = Number(url.searchParams.get("limit"));
    const limit =
      Number.isFinite(raw) && raw > 0
        ? Math.min(Math.trunc(raw), maxSnapshotLimit)
        : snapshotLimit;
    sendJsonMaybeGzip(
      res,
      200,
      {
        schema: "live-snapshot/1",
        events: store.recent(limit),
        max_seq: store.maxSeq(),
        generated_at: new Date().toISOString(),
      },
      req.headers["accept-encoding"],
    );
  }

  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const path = url.pathname;

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

  return { server, broadcaster };
}
