import { EntityLink } from "./ExternalLink.tsx";
import type { LabelDTO } from "@symphony-board/contract";

// One label. Providers differ: GitHub gives a bare hex ("ededed"), GitLab a
// "#rrggbb". We normalize and use it as a left accent. A scoped "a::b" label
// (mutually exclusive per scope on GitLab) is rendered with the scope dimmed.
export function LabelChip({ label, sourceId, projectPath }: { label: LabelDTO; sourceId?: string; projectPath?: string | null }) {
  const hex = label.color ? `#${label.color.replace(/^#/, "")}` : null;
  const style = hex ? { borderLeftColor: hex } : undefined;
  if (label.scope) {
    const value = label.name.slice(label.scope.length + 2); // strip "scope::"
    return (
      <EntityLink sourceId={sourceId} entity={{ kind: "label", projectPath, label: label.name }} className="chip chip-scoped" style={style} title={`scope: ${label.scope}`}>
        <span className="chip-scope">{label.scope}</span>
        <span className="chip-value">{value || label.name}</span>
      </EntityLink>
    );
  }
  return (
    <EntityLink sourceId={sourceId} entity={{ kind: "label", projectPath, label: label.name }} className="chip" style={style}>
      {label.name}
    </EntityLink>
  );
}
