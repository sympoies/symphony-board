// Build metadata is embedded by Vite from the release-controlled root package.
// Only allow version/commit values into display and copy; never copy an env or
// server diagnostics object, even when additional fields are present.
declare const __SYMPHONY_BOARD_BUILD__: unknown;

export function clientBuildMetadata(): unknown {
  return typeof __SYMPHONY_BOARD_BUILD__ === "undefined" ? null : __SYMPHONY_BOARD_BUILD__;
}

export function versionSurface(clientKind: string | null, tauri: boolean): string {
  if (clientKind === "standalone") return "Standalone";
  if (clientKind === "android") return "Android";
  return tauri ? "Desktop" : "Web";
}

export function versionDetails(metadata: unknown, clientKind: string | null, tauri: boolean) {
  const fields = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const version = typeof fields.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(fields.version)
    ? fields.version : "Unavailable";
  const build = typeof fields.commit === "string" && /^[a-f0-9]{7,40}$/i.test(fields.commit)
    ? fields.commit.slice(0, 7) : "Unavailable";
  const surface = versionSurface(clientKind, tauri);
  // The current backend exposes no authoritative runtime version. Neither a
  // contract producer's app_version nor contract_version identifies this server.
  const backend = "Unavailable";
  return { surface, version, build, backend,
    copy: `Client (${surface}): ${version}\nBuild: ${build}\nBackend: ${backend}` };
}
