// Markdown renderer for UNTRUSTED webhook bodies. GitHub/GitLab bodies mix
// markdown with a little inline HTML (e.g. `<sub>` badges), so raw HTML IS
// parsed (rehype-raw) but then sanitized against a hardened allowlist
// (`liveMarkdownSchema` — the default GitHub schema minus `<img>`): safe inline
// tags like sub/sup survive, while remote `<img>` (tracking pixels), `<script>`,
// event handlers, and `javascript:`/`data:` URLs are stripped. Surviving link
// hrefs additionally pass the safeHref scheme guard, and links open in a new
// tab. Default-exported so the Live tab can lazy-load it — react-markdown + the
// rehype/remark plugins then form their own chunk, out of the board bundle.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { liveMarkdownSchema } from "../markdownSchema.ts";
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
        rehypePlugins={[rehypeRaw, [rehypeSanitize, liveMarkdownSchema]]}
        urlTransform={(url) => safeHref(url) ?? ""}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
