import type { DebugTab } from "./nav.ts";

export interface DebugRefreshActions {
  refreshContract: () => Promise<boolean>;
  refreshStore: () => void;
  refreshLive: () => void;
  refreshTokenRates: () => void;
  refreshLogs: () => void;
}

export async function refreshDebugTab(tab: DebugTab, actions: DebugRefreshActions): Promise<void> {
  if (tab === "contract") {
    const loadedContract = await actions.refreshContract();
    if (!loadedContract) actions.refreshStore();
    return;
  }
  if (tab === "store" || tab === "sync") {
    actions.refreshStore();
    return;
  }
  if (tab === "live") {
    actions.refreshLive();
    return;
  }
  if (tab === "ratelimit") {
    actions.refreshTokenRates();
    return;
  }
  if (tab === "log") {
    actions.refreshLogs();
  }
}
