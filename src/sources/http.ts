import { createHmac, randomBytes } from "node:crypto";
import { log } from "../log.ts";

// Shared fetch wrapper that bounds every provider request with an abort-based
// timeout. Without it, a socket that stalls (e.g. a half-up network or VPN right
// after the host wakes from sleep) hangs the whole sync iteration until the OS
// TCP timeout — minutes of dead air. A timeout here surfaces as an ordinary
// fetch error, which the engine treats as an INCOMPLETE fetch, so it can never
// trigger a disappearance soft-delete: a slow source degrades to "stale", never
// "deleted".
//
// Override the default with SYNC_FETCH_TIMEOUT_MS (milliseconds).
export const DEFAULT_FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.SYNC_FETCH_TIMEOUT_MS) || 30000);

export interface AuthToken {
  env: string;
  value: string;
  kind?: "pat" | "github_app";
  name?: string;
  strategy?: "failover" | "budget_aware" | "round_robin";
}

export type AuthTokenInput = string | AuthToken[];

export interface AuthSelectionState {
  cursor: number;
  namespace: string;
  selectionKey: string;
  budgetAwareIndexes: readonly number[];
  budgetAwareIndexSet: ReadonlySet<number>;
}

const authSelectionStarts = new Map<string, number>();
const authBudgetStates = new Map<string, AuthBudgetState>();
const DEFAULT_ESTIMATED_COST = 1;
const AUTH_BUDGET_KEY_SALT = randomBytes(16);

interface AuthBudgetState {
  limit?: number;
  remaining?: number;
  used?: number;
  resetAtMs?: number;
  blockedUntilMs?: number;
  inFlight: number;
  lastCost: number;
}

export interface GitHubRateBudget {
  limit?: number;
  remaining?: number;
  used?: number;
  resetAtMs?: number;
  resource?: string;
  cost?: number;
}

function canonicalAuthStrategy(strategy: AuthToken["strategy"] | undefined): NonNullable<AuthToken["strategy"]> {
  if (strategy === "round_robin") return "budget_aware";
  return strategy ?? "failover";
}

function isBudgetAwareToken(token: AuthToken | undefined): token is AuthToken {
  return token !== undefined && canonicalAuthStrategy(token.strategy) === "budget_aware";
}

function budgetAwareIndexes(tokens: readonly AuthToken[]): number[] {
  const indexes: number[] = [];
  for (let idx = 0; idx < tokens.length; idx++) {
    if (isBudgetAwareToken(tokens[idx])) indexes.push(idx);
  }
  return indexes;
}

function tokenSelectionKey(tokens: readonly AuthToken[], namespace: string): string {
  return [
    namespace,
    ...tokens.map((token) => `${token.env}\t${token.kind ?? ""}\t${canonicalAuthStrategy(token.strategy)}`),
  ].join("\n");
}

function credentialFingerprint(value: string): string {
  return createHmac("sha256", AUTH_BUDGET_KEY_SALT).update(value).digest("hex").slice(0, 16);
}

function budgetKeyFor(namespace: string, token: AuthToken): string {
  return [
    namespace,
    token.env,
    token.kind ?? "",
    canonicalAuthStrategy(token.strategy),
    token.name ?? "",
    credentialFingerprint(token.value),
  ].join("\t");
}

// Pick an initial probe cursor for a newly-created client. The daemon rebuilds
// clients each sync run; keeping this process-local handoff prevents every new
// run from pinning its first unknown-budget page to the same bot.
export function createAuthSelectionState(tokens: readonly AuthToken[], namespace: string): AuthSelectionState {
  const indexes = budgetAwareIndexes(tokens);
  const budgetAwareIndexSet = new Set(indexes);
  const selectionKey = tokenSelectionKey(tokens, namespace);
  if (indexes.length === 0) return { cursor: 0, namespace, selectionKey, budgetAwareIndexes: indexes, budgetAwareIndexSet };
  const next = authSelectionStarts.get(selectionKey) ?? 0;
  authSelectionStarts.set(selectionKey, (next + 1) % indexes.length);
  return { cursor: indexes[next] ?? 0, namespace, selectionKey, budgetAwareIndexes: indexes, budgetAwareIndexSet };
}

export function resetAuthTokenSelectionStateForTests(): void {
  authSelectionStarts.clear();
  authBudgetStates.clear();
}

export interface GitHubRateLimitInfo {
  kind: "primary" | "secondary";
  resetAtMs: number | null;
  retryAfterMs: number | null;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly rateLimit: GitHubRateLimitInfo | null;

  constructor(message: string, status: number, rateLimit: GitHubRateLimitInfo | null = null) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.rateLimit = rateLimit;
  }
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function logField(value: string): string {
  return value.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_./:@=-]/g, "_");
}

export function describeGraphqlQuery(query: string): string {
  if (/\brateLimit\b/.test(query)) return "rateLimit";
  if (/\bpullRequest\s*\(/.test(query)) return "pullRequest";
  if (/\bpullRequests\s*\(/.test(query)) return "pullRequests";
  if (/\bissues\s*\(/.test(query)) return "issues";
  if (/\bviewer\b/.test(query)) return "viewer";
  return "query";
}

export function repoFromGraphqlVariables(variables: Record<string, unknown>): string | null {
  const owner = variables.owner;
  const name = variables.name;
  return typeof owner === "string" && typeof name === "string" && owner && name ? `${owner}/${name}` : null;
}

export function repoFromRestPath(path: string): string | null {
  const match = path.replace(/^\/+/, "").match(/^repos\/([^/]+)\/([^/]+)/);
  return match ? `${match[1]}/${match[2]}` : null;
}

const REST_ROUTE_SEGMENTS = new Set([
  "activity",
  "comments",
  "commits",
  "compare",
  "discussions",
  "events",
  "issues",
  "merge_requests",
  "projects",
  "pulls",
  "repository",
  "repos",
]);

function restRouteSegment(segment: string): string {
  return REST_ROUTE_SEGMENTS.has(segment) ? segment : ":param";
}

export function describeRestOperation(path: string): string {
  const segments = path.replace(/^\/+/, "").split(/[?#]/, 1)[0]?.split("/").filter(Boolean) ?? [];
  if (segments.length === 0) return "request";

  if (segments[0] === "repos" && segments.length >= 3) {
    const tail = segments.slice(3);
    if (tail.length === 0) return "repos/:owner/:repo";
    if (tail[0] === "compare") return "repos/:owner/:repo/compare/:base...:head";
    return ["repos", ":owner", ":repo", ...tail.map(restRouteSegment)].join("/");
  }

  if (segments[0] === "projects" && segments.length >= 2) {
    const tail = segments.slice(2);
    if (tail.length === 0) return "projects/:project";
    return ["projects", ":project", ...tail.map(restRouteSegment)].join("/");
  }

  return segments.map(restRouteSegment).join("/");
}

export function traceAuthSelection(input: {
  provider: string;
  api: "graphql" | "rest";
  token: AuthToken;
  operation: string;
  repo?: string | null;
}): void {
  if (!envFlag("SYNC_AUTH_TRACE")) return;
  const kind = input.token.kind ?? (input.token.env.startsWith("github_app:") ? "github_app" : "pat");
  const parts = [
    "provider=" + logField(input.provider || "unknown"),
    "api=" + input.api,
    "token=" + logField(input.token.env),
    "kind=" + kind,
    "strategy=" + canonicalAuthStrategy(input.token.strategy),
  ];
  if (input.token.name?.trim()) parts.push("name=" + logField(input.token.name));
  if (input.repo) parts.push("repo=" + logField(input.repo));
  parts.push("op=" + logField(input.operation));
  log.info(`[auth-trace] ${parts.join(" ")}`);
}

export function normalizeAuthTokens(input: AuthTokenInput): AuthToken[] {
  if (typeof input === "string") {
    const value = input.trim();
    return value.length > 0 ? [{ env: "token", value, kind: "pat", strategy: "failover" }] : [];
  }
  return input
    .filter((token) => token.value.trim().length > 0)
    .map((token) => ({
      ...token,
      value: token.value.trim(),
      kind: token.kind ?? (token.env.startsWith("github_app:") ? "github_app" : "pat"),
      strategy: canonicalAuthStrategy(token.strategy),
      ...(token.name?.trim() ? { name: token.name.trim() } : {}),
    }));
}

export function githubRateLimitInfo(headers: Headers, message: string): GitHubRateLimitInfo | null {
  const lower = message.toLowerCase();
  const retryAfter = Number(headers.get("retry-after"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
  const resetAtMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;

  if (lower.includes("secondary rate limit") || lower.includes("abuse detection")) {
    return { kind: "secondary", resetAtMs, retryAfterMs };
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    return { kind: "primary", resetAtMs, retryAfterMs };
  }
  return null;
}

export function githubRepoAccessFailure(status: number, message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("could not resolve to a repository")) return true;
  if (lower.includes("resource not accessible")) return true;
  if (lower.includes("not accessible by integration")) return true;
  if (status === 404 && lower.includes("not found")) return true;
  if (status === 403 && lower.includes("forbidden")) return true;
  return false;
}

export function fallbackRepoAccessMessage(message: string, token: AuthToken, status: number, provider: string, isFallback: boolean): string {
  if (!isFallback || provider !== "github" || !githubRepoAccessFailure(status, message)) return message;
  return `${message} (fallback token lacks repo access: ${token.env})`;
}

export function primaryCooldownUntil(rateLimit: GitHubRateLimitInfo): number {
  return rateLimit.resetAtMs ?? Date.now() + 60 * 60 * 1000;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function githubGraphqlRateBudget(data: unknown): GitHubRateBudget | null {
  const rateLimit = typeof data === "object" && data !== null && "rateLimit" in data ? (data as { rateLimit?: unknown }).rateLimit : null;
  if (typeof rateLimit !== "object" || rateLimit === null) return null;
  const source = rateLimit as Record<string, unknown>;
  const out: GitHubRateBudget = { resource: "graphql" };
  if (typeof source.limit === "number" && Number.isFinite(source.limit)) out.limit = source.limit;
  if (typeof source.remaining === "number" && Number.isFinite(source.remaining)) out.remaining = source.remaining;
  if (typeof source.used === "number" && Number.isFinite(source.used)) out.used = source.used;
  if (typeof source.cost === "number" && Number.isFinite(source.cost)) out.cost = source.cost;
  if (typeof source.resetAt === "string") {
    const resetAtMs = Date.parse(source.resetAt);
    if (Number.isFinite(resetAtMs)) out.resetAtMs = resetAtMs;
  }
  return out.limit !== undefined || out.remaining !== undefined || out.used !== undefined || out.resetAtMs !== undefined || out.cost !== undefined
    ? out
    : null;
}

export function githubRateBudgetFromHeaders(headers: Headers, bodyBudget: GitHubRateBudget | null = null): GitHubRateBudget | null {
  const limit = headerNumber(headers, "x-ratelimit-limit");
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const used = headerNumber(headers, "x-ratelimit-used");
  const reset = headerNumber(headers, "x-ratelimit-reset");
  const resource = headers.get("x-ratelimit-resource") ?? undefined;
  if (limit === undefined && remaining === undefined && used === undefined && reset === undefined && !resource && !bodyBudget) return null;
  return {
    ...bodyBudget,
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(reset !== undefined && reset > 0 ? { resetAtMs: reset * 1000 } : {}),
    ...(resource ? { resource } : {}),
  };
}

function budgetKey(selection: AuthSelectionState, token: AuthToken): string {
  return budgetKeyFor(selection.namespace, token);
}

function budgetStateFor(selection: AuthSelectionState, token: AuthToken): AuthBudgetState {
  const key = budgetKey(selection, token);
  let state = authBudgetStates.get(key);
  if (!state) {
    state = { inFlight: 0, lastCost: DEFAULT_ESTIMATED_COST };
    authBudgetStates.set(key, state);
  }
  return state;
}

function resetExpiredBudget(state: AuthBudgetState, now: number): void {
  if (state.resetAtMs === undefined || state.resetAtMs > now) return;
  delete state.limit;
  delete state.remaining;
  delete state.used;
  delete state.resetAtMs;
  delete state.blockedUntilMs;
  state.lastCost = DEFAULT_ESTIMATED_COST;
}

function tokenAvailable(
  tokens: readonly AuthToken[],
  blockedUntil: Map<number, number>,
  selection: AuthSelectionState,
  idx: number,
  now: number,
): boolean {
  if ((blockedUntil.get(idx) ?? 0) > now) return false;
  const token = tokens[idx];
  if (!isBudgetAwareToken(token)) return true;
  const state = budgetStateFor(selection, token);
  resetExpiredBudget(state, now);
  return (state.blockedUntilMs ?? 0) <= now;
}

function selectBudgetAwareToken(
  tokens: readonly AuthToken[],
  blockedUntil: Map<number, number>,
  selection: AuthSelectionState,
  candidate: (idx: number) => boolean,
  now: number,
): number | null {
  let best: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestUsed = Number.POSITIVE_INFINITY;
  for (let step = 0; step < tokens.length; step++) {
    const idx = (selection.cursor + step) % tokens.length;
    if (!selection.budgetAwareIndexSet.has(idx)) continue;
    if (!candidate(idx)) continue;
    if (!tokenAvailable(tokens, blockedUntil, selection, idx, now)) continue;
    const state = budgetStateFor(selection, tokens[idx]!);
    resetExpiredBudget(state, now);
    if (state.remaining === undefined) {
      selection.cursor = (idx + 1) % tokens.length;
      return idx;
    }
    const cost = state.lastCost > 0 ? state.lastCost : DEFAULT_ESTIMATED_COST;
    const score = (state.remaining ?? 0) - state.inFlight * cost;
    const used = state.used ?? Number.POSITIVE_INFINITY;
    if (score > bestScore || (score === bestScore && used < bestUsed)) {
      best = idx;
      bestScore = score;
      bestUsed = used;
    }
  }
  if (best !== null) selection.cursor = (best + 1) % tokens.length;
  return best;
}

export function recordAuthAttemptStart(tokens: readonly AuthToken[], idx: number, selection: AuthSelectionState): void {
  const token = tokens[idx];
  if (!isBudgetAwareToken(token)) return;
  budgetStateFor(selection, token).inFlight++;
}

export function recordAuthAttemptDone(
  tokens: readonly AuthToken[],
  idx: number,
  selection: AuthSelectionState,
  budget: GitHubRateBudget | null = null,
  now: number = Date.now(),
): void {
  const token = tokens[idx];
  if (!isBudgetAwareToken(token)) return;
  const state = budgetStateFor(selection, token);
  if (state.inFlight > 0) state.inFlight--;
  resetExpiredBudget(state, now);
  if (!budget) return;

  const priorRemaining = state.remaining;
  const priorResetAt = state.resetAtMs;
  if (budget.limit !== undefined) state.limit = budget.limit;
  if (budget.used !== undefined) state.used = budget.used;
  if (budget.resetAtMs !== undefined) state.resetAtMs = budget.resetAtMs;
  if (budget.cost !== undefined && budget.cost > 0) state.lastCost = budget.cost;
  if (budget.remaining !== undefined) {
    if (
      budget.cost === undefined &&
      priorRemaining !== undefined &&
      priorRemaining >= budget.remaining &&
      (priorResetAt === undefined || budget.resetAtMs === undefined || priorResetAt === budget.resetAtMs)
    ) {
      const observedCost = priorRemaining - budget.remaining;
      if (observedCost > 0) state.lastCost = observedCost;
    }
    state.remaining = budget.remaining;
  }
  if (state.remaining === 0 && state.resetAtMs !== undefined) state.blockedUntilMs = state.resetAtMs;
}

export function markAuthTokenCooledDown(tokens: readonly AuthToken[], idx: number, selection: AuthSelectionState, until: number): void {
  const token = tokens[idx];
  if (!isBudgetAwareToken(token)) return;
  budgetStateFor(selection, token).blockedUntilMs = until;
}

export function selectAvailableToken(
  tokens: readonly AuthToken[],
  blockedUntil: Map<number, number>,
  selection: AuthSelectionState,
  now: number = Date.now(),
): number | null {
  if (tokens.length === 0) return null;
  const budgetChoice = selectBudgetAwareToken(tokens, blockedUntil, selection, () => true, now);
  if (budgetChoice !== null) return budgetChoice;
  for (let idx = 0; idx < tokens.length; idx++) {
    if (tokenAvailable(tokens, blockedUntil, selection, idx, now)) return idx;
  }
  return null;
}

// Pick the next token to retry after `after` was rate-limited, mirroring
// selectAvailableToken's bot-first rule: prefer an available GitHub App bot
// token before falling back to any available token (e.g. the failover PAT). The
// preference keys on the token being a bot (`kind === "github_app"`), so a
// `bot_then_pat` pool whose apps use the failover strategy still rotates to a
// sibling bot before spending PAT quota. The initial pick is already bot-first;
// without the same preference here a retry could spend PAT quota while a bot in
// the pool is still available.
export function nextAvailableToken(
  tokens: readonly AuthToken[],
  blockedUntil: Map<number, number>,
  tried: ReadonlySet<number>,
  after: number,
  selection?: AuthSelectionState,
  now: number = Date.now(),
): number | null {
  const tokenCount = tokens.length;
  const available = (idx: number) => selection
    ? tokenAvailable(tokens, blockedUntil, selection, idx, now)
    : (blockedUntil.get(idx) ?? 0) <= now;
  if (selection) {
    const budgetChoice = selectBudgetAwareToken(
      tokens,
      blockedUntil,
      selection,
      (idx) => !tried.has(idx) && tokens[idx]?.kind === "github_app",
      now,
    );
    if (budgetChoice !== null) return budgetChoice;
  }
  for (let step = 1; step <= tokenCount; step++) {
    const idx = (after + step) % tokenCount;
    if (tried.has(idx)) continue;
    if (tokens[idx]?.kind !== "github_app") continue;
    if (!available(idx)) continue;
    return idx;
  }
  for (let step = 1; step <= tokenCount; step++) {
    const idx = (after + step) % tokenCount;
    if (tried.has(idx)) continue;
    if (available(idx)) return idx;
  }
  return null;
}

export function isGithubPrimaryRateLimit(provider: string, err: ProviderHttpError): boolean {
  return provider === "github" && err.rateLimit?.kind === "primary";
}

// Error raised when every token in the pool is cooled down. Carries the soonest
// reset so callers/telemetry can see when a retry could succeed.
export function allTokensCooledDownError(
  label: string,
  tokenCount: number,
  blockedUntil: Map<number, number>,
  tokens: readonly AuthToken[] = [],
  selection?: AuthSelectionState,
): ProviderHttpError {
  let soonest: number | null = null;
  for (const at of blockedUntil.values()) {
    if (soonest === null || at < soonest) soonest = at;
  }
  if (selection) {
    for (const idx of selection.budgetAwareIndexes) {
      const token = tokens[idx];
      if (!token) continue;
      const state = authBudgetStates.get(budgetKey(selection, token));
      if (!state) continue;
      if (state.blockedUntilMs !== undefined && (soonest === null || state.blockedUntilMs < soonest)) soonest = state.blockedUntilMs;
    }
  }
  const when = soonest ? ` until ${new Date(soonest).toISOString()}` : "";
  return new ProviderHttpError(
    `${label}: all ${tokenCount} token(s) are rate-limited${when}`,
    429,
    soonest ? { kind: "primary", resetAtMs: soonest, retryAfterMs: null } : null,
  );
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`request to ${String(input)} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
