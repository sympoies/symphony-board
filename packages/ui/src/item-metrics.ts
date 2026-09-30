import type { ItemDTO } from "@symphony-board/contract";
import { reviewThreadsLabel, type RelationCount } from "./model.ts";
import { programChildName, type ProgramRollup } from "./program.ts";

export type ItemMetricKind = "comments" | "threads" | "related";

export interface ItemMetricEntry {
  kind: ItemMetricKind;
  value: number;
  title: string;
}

export function itemMetricEntries(item: ItemDTO, related: RelationCount | null | undefined): ItemMetricEntry[] {
  const entries: ItemMetricEntry[] = [];
  const commentTotal = item.comments?.total ?? null;
  if (commentTotal != null && commentTotal > 0) {
    entries.push({ kind: "comments", value: commentTotal, title: "comments" });
  }

  const threadLabel = reviewThreadsLabel(item.review_threads);
  if (threadLabel && item.review_threads) {
    entries.push({
      kind: "threads",
      value: item.review_threads.open > 0 ? item.review_threads.open : item.review_threads.total,
      title: threadLabel,
    });
  }

  if (related && related.total > 0) {
    entries.push({
      kind: "related",
      value: related.total,
      title: related.byType.map((part) => `${part.type} ${part.count}`).join(" · "),
    });
  }

  return entries;
}

// What a tracker card says about its program (see program.ts): `done/total`,
// the first ready children by name — what can start next — and how many more
// there are, then the in-review and blocked counts. The card shows a count only
// when it is non-zero.
const PROGRAM_READY_NAMED = 3;

export interface ProgramCardSummary {
  progress: string;
  complete: boolean;
  ready: Array<{ id: string; name: string; url: string | null }>;
  readyMore: number;
  inReview: number;
  blocked: number;
}

export function programCardSummary(rollup: ProgramRollup): ProgramCardSummary {
  return {
    progress: `${rollup.done}/${rollup.total}`,
    complete: rollup.done === rollup.total,
    ready: rollup.ready
      .slice(0, PROGRAM_READY_NAMED)
      .map((child) => ({ id: child.id, name: programChildName(child), url: child.item?.url || null })),
    readyMore: Math.max(0, rollup.ready.length - PROGRAM_READY_NAMED),
    inReview: rollup.inReview.length,
    blocked: rollup.blocked,
  };
}
