import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION } from "../src/contract/version.ts";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function semverParts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return [major, minor, patch];
}

function documentedVersions(markdown: string): string[] {
  const versions = new Set<string>();
  for (const pattern of [/\bVersion `(\d+\.\d+\.\d+)`/g, /\badded in `(\d+\.\d+\.\d+)`/gi]) {
    for (const match of markdown.matchAll(pattern)) {
      const version = match[1];
      if (version) versions.add(version);
    }
  }
  return [...versions].sort((a, b) => {
    const aa = semverParts(a);
    const bb = semverParts(b);
    return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
  });
}

test("current contract version is documented in the public contract docs", () => {
  const current = new RegExp(`\\b${escapeRe(CONTRACT_VERSION)}\\b`);
  for (const path of ["README.md", "docs/DESIGN.md", "docs/CONTRACT.md", "packages/contract/README.md"]) {
    assert.match(read(path), current, `${path} should mention current contract version ${CONTRACT_VERSION}`);
  }
});

test("package contract README summarizes the canonical contract version history", () => {
  const canonicalVersions = documentedVersions(read("docs/CONTRACT.md"));
  assert.ok(canonicalVersions.includes(CONTRACT_VERSION), "docs/CONTRACT.md should include a Version note for the current contract version");

  const packageReadme = read("packages/contract/README.md");
  const missing = canonicalVersions.filter((version) => !packageReadme.includes(`Version \`${version}\``));
  assert.deepEqual(missing, [], `packages/contract/README.md is missing version summaries: ${missing.join(", ")}`);
});
