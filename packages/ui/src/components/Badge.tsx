// A small pill. `kind` maps to a CSS modifier (badge-open, badge-fulfilled, …).
export function Badge({ text, kind, title }: { text: string; kind?: string; title?: string }) {
  return (
    <span className={`badge${kind ? ` badge-${kind}` : ""}`} title={title ?? text}>
      {text}
    </span>
  );
}
