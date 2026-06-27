import type { ItemDTO } from "@symphony-board/contract";
import { reviewThreadsLabel, type RelationCount } from "./model.ts";

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
