interface RefreshShortcutEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function isRefreshShortcut(event: RefreshShortcutEventLike): boolean {
  const key = event.key.toLowerCase();
  if (key === "f5") return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (key !== "r") return false;
  return !!(event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}
