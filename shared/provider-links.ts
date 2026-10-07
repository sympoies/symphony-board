export interface ProviderLinkSource {
  kind: string;
  host: string;
}

function safeHost(host: string | null | undefined): string | null {
  const value = host?.trim();
  if (!value || value.includes("/") || value.includes("://")) return null;
  return /^[a-z0-9.-]+(?::\d+)?$/i.test(value) ? value : null;
}

function providerKind(source: ProviderLinkSource): "github" | "gitlab" | null {
  if (source.kind === "github" || source.kind === "gitlab") return source.kind;
  return null;
}

function projectPathSegments(kind: string, projectPath: string | null | undefined): string[] | null {
  const path = projectPath?.trim();
  if (!path) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment.trim() === "" || segment === "." || segment === "..")) return null;
  if (kind === "github" && segments.length !== 2) return null;
  if (kind === "gitlab" && segments.length < 2) return null;
  return segments;
}

function repoBase(source: ProviderLinkSource, projectPath: string | null | undefined): string | null {
  const kind = providerKind(source);
  const host = safeHost(source.host);
  const segments = kind ? projectPathSegments(kind, projectPath) : null;
  if (!kind || !host || !segments) return null;
  return `https://${host}/${segments.map(encodeURIComponent).join("/")}`;
}

function safeIid(iid: number | null | undefined): number | null {
  return typeof iid === "number" && Number.isInteger(iid) && iid > 0 ? iid : null;
}

function safeSha(value: unknown): string | null {
  const sha = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{6,64}$/i.test(sha)) return null;
  if (/^0+$/.test(sha)) return null;
  return sha;
}

function shortRef(ref: unknown): string | null {
  const value = typeof ref === "string" ? ref.trim() : "";
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "") || null;
}

// A provider username safe to place as a single profile path segment. GitHub
// logins and GitLab usernames are slugs drawn from [A-Za-z0-9._-]; anything else
// (whitespace, slashes that would smuggle in extra path segments, control chars)
// is rejected rather than encoded.
function safeUsername(value: string | null | undefined): string | null {
  const name = value?.trim();
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return name;
}

function safePathSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export function providerRepoUrl(source: ProviderLinkSource, projectPath: string | null | undefined): string | null {
  return repoBase(source, projectPath);
}

// Canonical provider profile page for an actor's username. Both GitHub and
// GitLab serve a user profile at `https://<host>/<username>`. Returns null when
// the source kind/host is unsupported or the username is missing/unsafe.
export function providerProfileUrl(source: ProviderLinkSource, username: string | null | undefined): string | null {
  const kind = providerKind(source);
  const host = safeHost(source.host);
  const name = safeUsername(username);
  if (!kind || !host || !name) return null;
  return `https://${host}/${encodeURIComponent(name)}`;
}

// Provider-reported actor profile URL, constrained to the configured host and
// known profile path shapes. This preserves GitHub App bot URLs
// (`/apps/<slug>`) without letting arbitrary activity details become links.
export function providerObservedProfileUrl(source: ProviderLinkSource, value: unknown): string | null {
  const kind = providerKind(source);
  const host = safeHost(source.host);
  const text = typeof value === "string" ? value.trim() : "";
  if (!kind || !host || !text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.host.toLowerCase() !== host.toLowerCase()) return null;
  const segments = safePathSegments(url.pathname);
  if (!segments) return null;
  if (kind === "github" && segments.length === 2 && segments[0] === "apps") {
    const app = safeUsername(segments[1]);
    return app ? `https://${host}/apps/${encodeURIComponent(app)}` : null;
  }
  if (segments.length === 1) {
    const name = safeUsername(segments[0]);
    return name ? `https://${host}/${encodeURIComponent(name)}` : null;
  }
  return null;
}

export function providerIssueUrl(source: ProviderLinkSource, projectPath: string | null | undefined, iid: number | null | undefined): string | null {
  const base = repoBase(source, projectPath);
  const n = safeIid(iid);
  if (!base || n === null) return null;
  return source.kind === "github" ? `${base}/issues/${n}` : `${base}/-/issues/${n}`;
}

export function providerChangeRequestUrl(source: ProviderLinkSource, projectPath: string | null | undefined, iid: number | null | undefined): string | null {
  const base = repoBase(source, projectPath);
  const n = safeIid(iid);
  if (!base || n === null) return null;
  return source.kind === "github" ? `${base}/pull/${n}` : `${base}/-/merge_requests/${n}`;
}

export function providerCommitUrl(source: ProviderLinkSource, projectPath: string | null | undefined, shaValue: unknown): string | null {
  const base = repoBase(source, projectPath);
  const sha = safeSha(shaValue);
  if (!base || !sha) return null;
  return source.kind === "github" ? `${base}/commit/${sha}` : `${base}/-/commit/${sha}`;
}

export function providerCompareUrl(
  source: ProviderLinkSource,
  projectPath: string | null | undefined,
  beforeValue: unknown,
  afterValue: unknown,
): string | null {
  const base = repoBase(source, projectPath);
  const before = safeSha(beforeValue);
  const after = safeSha(afterValue);
  if (!base || !before || !after || before === after) return null;
  const range = `${before}...${after}`;
  return source.kind === "github" ? `${base}/compare/${range}` : `${base}/-/compare/${range}`;
}

export function providerRefUrl(source: ProviderLinkSource, projectPath: string | null | undefined, refValue: unknown): string | null {
  const base = repoBase(source, projectPath);
  const ref = shortRef(refValue);
  if (!base || !ref) return null;
  return source.kind === "github" ? `${base}/tree/${encodeURIComponent(ref)}` : `${base}/-/tree/${encodeURIComponent(ref)}`;
}

export function providerPushUrl(
  source: ProviderLinkSource,
  projectPath: string | null | undefined,
  action: string,
  refValue: unknown,
  beforeValue: unknown,
  afterValue: unknown,
): string | null {
  if (action === "deleted") return providerCommitUrl(source, projectPath, beforeValue);
  if (action === "created") return providerRefUrl(source, projectPath, refValue) ?? providerCommitUrl(source, projectPath, afterValue);
  return (
    providerCompareUrl(source, projectPath, beforeValue, afterValue) ??
    providerCommitUrl(source, projectPath, afterValue) ??
    providerRefUrl(source, projectPath, refValue)
  );
}

// Exact provider permalinks take precedence over reconstructed destinations.
// Reviews/comments require their permalink: a parent item number alone does not
// identify a particular review or comment.
export interface ProviderEntity {
  kind: "source" | "repo" | "profile" | "issue" | "change_request" | "commit" | "branch" | "tag" | "workflow_run" | "review" | "comment" | "file" | "directory" | "label";
  url?: string | null;
  projectPath?: string | null;
  username?: string | null;
  iid?: number | null;
  sha?: string | null;
  ref?: string | null;
  path?: string | null;
  label?: string | null;
}

export function externalWebUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? value : null;
  } catch { return null; }
}

export function providerEntityUrl(source: ProviderLinkSource | null | undefined, entity: ProviderEntity): string | null {
  if (entity.url) return externalWebUrl(entity.url);
  if (!source) return null;
  switch (entity.kind) {
    case "source": {
      const host = safeHost(source.host);
      return providerKind(source) && host ? `https://${host}/` : null;
    }
    case "repo": return providerRepoUrl(source, entity.projectPath);
    case "profile": return providerProfileUrl(source, entity.username);
    case "issue": return providerIssueUrl(source, entity.projectPath, entity.iid);
    case "change_request": return providerChangeRequestUrl(source, entity.projectPath, entity.iid);
    case "commit": return providerCommitUrl(source, entity.projectPath, entity.sha);
    case "branch":
    case "tag": return providerRefUrl(source, entity.projectPath, entity.ref);
    case "workflow_run": {
      const base = repoBase(source, entity.projectPath);
      const id = safeIid(entity.iid);
      return base && id ? `${base}/${source.kind === "github" ? "actions/runs" : "-/pipelines"}/${id}` : null;
    }
    case "file":
    case "directory": {
      const base = repoBase(source, entity.projectPath);
      const ref = shortRef(entity.ref);
      if (entity.kind === "directory" && entity.path === ".") return providerRefUrl(source, entity.projectPath, entity.ref);
      const parts = entity.path?.split("/");
      if (!base || !ref || !parts?.length || parts.some(p => !p || p === "." || p === "..")) return null;
      const route = entity.kind === "directory" ? "tree" : "blob";
      return `${base}/${source.kind === "github" ? route : `-/${route}`}/${encodeURIComponent(ref)}/${parts.map(encodeURIComponent).join("/")}`;
    }
    case "label": {
      const base = repoBase(source, entity.projectPath);
      if (!base || !entity.label?.trim()) return null;
      const query = source.kind === "github"
        ? new URLSearchParams({ q: `label:${JSON.stringify(entity.label)}` })
        : new URLSearchParams({ "label_name[]": entity.label });
      return `${base}/${source.kind === "github" ? "issues" : "-/issues"}?${query}`;
    }
    case "review":
    case "comment": return null;
  }
}
