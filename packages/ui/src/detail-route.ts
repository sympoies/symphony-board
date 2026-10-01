import { buildHashRoute, parseHashRoute } from "./model.ts";

const DETAIL_ROUTES = {
  live: { field: "liveDetail", marker: "symphonyLiveDetail" },
  reviews: { field: "reviewDetail", marker: "symphonyReviewDetail" },
  items: { field: "itemDetail", marker: "symphonyItemDetail" },
  commits: { field: "commitDetail", marker: "symphonyCommitDetail" },
  activity: { field: "activityDetail", marker: "symphonyActivityDetail" },
} as const;

interface DetailRouteHost {
  readHash: () => string;
  setHash: (hash: string) => void;
  history: Pick<History, "state" | "pushState" | "replaceState" | "back">;
}

// A UI-opened reader owns one history entry. A restored/shared reader flag has
// no such entry, so closing it replaces the flag instead of leaving the page.
export function detailRouteController(page: keyof typeof DETAIL_ROUTES, host: DetailRouteHost) {
  const { field, marker } = DETAIL_ROUTES[page];
  const hash = (open: boolean) => {
    const current = parseHashRoute(host.readHash());
    return current.page === page ? buildHashRoute({ ...current, [field]: open ? "1" : null }) : null;
  };
  const state = (): Record<string, unknown> => {
    const value = host.history.state;
    return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  };
  const clear = () => {
    const next = hash(false);
    if (!next || next === host.readHash()) return;
    const nextState = state();
    delete nextState[marker];
    host.history.replaceState(nextState, "", next);
    host.setHash(next);
  };
  return {
    open() {
      const next = hash(true);
      if (!next || next === host.readHash()) return;
      host.history.pushState({ ...state(), [marker]: true }, "", next);
      host.setHash(next);
    },
    clear,
    close() {
      const current = parseHashRoute(host.readHash());
      if (current.page !== page || current[field] !== "1") return;
      const next = hash(false);
      if (state()[marker] === true) {
        host.history.back();
        if (next) host.setHash(next);
      } else clear();
    },
  };
}
