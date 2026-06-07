import type { EdgeLifecycle, ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { anchorId, LIFECYCLE_ORDER, type ResolvedEdge } from "../model.ts";

// The spine: issue <-> PR/MR `closes` edges, grouped by derived lifecycle.
// declared = in flight, fulfilled = PR merged + issue closed, broken = PR
// closed unmerged. This is the board's "what's in progress / what landed" view.

const LIFECYCLE_BLURB: Record<EdgeLifecycle | "other", string> = {
  declared: "in flight — change request open / not yet resolved",
  fulfilled: "landed — change request merged and target closed",
  broken: "abandoned — change request closed without merging",
  other: "non-lifecycle links (relates / mentions / …)",
};

// NB: the prop is `refStr`, never `ref` — `ref` is reserved by React (it gets
// intercepted as an element ref, and a string value throws at render time,
// crashing the whole tree). Caught by the headless render e2e, not by tsc/build.
function Endpoint({ item, refStr, role }: { item: ItemDTO | null; refStr: string; role: string }) {
  if (!item) {
    // endpoint in an untracked project — show the raw ref so the link is not lost
    return (
      <span className="endpoint endpoint-untracked" title={`${role} (untracked): ${refStr}`}>
        <span className="muted">{role}</span> {refStr}
      </span>
    );
  }
  return (
    <a className="endpoint" href={`#${anchorId(item.id)}`} title={item.title ?? undefined}>
      <Badge text={item.state} kind={item.state} />
      <span className="endpoint-title">{item.title ?? refStr}</span>
    </a>
  );
}

export function Relationships({ edges }: { edges: ResolvedEdge[] }) {
  if (edges.length === 0) return null;
  const buckets: Array<EdgeLifecycle | "other"> = [...LIFECYCLE_ORDER, "other"];
  return (
    <section className="relationships">
      <h2>Relationships <span className="muted">· issue ↔ PR/MR</span></h2>
      {buckets.map((bucket) => {
        const rows = edges.filter((re) => (re.edge.lifecycle ?? "other") === bucket);
        if (rows.length === 0) return null;
        return (
          <div key={bucket} className={`lifecycle lifecycle-${bucket}`}>
            <h3>
              <Badge text={bucket} kind={`lifecycle-${bucket}`} /> <span className="count">{rows.length}</span>
              <span className="muted blurb">{LIFECYCLE_BLURB[bucket]}</span>
            </h3>
            <ul className="edge-list">
              {rows.map((re, i) => (
                <li key={`${re.edge.from}->${re.edge.to}-${i}`} className="edge-row">
                  <Endpoint item={re.from} refStr={re.edge.from} role="from" />
                  <span className="edge-arrow" title={re.edge.type}>
                    {re.edge.type === "closes" ? "closes →" : `${re.edge.type} →`}
                  </span>
                  <Endpoint item={re.to} refStr={re.edge.to} role="to" />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
