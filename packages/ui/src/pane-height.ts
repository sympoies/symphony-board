// Shared content panes fill the viewport below their split/header while keeping
// a small bottom gutter. `min` is a soft target: on short windows, honor the
// actually available space instead of forcing document-level scrolling.
export function clampContentPaneHeight(
  innerHeight: number,
  splitTop: number,
  bottomGutter: number,
  min: number,
): number {
  const available = Math.floor(innerHeight - splitTop - bottomGutter);
  if (available <= min) return Math.max(0, available);
  return available;
}
