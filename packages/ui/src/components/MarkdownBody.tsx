import { lazy, memo, Suspense } from "react";

// react-markdown + remark-gfm are lazy-loaded so they form their own chunk and
// stay out of the core bundles until a body-rendering surface needs them.
const Markdown = lazy(() => import("./Markdown.tsx"));

// Memoized so incidental page re-renders do not re-parse unchanged markdown.
// Falls back to the plain text while the markdown chunk loads, so body surfaces
// never flash empty.
export const MarkdownBody = memo(function MarkdownBody({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<div className={className}><div className="live-md-fallback">{text}</div></div>}>
      <Markdown className={className}>{text}</Markdown>
    </Suspense>
  );
});
