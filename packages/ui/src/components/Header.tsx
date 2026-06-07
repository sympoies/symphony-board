import type { ContractEnvelope } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { relativeTime } from "../model.ts";

// Title + contract provenance + per-source health, so a viewer can immediately
// see whether the data is fresh and whether any source last synced partial/error.
export function Header({ env }: { env: ContractEnvelope }) {
  return (
    <header className="app-header">
      <div className="brand">
        <h1>symphony-board</h1>
        <span className="muted">
          contract {env.contract_version} · {env.generator} · emitted {relativeTime(env.generated_at)}
        </span>
      </div>
      <div className="sources">
        {env.sources.map((s) => (
          <span key={s.source_id} className="source-chip" title={`${s.kind} @ ${s.host}`}>
            <Badge text={s.last_status ?? "unknown"} kind={`status-${s.last_status ?? "unknown"}`} />
            <span className="source-name">{s.display_name ?? s.source_id}</span>
            <span className="muted">ok {relativeTime(s.last_success_at)}</span>
          </span>
        ))}
      </div>
    </header>
  );
}
