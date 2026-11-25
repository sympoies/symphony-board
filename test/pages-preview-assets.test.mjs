import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const [surface, file, assetPrefix] of [
  ["README", "../README.md", "site/screenshots/"],
  ["Pages landing", "../site/index.html", "./screenshots/"],
]) {
  test(`${surface} pairs each preview with a matching light and dark WebP`, async () => {
    const html = await readFile(new URL(file, import.meta.url), "utf8");
    const screenshots = [...html.matchAll(/<picture>([\s\S]*?)<\/picture>/g)]
      .map(([, picture]) => picture)
      .filter((picture) => picture.includes(assetPrefix));
    assert.ok(screenshots.length > 0, "expected at least one theme-aware screenshot");

    for (const picture of screenshots) {
      const attributes = [...picture.matchAll(/<source media="\(prefers-color-scheme: (light|dark)\)" srcset="([^"]+)"/g)];
      assert.deepEqual(attributes.map(([, theme]) => theme).sort(), ["dark", "light"]);
      const paths = Object.fromEntries(attributes.map(([, theme, path]) => [theme, path]));
      for (const [theme, path] of Object.entries(paths)) {
        assert.ok(path.startsWith(assetPrefix) && path.endsWith(`-${theme}.webp`), path);
        const image = await readFile(new URL(path, new URL(file, import.meta.url)));
        assert.equal(image.toString("ascii", 8, 12), "WEBP", path);
      }
      assert.equal(paths.light.replace(/-light\.webp$/, ""), paths.dark.replace(/-dark\.webp$/, ""));
      const fallback = picture.match(/<img\s+src="([^"]+)"\s+alt="([^"]+)"/);
      assert.equal(fallback?.[1], paths.light, "fallback needs light preview and descriptive alt text");
    }
  });
}
