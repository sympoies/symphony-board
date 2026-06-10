// Minimal timestamped logger. Operational scripts log through this so the
// always-on Docker loop output correlates with wall-clock time. JSON / contract
// output is written raw to stdout elsewhere and must NOT go through here (a
// timestamp prefix would corrupt machine-consumed output).
//
// Every line is also teed into a small in-memory ring buffer so the writer's
// control surface can serve a recent-log tail (GET /api/logs) to the UI's
// Diagnostics page. The buffer is per-process and lost on restart by design:
// it answers "what is the daemon doing / failing on right now", not forensics
// — container logs / the standalone app-server.log remain the durable record.
const ts = (): string => new Date().toISOString();

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  // Monotonic per-process sequence so a poller can ask for "entries after the
  // last one I saw" instead of re-reading the whole buffer every tick.
  seq: number;
  ts: string;
  level: LogLevel;
  message: string;
}

export const LOG_BUFFER_CAPACITY = 1000;

const buffer: LogEntry[] = [];
let nextSeq = 1;

function record(level: LogLevel, message: string, at: string): void {
  buffer.push({ seq: nextSeq++, ts: at, level, message });
  if (buffer.length > LOG_BUFFER_CAPACITY) buffer.splice(0, buffer.length - LOG_BUFFER_CAPACITY);
}

// Buffered entries with seq > after (0 = everything still retained).
export function recentLogs(after = 0): LogEntry[] {
  return after > 0 ? buffer.filter((e) => e.seq > after) : [...buffer];
}

// Highest seq currently in the buffer (0 when empty). Served alongside the
// tail so a poller can detect a daemon restart: its last-seen seq suddenly
// exceeding latest_seq means the seq space reset and it must re-read from 0.
export function latestLogSeq(): number {
  return buffer.at(-1)?.seq ?? 0;
}

export const log = {
  info: (msg: string): void => {
    const at = ts();
    record("info", msg, at);
    console.log(`${at} ${msg}`);
  },
  warn: (msg: string): void => {
    const at = ts();
    record("warn", msg, at);
    console.warn(`${at} WARN ${msg}`);
  },
  error: (msg: string): void => {
    const at = ts();
    record("error", msg, at);
    console.error(`${at} ERROR ${msg}`);
  },
};
