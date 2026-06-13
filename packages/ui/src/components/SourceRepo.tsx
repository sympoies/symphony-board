import { SourceIcon } from "./SourceIcon.tsx";

// The "provider mark + repo path" pair that opens every meta row — the item
// card, the activity feed, and the commit timeline all lead with it. The
// SourceIcon renders nothing for an absent/unknown provider, and the repo span
// is dropped when there is no path, so callers can pass either field loosely.
// Returns a fragment so it drops straight into an existing flex meta row.
export function SourceRepo({ kind, repo }: { kind?: string; repo?: string | null }) {
  return (
    <>
      <SourceIcon kind={kind} />
      {repo ? <span className="card-repo">{repo}</span> : null}
    </>
  );
}
