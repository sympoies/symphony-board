import { useState } from "react";
import { copyText } from "../clipboard.ts";
import { isTauriRuntime } from "../runtime.ts";
import { currentClientKind } from "../viewconfig.ts";
import { clientBuildMetadata, versionDetails } from "../version.ts";

export function VersionInfo() {
  const info = versionDetails(clientBuildMetadata(), currentClientKind(), isTauriRuntime());
  const [copyStatus, setCopyStatus] = useState("");
  async function copyVersion() {
    try {
      await copyText(info.copy);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed. Select the version text to copy manually.");
    }
  }
  return (
    <div className="settings-pref settings-version">
      <div>
        <h3>Version</h3>
        <p>Client ({info.surface}): <span data-client-version>{info.version}</span></p>
        <p>Build: <span data-client-build>{info.build}</span></p>
        <p>Backend: {info.backend}</p>
        <p className="muted">Backend runtime version is not supplied by this server.</p>
      </div>
      <div>
        <button type="button" className="link-btn" onClick={() => void copyVersion()}>Copy version</button>
        <span role="status">{copyStatus}</span>
      </div>
    </div>
  );
}
