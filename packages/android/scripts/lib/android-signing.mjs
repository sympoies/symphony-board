import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Release-signing wiring for the generated Android project. Kept in its own module
// so it can be unit-tested without the full gen/android tree that
// prepare-generated-android.mjs otherwise requires.

// Resolve the four signing inputs from env (CI) or a local keystore.properties
// (developer machine). Returns the inputs, or null when no complete set is
// available — the caller then leaves the release build unsigned (debug builds and
// keyless CI/contributors are unaffected).
export function resolveSigning(env, localKeystorePropsPath) {
  if (env.ANDROID_KEYSTORE_FILE && env.ANDROID_KEYSTORE_PASSWORD && env.ANDROID_KEY_ALIAS && env.ANDROID_KEY_PASSWORD) {
    return {
      storeFile: env.ANDROID_KEYSTORE_FILE,
      storePassword: env.ANDROID_KEYSTORE_PASSWORD,
      keyAlias: env.ANDROID_KEY_ALIAS,
      keyPassword: env.ANDROID_KEY_PASSWORD,
    };
  }
  if (localKeystorePropsPath && existsSync(localKeystorePropsPath)) {
    const p = parseProps(readFileSync(localKeystorePropsPath, "utf8"));
    if (p.storeFile && p.storePassword && p.keyAlias && p.keyPassword) return p;
  }
  return null;
}

function parseProps(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

// `Properties()` (not `java.util.Properties()`) — the generated build.gradle.kts
// already `import java.util.Properties`, and the Kotlin DSL fails to resolve the
// fully-qualified `java.util` reference inline.
const SIGNING_CONFIGS_BLOCK = `    signingConfigs {
        create("release") {
            val keystoreProps = Properties()
            val keystorePropsFile = rootProject.file("keystore.properties")
            if (keystorePropsFile.exists()) {
                keystorePropsFile.inputStream().use { keystoreProps.load(it) }
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }`;

// Patch the generated Gradle project so the release build is signed. Writes the
// keystore values to gen/android/keystore.properties (the gen tree is gitignored,
// so the secret is never committed) and injects a release signingConfig that reads
// them. Idempotent: returns false if already injected. `baseDir` resolves a
// relative storeFile from a local keystore.properties.
export function injectReleaseSigning({ genAndroidDir, signing, baseDir }) {
  // Only `\` needs escaping: keys are fixed literals and each value is written on
  // its own line, so `=` / `:` / whitespace in a password are read verbatim by
  // Properties.load(); a backslash would be misread as an escape.
  const esc = (v) => String(v).replace(/\\/g, "\\\\");
  const storeFileAbs = isAbsolute(signing.storeFile) ? signing.storeFile : join(baseDir, signing.storeFile);
  writeFileSync(
    join(genAndroidDir, "keystore.properties"),
    [
      `storeFile=${esc(storeFileAbs)}`,
      `storePassword=${esc(signing.storePassword)}`,
      `keyAlias=${esc(signing.keyAlias)}`,
      `keyPassword=${esc(signing.keyPassword)}`,
      "",
    ].join("\n"),
  );

  const gradlePath = join(genAndroidDir, "app", "build.gradle.kts");
  const original = readFileSync(gradlePath, "utf8");
  if (original.includes('signingConfigs.getByName("release")')) return false;

  // Fail loudly if either anchor is gone (a future Tauri gen layout): a silent
  // no-op would otherwise ship an UNSIGNED release, or — on a re-run past the
  // guard — duplicate the signingConfigs block. Throw before writing so the file
  // is never left half-patched.
  const withConfigs = original.replace(/\n    buildTypes \{/, `\n${SIGNING_CONFIGS_BLOCK}\n    buildTypes {`);
  if (withConfigs === original) {
    throw new Error("android-signing: could not anchor signingConfigs before `buildTypes {` in build.gradle.kts (generated layout changed?)");
  }
  const withRelease = withConfigs.replace(
    /getByName\("release"\) \{\n            isMinifyEnabled = true/,
    'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")\n            isMinifyEnabled = true',
  );
  if (withRelease === withConfigs) {
    throw new Error("android-signing: could not attach signingConfig to the release buildType in build.gradle.kts (generated layout changed?)");
  }
  writeFileSync(gradlePath, withRelease);
  return true;
}
