import type { LiveEventActor } from "./model.ts";
import { safeHref } from "./url.ts";

export interface LiveAvatarModel {
  label: string;
  initials: string;
  imageUrl: string | null;
  profileUrl: string | null;
}

function safeHttpUrl(value: string | null | undefined): string | null {
  const href = safeHref(value);
  if (!href) return null;
  return href.startsWith("http://") || href.startsWith("https://") ? href : null;
}

function initialsFor(label: string): string {
  if (label === "someone") return "?";
  const display = label.replace(/\[[^\]]+\]$/u, "").trim() || label;
  const parts = display.match(/[a-z0-9]+/gi) ?? [];
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[1]?.[0] ?? "") : "";
  return `${first}${second}`.toUpperCase() || "?";
}

export function liveAvatarModel(actor: LiveEventActor | null | undefined): LiveAvatarModel {
  const label = actor?.display_name || actor?.login || "someone";
  return {
    label,
    initials: initialsFor(label),
    imageUrl: safeHttpUrl(actor?.avatar_url),
    profileUrl: safeHttpUrl(actor?.profile_url),
  };
}
