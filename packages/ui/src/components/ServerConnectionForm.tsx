import { useEffect, useState } from "react";
import { normalizeServerBaseUrl } from "../viewconfig.ts";

interface Props {
  serverBaseUrl: string | null;
  onServerBaseUrl: (serverBaseUrl: string | null) => void;
}

export function ServerConnectionForm({ serverBaseUrl, onServerBaseUrl }: Props) {
  const [draft, setDraft] = useState(serverBaseUrl ?? "");
  useEffect(() => setDraft(serverBaseUrl ?? ""), [serverBaseUrl]);

  const trimmed = draft.trim();
  const normalized = normalizeServerBaseUrl(trimmed);
  const invalid = trimmed !== "" && !normalized;

  return (
    <form
      className="server-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) onServerBaseUrl(normalized);
      }}
    >
      <label className="server-url-field">
        <span>Server URL</span>
        <input
          className={`server-url-input${invalid ? " input-error" : ""}`}
          type="url"
          value={draft}
          placeholder="https://board.tailnet.ts.net/"
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <button type="submit" className="toggle" disabled={invalid}>
        Connect
      </button>
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          setDraft("");
          onServerBaseUrl(null);
        }}
      >
        Reset
      </button>
      <span className={`server-url-status muted${invalid ? " sync-error" : ""}`} role="status">
        {invalid ? "Use http:// or https://." : `Current: ${serverBaseUrl ?? "same-origin"}`}
      </span>
    </form>
  );
}
