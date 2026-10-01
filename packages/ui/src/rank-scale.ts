// Axis maths for the ranked-bar charts, kept DOM-free so it can be unit-tested
// and so importing it can never drag the DOM lib into a type-check program that
// does not have one (the same rule layout-tier.ts documents).

// Round an axis ceiling up to the next 1 / 2 / 5 x 10^n step, so the two grid
// lines a rank chart draws land on values a reader can actually do arithmetic
// with (500 / 1k, not 437 / 874).
export function niceAxisMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  if (scaled <= 1) return power;
  if (scaled <= 2) return 2 * power;
  if (scaled <= 5) return 5 * power;
  return 10 * power;
}

// Axis tick text. The charts are narrow — a rail is ~340px wide and a bar's
// column is a fraction of that — so a full count would wrap or clip; 16_526
// reads as "17k".
export function formatAxisValue(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value));
}

// Bar height as a percentage string. Floored at 3% so a non-zero count always
// leaves a visible mark: a repo with 1 commit against a 1000-commit leader still
// has to be clickable, and a bar rounded to 0% is not.
export function rankBarHeight(count: number, axisMax: number): string {
  if (axisMax <= 0) return "3%";
  return `${Math.max(3, Math.round((count / axisMax) * 100))}%`;
}

// A ranked row's name tip says something the row does not: the whole name when
// the row cuts it, and what a click does on a row that toggles a filter. A tip
// that only repeats a name already in full view is noise, and in a row layout it
// covered the row beside it.

// The label's box, or null when the footer draws no name (an avatar only). A
// one-pixel difference is sub-pixel rounding, not a clip; an ellipsis clips by
// width and a line clamp by height.
export type LabelBox = { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number };
export function labelClipped(box: LabelBox | null): boolean {
  if (!box || box.clientWidth === 0) return true;
  return box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1;
}

// A footer may draw a shorter form of the name than the row's label: a
// repository without its group, a branch's last segment. The tip then carries
// the full name even though nothing is cut. Extra text around the name, such as
// a "default" tag, does not count.
export function labelShortened(shownText: string, label: string): boolean {
  return !shownText.includes(label);
}

export function showsNameTip({ clipped, selectable }: { clipped: boolean; selectable: boolean }): boolean {
  return clipped || selectable;
}

export function nameTipText(label: string, { selectable, selected }: { selectable: boolean; selected: boolean }): string {
  if (!selectable) return label;
  return `${label} · ${selected ? "click to clear the filter" : "click to filter"}`;
}

// The control under a list cut at its row limit, which expands it up to `cap`.
export function rankMoreLabel(total: number, cap: number): string {
  return total > cap ? `Show top ${cap} of ${total.toLocaleString("en-US")}` : `Show all ${total}`;
}
