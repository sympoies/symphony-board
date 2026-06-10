interface ShortcutEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function isRefreshShortcut(event: ShortcutEventLike): boolean {
  const key = event.key.toLowerCase();
  if (key === "f5") return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (key !== "r") return false;
  return !!(event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

// Cmd+/ (macOS) / Ctrl+/ toggles the hidden Diagnostics page (#/debug). Shift
// is tolerated because "/" is a shifted key on several layouts, so a strict
// no-shift check would break the chord exactly where it is hardest to type.
export function isDebugShortcut(event: ShortcutEventLike): boolean {
  if (event.key !== "/") return false;
  return !!(event.metaKey || event.ctrlKey) && !event.altKey;
}
