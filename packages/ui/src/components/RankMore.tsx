import { useState } from "react";

// Shared by every bounded ranking. Expansion is local to the mounted panel,
// matching Activity: filters and resizing retain it; leaving the view resets it.
export function RankMore({ total, limit, open, onToggle }: {
  total: number;
  limit: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (total <= limit) return null;
  return (
    <button type="button" className="rank-more" aria-expanded={open} onClick={onToggle}>
      {open ? "Show fewer" : `Show all ${total}`}
    </button>
  );
}

export function useRankedRows<T>(all: readonly T[], limit: number) {
  const [open, setOpen] = useState(false);
  return {
    rows: open ? all : all.slice(0, limit),
    more: <RankMore total={all.length} limit={limit} open={open} onToggle={() => setOpen(value => !value)} />,
  };
}
