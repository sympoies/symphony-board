#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ACTORS = ["chatgpt-codex-connector"];
const DEFAULT_RESOLUTION_NOTE = "Resolved by project-review-cleanup: stale allowlisted bot review thread on a closed or merged PR after live verification.";
const DISPOSITIONS = new Set(["stale", "fixed", "follow_up", "accepted"]);
const DEFAULT_CONTRACT_PATH = "data/contract.json";
const DEFAULT_PG_CONTRACT_PORT = "18080";
const CONTRACT_FETCH_TIMEOUT_MS = 10_000;

const REVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $threadCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      title
      state
      mergedAt
      closedAt
      url
      reviewThreads(first: 100, after: $threadCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 100) {
            totalCount
            nodes {
              id
              author { login }
              url
              createdAt
              updatedAt
              bodyText
              diffHunk
              path
              line
              originalLine
              pullRequestReview {
                id
                state
                submittedAt
                url
                author { login }
              }
            }
          }
        }
      }
      reviews(last: 30) {
        nodes {
          id
          state
          author { login }
          submittedAt
          url
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

const REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId,
    body: $body
  }) {
    comment {
      id
      url
    }
  }
}`;

function usage() {
  return `Usage:
  project-review-cleanup.sh [options]

Options:
  --contract PATH   Contract file to scan (overrides repo .env defaults).
  --contract-url URL
                    Contract URL to scan (overrides repo .env defaults).
                    By default, repo .env SYMPHONY_BOARD_ENV=postgres reads
                    http://127.0.0.1:\${SYMPHONY_POSTGRES_WEB_PORT:-18080}/contract.json;
                    otherwise the default is data/contract.json.
  --repo OWNER/REPO GitHub repository to verify (default: all GitHub repos in
                    the contract; origin for live-only without a contract).
  --pr NUMBER       Focus one PR and allow live-only verification.
  --days N          Contract lookback window (default: 7).
  --actor LOGIN     Allowlisted bot actor; repeatable.
  --all-actors      Report candidates from every actor.
  --limit N         Maximum contract candidates (default: 20).
  --no-live         Skip provider live verification.
  --apply           Resolve safe allowlisted bot review threads.
  --disposition-file PATH
                    JSON file of agent-inspected thread dispositions. In
                    --apply mode, only listed safe threads are resolved and
                    each uses its per-thread note.
  --resolution-note TEXT
                    Provider-visible note to reply before resolving threads.
                    Defaults to a stale-thread disposition note in --apply mode.
  --no-resolution-note
                    Resolve without posting a provider-visible note.
  --json            Emit JSON.
  -h, --help        Show this help.`;
}

function parseArgs(argv) {
  const options = {
    contractPath: null,
    contractUrl: null,
    repo: null,
    pr: null,
    days: 7,
    actors: [],
    allActors: false,
    limit: 20,
    live: true,
    apply: false,
    dispositionPath: null,
    dispositions: null,
    resolutionNote: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw usageError(`${arg} requires a value`);
      return argv[i];
    };

    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--contract") {
      options.contractPath = next();
    } else if (arg === "--contract-url") {
      options.contractUrl = next();
    } else if (arg === "--repo") {
      options.repo = next();
    } else if (arg === "--pr") {
      options.pr = parsePositiveInt(next(), "--pr");
    } else if (arg === "--days") {
      options.days = parseNonNegativeNumber(next(), "--days");
    } else if (arg === "--actor") {
      options.actors.push(next());
    } else if (arg === "--all-actors") {
      options.allActors = true;
    } else if (arg === "--limit") {
      options.limit = parsePositiveInt(next(), "--limit");
    } else if (arg === "--no-live") {
      options.live = false;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--disposition-file") {
      options.dispositionPath = next();
    } else if (arg === "--resolution-note") {
      options.resolutionNote = next();
    } else if (arg === "--no-resolution-note") {
      options.resolutionNote = "";
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw usageError(`unknown argument: ${arg}`);
    }
  }

  if (options.apply && !options.live) {
    throw usageError("--apply requires live provider verification");
  }
  if (options.contractPath && options.contractUrl) {
    throw usageError("--contract and --contract-url are mutually exclusive");
  }
  if (options.dispositionPath && !options.live) {
    throw usageError("--disposition-file requires live provider verification");
  }
  if (!options.apply && options.resolutionNote != null) {
    throw usageError("--resolution-note and --no-resolution-note require --apply");
  }
  if (options.apply && options.resolutionNote == null) {
    options.resolutionNote = DEFAULT_RESOLUTION_NOTE;
  }

  const envActors = (process.env.PROJECT_REVIEW_CLEANUP_ALLOW_ACTORS ?? "")
    .split(",")
    .map((actor) => actor.trim())
    .filter(Boolean);
  options.allowActors = unique([...DEFAULT_ACTORS, ...envActors, ...options.actors]);
  return options;
}

function parsePositiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw usageError(`${name} must be a non-negative number`);
  }
  return parsed;
}

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function repoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function parseEnvContent(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;
    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = stripEnvQuotes(normalized.slice(equals + 1).trim());
  }
  return env;
}

function stripEnvQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function loadRepoEnv() {
  const root = repoRoot();
  if (!root) return {};
  try {
    return parseEnvContent(readFileSync(join(root, ".env"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`failed to read repo .env: ${error.message}`);
  }
}

function resolveContractSource(options, deps = {}) {
  if (options.contractPath) {
    return { kind: "file", value: options.contractPath, origin: "--contract" };
  }
  if (options.contractUrl) {
    return { kind: "url", value: options.contractUrl, origin: "--contract-url" };
  }

  const repoEnv = deps.repoEnv ?? loadRepoEnv();
  const processEnv = deps.processEnv ?? process.env;
  const envValue = (name) => stringValue(processEnv[name]) ?? stringValue(repoEnv[name]);

  const cleanupUrl = envValue("PROJECT_REVIEW_CLEANUP_CONTRACT_URL");
  if (cleanupUrl) return { kind: "url", value: cleanupUrl, origin: "PROJECT_REVIEW_CLEANUP_CONTRACT_URL" };

  const boardUrl = envValue("SYMPHONY_BOARD_CONTRACT_URL");
  if (boardUrl) return { kind: "url", value: boardUrl, origin: "SYMPHONY_BOARD_CONTRACT_URL" };

  const runtime = (envValue("SYMPHONY_BOARD_ENV") ?? envValue("SYMPHONY_BOARD_RUNTIME") ?? "").toLowerCase();
  if (runtime === "postgres") {
    const port = envValue("SYMPHONY_POSTGRES_WEB_PORT") ?? envValue("SYMPHONY_PG_WEB_PORT") ?? DEFAULT_PG_CONTRACT_PORT;
    return {
      kind: "url",
      value: `http://127.0.0.1:${port}/contract.json`,
      origin: "SYMPHONY_BOARD_ENV=postgres",
    };
  }
  if (runtime && runtime !== "sqlite") {
    throw usageError(`unsupported SYMPHONY_BOARD_ENV=${runtime}; expected postgres or sqlite`);
  }

  return {
    kind: "file",
    value: DEFAULT_CONTRACT_PATH,
    origin: runtime ? `SYMPHONY_BOARD_ENV=${runtime}` : "default",
  };
}

async function loadContract(source) {
  if (source.kind === "url") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTRACT_FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(source.value, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`failed to fetch contract ${source.value}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`failed to fetch contract ${source.value}: HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`failed to parse contract ${source.value}: ${error.message}`);
    }
  }

  try {
    return JSON.parse(readFileSync(source.value, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`failed to read contract ${source.value}: ${error.message}`);
  }
}

function loadDispositionFile(path) {
  try {
    return parseDispositionDocument(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error?.usage) throw error;
    throw new Error(`failed to read disposition file ${path}: ${error.message}`);
  }
}

function parseDispositionDocument(document) {
  let entries;
  if (Array.isArray(document)) {
    entries = document;
  } else if (Array.isArray(document?.threads)) {
    entries = document.threads;
  } else if (document && typeof document === "object") {
    entries = Object.entries(document).map(([threadId, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { threadId, ...value };
      }
      return { threadId, disposition: value };
    });
  } else {
    throw usageError("disposition file must be an array, an object with threads[], or a thread-id map");
  }

  const dispositions = new Map();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw usageError(`disposition entry ${index + 1} must be an object`);
    }
    const threadId = stringValue(entry.threadId ?? entry.thread_id);
    if (!threadId) throw usageError(`disposition entry ${index + 1} is missing threadId`);
    if (dispositions.has(threadId)) throw usageError(`duplicate disposition for thread ${threadId}`);

    const disposition = stringValue(entry.disposition);
    if (!DISPOSITIONS.has(disposition)) {
      throw usageError(`disposition for thread ${threadId} must be one of: ${[...DISPOSITIONS].join(", ")}`);
    }

    const note = stringValue(entry.note ?? entry.resolution_note) ?? defaultDispositionNote(entry);
    if (!note) throw usageError(`disposition for thread ${threadId} needs a provider-visible note`);

    dispositions.set(threadId, {
      threadId,
      disposition,
      note,
      followUpUrl: stringValue(entry.followUpUrl ?? entry.follow_up_url),
      fixPrUrl: stringValue(entry.fixPrUrl ?? entry.fix_pr_url),
      issueUrl: stringValue(entry.issueUrl ?? entry.issue_url),
    });
  }
  return dispositions;
}

function defaultDispositionNote(entry) {
  const disposition = stringValue(entry.disposition);
  const url = stringValue(entry.fixPrUrl ?? entry.fix_pr_url ?? entry.followUpUrl ?? entry.follow_up_url ?? entry.issueUrl ?? entry.issue_url);
  if (!url && (disposition === "fixed" || disposition === "follow_up")) return null;

  if (disposition === "fixed") {
    return `Resolved by project-review-cleanup: fixed in follow-up PR ${url}.`;
  }
  if (disposition === "follow_up") {
    return `Resolved by project-review-cleanup: tracked in follow-up issue ${url}.`;
  }
  if (disposition === "accepted") {
    return `Resolved by project-review-cleanup: accepted as a tradeoff after agent review${url ? ` (${url})` : ""}.`;
  }
  if (disposition === "stale") {
    return `Resolved by project-review-cleanup: stale or no longer actionable after agent review${url ? ` (${url})` : ""}.`;
  }
  return null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultRepo() {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const url = result.stdout.trim();
  const ssh = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (ssh) return ssh[1];
  return null;
}

function splitRepo(repo) {
  const parts = String(repo ?? "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw usageError("--repo must be OWNER/REPO");
  }
  return { owner: parts[0], name: parts[1] };
}

function buildCandidates(contract, options, repo) {
  if (!contract) return [];
  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;
  const sources = new Map();
  for (const source of contract.sources ?? []) {
    if (source.source_id) sources.set(source.source_id, source);
  }
  const isGithub = (sourceId) => sources.get(sourceId)?.kind === "github";

  const items = new Map();
  for (const item of contract.items ?? []) {
    if (item.kind !== "change_request") continue;
    items.set(itemKey(item.source_id, item.project_path, item.iid), item);
  }

  // Most recent GitHub review activity per change_request. Used only to enrich
  // candidate display (who reviewed last, when) — never to gate discovery, so
  // an open thread from a non-allowlisted actor still surfaces.
  const latestReview = new Map();
  for (const activity of contract.activities ?? []) {
    if (activity.kind !== "review" || activity.target_kind !== "change_request") continue;
    if (!isGithub(activity.source_id)) continue;
    const key = itemKey(activity.source_id, activity.project_path, activity.target_iid);
    const prev = latestReview.get(key);
    if (!prev || (toMs(activity.occurred_at) ?? 0) > (toMs(prev.occurred_at) ?? 0)) {
      latestReview.set(key, activity);
    }
  }

  const allowSet = new Set(options.allowActors);
  const candidates = new Map();
  const candidateKey = (sourceId, projectPath, iid) => `${sourceId ?? ""}|${projectPath ?? ""}#${Number(iid)}`;
  const ensure = (sourceId, projectPath, iid, item) => {
    const sid = sourceId ?? item?.source_id ?? null;
    const key = candidateKey(sid, projectPath, iid);
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = {
        sourceId: sid,
        pr: Number(iid),
        repo: projectPath,
        title: item?.title ?? null,
        actor: null,
        action: null,
        state: null,
        reviewUrl: null,
        reviewOccurredAt: null,
        itemState: item?.state ?? null,
        itemUrl: item?.url ?? null,
        mergedAt: item?.merged_at ?? null,
        closedAt: item?.closed_at ?? null,
        openThreads: item?.review_threads?.open ?? null,
        totalThreads: item?.review_threads?.total ?? null,
        reasons: [],
        reason: null,
      };
      candidates.set(key, candidate);
    } else if (!candidate.sourceId && sourceId) {
      candidate.sourceId = sourceId;
    }
    return candidate;
  };
  const addReason = (candidate, reason) => {
    if (!candidate.reasons.includes(reason)) candidate.reasons.push(reason);
  };

  // Pass 1 — item-centric, actor-agnostic. Any GitHub change_request the
  // contract reports with open review threads (review_threads.open > 0). This
  // mirrors the board "unresolved" lens and is the primary, complete discovery
  // source: it does not depend on a review activity existing in the window, on
  // when the review landed, or on who authored it. The actor allowlist governs
  // only what --apply may auto-resolve, not what gets reported.
  for (const item of items.values()) {
    if (!(item.review_threads && item.review_threads.open > 0)) continue;
    if (!isGithub(item.source_id)) continue;
    if (repo && item.project_path !== repo) continue;
    if (options.pr && Number(item.iid) !== options.pr) continue;
    addReason(ensure(item.source_id, item.project_path, item.iid, item), "open_review_threads");
  }

  // Pass 2 — activity-centric heuristic. An allowlisted bot review that landed
  // after merge/close (late) or on an already-closed PR, even if its threads
  // are now resolved. Still gated by the actor allowlist (widen with
  // --all-actors) and the --days window; this flags review timing that the
  // point-in-time open-thread count cannot.
  for (const activity of contract.activities ?? []) {
    if (activity.kind !== "review" || activity.target_kind !== "change_request") continue;
    if (!isGithub(activity.source_id)) continue;
    if (repo && activity.project_path !== repo) continue;
    if (options.pr && Number(activity.target_iid) !== options.pr) continue;
    if (!options.allActors && !allowSet.has(activity.actor)) continue;

    const occurredMs = toMs(activity.occurred_at);
    if (occurredMs != null && occurredMs < cutoffMs) continue;

    const item = items.get(itemKey(activity.source_id, activity.project_path, activity.target_iid));
    const resolvedAt = item?.merged_at ?? item?.closed_at ?? null;
    const resolvedMs = toMs(resolvedAt);
    const late = resolvedMs != null && occurredMs != null && occurredMs > resolvedMs;
    const closed = item?.state && item.state !== "open";
    if (!late && !closed && !options.pr) continue;

    addReason(ensure(activity.source_id, activity.project_path, activity.target_iid, item), late ? "late_review" : "review_on_closed_pr");
  }

  const list = [...candidates.values()];
  for (const candidate of list) {
    const review = latestReview.get(itemKey(candidate.sourceId, candidate.repo, candidate.pr));
    if (review) {
      candidate.actor = review.actor ?? null;
      candidate.action = review.action ?? null;
      candidate.state = review.details?.state ?? null;
      candidate.reviewUrl = review.url ?? null;
      candidate.reviewOccurredAt = review.occurred_at ?? null;
      if (!candidate.title) candidate.title = review.title ?? null;
    }
    // Lead with the actionable open-thread signal when present.
    candidate.reason = candidate.reasons.includes("open_review_threads")
      ? "open_review_threads"
      : candidate.reasons[0] ?? null;
  }

  // Open-thread candidates first (most open threads first), then by review
  // recency, so the actionable, complete signal leads the report.
  list.sort((a, b) => {
    const ao = a.openThreads ?? -1;
    const bo = b.openThreads ?? -1;
    if (ao !== bo) return bo - ao;
    return (toMs(b.reviewOccurredAt) ?? 0) - (toMs(a.reviewOccurredAt) ?? 0);
  });
  return list.slice(0, options.limit);
}

function targetKey(target) {
  return `${target.repo ?? ""}#${target.pr ?? ""}`;
}

function uniqueTargets(targets) {
  const seen = new Set();
  const uniqueTargets = [];
  for (const target of targets) {
    if (!target.repo || !target.pr) continue;
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTargets.push(target);
  }
  return uniqueTargets;
}

function itemKey(sourceId, projectPath, iid) {
  return `${sourceId ?? ""}|${projectPath ?? ""}|${iid ?? ""}`;
}

function toMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function queryPr(repo, pr) {
  const { owner, name } = splitRepo(repo);
  let cursor = null;
  let mergedPullRequest = null;
  const reviewThreads = [];

  do {
    const args = [
      "api",
      "graphql",
      "-f", `query=${REVIEW_QUERY}`,
      "-F", `owner=${owner}`,
      "-F", `name=${name}`,
      "-F", `number=${pr}`,
    ];
    if (cursor) args.push("-F", `threadCursor=${cursor}`);

    const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `gh exited ${result.status}`).trim());
    }
    const body = JSON.parse(result.stdout);
    const pullRequest = body?.data?.repository?.pullRequest;
    if (!pullRequest) throw new Error(`PR #${pr} was not found in ${repo}`);

    if (!mergedPullRequest) mergedPullRequest = pullRequest;
    reviewThreads.push(...(pullRequest.reviewThreads?.nodes ?? []));
    cursor = pullRequest.reviewThreads?.pageInfo?.hasNextPage
      ? pullRequest.reviewThreads.pageInfo.endCursor
      : null;
  } while (cursor);

  mergedPullRequest.reviewThreads = {
    ...(mergedPullRequest.reviewThreads ?? {}),
    nodes: reviewThreads,
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  return mergedPullRequest;
}

function resolveThread(threadId) {
  const result = spawnSync("gh", [
    "api",
    "graphql",
    "-f", `query=${RESOLVE_MUTATION}`,
    "-F", `threadId=${threadId}`,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `gh exited ${result.status}`).trim());
  }
  const body = JSON.parse(result.stdout);
  return body?.data?.resolveReviewThread?.thread ?? null;
}

function replyThread(threadId, body) {
  const result = spawnSync("gh", [
    "api",
    "graphql",
    "-f", `query=${REPLY_MUTATION}`,
    "-F", `threadId=${threadId}`,
    "-F", `body=${body}`,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `gh exited ${result.status}`).trim());
  }
  const response = JSON.parse(result.stdout);
  return response?.data?.addPullRequestReviewThreadReply?.comment ?? null;
}

function classifyLive(prData, allowActors) {
  const allowSet = new Set(allowActors);
  const unresolved = (prData.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved);
  const threadSummaries = unresolved.map((thread) => {
    const comments = thread.comments?.nodes ?? [];
    const commentSummaries = comments.map((comment) => ({
      id: comment.id ?? null,
      author: comment.author?.login ?? null,
      url: comment.url ?? null,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
      bodyText: comment.bodyText ?? null,
      diffHunk: comment.diffHunk ?? null,
      path: comment.path ?? thread.path ?? null,
      line: comment.line ?? comment.originalLine ?? thread.line ?? thread.originalLine ?? null,
      review: comment.pullRequestReview
        ? {
            id: comment.pullRequestReview.id ?? null,
            state: comment.pullRequestReview.state ?? null,
            submittedAt: comment.pullRequestReview.submittedAt ?? null,
            url: comment.pullRequestReview.url ?? null,
            author: comment.pullRequestReview.author?.login ?? null,
          }
        : null,
    }));
    const authorLogins = commentSummaries.map((comment) => comment.author);
    const unknownAuthorCount = authorLogins.filter((actor) => !actor).length;
    const authors = unique(authorLogins.filter(Boolean));
    const allCommentsInspected = comments.length === (thread.comments?.totalCount ?? comments.length);
    const allowlistedAuthorsOnly = comments.length > 0
      && unknownAuthorCount === 0
      && authors.every((actor) => allowSet.has(actor));
    const safeToResolve = prData.state !== "OPEN" && allCommentsInspected && allowlistedAuthorsOnly;
    return {
      id: thread.id,
      path: thread.path ?? null,
      line: thread.line ?? thread.originalLine ?? null,
      isOutdated: Boolean(thread.isOutdated),
      authors,
      comments: commentSummaries,
      commentsInspected: comments.length,
      commentsTotal: thread.comments?.totalCount ?? comments.length,
      unknownAuthorCount,
      firstUrl: commentSummaries[0]?.url ?? null,
      lastUrl: commentSummaries.at(-1)?.url ?? null,
      latestCommentText: summarizeComment(commentSummaries.at(-1)?.bodyText),
      safeToResolve,
      reason: safeToResolve ? "closed_pr_allowlisted_bot_thread" : unsafeReason(prData, authors, allowSet, allCommentsInspected, unknownAuthorCount),
    };
  });

  const reviews = (prData.reviews?.nodes ?? []).map((review) => ({
    actor: review.author?.login ?? null,
    state: review.state ?? null,
    submittedAt: review.submittedAt ?? null,
    url: review.url ?? null,
  }));

  return {
    pr: prData.number,
    state: prData.state,
    title: prData.title,
    url: prData.url,
    mergedAt: prData.mergedAt ?? null,
    closedAt: prData.closedAt ?? null,
    unresolvedThreads: threadSummaries,
    unresolvedCount: threadSummaries.length,
    safeToResolveCount: threadSummaries.filter((thread) => thread.safeToResolve).length,
    reviews,
  };
}

function unsafeReason(prData, authors, allowSet, allCommentsInspected, unknownAuthorCount) {
  if (prData.state === "OPEN") return "pr_open";
  if (!allCommentsInspected) return "thread_comments_not_fully_inspected";
  if (unknownAuthorCount > 0) return "thread_has_unknown_author";
  if (authors.length === 0) return "thread_has_no_comment_authors";
  if (authors.some((actor) => !allowSet.has(actor))) return "human_or_unallowlisted_author";
  return "not_safe";
}

function summarizeComment(bodyText) {
  const normalized = stringValue(bodyText)?.replace(/\s+/g, " ") ?? null;
  if (!normalized) return null;
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function annotateDispositions(live, dispositions) {
  if (!dispositions) return live;
  for (const thread of live.unresolvedThreads) {
    thread.disposition = dispositions.get(thread.id) ?? null;
  }
  return live;
}

function liveTargetKey(repo, pr) {
  return `${repo ?? ""}#${pr ?? ""}`;
}

function summarizeCandidateLive(entry) {
  if (!entry) {
    return {
      checked: false,
      unresolvedCount: null,
      safeToResolveCount: null,
      unresolvedThreadIds: [],
    };
  }
  if (entry.error) {
    return {
      checked: true,
      error: entry.error,
      unresolvedCount: null,
      safeToResolveCount: null,
      unresolvedThreadIds: [],
    };
  }
  return {
    checked: true,
    state: entry.state ?? null,
    unresolvedCount: entry.unresolvedCount,
    safeToResolveCount: entry.safeToResolveCount,
    unresolvedThreadIds: entry.unresolvedThreads.map((thread) => thread.id),
  };
}

function attachCandidateLiveSummaries(result) {
  const liveByTarget = new Map(result.live.map((entry) => [liveTargetKey(entry.repo, entry.pr), entry]));
  for (const candidate of result.candidates) {
    candidate.live = summarizeCandidateLive(liveByTarget.get(liveTargetKey(candidate.repo, candidate.pr)));
  }
}

function summarizeResult(result) {
  const verifiedLive = result.live.filter((entry) => !entry.error);
  return {
    contractCandidateCount: result.candidates.length,
    liveTargetCount: result.live.length,
    liveFailedTargetCount: result.live.length - verifiedLive.length,
    liveUnresolvedThreadCount: verifiedLive.reduce((sum, entry) => sum + entry.unresolvedCount, 0),
    liveSafeToResolveThreadCount: verifiedLive.reduce((sum, entry) => sum + entry.safeToResolveCount, 0),
    applyActionCount: result.actions.length,
    resolvedActionCount: result.actions.filter((action) => action.status === "resolved").length,
    warningCount: result.warnings.length,
  };
}

function runCleanup(options, repo, contract, deps = {}) {
  const queryPrFn = deps.queryPr ?? queryPr;
  const resolveThreadFn = deps.resolveThread ?? resolveThread;
  const replyThreadFn = deps.replyThread ?? replyThread;
  const dispositions = options.dispositions ?? null;
  const matchedDispositionIds = new Set();
  const candidates = buildCandidates(contract, options, repo);
  const focusedTargets = uniqueTargets([
    ...candidates.map((candidate) => ({ repo: candidate.repo, pr: candidate.pr })),
    ...(options.pr && repo ? [{ repo, pr: options.pr }] : []),
  ]);

  const result = {
    repo,
    contractPath: options.contractPath,
    contractSourceKind: options.contractSourceKind ?? null,
    contractSourceOrigin: options.contractSourceOrigin ?? null,
    contractLoaded: Boolean(contract),
    apply: options.apply,
    dispositionPath: options.dispositionPath,
    dispositionCount: dispositions?.size ?? 0,
    resolutionNote: options.apply && options.resolutionNote ? options.resolutionNote : null,
    allowActors: options.allowActors,
    candidates,
    live: [],
    actions: [],
    warnings: [],
    summary: null,
  };

  if (options.pr && !repo && focusedTargets.length === 0) {
    result.warnings.push("--pr without --repo found no matching contract candidates; pass --repo OWNER/REPO for live-only verification");
  }

  if (options.live) {
    for (const target of focusedTargets) {
      try {
        const live = annotateDispositions(classifyLive(queryPrFn(target.repo, target.pr), options.allowActors), dispositions);
        result.live.push({ repo: target.repo, ...live });
      } catch (error) {
        result.live.push({ repo: target.repo, pr: target.pr, error: error.message });
        result.warnings.push(`live verification failed for ${target.repo}#${target.pr}: ${error.message}`);
      }
    }

    if (options.apply && result.live.some((entry) => entry.error)) {
      result.warnings.push("apply aborted before mutation because one or more live verifications failed");
    } else if (options.apply) {
      for (const live of result.live) {
        for (const thread of live.unresolvedThreads) {
          const disposition = dispositions?.get(thread.id) ?? null;
          if (dispositions && !disposition) {
            if (thread.safeToResolve) {
              result.warnings.push(`safe thread ${live.repo ?? repo}#${live.pr} ${thread.id} lacks an agent disposition; left unresolved`);
            }
            continue;
          }
          if (!thread.safeToResolve) {
            if (disposition) {
              matchedDispositionIds.add(thread.id);
              result.warnings.push(`disposition for ${live.repo ?? repo}#${live.pr} ${thread.id} was not applied: ${thread.reason}`);
            }
            continue;
          }

          matchedDispositionIds.add(thread.id);
          const replyBody = disposition?.note ?? options.resolutionNote;
          const note = replyBody
            ? replyThreadFn(thread.id, replyBody)
            : null;
          const resolved = resolveThreadFn(thread.id);
          result.actions.push({
            repo: live.repo ?? repo,
            pr: live.pr,
            threadId: thread.id,
            disposition: disposition?.disposition ?? "stale",
            reason: thread.reason,
            threadUrl: thread.lastUrl ?? null,
            noteUrl: note?.url ?? null,
            status: resolved?.isResolved ? "resolved" : "mutation_returned_unresolved",
          });
        }
      }
      for (const threadId of dispositions?.keys() ?? []) {
        if (!matchedDispositionIds.has(threadId)) {
          result.warnings.push(`disposition for thread ${threadId} did not match any focused unresolved live thread`);
        }
      }
    }
  } else if (focusedTargets.length > 0) {
    result.warnings.push("--no-live skipped provider verification");
  }

  attachCandidateLiveSummaries(result);
  result.summary = summarizeResult(result);
  return result;
}

function printText(result) {
  console.log("Project review cleanup");
  console.log(`Repo: ${result.repo ?? "all GitHub repos in contract"}`);
  const source = result.contractSourceOrigin ? ` (${result.contractSourceOrigin})` : "";
  console.log(`Contract: ${result.contractPath}${source}${result.contractLoaded ? "" : " (not loaded)"}`);
  console.log(`Mode: ${result.apply ? "apply" : "dry-run"}`);
  if (result.dispositionPath) console.log(`Disposition file: ${result.dispositionPath} (${result.dispositionCount} thread${result.dispositionCount === 1 ? "" : "s"})`);
  console.log(`Allowlisted actors: ${result.allowActors.join(", ") || "(none)"}`);
  console.log("");
  console.log(`Contract candidates: ${result.candidates.length}`);
  for (const candidate of result.candidates) {
    const reasons = (candidate.reasons?.length ? candidate.reasons : [candidate.reason]).filter(Boolean).join("+");
    const threads = candidate.openThreads != null
      ? ` open_threads=${candidate.openThreads}/${candidate.totalThreads ?? "?"}`
      : "";
    const lastReview = candidate.actor
      ? ` last review by ${candidate.actor}${candidate.reviewOccurredAt ? ` at ${candidate.reviewOccurredAt}` : ""}`
      : "";
    console.log(`- ${candidate.repo}#${candidate.pr} ${reasons}:${threads}${lastReview}`);
    console.log(`  ${candidate.title ?? "(no title)"}`);
    console.log(`  state=${candidate.itemState ?? "unknown"} merged_at=${candidate.mergedAt ?? "null"} closed_at=${candidate.closedAt ?? "null"}`);
    if (candidate.reviewUrl) console.log(`  review=${candidate.reviewUrl}`);
  }

  if (result.live.length > 0) {
    console.log("");
    console.log("Live GitHub verification:");
    for (const live of result.live) {
      if (live.error) {
        console.log(`- ${live.repo ?? result.repo}#${live.pr}: live check failed: ${live.error}`);
        continue;
      }
      console.log(`- ${live.repo ?? result.repo}#${live.pr} ${live.state}: unresolved=${live.unresolvedCount}, safe_to_resolve=${live.safeToResolveCount}`);
      for (const thread of live.unresolvedThreads) {
        console.log(`  thread ${thread.id}: ${thread.reason}; authors=${thread.authors.join(", ") || "(none)"}; path=${thread.path ?? "(unknown)"}`);
        if (thread.disposition) console.log(`  disposition=${thread.disposition.disposition}`);
        if (thread.latestCommentText) console.log(`  comment=${thread.latestCommentText}`);
        if (thread.lastUrl) console.log(`  url=${thread.lastUrl}`);
      }
    }
  }

  if (result.actions.length > 0) {
    console.log("");
    console.log("Apply actions:");
    for (const action of result.actions) {
      console.log(`- ${action.status}: ${action.repo ?? result.repo}#${action.pr} thread ${action.threadId}; disposition=${action.disposition}; reason=${action.reason}`);
      if (action.noteUrl) console.log(`  note=${action.noteUrl}`);
    }
  } else {
    console.log("");
    console.log(result.apply ? "Apply actions: none" : "No apply actions taken (dry-run).");
  }

  for (const warning of result.warnings) {
    console.error(`warning: ${warning}`);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error(usage());
    process.exit(2);
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const contractSource = resolveContractSource(options);
  options.contractPath = contractSource.value;
  options.contractSourceKind = contractSource.kind;
  options.contractSourceOrigin = contractSource.origin;
  const contract = await loadContract(contractSource);
  if (!contract && !options.pr) {
    throw new Error(`contract not found at ${options.contractPath}; pass --contract or --pr for live-only triage`);
  }

  const repo = options.repo ?? (contract ? null : defaultRepo());
  if (!repo && !contract) throw usageError("could not infer GitHub repo from origin; pass --repo OWNER/REPO");
  if (options.dispositionPath) options.dispositions = loadDispositionFile(options.dispositionPath);
  const result = runCleanup(options, repo, contract);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }

  if (options.apply && result.live.some((entry) => entry.unresolvedThreads?.some((thread) => !thread.safeToResolve))) {
    process.exitCode = 1;
  }
  if (options.apply && options.dispositions && result.warnings.some((warning) => /disposition|lacks an agent disposition/.test(warning))) {
    process.exitCode = 1;
  }
  if (result.live.some((entry) => entry.error)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    if (error.usage) {
      console.error(`error: ${error.message}`);
      console.error(usage());
      process.exit(2);
    }
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}

export { buildCandidates, classifyLive, parseArgs, parseDispositionDocument, resolveContractSource, runCleanup };
