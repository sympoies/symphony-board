import { useLayoutEffect, useRef, type ReactNode } from "react";

export function ControlDisclosure({ open, controls, label, summary, className, ariaLabel, disabled, onClick }: {
  open: boolean; controls: string; label?: string; summary: string; className: string;
  ariaLabel?: string; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`filter-summary-disclosure ${className}`}
      aria-expanded={open} aria-controls={controls}
      aria-label={ariaLabel ?? `${open ? "Hide" : "Show"} ${label}`}
      disabled={disabled} onClick={onClick}>
      {label ? <span className="filter-summary-disclosure-label">{label}</span> : null}
      <span className="filter-summary-disclosure-summary">{summary}</span>
      {label ? <span className="filter-summary-disclosure-caret" aria-hidden="true" /> : null}
    </button>
  );
}

export function MobileControlSheet({ id, titleId, panel, title, closeLabel = "Close controls", onClose, headerAction, children }: {
  id: string; titleId: string; panel: string; title: string; closeLabel?: string;
  onClose: () => void; headerAction?: ReactNode; children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // Initial focus and returning to the disclosure are owned by this shell, so
  // every phone control follows the same keyboard lifecycle.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || sheet.getClientRects().length === 0) return;
    const opener = document.activeElement;
    const first = sheet.querySelector<HTMLElement>(
      "input:not(:disabled), select:not(:disabled), textarea:not(:disabled), .mobile-control-sheet-body button:not(:disabled)",
    ) ?? sheet.querySelector<HTMLElement>(".mobile-control-sheet-close");
    first?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected &&
          (sheet.contains(document.activeElement) || document.activeElement === document.body)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [id]);
  return (
    <>
      <button type="button" className="mobile-control-backdrop" aria-label={closeLabel} onClick={onClose} />
      <div ref={sheetRef} id={id} className="mobile-control-sheet" data-panel={panel}
        role="dialog" aria-modal="false" aria-labelledby={titleId}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <div className="mobile-control-sheet-head">
          <strong id={titleId} className="mobile-control-sheet-title">{title}</strong>
          {headerAction}
          <button type="button" className="mobile-control-sheet-close" aria-label={closeLabel} onClick={onClose}>×</button>
        </div>
        <div className="mobile-control-sheet-body">{children}</div>
      </div>
    </>
  );
}
