import type { TouchEvent } from "react";
import type { DetailMove } from "../detail-navigation.ts";

export function DetailNav({
  position, total, canPrevious, canNext, onNavigate, label, noun,
  className = "", chronological = false, hideSingle = true,
}: {
  position: number; total: number; canPrevious: boolean; canNext: boolean;
  onNavigate: (move: DetailMove) => void;
  label: string; noun: string; className?: string; chronological?: boolean; hideSingle?: boolean;
}) {
  if (hideSingle && total <= 1) return null;
  const previous = chronological ? "newer" : "previous";
  const next = chronological ? "older" : "next";
  const touchNavigate = (move: DetailMove, enabled: boolean) => (event: TouchEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (enabled) onNavigate(move);
  };
  return (
    <nav className={`live-detail-nav ${className}`.trim()} aria-label={label}>
      <button type="button" className="live-detail-nav-button" disabled={!canPrevious}
        aria-label={`Show ${previous} ${noun}`} title={`Show ${previous} ${noun}`}
        onTouchStart={(event) => event.stopPropagation()}
        onTouchEnd={touchNavigate("previous", canPrevious)} onClick={() => onNavigate("previous")}>
        ‹ <span>{chronological ? "Newer" : "Prev"}</span>
      </button>
      <span className="live-detail-nav-count" aria-live="polite">{position > 0 ? position : "—"} / {total}</span>
      <button type="button" className="live-detail-nav-button" disabled={!canNext}
        aria-label={`Show ${next} ${noun}`} title={`Show ${next} ${noun}`}
        onTouchStart={(event) => event.stopPropagation()}
        onTouchEnd={touchNavigate("next", canNext)} onClick={() => onNavigate("next")}>
        <span>{chronological ? "Older" : "Next"}</span> ›
      </button>
    </nav>
  );
}
