import type { LabelDTO } from "@symphony-board/contract";

// One label. Providers differ: GitHub gives a bare hex ("ededed"), GitLab a
// "#rrggbb". We normalize and use it as a left accent. A scoped "a::b" label
// (mutually exclusive per scope on GitLab) is rendered with the scope dimmed.
export function LabelChip({ label }: { label: LabelDTO }) {
  const hex = label.color ? `#${label.color.replace(/^#/, "")}` : null;
  const style = hex ? { borderLeftColor: hex } : undefined;
  if (label.scope) {
    const value = label.name.slice(label.scope.length + 2); // strip "scope::"
    return (
      <span className="chip chip-scoped" style={style} title={`scope: ${label.scope}`}>
        <span className="chip-scope">{label.scope}</span>
        <span className="chip-value">{value || label.name}</span>
      </span>
    );
  }
  return (
    <span className="chip" style={style}>
      {label.name}
    </span>
  );
}
