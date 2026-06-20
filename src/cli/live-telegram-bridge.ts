// Read-only bridge: consume the Live SSE stream (GET /api/live) and forward
// EVERY event to a Telegram channel, 1:1, with no filtering — a faithful mirror
// of what the receiver captures. It is "read-only toward providers" like the
// rest of the product: it only reads the Live contract and pushes to Telegram,
// never writing back to GitHub/GitLab. Runs as a sidecar in the same compose
// project as the live receiver, reaching it over the compose network
// (http://live:8090). Connection discipline mirrors the UI client
// (packages/ui/src/useLive.ts): seed the cursor from /api/live-snapshot's
// max_seq, then resume the stream via the Last-Event-ID header; on a `reset`
// sentinel, jump the cursor to max_seq (a missed gap is logged, never replayed
// as a channel flood); the last delivered seq is persisted so a restart resumes
// gap-free within the receiver's retention window.
//
// Config is read from the environment BY NAME only (no token is ever inlined or
// logged). The Telegram bot token never leaves the host running this bridge.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../log.ts";
import { isLiveEvent, type LiveEvent } from "../live/types.ts";
import { clampHtml, formatLiveEvent, TELEGRAM_MESSAGE_LIMIT } from "../live/telegram.ts";

export interface TelegramBridgeConfig {
  // Base URL of the Live receiver's reads listener (no trailing slash).
  liveUrl: string;
  botToken: string;
  chatId: string;
  // When true, formatted messages are logged instead of sent (no token needed).
  dryRun: boolean;
  // Where the last-delivered seq is persisted across restarts.
  cursorPath: string;
  // Minimum spacing between sends, a light guard against Telegram rate limits.
  minIntervalMs: number;
  warnings: string[];
}

// Pure environment -> config resolution (no IO), unit-testable without a socket.
export function resolveTelegramBridgeConfig(
  env: Record<string, string | undefined> = process.env,
): TelegramBridgeConfig {
  const warnings: string[] = [];
  const dryRun = env.LIVE_TELEGRAM_DRY_RUN === "1" ||
    env.LIVE_TELEGRAM_DRY_RUN === "true";
  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = env.TELEGRAM_CHAT_ID ?? "";
  if (!dryRun && (botToken.length === 0 || chatId.length === 0)) {
    warnings.push(
      "TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID is unset; no messages will be sent (set LIVE_TELEGRAM_DRY_RUN=1 to silence)",
    );
  }
  const minIntervalMs = Number(env.LIVE_TELEGRAM_MIN_INTERVAL_MS ?? "350");
  return {
    liveUrl: (env.LIVE_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, ""),
    botToken,
    chatId,
    dryRun,
    cursorPath: env.LIVE_TELEGRAM_CURSOR_PATH ?? "data/live-telegram.cursor",
    minIntervalMs: Number.isFinite(minIntervalMs) && minIntervalMs >= 0
      ? minIntervalMs
      : 350,
    warnings,
  };
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

// Parse one SSE frame (the text between blank-line separators) into its fields.
// Comment lines (leading ':') are ignored; multiple `data:` lines join with
// '\n' per the SSE spec. Returns the empty object for a comment-only frame (e.g.
// a ': heartbeat' keepalive), which the caller skips.
export function parseSseFrame(block: string): SseFrame {
  const frame: SseFrame = {};
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") frame.id = value;
    else if (field === "event") frame.event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length > 0) frame.data = dataLines.join("\n");
  return frame;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Give up re-sending one message after this many consecutive 429s (then drop
// it) so a sustained rate limit cannot wedge the whole stream forever.
const MAX_RATE_LIMIT_RETRIES = 5;
// Hard ceiling on the un-delimited SSE read buffer. One event's JSON is far
// smaller; a stream that never emits a frame delimiter is treated as hostile
// and the connection is dropped rather than letting the buffer OOM the process.
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

function readCursor(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

// Persist the cursor atomically (write a temp file, then rename) so a crash
// mid-write can never leave a torn cursor value. Returns whether the value is
// now durable: callers advance the in-memory cursor ONLY on success, so memory
// and disk never diverge — a persist failure leaves the cursor where it last
// landed on disk, the only state a restart can recover.
function writeCursor(path: string, seq: number): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, String(seq), "utf8");
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log.error(`[tg] failed to persist cursor at seq ${seq}: ${(err as Error).message}`);
    return false;
  }
}

// Seed the cursor from the snapshot's max_seq so a cold start streams only NEW
// activity (a `since=0` resume would replay the whole backlog as a flood).
async function seedCursor(liveUrl: string): Promise<number> {
  const res = await fetch(`${liveUrl}/api/live-snapshot?limit=1`);
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const body = (await res.json()) as { max_seq?: unknown };
  const maxSeq = body.max_seq;
  if (typeof maxSeq !== "number" || !Number.isFinite(maxSeq)) {
    throw new Error("snapshot missing a numeric max_seq");
  }
  return maxSeq;
}

export class TelegramSender {
  #lastSendAt = 0;
  readonly #cfg: TelegramBridgeConfig;
  constructor(cfg: TelegramBridgeConfig) {
    this.#cfg = cfg;
  }

  // Deliver one message. Returns when delivered or deliberately skipped (a 4xx
  // poison message is dropped so it cannot stall the stream); a 429 is retried
  // after the server-advised delay; a network error throws so the caller can
  // reconnect and redeliver (the cursor is only advanced on a clean return).
  async send(text: string): Promise<void> {
    if (this.#cfg.dryRun) {
      log.info(`[tg] (dry-run) would send:\n${text}`);
      return;
    }
    if (!this.#cfg.botToken || !this.#cfg.chatId) {
      log.warn("[tg] no bot token / chat id configured; dropping message");
      return;
    }
    await this.#throttle();
    let rateLimitRetries = 0;
    for (;;) {
      const res = await fetch(
        `https://api.telegram.org/bot${this.#cfg.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.#cfg.chatId,
            // Entity-safe clamp: never post a half-written entity (400 poison).
            text: clampHtml(text, TELEGRAM_MESSAGE_LIMIT),
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        },
      );
      if (res.ok) return;
      if (res.status === 429) {
        if (++rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
          log.warn(
            `[tg] still rate limited after ${MAX_RATE_LIMIT_RETRIES} retries; dropping message`,
          );
          return;
        }
        const payload = (await res.json().catch(() => ({}))) as {
          parameters?: { retry_after?: number };
        };
        // Cap the advised wait so a pathological retry_after cannot freeze the
        // whole stream (send() blocks the SSE read loop while it waits).
        const retryAfter = Math.min(payload.parameters?.retry_after ?? 1, 60);
        log.warn(`[tg] rate limited; retrying after ${retryAfter}s`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      const detail = await res.text().catch(() => "");
      log.warn(`[tg] sendMessage HTTP ${res.status}; dropping message. ${detail}`);
      return;
    }
  }

  async #throttle(): Promise<void> {
    const wait = this.#lastSendAt + this.#cfg.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.#lastSendAt = Date.now();
  }
}

// One SSE connection: stream frames until the connection ends or aborts. Returns
// the (possibly advanced) cursor so the next reconnect resumes from it.
async function streamOnce(
  cfg: TelegramBridgeConfig,
  sender: TelegramSender,
  startCursor: number,
  signal: AbortSignal,
): Promise<number> {
  let cursor = startCursor;
  const res = await fetch(`${cfg.liveUrl}/api/live`, {
    headers: {
      Accept: "text/event-stream",
      "Last-Event-ID": String(cursor),
    },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`live stream HTTP ${res.status}`);
  }
  log.info(`[tg] connected to ${cfg.liveUrl}/api/live (since seq ${cursor})`);

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER_BYTES) {
      throw new Error("SSE buffer exceeded limit without a frame delimiter");
    }
    let sep: number;
    // SSE frames are separated by a blank line ("\n\n").
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame = parseSseFrame(block);
      // Advance the in-memory cursor ONLY when the new value is persisted, so a
      // disk failure never lets memory run ahead of disk (which would re-send
      // already-delivered events after a reconnect/restart).
      if (frame.event === "reset") {
        const maxSeq = handleReset(frame.data, cursor);
        if (maxSeq > cursor && writeCursor(cfg.cursorPath, maxSeq)) cursor = maxSeq;
      } else if (frame.event === "live" && frame.data) {
        const advanced = await handleLiveFrame(frame.data, cursor, sender);
        if (advanced > cursor && writeCursor(cfg.cursorPath, advanced)) {
          cursor = advanced;
        }
      }
      // Comment/heartbeat/`retry:` frames carry no event+data and are skipped.
    }
  }
  return cursor;
}

function handleReset(data: string | undefined, cursor: number): number {
  try {
    const payload = JSON.parse(data ?? "{}") as {
      reason?: string;
      max_seq?: number;
    };
    const maxSeq = typeof payload.max_seq === "number" ? payload.max_seq : cursor;
    const missed = Math.max(0, maxSeq - cursor);
    log.warn(
      `[tg] reset (${payload.reason ?? "unknown"}); skipped ${missed} event(s), resynced to seq ${maxSeq}`,
    );
    return maxSeq;
  } catch {
    return cursor;
  }
}

// Parse, validate, format, and send one `live` frame. Returns the event's seq on
// a successful send (so the caller advances the cursor) or the unchanged cursor
// on a stale/duplicate/invalid frame.
async function handleLiveFrame(
  data: string,
  cursor: number,
  sender: TelegramSender,
): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    log.warn("[tg] skipping unparseable live frame");
    return cursor;
  }
  if (!isLiveEvent(parsed)) {
    log.warn("[tg] skipping frame that is not a live-event/1 record");
    return cursor;
  }
  const event = parsed as LiveEvent;
  if (event.seq <= cursor) return cursor; // already delivered (replay dedupe)
  await sender.send(formatLiveEvent(event));
  return event.seq;
}

export async function runBridge(
  cfg: TelegramBridgeConfig,
  signal: AbortSignal,
): Promise<void> {
  for (const w of cfg.warnings) log.warn(`[tg] ${w}`);

  let cursor = readCursor(cfg.cursorPath);
  if (cursor === null) {
    cursor = await seedCursor(cfg.liveUrl);
    if (!writeCursor(cfg.cursorPath, cursor)) {
      log.error(
        "[tg] could not persist the seed cursor; a crash before the next persist may skip events",
      );
    }
    log.info(`[tg] cold start; seeded cursor at seq ${cursor} (no backlog replay)`);
  } else {
    log.info(`[tg] resuming from persisted seq ${cursor}`);
  }

  const sender = new TelegramSender(cfg);
  const BASE_RETRY_MS = 3000;
  const MAX_RETRY_MS = 30_000;
  let backoff = BASE_RETRY_MS;
  while (!signal.aborted) {
    // Trust the persisted cursor as the source of truth: every successful send
    // advances it on disk. A mid-stream error throws out of streamOnce without
    // returning the advanced value, so reloading here recovers those advances —
    // otherwise we would resume from the connection's start seq and re-send
    // everything already delivered this session (duplicate messages).
    cursor = readCursor(cfg.cursorPath) ?? cursor;
    try {
      cursor = await streamOnce(cfg, sender, cursor, signal);
      if (signal.aborted) break;
      // A clean stream end means we were connected; reset the backoff so a
      // routine idle disconnect reconnects promptly.
      backoff = BASE_RETRY_MS;
      log.warn("[tg] stream ended; reconnecting");
    } catch (err) {
      if (signal.aborted) break;
      log.warn(`[tg] stream error: ${(err as Error).message}; reconnecting in ${backoff}ms`);
    }
    await sleep(backoff);
    // Capped exponential backoff: a persistently-down receiver is not hammered
    // at a fixed 20 req/min; a healthy reconnect resets it above.
    backoff = Math.min(backoff * 2, MAX_RETRY_MS);
  }
}

export async function main(): Promise<void> {
  const cfg = resolveTelegramBridgeConfig();
  const controller = new AbortController();
  const shutdown = (sig: string): void => {
    log.info(`[tg] ${sig} received; shutting down`);
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await runBridge(cfg, controller.signal);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
