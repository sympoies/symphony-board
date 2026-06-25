import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSigning, injectReleaseSigning } from "../packages/android/scripts/lib/android-signing.mjs";

// A minimal stand-in for the generated app/build.gradle.kts — only the lines the
// signing injection anchors on.
const FIXTURE_GRADLE = `import java.util.Properties

android {
    compileSdk = 36
    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles()
        }
    }
}
`;

const ENV = {
  ANDROID_KEYSTORE_FILE: "/abs/release.jks",
  ANDROID_KEYSTORE_PASSWORD: "pw-store",
  ANDROID_KEY_ALIAS: "symphony-board",
  ANDROID_KEY_PASSWORD: "pw-key",
};

test("resolveSigning reads a complete env set (CI path)", () => {
  assert.deepEqual(resolveSigning(ENV, "/nonexistent.properties"), {
    storeFile: "/abs/release.jks",
    storePassword: "pw-store",
    keyAlias: "symphony-board",
    keyPassword: "pw-key",
  });
});

test("resolveSigning returns null when env is incomplete and no props file (keyless build)", () => {
  assert.equal(resolveSigning({ ANDROID_KEYSTORE_FILE: "/x" }, "/nonexistent.properties"), null);
  assert.equal(resolveSigning({}, "/nonexistent.properties"), null);
});

test("resolveSigning falls back to a local keystore.properties", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-signing-"));
  try {
    const props = join(dir, "keystore.properties");
    writeFileSync(props, "# comment\nstoreFile=rel/release.jks\nstorePassword=ps\nkeyAlias=al\nkeyPassword=pk\n");
    assert.deepEqual(resolveSigning({}, props), {
      storeFile: "rel/release.jks",
      storePassword: "ps",
      keyAlias: "al",
      keyPassword: "pk",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("injectReleaseSigning patches gradle + writes keystore.properties, idempotently", () => {
  const gen = mkdtempSync(join(tmpdir(), "sb-gen-"));
  try {
    mkdirSync(join(gen, "app"), { recursive: true });
    const gradlePath = join(gen, "app", "build.gradle.kts");
    writeFileSync(gradlePath, FIXTURE_GRADLE);

    const first = injectReleaseSigning({
      genAndroidDir: gen,
      signing: { storeFile: "/abs/release.jks", storePassword: "ps", keyAlias: "al", keyPassword: "pk" },
      baseDir: gen,
    });
    assert.equal(first, true);

    const gradle = readFileSync(gradlePath, "utf8");
    assert.match(gradle, /signingConfigs \{/);
    assert.match(gradle, /create\("release"\)/);
    assert.match(gradle, /signingConfig = signingConfigs\.getByName\("release"\)\n            isMinifyEnabled = true/);
    // Must use the imported Properties(), not the inline java.util.* the Kotlin DSL rejects.
    assert.match(gradle, /val keystoreProps = Properties\(\)/);
    assert.doesNotMatch(gradle, /java\.util\.Properties\(\)/);

    const ksProps = readFileSync(join(gen, "keystore.properties"), "utf8");
    assert.match(ksProps, /^storeFile=\/abs\/release\.jks$/m);
    assert.match(ksProps, /^keyAlias=al$/m);

    // Idempotent: a second run must not double-patch.
    const second = injectReleaseSigning({
      genAndroidDir: gen,
      signing: { storeFile: "/abs/release.jks", storePassword: "ps", keyAlias: "al", keyPassword: "pk" },
      baseDir: gen,
    });
    assert.equal(second, false);
    assert.equal((readFileSync(gradlePath, "utf8").match(/signingConfigs \{/g) || []).length, 1);
  } finally {
    rmSync(gen, { recursive: true, force: true });
  }
});

test("injectReleaseSigning throws (does not silently no-op) when an anchor is missing", () => {
  const gen = mkdtempSync(join(tmpdir(), "sb-gen-"));
  try {
    mkdirSync(join(gen, "app"), { recursive: true });
    // A release block without `isMinifyEnabled = true` — the second anchor is gone.
    writeFileSync(
      join(gen, "app", "build.gradle.kts"),
      'import java.util.Properties\n\nandroid {\n    buildTypes {\n        getByName("release") {\n            proguardFiles()\n        }\n    }\n}\n',
    );
    assert.throws(
      () =>
        injectReleaseSigning({
          genAndroidDir: gen,
          signing: { storeFile: "/abs/release.jks", storePassword: "ps", keyAlias: "al", keyPassword: "pk" },
          baseDir: gen,
        }),
      /could not attach signingConfig/,
    );
  } finally {
    rmSync(gen, { recursive: true, force: true });
  }
});

test("injectReleaseSigning resolves a relative storeFile against baseDir", () => {
  const gen = mkdtempSync(join(tmpdir(), "sb-gen-"));
  try {
    mkdirSync(join(gen, "app"), { recursive: true });
    writeFileSync(join(gen, "app", "build.gradle.kts"), FIXTURE_GRADLE);
    injectReleaseSigning({
      genAndroidDir: gen,
      signing: { storeFile: "sub/release.jks", storePassword: "ps", keyAlias: "al", keyPassword: "pk" },
      baseDir: "/base",
    });
    assert.match(readFileSync(join(gen, "keystore.properties"), "utf8"), /^storeFile=\/base\/sub\/release\.jks$/m);
  } finally {
    rmSync(gen, { recursive: true, force: true });
  }
});
