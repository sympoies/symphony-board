export type DetailMove = "previous" | "next";

// Newer-first row order belongs to the caller; reader position and boundaries
// are the same for every detail pane.
export function detailNavigation<T>(rows: readonly T[], index: number) {
  return {
    index,
    position: index >= 0 ? index + 1 : 0,
    total: rows.length,
    previous: index > 0 ? rows[index - 1]! : null,
    next: index >= 0 && index + 1 < rows.length ? rows[index + 1]! : null,
  };
}

export function detailSwipeMove(dx: number, dy: number, elapsed: number): DetailMove | null {
  if (elapsed > 1100 || Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.3) return null;
  return dx < 0 ? "next" : "previous";
}

export function scrollCanConsumeSwipe(scrollWidth: number, clientWidth: number, scrollLeft: number, dx: number): boolean {
  const max = Math.max(0, scrollWidth - clientWidth);
  return max > 2 && ((dx < 0 && scrollLeft < max - 2) || (dx > 0 && scrollLeft > 2));
}
