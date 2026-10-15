// In-memory webhook ingestion stats for GET /api/live-status. Raw values only:
// the last accepted and rejected delivery instants, the last rejected status,
// and rolling-window counts kept in per-minute buckets so memory stays bounded
// under a request flood. Stats reset when the receiver restarts; `started_at`
// on the status response lets a consumer account for that.

export const WEBHOOK_STATS_WINDOW_SECONDS = 3600;
const BUCKET_MS = 60_000;

export interface WebhookStatsSnapshot {
  last_accepted_at: string | null;
  last_rejected_at: string | null;
  last_rejected_status: number | null;
  last_rejected_status_class: string | null;
  accepted_in_window: number;
  rejected_in_window: number;
}

interface Bucket {
  accepted: number;
  rejected: number;
}

export class WebhookStats {
  readonly #now: () => number;
  readonly #buckets = new Map<number, Bucket>();
  #lastAcceptedMs: number | null = null;
  #lastRejectedMs: number | null = null;
  #lastRejectedStatus: number | null = null;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // Record one finished webhook request. A 2xx is an accepted delivery. A
  // non-2xx counts as a rejected delivery only when the request carried the
  // provider's delivery id, so stray traffic on the public listener does not
  // look like a provider failing to deliver.
  record(status: number, providerDelivery: boolean): void {
    const at = this.#now();
    const accepted = status >= 200 && status < 300;
    if (!accepted && !providerDelivery) return;
    this.#prune(at);
    const key = Math.floor(at / BUCKET_MS);
    const bucket = this.#buckets.get(key) ?? { accepted: 0, rejected: 0 };
    if (accepted) {
      bucket.accepted++;
      this.#lastAcceptedMs = at;
    } else {
      bucket.rejected++;
      this.#lastRejectedMs = at;
      this.#lastRejectedStatus = status;
    }
    this.#buckets.set(key, bucket);
  }

  snapshot(): WebhookStatsSnapshot {
    const at = this.#now();
    this.#prune(at);
    let accepted = 0;
    let rejected = 0;
    for (const b of this.#buckets.values()) {
      accepted += b.accepted;
      rejected += b.rejected;
    }
    return {
      last_accepted_at: iso(this.#lastAcceptedMs),
      last_rejected_at: iso(this.#lastRejectedMs),
      last_rejected_status: this.#lastRejectedStatus,
      last_rejected_status_class:
        this.#lastRejectedStatus === null ? null : `${Math.floor(this.#lastRejectedStatus / 100)}xx`,
      accepted_in_window: accepted,
      rejected_in_window: rejected,
    };
  }

  #prune(at: number): void {
    const oldest = Math.floor((at - WEBHOOK_STATS_WINDOW_SECONDS * 1000) / BUCKET_MS);
    for (const key of this.#buckets.keys()) if (key <= oldest) this.#buckets.delete(key);
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
