// Sanitize schema for UNTRUSTED markdown (provider / webhook bodies rendered in
// the Live feed). rehype-sanitize's default (GitHub) schema permits `<img>`, and
// our `urlTransform` passes `http(s)` image srcs through unchanged — so an
// attacker-controlled body like `![x](https://attacker.example/pixel)` would
// render an `<img>` the browser auto-fetches on render, leaking every reader's
// IP and User-Agent to an arbitrary host (a tracking-pixel / SSRF-adjacent
// vector). These bodies are read-only and gain nothing from remote images, so we
// drop `<img>` entirely from the allowlist. The safe inline tags the provider
// badges rely on (`sub` / `sup`) and links are unaffected.
import { defaultSchema, type Options } from "rehype-sanitize";

// Drop the now-unreachable `img` attribute entry too, so the schema reads clean.
const { img: _img, ...attributesWithoutImg } = defaultSchema.attributes ?? {};

export const liveMarkdownSchema: Options = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "img"),
  attributes: attributesWithoutImg,
};
