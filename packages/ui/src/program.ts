import type { EdgeDTO, ItemDTO } from "@symphony-board/contract";

// The program model: how far a tracker's program is, and what can start next.
// Pure and view-agnostic — it reads only loaded items and edges.
//
//   children  the targets of the tracker's `parent` edges, one per distinct
//             child; a tracker is never its own child.
//   state     an endpoint's state is its loaded item row's when there is one —
//             the edge's `from_state` / `to_state` is as of the tracker's last
//             sync — and the edge's otherwise. Unknown counts as open.
//   status    done       closed or merged;
//             blocked    else, a `blocks` edge into the child comes from an
//                        item that is not done (whichever tracker reported it);
//             in_review  else, a `closes` edge into the child comes from an
//                        item that is still open;
//             ready      otherwise.
//
// Children are ordered by iid, then title, then ref; a child without an item
// row has neither and sorts last, by ref.

export type ProgramChildStatus = "done" | "blocked" | "in_review" | "ready";

export interface ProgramChild {
  /** the child's ref (`source_id|external_id`). */
  id: string;
  /** the child's loaded item row; null when only the edge knows it. */
  item: ItemDTO | null;
  /** the state the status was derived from; null when unknown (read as open). */
  state: string | null;
  status: ProgramChildStatus;
}

export interface ProgramRollup {
  total: number;
  done: number;
  ready: ProgramChild[];
  inReview: ProgramChild[];
  blocked: number;
  /** every child with its status, in the order above. */
  children: ProgramChild[];
}

const isDone = (state: string | null): boolean => state === "closed" || state === "merged";

function compareChildren(a: ProgramChild, b: ProgramChild): number {
  if (!a.item || !b.item) return Number(!a.item) - Number(!b.item) || a.id.localeCompare(b.id);
  return (
    (a.item.iid ?? Infinity) - (b.item.iid ?? Infinity) ||
    (a.item.title ?? "").localeCompare(b.item.title ?? "") ||
    a.id.localeCompare(b.id)
  );
}

// Every tracker's rollup, keyed by tracker ref, in one pass over the edges. A
// ref with no `parent` edge to another item has no entry.
export function programRollups(itemsById: ReadonlyMap<string, ItemDTO>, edges: readonly EdgeDTO[]): Map<string, ProgramRollup> {
  const stateOf = (id: string, edgeState: string | null): string | null => itemsById.get(id)?.state ?? edgeState;
  const childStates = new Map<string, Map<string, string | null>>(); // tracker -> child -> state
  const blocked = new Set<string>();
  const inReview = new Set<string>();
  for (const edge of edges) {
    if (edge.type === "parent") {
      if (edge.from === edge.to) continue;
      let children = childStates.get(edge.from);
      if (!children) childStates.set(edge.from, (children = new Map()));
      if (!children.has(edge.to)) children.set(edge.to, stateOf(edge.to, edge.to_state));
    } else if (edge.type === "blocks") {
      if (!isDone(stateOf(edge.from, edge.from_state))) blocked.add(edge.to);
    } else if (edge.type === "closes") {
      if ((stateOf(edge.from, edge.from_state) ?? "open") === "open") inReview.add(edge.to);
    }
  }

  const rollups = new Map<string, ProgramRollup>();
  for (const [trackerId, states] of childStates) {
    const children = [...states]
      .map(([id, state]): ProgramChild => ({
        id,
        item: itemsById.get(id) ?? null,
        state,
        status: isDone(state) ? "done" : blocked.has(id) ? "blocked" : inReview.has(id) ? "in_review" : "ready",
      }))
      .sort(compareChildren);
    const withStatus = (status: ProgramChildStatus) => children.filter((child) => child.status === status);
    rollups.set(trackerId, {
      total: children.length,
      done: withStatus("done").length,
      ready: withStatus("ready"),
      inReview: withStatus("in_review"),
      blocked: withStatus("blocked").length,
      children,
    });
  }
  return rollups;
}

// One tracker's rollup; null when it has no children, so a view shows no
// progress rather than 0/0.
export function programRollup(trackerId: string, itemsById: ReadonlyMap<string, ItemDTO>, edges: readonly EdgeDTO[]): ProgramRollup | null {
  return programRollups(itemsById, edges).get(trackerId) ?? null;
}

// What to call a child: its title; `repo#iid` for a row without one; the ref's
// external id when there is no item row at all.
export function programChildName(child: ProgramChild): string {
  const item = child.item;
  if (item?.title) return item.title;
  if (item && item.iid != null) return `${item.project_path ?? ""}#${item.iid}`;
  return child.id.slice(child.id.indexOf("|") + 1);
}
