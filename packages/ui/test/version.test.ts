import { test } from "node:test";
import assert from "node:assert/strict";
import { clientBuildMetadata, versionDetails } from "../src/version.ts";

test("version copy contains only client version/build, known surface, and unavailable backend", () => {
  const info = versionDetails({
    version: "2.3.4-rc.1", commit: "abcdef0123456789", token: "private-token",
    account: "private-account", url: "https://private.example", app_version: "9.0.0", contract_version: "4.0.0",
  }, "web", false);
  assert.deepEqual(info, {
    surface: "Web", version: "2.3.4-rc.1", build: "abcdef0", backend: "Unavailable",
    copy: "Client (Web): 2.3.4-rc.1\nBuild: abcdef0\nBackend: Unavailable",
  });
});

test("missing client metadata has explicit independent fallbacks without borrowing contract or backend versions", () => {
  assert.equal(clientBuildMetadata(), null);
  for (const metadata of [null, undefined, {}, { app_version: "9.0.0", contract_version: "4.0.0" }]) {
    const info = versionDetails(metadata, null, false);
    assert.equal(info.version, "Unavailable");
    assert.equal(info.build, "Unavailable");
    assert.equal(info.backend, "Unavailable");
    assert.equal(info.copy, "Client (Web): Unavailable\nBuild: Unavailable\nBackend: Unavailable");
  }
  assert.equal(versionDetails({ version: "2.3.4" }, null, false).build, "Unavailable");
  assert.equal(versionDetails({ commit: "abcdef012" }, null, false).version, "Unavailable");
});

test("unsafe metadata and unknown surface strings never enter version copy", () => {
  const info = versionDetails({ version: "https://private.example", commit: "token=private" }, "private-account", false);
  assert.equal(info.copy, "Client (Web): Unavailable\nBuild: Unavailable\nBackend: Unavailable");
});

test("the shared UI identifies existing native and Web surfaces", () => {
  for (const [kind, tauri, expected] of [[null, false, "Web"], [null, true, "Desktop"], ["android", true, "Android"], ["standalone", true, "Standalone"]] as const) {
    assert.equal(versionDetails({}, kind, tauri).surface, expected);
  }
});
