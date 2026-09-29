// One request at a time. Wake events can request a tick without bypassing the
// in-flight guard; the next cadence begins after completion, not after launch.
export interface SerialPoll {
  trigger: () => void;
  stop: () => void;
}

export function serialPoll(tick: (signal: AbortSignal) => Promise<void>, intervalMs: number, immediate = false): SerialPoll {
  const controller = new AbortController();
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const trigger = () => {
    if (controller.signal.aborted || running) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    running = true;
    void (async () => {
      try { await tick(controller.signal); }
      catch { /* each consumer owns error state; scheduling remains available */ }
      finally {
        running = false;
        if (!controller.signal.aborted) timer = setTimeout(trigger, intervalMs);
      }
    })();
  };
  if (immediate) trigger();
  else timer = setTimeout(trigger, intervalMs);
  return {
    trigger,
    stop: () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    },
  };
}
