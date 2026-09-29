import { useRef, type TouchEvent } from "react";
import { detailSwipeMove, scrollCanConsumeSwipe, type DetailMove } from "./detail-navigation.ts";

export function useDetailSwipe(
  identity: string | null,
  onNavigate: (move: DetailMove) => void,
  allowTarget?: (target: Element) => boolean,
) {
  const startRef = useRef<{
    identity: string; x: number; y: number; time: number;
    scroller: HTMLElement | null; scrollLeft: number;
  } | null>(null);
  const handleDetailTouchCancel = () => { startRef.current = null; };
  const handleDetailTouchStart = (event: TouchEvent<HTMLElement>) => {
    startRef.current = null;
    const target = event.target;
    if (!identity || event.touches.length !== 1 || !(target instanceof Element)) return;
    if (target.closest("a, button, input, textarea, select, summary, [role='button']")) return;
    if (allowTarget && !allowTarget(target)) return;
    const candidate = target.closest("table, pre");
    const scroller = candidate instanceof HTMLElement && candidate.scrollWidth > candidate.clientWidth + 2 ? candidate : null;
    const touch = event.touches[0]!;
    startRef.current = {
      identity, x: touch.clientX, y: touch.clientY, time: Date.now(),
      scroller, scrollLeft: scroller?.scrollLeft ?? 0,
    };
  };
  const handleDetailTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = startRef.current;
    startRef.current = null;
    if (!start || start.identity !== identity || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0]!;
    const dx = touch.clientX - start.x;
    const move = detailSwipeMove(dx, touch.clientY - start.y, Date.now() - start.time);
    if (!move) return;
    if (start.scroller && scrollCanConsumeSwipe(start.scroller.scrollWidth, start.scroller.clientWidth, start.scrollLeft, dx)) return;
    onNavigate(move);
  };
  return { handleDetailTouchStart, handleDetailTouchEnd, handleDetailTouchCancel };
}
