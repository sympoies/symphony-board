import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_VERSION, GENERATOR } from "../src/contract/version.ts";

type PackageJson = {
  name: string;
  version: string;
};

function rootPackageJson(): PackageJson {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson;
}

test("generator derives from the root package app version", () => {
  const pkg = rootPackageJson();

  assert.equal(APP_VERSION, pkg.version);
  assert.equal(GENERATOR, `${pkg.name}/${pkg.version}`);
});
