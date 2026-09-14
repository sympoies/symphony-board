import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Node must not run under emulation during a multi-arch image build.
//
// The published images are linux/amd64 + linux/arm64, and CI builds arm64 on an
// amd64 runner through QEMU. Any stage that runs Node or pnpm on the TARGET
// platform therefore runs it emulated, and QEMU's arm64 emulation is not
// reliable for what Node 24 emits: the v1.22.0 release failed twice in a row
// with `qemu: uncaught target signal 4 (Illegal instruction)` inside pnpm, while
// the identical build succeeded under a local QEMU of a different version.
//
// The fix is not to chase emulator versions. Both images' dependency and build
// work is architecture-independent — the production tree is pure JavaScript
// (postgres.js ships no native binding) and the UI build emits static assets —
// so those stages belong on $BUILDPLATFORM, where they run natively and the
// emulator never enters the picture.
//
// ui.Dockerfile already did this. Dockerfile did not, which is exactly why the
// board image was the one that died.

const NODE_TOOLS = new Set(["node", "npm", "npx", "pnpm", "corepack", "yarn"]);

// The words appear constantly as PATHS — `rm -rf .../npm`, `chmod pnpm-lock.yaml`,
// `chown node:node` — so a substring match reports the whole file. What matters
// is whether one is the command being invoked, which means looking at the head
// of each command in the shell line.
function invokedTools(runLine) {
  return runLine
    .replace(/^RUN\s+/i, "")
    .split(/&&|\|\||[;|]/)
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .map((head) => head.replace(/^.*\//, "")) // /usr/local/bin/pnpm -> pnpm
    .filter((head) => NODE_TOOLS.has(head));
}

// Join backslash continuations so a multi-line RUN is analysed as one command.
function runCommands(source) {
  const joined = source.replace(/\\\r?\n\s*/g, " ");
  const out = [];
  let stage = null;
  for (const raw of joined.split("\n")) {
    const line = raw.trim();
    if (/^FROM\s/i.test(line)) {
      stage = line;
      continue;
    }
    if (/^RUN\s/i.test(line) && stage !== null) out.push({ stage, line });
  }
  return out;
}

const DOCKERFILES = [
  { path: "docker/Dockerfile", label: "board" },
  { path: "docker/ui.Dockerfile", label: "web" },
];

for (const { path, label } of DOCKERFILES) {
  test(`${label} image invokes no Node tooling on the target platform`, () => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    const offenders = runCommands(source)
      .filter(({ stage }) => /node:/.test(stage) && !/--platform=\$\{?BUILDPLATFORM\}?/.test(stage))
      .map(({ stage, line }) => ({ stage, tools: invokedTools(line), line }))
      .filter(({ tools }) => tools.length > 0);

    assert.deepEqual(
      offenders.map((o) => `${o.stage} -> ${o.tools.join(", ")}`),
      [],
      `${path}: these stages invoke Node tooling on the TARGET platform, so a cross-arch build runs it under QEMU:\n` +
        offenders.map((o) => `  ${o.stage}\n    ${o.line.slice(0, 100)}`).join("\n"),
    );
  });
}

test("the detector actually catches an emulated install", () => {
  // Guard the guard. The first cut of this matched the words anywhere in the
  // line and reported `rm -rf .../npm`, `chmod pnpm-lock.yaml` and
  // `chown node:node` as emulated installs — three false positives and no way
  // to tell them from a real one.
  const bad = `FROM node:24-alpine\nRUN corepack enable && pnpm install --prod\n`;
  const offenders = runCommands(bad).filter(({ stage }) => !/BUILDPLATFORM/.test(stage));
  assert.deepEqual(invokedTools(offenders[0].line), ["corepack", "pnpm"]);

  const pathsOnly = `FROM node:24-alpine\nRUN rm -rf /usr/local/lib/node_modules/npm && chmod a+r pnpm-lock.yaml && chown -R node:node /app\n`;
  assert.deepEqual(invokedTools(runCommands(pathsOnly)[0].line), [], "paths are not invocations");
});

test("the board image takes its dependency tree from a build-platform stage", () => {
  const source = readFileSync(new URL("../docker/Dockerfile", import.meta.url), "utf8");

  // The pairing that makes the above safe: install on the builder, copy the
  // result into the target-arch runtime. Both halves, because either alone is
  // wrong — a builder stage nothing copies from is dead weight, and a COPY from
  // a target-platform stage is back to emulated installs.
  assert.match(
    source,
    /FROM --platform=\$BUILDPLATFORM node:[^\s]+ AS deps/,
    "the dependency stage must be pinned to the build platform",
  );
  assert.match(
    source,
    /COPY --from=deps \/app\/node_modules \.\/node_modules/,
    "the runtime stage must take node_modules from that stage",
  );
});
