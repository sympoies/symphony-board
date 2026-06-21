// Unit coverage for the live->Telegram bridge: the pure event formatter
// (escaping, category glyphs, merged-PR labelling, body truncation), the SSE
// frame parser (heartbeat skip, multi-data, comment lines), and the bridge's
// pure env -> config resolution. No socket is bound and no token is needed.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampHtml,
  escapeHtml,
  eventEmoji,
  formatLiveEvent,
  MAX_BODY_LINES,
  TELEGRAM_MESSAGE_LIMIT,
} from "../src/live/telegram.ts";
import {
  parseSseFrame,
  resolveTelegramBridgeConfig,
  runBridge,
  streamOnce,
  TelegramSender,
} from "../src/cli/live-telegram-bridge.ts";
import { LIVE_EVENT_SCHEMA, type LiveEvent } from "../src/live/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeEvent(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    schema: LIVE_EVENT_SCHEMA,
    seq: 1,
    event_id: "d-1",
    source_id: "github:github.com",
    provider: "github",
    received_at: "2026-06-21T10:00:00Z",
    event_type: "issues",
    action: "opened",
    category: "issue",
    actor: { login: "graysurf" },
    target: {
      kind: "issue",
      source_id: "github:github.com",
      project_path: "sympoies/symphony-board",
      number: 327,
      title: "Live SSE flaky reconnect",
      url: "https://github.com/sympoies/symphony-board/issues/327",
    },
    title: "Live SSE flaky reconnect",
    delivery: {
      delivery_id: "d-1",
      event_header: "issues",
      signature_status: "verified",
    },
    ...over,
  } as LiveEvent;
}

function sseBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("escapeHtml escapes the Bot-API HTML entities including double quotes", () => {
  assert.equal(escapeHtml('a & b < c > d "q"'), "a &amp; b &lt; c &gt; d &quot;q&quot;");
  assert.equal(escapeHtml("plain text"), "plain text");
});

test("clampHtml drops a trailing partial entity but keeps a complete one", () => {
  // Cutting "&amp;" mid-entity must not leave "&am" (Telegram 400s on that).
  assert.equal(clampHtml("ab&amp;cd", 5), "ab"); // "ab&am" -> strip "&am"
  assert.equal(clampHtml("ab&amp;", 6), "ab"); // "ab&amp" -> strip "&amp"
  assert.equal(clampHtml("ab&amp;cd", 7), "ab&amp;"); // complete entity kept
  assert.equal(clampHtml("short", 99), "short"); // no clamp under the limit
});

test("formatLiveEvent neutralises a hostile URL inside the href attribute", () => {
  const msg = formatLiveEvent(
    makeEvent({
      target: {
        kind: "issue",
        source_id: "github:github.com",
        title: "t",
        url: 'https://x/" onmouseover="alert(1)',
      },
    }),
  );
  // The quote is escaped, so it cannot close the href attribute.
  assert.match(msg, /href="https:\/\/x\/&quot; onmouseover=&quot;alert\(1\)"/);
  assert.doesNotMatch(msg, /onmouseover="/);
});

test("eventEmoji maps known categories and falls back for unknown ones", () => {
  assert.equal(eventEmoji(makeEvent({ category: "issue" })), "📌");
  assert.equal(eventEmoji(makeEvent({ category: "change_request" })), "🔀");
  assert.equal(eventEmoji(makeEvent({ category: "deployment" })), "📣");
});

test("formatLiveEvent renders header, linked title, actor, and time", () => {
  const msg = formatLiveEvent(makeEvent());
  assert.match(msg, /<b>sympoies\/symphony-board<\/b> · issue opened #327/);
  assert.match(
    msg,
    /<a href="https:\/\/github.com\/sympoies\/symphony-board\/issues\/327">Live SSE flaky reconnect<\/a>/,
  );
  assert.match(msg, /👤 graysurf/);
  assert.match(msg, /🕒 2026-06-21T10:00:00Z/);
});

test("formatLiveEvent links the event permalink in preference to the target URL", () => {
  // A comment event: event.url is the comment anchor, target.url the parent PR.
  const msg = formatLiveEvent(
    makeEvent({
      category: "comment",
      url: "https://github.com/o/r/pull/9#issuecomment-42",
      target: {
        kind: "change_request",
        source_id: "github:github.com",
        title: "parent PR",
        url: "https://github.com/o/r/pull/9",
      },
    }),
  );
  assert.match(msg, /href="https:\/\/github.com\/o\/r\/pull\/9#issuecomment-42"/);
  assert.ok(!msg.includes('href="https://github.com/o/r/pull/9"'), "must not link the parent target URL");
});

test("formatLiveEvent keeps the short SHA in the commit mirror's linked title", () => {
  // A commit row's target.title is the bare subject; its event.title is the
  // disambiguating "<author> committed <short-sha>". The bare subject loses the
  // SHA, so repeated/generic subjects become indistinguishable in the mirror.
  // The commit mirror must surface the short SHA in the linked title.
  const msg = formatLiveEvent(
    makeEvent({
      category: "commit",
      title: "Robo Committer committed cccc333",
      url: "https://github.com/sympoies/symphony-board/commit/cccc333cccc333cccc333cccc333cccc333cccc3",
      target: {
        kind: "commit",
        source_id: "github:github.com",
        project_path: "sympoies/symphony-board",
        external_id: "cccc333cccc333cccc333cccc333cccc333cccc3",
        title: "fix: second commit single line",
        url: "https://github.com/sympoies/symphony-board/commit/cccc333cccc333cccc333cccc333cccc333cccc3",
      },
    }),
  );
  // Assert on the LINKED TITLE TEXT (between > and </a>), not anywhere in the
  // message — the href legitimately carries the full SHA, so a bare /cccc333/
  // match would pass even while the visible title shows only the subject.
  const linkText = msg.match(/>([^<]*)<\/a>/)?.[1] ?? "";
  assert.match(linkText, /committed cccc333/, "the linked title carries the short SHA");
  assert.doesNotMatch(
    linkText,
    /^fix: second commit single line$/,
    "the bare subject (no SHA) must not be the linked title for a commit",
  );
});

test("formatLiveEvent labels a merged PR as merged, not closed", () => {
  const msg = formatLiveEvent(
    makeEvent({
      category: "change_request",
      action: "closed",
      provider_details: { merged: true },
    }),
  );
  assert.match(msg, /change_request merged/);
  assert.doesNotMatch(msg, /change_request closed/);
});

test("formatLiveEvent escapes hostile body/title text", () => {
  const msg = formatLiveEvent(
    makeEvent({
      title: "<script>alert(1)</script>",
      target: null,
      url: null,
      body: "look <b>bold</b> & <i>x</i>",
    }),
  );
  assert.match(msg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(msg, /look &lt;b&gt;bold&lt;\/b&gt; &amp; &lt;i&gt;x&lt;\/i&gt;/);
  // Plain substring check (not a tag-shaped regex) — the raw tag must be gone.
  assert.ok(!msg.includes("<script>"), "raw <script> tag must be escaped");
});

test("formatLiveEvent truncates an over-long body to the message ceiling", () => {
  const msg = formatLiveEvent(makeEvent({ body: "x".repeat(8000) }));
  assert.ok(msg.length <= TELEGRAM_MESSAGE_LIMIT);
  assert.match(msg, /…$/);
});

test("formatLiveEvent caps the body at MAX_BODY_LINES lines", () => {
  const body = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
  const msg = formatLiveEvent(makeEvent({ body }));
  const bodyPart = msg.split("\n\n").slice(1).join("\n\n");
  const kept = bodyPart.split("\n").filter((l) => /^line \d+$/.test(l));
  assert.equal(kept.length, MAX_BODY_LINES);
  assert.match(msg, /…$/);
  assert.ok(!msg.includes("line 11"), "lines past the cap are dropped");
});

test("formatLiveEvent accepts a caller-specified body line cap", () => {
  const body = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
  const msg = formatLiveEvent(makeEvent({ body }), 5);
  const bodyPart = msg.split("\n\n").slice(1).join("\n\n");
  const kept = bodyPart.split("\n").filter((l) => /^line \d+$/.test(l));
  assert.equal(kept.length, 5);
  assert.match(msg, /…$/);
  assert.ok(!msg.includes("line 6"), "lines past the override cap are dropped");
});

test("formatLiveEvent tolerates missing actor/target/title/body", () => {
  const msg = formatLiveEvent(
    makeEvent({ actor: null, target: null, title: null, url: null, body: null }),
  );
  assert.match(msg, /📌 <b>github:github.com<\/b> · issue opened/);
});

test("parseSseFrame extracts id/event/data and strips one leading space", () => {
  const frame = parseSseFrame('id: 42\nevent: live\ndata: {"seq":42}');
  assert.deepEqual(frame, { id: "42", event: "live", data: '{"seq":42}' });
});

test("parseSseFrame ignores comment-only heartbeat frames", () => {
  assert.deepEqual(parseSseFrame(": heartbeat"), {});
});

test("parseSseFrame joins multiple data lines with newlines", () => {
  const frame = parseSseFrame("event: live\ndata: line1\ndata: line2");
  assert.equal(frame.data, "line1\nline2");
});

test("parseSseFrame tolerates CRLF line endings", () => {
  const frame = parseSseFrame("id: 7\r\nevent: reset\r\ndata: {}\r");
  assert.deepEqual(frame, { id: "7", event: "reset", data: "{}" });
});

test("resolveTelegramBridgeConfig warns when token/chat unset and not dry-run", () => {
  const cfg = resolveTelegramBridgeConfig({});
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0]!, /TELEGRAM_BOT_TOKEN/);
});

test("resolveTelegramBridgeConfig is silent in dry-run mode", () => {
  const cfg = resolveTelegramBridgeConfig({ LIVE_TELEGRAM_DRY_RUN: "1" });
  assert.equal(cfg.dryRun, true);
  assert.deepEqual(cfg.warnings, []);
});

test("resolveTelegramBridgeConfig strips trailing slashes and applies defaults", () => {
  const def = resolveTelegramBridgeConfig({ LIVE_TELEGRAM_DRY_RUN: "1" });
  assert.equal(def.liveUrl, "http://127.0.0.1:8090");
  assert.equal(def.cursorPath, "data/live-telegram.cursor");
  assert.equal(def.minIntervalMs, 350);

  const over = resolveTelegramBridgeConfig({
    LIVE_URL: "http://live:8090///",
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_CHAT_ID: "c",
    LIVE_TELEGRAM_MIN_INTERVAL_MS: "1000",
    LIVE_TELEGRAM_BODY_LINES: "5",
  });
  assert.equal(over.liveUrl, "http://live:8090");
  assert.equal(over.warnings.length, 0);
  assert.equal(over.minIntervalMs, 1000);
  assert.equal(over.bodyLines, 5);

  const invalid = resolveTelegramBridgeConfig({
    LIVE_TELEGRAM_DRY_RUN: "1",
    LIVE_TELEGRAM_BODY_LINES: "nope",
  });
  assert.equal(invalid.bodyLines, MAX_BODY_LINES);
});

test("TelegramSender throws on auth/config HTTP failures so the cursor is not advanced", async () => {
  const cfg = resolveTelegramBridgeConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "chat",
    LIVE_TELEGRAM_MIN_INTERVAL_MS: "0",
  });
  const cases = [
    { status: 401, body: "Unauthorized" },
    { status: 403, body: "Forbidden" },
    { status: 404, body: "Not Found" },
    { status: 400, body: "Bad Request: chat not found" },
  ];
  for (const { status, body } of cases) {
    globalThis.fetch = (async () =>
      new Response(body, { status })) as typeof fetch;
    const sender = new TelegramSender(cfg);
    await assert.rejects(
      () => sender.send("hello"),
      new RegExp(`Telegram HTTP ${status}`),
      `HTTP ${status} must leave the live cursor unmoved for retry/fail-fast recovery`,
    );
  }
});

test("TelegramSender drops message-specific HTTP 400 poison without retrying forever", async () => {
  const cfg = resolveTelegramBridgeConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "chat",
    LIVE_TELEGRAM_MIN_INTERVAL_MS: "0",
  });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("Bad Request: can't parse entities", { status: 400 });
  }) as typeof fetch;
  const sender = new TelegramSender(cfg);
  await sender.send("hello");
  assert.equal(calls, 1);
});

test("streamOnce leaves the cursor file unchanged when Telegram auth/config send fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-tg-"));
  try {
    const cursorPath = join(dir, "cursor");
    writeFileSync(cursorPath, "5", "utf8");
    const cfg = resolveTelegramBridgeConfig({
      LIVE_URL: "http://live",
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "chat",
      LIVE_TELEGRAM_CURSOR_PATH: cursorPath,
      LIVE_TELEGRAM_MIN_INTERVAL_MS: "0",
    });
    const event = makeEvent({ seq: 6 });
    let telegramCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://live/api/live") {
        return new Response(
          sseBody(`id: 6\nevent: live\ndata: ${JSON.stringify(event)}\n\n`),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.startsWith("https://api.telegram.org/")) {
        telegramCalls += 1;
        return new Response("Unauthorized", { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => streamOnce(cfg, new TelegramSender(cfg), 5, new AbortController().signal),
      /Telegram HTTP 401/,
    );
    assert.equal(readFileSync(cursorPath, "utf8"), "5");
    assert.equal(telegramCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamOnce persists a lower reset cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-tg-"));
  try {
    const cursorPath = join(dir, "cursor");
    writeFileSync(cursorPath, "100", "utf8");
    const cfg = resolveTelegramBridgeConfig({
      LIVE_URL: "http://live",
      LIVE_TELEGRAM_DRY_RUN: "1",
      LIVE_TELEGRAM_CURSOR_PATH: cursorPath,
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://live/api/live") {
        return new Response(
          sseBody('id: 2\nevent: reset\ndata: {"reason":"stale_cursor","max_seq":2}\n\n'),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const cursor = await streamOnce(
      cfg,
      new TelegramSender(cfg),
      100,
      new AbortController().signal,
    );
    assert.equal(cursor, 2);
    assert.equal(readFileSync(cursorPath, "utf8"), "2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runBridge fails fast if the cold-start seed cursor is not durable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-tg-"));
  try {
    const cursorPath = join(dir, "cursor-as-directory");
    mkdirSync(cursorPath);
    const cfg = resolveTelegramBridgeConfig({
      LIVE_URL: "http://live",
      LIVE_TELEGRAM_DRY_RUN: "1",
      LIVE_TELEGRAM_CURSOR_PATH: cursorPath,
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://live/api/live-snapshot?limit=1") {
        return new Response(JSON.stringify({ max_seq: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => runBridge(cfg, new AbortController().signal),
      /seed cursor persist failed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
