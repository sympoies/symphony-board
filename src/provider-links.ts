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
  if (segments.some((segment) => segment.trim() === "")) return null;
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

export function providerRepoUrl(source: ProviderLinkSource, projectPath: string | null | undefined): string | null {
  return repoBase(source, projectPath);
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
