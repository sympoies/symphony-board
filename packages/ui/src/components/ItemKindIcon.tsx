const ITEM_KIND_LABELS: Record<string, string> = {
  issue: "issue",
  change_request: "change request",
};

function iconClass(kind: string, className?: string): string {
  const key = kind === "change_request" ? "pr" : kind === "issue" ? "issue" : "unknown";
  return ["icon-item-kind", `icon-item-kind-${key}`, className].filter(Boolean).join(" ");
}

export function itemKindLabel(kind: string): string {
  return ITEM_KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

export function ItemKindIcon({ kind, className }: { kind: string; className?: string }) {
  const label = itemKindLabel(kind);
  if (kind === "change_request") {
    return (
      <svg
        className={iconClass(kind, className)}
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <circle cx="6" cy="6" r="2.4" />
        <circle cx="6" cy="18" r="2.4" />
        <circle cx="18" cy="18" r="2.4" />
        <path d="M6 8.4v7.2" />
        <path d="M8.4 6H12a6 6 0 0 1 6 6v3.6" />
      </svg>
    );
  }
  if (kind === "issue") {
    return (
      <svg
        className={iconClass(kind, className)}
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <circle cx="12" cy="12" r="7.3" />
        <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg
      className={iconClass(kind, className)}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
