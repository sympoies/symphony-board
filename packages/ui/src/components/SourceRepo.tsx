import { EntityLink } from "./ExternalLink.tsx";
import { SourceIcon } from "./SourceIcon.tsx";

// The "provider mark + repo path" pair that opens every meta row — the item
// card, the activity feed, and the commit timeline all lead with it. The
// SourceIcon renders nothing for an absent/unknown provider, and the repo name
// is dropped when there is no path, so callers can pass either field loosely.
// The explicit sourceId resolves the configured provider instance.
// Returns a fragment so it drops straight into an existing flex meta row.
export function SourceRepo({ kind, repo, sourceId }: { kind?: string; repo?: string | null; sourceId?: string | null }) {
  return (
    <>
      <SourceIcon kind={kind} />
      {repo ? <EntityLink className="card-repo nodrag" sourceId={sourceId} entity={{ kind: "repo", projectPath: repo }}>{repo}</EntityLink> : null}
    </>
  );
}
