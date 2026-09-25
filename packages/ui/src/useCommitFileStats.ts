import { useEffect, useState } from "react";
import { fetchCommitFileStats, type CommitFileStats } from "./contract.ts";

// The fetch state the changed-files block renders. It is a state machine rather
// than `stats | null` because every non-ready branch has something to say: the
// viewer turned this on deliberately, so "why is there no list" has to be
// answerable in place.
export type CommitFileStatsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; stats: CommitFileStats };

// One request per commit while the Settings toggle is on or a phone detail
// view is open. Keyed on the commit identity so following a newer head re-requests, and
// aborted on unmount/change so a slow provider cannot land its answer against a
// later commit.
//
// It lives here rather than in a component because the commit is chosen in
// CommitsPage while the list is rendered in the digest rail beside it.
export function useCommitFileStats(
  enabled: boolean,
  sourceId: string | null,
  projectPath: string | null,
  sha: string | null,
): CommitFileStatsState {
  const [state, setState] = useState<CommitFileStatsState>({ kind: "idle" });

  useEffect(() => {
    if (!enabled || !sourceId || !projectPath || !sha) {
      setState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetchCommitFileStats(sourceId, projectPath, sha, undefined, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      setState(outcome.ok ? { kind: "ready", stats: outcome.stats } : { kind: "error", message: outcome.message });
    });
    return () => controller.abort();
  }, [enabled, sourceId, projectPath, sha]);

  return state;
}
