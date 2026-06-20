import { test } from "node:test";
import assert from "node:assert/strict";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { liveMarkdownSchema } from "../src/markdownSchema.ts";

// An untrusted provider/webhook body, as hast: a remote tracking image plus the
// safe inline tags the provider badges and links rely on.
const untrustedTree = {
  type: "root",
  children: [
    {
      type: "element",
      tagName: "img",
      properties: { src: "https://attacker.example/pixel.png", alt: "x" },
      children: [],
    },
    {
      type: "element",
      tagName: "sub",
      properties: {},
      children: [{ type: "text", value: "P2" }],
    },
    {
      type: "element",
      tagName: "a",
      properties: { href: "https://example.com" },
      children: [{ type: "text", value: "link" }],
    },
  ],
};

// Run the same rehype-sanitize transform react-markdown applies and collect the
// element tag names that survive.
function survivingTags(schema, tree) {
  const out = rehypeSanitize(schema)(structuredClone(tree)) ?? tree;
  const tags = [];
  const walk = (node) => {
    if (node.tagName) tags.push(node.tagName);
    for (const child of node.children ?? []) walk(child);
  };
  walk(out);
  return tags;
}

test("hazard: the upstream default schema renders untrusted <img> (the vector we close)", () => {
  // Documents why the fix exists: rehype-sanitize's default GitHub schema lets
  // <img> through, so an attacker-controlled body auto-fetches a remote image.
  assert.ok((defaultSchema.tagNames ?? []).includes("img"));
  assert.ok(survivingTags(defaultSchema, untrustedTree).includes("img"));
});

test("liveMarkdownSchema strips untrusted remote <img> so it never auto-fetches", () => {
  assert.ok(
    !(liveMarkdownSchema.tagNames ?? []).includes("img"),
    "img must not be in the allowed tag set",
  );
  const tags = survivingTags(liveMarkdownSchema, untrustedTree);
  assert.ok(!tags.includes("img"), `expected no <img>, got: ${tags.join(",")}`);
});

test("liveMarkdownSchema keeps the safe inline tags badges and links rely on", () => {
  const tags = survivingTags(liveMarkdownSchema, untrustedTree);
  assert.ok(tags.includes("sub"), "the <sub> badge tag must survive");
  assert.ok(tags.includes("a"), "links must survive");
});
