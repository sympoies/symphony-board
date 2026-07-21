import { useEffect, useRef, useState } from "react";
import {
  configProjectPath,
  configWithSyncCadence,
  configWithProject,
  configWithSource,
  configWithSourcePatch,
  configWithoutProject,
  configWithoutSource,
  isSourceTokenSet,
  isSyncRunActive,
  shouldValidateSecretBeforeSave,
  sourceTokenEnvs,
  sourcesNeedingSync,
  standaloneDefaultConfig,
  STANDALONE_DEFAULT_FULL_SYNC_INTERVAL_SECONDS,
  STANDALONE_DEFAULT_SYNC_INTERVAL_SECONDS,
  suggestSourceDefaults,
  type ConfigAuthPolicyDoc,
  type ConfigDocument,
  type ConfigProjectEntry,
  type ConfigSourceKind,
} from "../model.ts";
import { Badge } from "./Badge.tsx";
import type { ConfigState } from "../useConfig.ts";
import type { SyncState } from "../useSync.ts";

interface Props {
  config: ConfigState; // writer-owned config control plane (capability already probed)
  sync?: SyncState; // for the post-save "run a first sync" affordance
  variant?: "default" | "standalone";
}

function authPolicyLabel(policy: ConfigAuthPolicyDoc | undefined): string {
  if (!policy) return "legacy auth";
  if (policy.mode === "inherit") return "inherit";
  if (policy.mode === "pat") return `PAT${policy.pat_pool ? `: ${policy.pat_pool}` : ""}`;
  if (policy.mode === "bot") return `bot${policy.bot_pool ? `: ${policy.bot_pool}` : ""}`;
  return `bot then PAT${policy.bot_pool ? `: ${policy.bot_pool}` : ""}${policy.pat_pool ? ` / ${policy.pat_pool}` : ""}`;
}

function projectAuthPolicy(entry: ConfigProjectEntry): ConfigAuthPolicyDoc | undefined {
  return typeof entry === "string" ? undefined : entry.auth_policy;
}

function syncCadenceValue(draft: ConfigDocument, field: "interval_seconds" | "full_interval_seconds", fallback: number): number {
  const value = draft.sync?.[field];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

// The Sources editor: edits the PRODUCER config through the writer-owned
// control plane — unlike everything else on the Settings page, this changes
// what the daemon syncs for every consumer of this server, not browser-local
// view preferences. It keeps a local draft and commits it with one explicit
// Save; the daemon validates authoritatively and its field-level messages
// render verbatim. Tokens never ride in the config document: they go through
// the write-only secrets surface, and existing values are never displayed.
export function SourcesEditor({ config, sync, variant = "default" }: Props) {
  const [draft, setDraft] = useState<ConfigDocument | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null); // JSON of the adopted server document
  const [newProject, setNewProject] = useState<Record<string, string>>({});
  const [tokenInput, setTokenInput] = useState<Record<string, string>>({});
  const [tokenError, setTokenError] = useState<Record<string, string>>({});
  const [addKind, setAddKind] = useState<ConfigSourceKind>("github");
  const [addHost, setAddHost] = useState("");
  const [addName, setAddName] = useState("");
  const [syncOffer, setSyncOffer] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const standalone = variant === "standalone";

  const dirty = draft !== null && baseline !== null ? JSON.stringify(draft) !== baseline : draft !== null && baseline === null;

  // Adopt the server document whenever it changes, unless local edits are in
  // flight — a refresh must not silently discard the user's draft.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(config.config ? (JSON.parse(JSON.stringify(config.config)) as ConfigDocument) : standalone ? standaloneDefaultConfig() : null);
    setBaseline(config.config ? JSON.stringify(config.config) : null);
  }, [config.config, standalone]);

  const update = (next: ConfigDocument) => {
    setDraft(next);
    setSaved(false);
  };

  const addSource = () => {
    const host = addHost.trim();
    if (!host) return;
    const defaults = suggestSourceDefaults(addKind, host);
    const source = { ...defaults, display_name: addName.trim() || undefined, projects: [] };
    update(configWithSource(draft, source));
    setAddHost("");
    setAddName("");
  };

  const save = async () => {
    if (!draft) return;
    const needsSync = sourcesNeedingSync(config.config, draft);
    const ok = await config.save(draft);
    if (ok) {
      setBaseline(JSON.stringify(draft));
      setSyncOffer(needsSync);
      setSaved(true);
    }
  };

  const discard = () => {
    setDraft(config.config ? (JSON.parse(JSON.stringify(config.config)) as ConfigDocument) : null);
    setBaseline(config.config ? JSON.stringify(config.config) : null);
    setSaved(false);
  };

  const setToken = async (sourceId: string, env: string) => {
    const value = (tokenInput[env] ?? "").trim();
    if (!value) return;
    if (standalone && dirty) {
      setTokenError((m) => ({ ...m, [env]: "Save source changes before setting this token." }));
      return;
    }
    const source = draft?.sources.find((s) => s.source_id === sourceId);
    const err = await config.setSecret(env, value, { sourceId, validate: source ? shouldValidateSecretBeforeSave(source, env, standalone) : false });
    setTokenError((m) => ({ ...m, [env]: err ?? "" }));
    if (!err) setTokenInput((m) => ({ ...m, [env]: "" }));
  };

  const syncRunning = isSyncRunActive(sync?.current);
  const canOfferSync = sync?.available && sync.enabled;
  const setSyncCadence = (field: "interval_seconds" | "full_interval_seconds", value: string) => {
    if (!draft) return;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return;
    update(configWithSyncCadence(draft, { [field]: n }));
  };

  return (
    <div className="settings-pref settings-config">
      <div>
        <h3>Sources (producer config)</h3>
        <p className="muted">
          What the daemon syncs — unlike the view preferences above, saving here changes the server's config for every
          consumer. Edits apply on the next sync run. Removing a source or repo stops syncing it but keeps its
          already-synced history on the board; nothing is deleted.
        </p>
      </div>

      {!draft ? (
        <div className="config-empty">
          <p className="muted">No producer config exists yet on this server.</p>
          <button type="button" className="toggle" onClick={() => update(standalone ? standaloneDefaultConfig() : { db_path: "data/symphony.db", sources: [] })}>
            {standalone ? "Create GitHub setup" : "Create config"}
          </button>
        </div>
      ) : (
        <>
          {standalone ? (
            <div className="config-sync-cadence">
              <div className="config-sync-cadence-head">
                <span className="source-name">Background sync</span>
                <span className="muted">saved with this standalone config</span>
              </div>
              <label className="config-sync-field">
                <span>Incremental every</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="settings-number config-sync-number"
                  value={syncCadenceValue(draft, "interval_seconds", STANDALONE_DEFAULT_SYNC_INTERVAL_SECONDS)}
                  onChange={(e) => setSyncCadence("interval_seconds", e.target.value)}
                />
                <span className="muted">seconds</span>
              </label>
              <label className="config-sync-field">
                <span>Full sync every</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="settings-number config-sync-number"
                  value={syncCadenceValue(draft, "full_interval_seconds", STANDALONE_DEFAULT_FULL_SYNC_INTERVAL_SECONDS)}
                  onChange={(e) => setSyncCadence("full_interval_seconds", e.target.value)}
                />
                <span className="muted">seconds</span>
              </label>
            </div>
          ) : null}

          {draft.sources.map((s) => {
            const credentialEnvs = sourceTokenEnvs(s);
            const credentialsSet = isSourceTokenSet(s, config.secrets);
            const sourceEnabled = s.enabled !== false;
            return (
              <div className={`config-source${sourceEnabled ? "" : " config-source-disabled"}`} key={s.source_id}>
                <div className="config-source-head">
                  <span className="source-name">{s.source_id}</span>
                  <span className="muted">
                    {s.kind} @ {s.host}
                  </span>
                  <span className="muted">auth: {authPolicyLabel(s.auth_policy)}</span>
                  <label className="config-enabled">
                    <input
                      type="checkbox"
                      checked={sourceEnabled}
                      onChange={(e) => update(configWithSourcePatch(draft, s.source_id, { enabled: e.target.checked ? undefined : false }))}
                    />
                    <span>{sourceEnabled ? "Enabled" : "Disabled"}</span>
                  </label>
                  <input
                    type="text"
                    className="config-input config-display-name"
                    placeholder="display name"
                    value={s.display_name ?? ""}
                    onChange={(e) => update(configWithSourcePatch(draft, s.source_id, { display_name: e.target.value || undefined }))}
                  />
                  {s.kind === "forgejo" ? (
                    <input
                      type="url"
                      className="config-input config-display-name"
                      placeholder="https://codeberg.org"
                      value={s.base_url ?? ""}
                      onChange={(e) => update(configWithSourcePatch(draft, s.source_id, { base_url: e.target.value || undefined }))}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="link-btn config-remove"
                    onClick={() => update(configWithoutSource(draft, s.source_id))}
                    title="stop syncing this source (already-synced history is kept)"
                  >
                    remove
                  </button>
                </div>
                <div className={`config-token${sourceEnabled && !credentialsSet ? " config-token-missing" : ""}`}>
                  <Badge text={credentialsSet ? "credentials set" : "credentials missing"} kind={credentialsSet ? "status-ok" : "status-error"} />
                  {sourceEnabled && !credentialsSet ? <span className="config-token-note">Required before sync</span> : null}
                  {credentialEnvs.map((env) => {
                    const envSet = config.secrets[env] === true;
                    return (
                      <div className="config-token-env" key={env}>
                        <span className="muted">{env}</span>
                        {config.secretsWritable ? (
                          <>
                            <input
                              type="password"
                              className="config-input config-token-input"
                              placeholder={envSet ? "replace value" : "paste value"}
                              autoComplete="off"
                              value={tokenInput[env] ?? ""}
                              onChange={(e) => setTokenInput((m) => ({ ...m, [env]: e.target.value }))}
                            />
                            <button type="button" className="toggle" disabled={!(tokenInput[env] ?? "").trim()} onClick={() => void setToken(s.source_id, env)}>
                              {envSet ? "Replace" : "Set"}
                            </button>
                          </>
                        ) : (
                          <span className="muted">{envSet ? "set via the server's environment" : "not set"}</span>
                        )}
                        {tokenError[env] ? <span className="config-error">{tokenError[env]}</span> : null}
                      </div>
                    );
                  })}
                </div>
                <ul className="config-projects">
                  {s.projects.map((p) => {
                    const path = configProjectPath(p);
                    return (
                      <li key={path}>
                        <span className="settings-repo-name">{path}</span>
                        {projectAuthPolicy(p) ? <span className="muted">auth: {authPolicyLabel(projectAuthPolicy(p))}</span> : null}
                        <button
                          type="button"
                          className="link-btn config-remove"
                          onClick={() => update(configWithoutProject(draft, s.source_id, path))}
                          title="stop syncing this repo (already-synced history is kept)"
                        >
                          remove
                        </button>
                      </li>
                    );
                  })}
                  <li className="config-add-project">
                    <input
                      type="text"
                      className="config-input"
                      placeholder={s.kind === "gitlab" ? "group/project" : "owner/repo"}
                      value={newProject[s.source_id] ?? ""}
                      onChange={(e) => setNewProject((m) => ({ ...m, [s.source_id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        update(configWithProject(draft, s.source_id, newProject[s.source_id] ?? ""));
                        setNewProject((m) => ({ ...m, [s.source_id]: "" }));
                      }}
                    />
                    <button
                      type="button"
                      className="toggle"
                      disabled={!(newProject[s.source_id] ?? "").trim()}
                      onClick={() => {
                        update(configWithProject(draft, s.source_id, newProject[s.source_id] ?? ""));
                        setNewProject((m) => ({ ...m, [s.source_id]: "" }));
                      }}
                    >
                      Add repo
                    </button>
                  </li>
                </ul>
              </div>
            );
          })}

          <div className="config-add-source">
            <select
              className="settings-select"
              value={addKind}
              onChange={(e) => setAddKind(e.target.value === "gitlab" ? "gitlab" : e.target.value === "forgejo" ? "forgejo" : "github")}
            >
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="forgejo">Forgejo / Codeberg</option>
            </select>
            <input type="text" className="config-input" placeholder="host or Forgejo base URL" value={addHost} onChange={(e) => setAddHost(e.target.value)} />
            <input type="text" className="config-input" placeholder="display name (optional)" value={addName} onChange={(e) => setAddName(e.target.value)} />
            <button type="button" className="toggle" disabled={!addHost.trim()} onClick={addSource}>
              Add source
            </button>
          </div>

          <div className="config-save">
            <button type="button" className="toggle config-save-button" disabled={!dirty || config.busy} onClick={() => void save()}>
              {config.busy ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="link-btn" disabled={!dirty || config.busy} onClick={discard}>
              discard
            </button>
            {saved && !dirty ? (
              <span className="muted" role="status">
                Saved — applies on the next sync run.
              </span>
            ) : null}
          </div>

          {config.saveErrors.length > 0 ? (
            <ul className="config-error-list" role="alert">
              {config.saveErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          {config.saveError ? (
            <p className="config-error" role="alert">
              {config.saveError}
            </p>
          ) : null}

          {saved && syncOffer.length > 0 && canOfferSync ? (
            <div className="config-sync-offer">
              {syncOffer.map((id) => (
                <button
                  type="button"
                  key={id}
                  className="toggle"
                  disabled={syncRunning || sync?.busy}
                  onClick={() => sync?.start({ mode: "full", dry_run: false, source_id: id })}
                  title="full sweep of the source you just added or extended"
                >
                  {syncRunning ? "Syncing" : `Run first sync · ${id}`}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
