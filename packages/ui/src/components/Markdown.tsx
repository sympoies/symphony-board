// Safe markdown renderer for UNTRUSTED webhook bodies. Raw HTML is off
// (react-markdown renders to React elements, never dangerouslySetInnerHTML), so
// an event body cannot inject markup; link hrefs are scheme-guarded via safeHref
// (http/https/mailto only), defeating `javascript:`/`data:` URLs, and links open
// in a new tab. Default-exported so the Live tab can lazy-load it — react-markdown
// + remark-gfm then form their own chunk and stay out of the board/graph bundles.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeHref } from "../url.ts";

const components: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  },
};

export default function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ?? "live-md"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => safeHref(url) ?? ""}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
