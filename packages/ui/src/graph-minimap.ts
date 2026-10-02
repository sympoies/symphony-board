// Graph minimap sizing. Compact layouts (width or height up to 760px) keep a
// small fixed minimap so it never covers much of a phone canvas. Everywhere else
// it scales with the graph pane: about 15% of the pane width at 4:3, never
// smaller than React Flow's default 200x150 and never larger than 360x270, so a
// very wide window does not shrink the nodes into an unreadable cluster inside a
// tiny corner map.
export const MINIMAP_COMPACT = { width: 112, height: 84 } as const;
export const MINIMAP_MIN_WIDTH_PX = 200;
export const MINIMAP_MAX_WIDTH_PX = 360;
export const MINIMAP_PANE_FRACTION = 0.15;

export function minimapSize(paneWidth: number, compact: boolean): { width: number; height: number } {
  if (compact) return { ...MINIMAP_COMPACT };
  const scaled = Number.isFinite(paneWidth) ? Math.round(paneWidth * MINIMAP_PANE_FRACTION) : 0;
  const width = Math.min(MINIMAP_MAX_WIDTH_PX, Math.max(MINIMAP_MIN_WIDTH_PX, scaled));
  return { width, height: Math.round((width * 3) / 4) };
}
