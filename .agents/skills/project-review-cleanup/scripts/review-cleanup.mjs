#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DEFAULT_ACTORS = ["chatgpt-codex-connector"];

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

function usage() {
  return `Usage:
  project-review-cleanup.sh [options]

Options:
  --contract PATH   Contract to scan (default: data/contract.json).
  --repo OWNER/REPO GitHub repository to verify (default: origin remote).
  --pr NUMBER       Focus one PR and allow live-only verification.
  --days N          Contract lookback window (default: 7).
  --actor LOGIN     Allowlisted bot actor; repeatable.
  --all-actors      Report candidates from every actor.
  --limit N         Maximum contract candidates (default: 20).
  --no-live         Skip provider live verification.
  --apply           Resolve safe stale allowlisted bot threads.
  --json            Emit JSON.
  -h, --help        Show this help.`;
}

function parseArgs(argv) {
  const options = {
    contractPath: "data/contract.json",
    repo: null,
    pr: null,
    days: 7,
    actors: [],
    allActors: false,
    limit: 20,
    live: true,
    apply: false,
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
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw usageError(`unknown argument: ${arg}`);
    }
  }

  if (options.apply && !options.live) {
    throw usageError("--apply requires live provider verification");
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

function loadContract(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`failed to read contract ${path}: ${error.message}`);
  }
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
  const items = new Map();
  for (const item of contract.items ?? []) {
    if (item.kind !== "change_request") continue;
    const key = itemKey(item.source_id, item.project_path, item.iid);
    items.set(key, item);
  }

  const allowSet = new Set(options.allowActors);
  const candidates = [];
  for (const activity of contract.activities ?? []) {
    if (activity.kind !== "review" || activity.target_kind !== "change_request") continue;
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

    candidates.push({
      pr: Number(activity.target_iid),
      repo: activity.project_path,
      title: activity.title ?? item?.title ?? null,
      actor: activity.actor ?? null,
      action: activity.action ?? null,
      state: activity.details?.state ?? null,
      reviewUrl: activity.url ?? null,
      reviewOccurredAt: activity.occurred_at ?? null,
      itemState: item?.state ?? null,
      itemUrl: item?.url ?? null,
      mergedAt: item?.merged_at ?? null,
      closedAt: item?.closed_at ?? null,
      reason: late ? "late_review" : "review_on_closed_pr",
    });
  }

  candidates.sort((a, b) => (toMs(b.reviewOccurredAt) ?? 0) - (toMs(a.reviewOccurredAt) ?? 0));
  return candidates.slice(0, options.limit);
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

function classifyLive(prData, allowActors) {
  const allowSet = new Set(allowActors);
  const unresolved = (prData.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved);
  const threadSummaries = unresolved.map((thread) => {
    const comments = thread.comments?.nodes ?? [];
    const authors = unique(comments.map((comment) => comment.author?.login).filter(Boolean));
    const allCommentsInspected = comments.length === (thread.comments?.totalCount ?? comments.length);
    const allowlistedAuthorsOnly = authors.length > 0 && authors.every((actor) => allowSet.has(actor));
    const safeToResolve = prData.state !== "OPEN" && allCommentsInspected && allowlistedAuthorsOnly;
    return {
      id: thread.id,
      path: thread.path ?? null,
      line: thread.line ?? thread.originalLine ?? null,
      isOutdated: Boolean(thread.isOutdated),
      authors,
      commentsInspected: comments.length,
      commentsTotal: thread.comments?.totalCount ?? comments.length,
      firstUrl: comments[0]?.url ?? null,
      lastUrl: comments.at(-1)?.url ?? null,
      safeToResolve,
      reason: safeToResolve ? "closed_pr_allowlisted_bot_thread" : unsafeReason(prData, authors, allowSet, allCommentsInspected),
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

function unsafeReason(prData, authors, allowSet, allCommentsInspected) {
  if (prData.state === "OPEN") return "pr_open";
  if (!allCommentsInspected) return "thread_comments_not_fully_inspected";
  if (authors.length === 0) return "thread_has_no_comment_authors";
  if (authors.some((actor) => !allowSet.has(actor))) return "human_or_unallowlisted_author";
  return "not_safe";
}

function printText(result) {
  console.log("Project review cleanup");
  console.log(`Repo: ${result.repo}`);
  console.log(`Contract: ${result.contractPath}${result.contractLoaded ? "" : " (not loaded)"}`);
  console.log(`Mode: ${result.apply ? "apply" : "dry-run"}`);
  console.log(`Allowlisted actors: ${result.allowActors.join(", ") || "(none)"}`);
  console.log("");
  console.log(`Contract candidates: ${result.candidates.length}`);
  for (const candidate of result.candidates) {
    console.log(`- #${candidate.pr} ${candidate.reason}: ${candidate.action ?? "review"} by ${candidate.actor ?? "unknown"} at ${candidate.reviewOccurredAt ?? "unknown time"}`);
    console.log(`  ${candidate.title ?? "(no title)"}`);
    console.log(`  state=${candidate.itemState ?? "unknown"} merged_at=${candidate.mergedAt ?? "null"} closed_at=${candidate.closedAt ?? "null"}`);
    if (candidate.reviewUrl) console.log(`  review=${candidate.reviewUrl}`);
  }

  if (result.live.length > 0) {
    console.log("");
    console.log("Live GitHub verification:");
    for (const live of result.live) {
      if (live.error) {
        console.log(`- #${live.pr}: live check failed: ${live.error}`);
        continue;
      }
      console.log(`- #${live.pr} ${live.state}: unresolved=${live.unresolvedCount}, safe_to_resolve=${live.safeToResolveCount}`);
      for (const thread of live.unresolvedThreads) {
        console.log(`  thread ${thread.id}: ${thread.reason}; authors=${thread.authors.join(", ") || "(none)"}; path=${thread.path ?? "(unknown)"}`);
        if (thread.lastUrl) console.log(`  url=${thread.lastUrl}`);
      }
    }
  }

  if (result.actions.length > 0) {
    console.log("");
    console.log("Apply actions:");
    for (const action of result.actions) {
      console.log(`- ${action.status}: #${action.pr} thread ${action.threadId}`);
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

  const repo = options.repo ?? defaultRepo();
  if (!repo) throw usageError("could not infer GitHub repo from origin; pass --repo OWNER/REPO");

  const contract = loadContract(options.contractPath);
  if (!contract && !options.pr) {
    throw new Error(`contract not found at ${options.contractPath}; pass --contract or --pr for live-only triage`);
  }

  const candidates = buildCandidates(contract, options, repo);
  const focusedPrs = unique([
    ...candidates.map((candidate) => candidate.pr),
    ...(options.pr ? [options.pr] : []),
  ]);

  const result = {
    repo,
    contractPath: options.contractPath,
    contractLoaded: Boolean(contract),
    apply: options.apply,
    allowActors: options.allowActors,
    candidates,
    live: [],
    actions: [],
    warnings: [],
  };

  if (options.live) {
    for (const pr of focusedPrs) {
      try {
        const live = classifyLive(queryPr(repo, pr), options.allowActors);
        result.live.push(live);
        if (options.apply) {
          for (const thread of live.unresolvedThreads.filter((thread) => thread.safeToResolve)) {
            const resolved = resolveThread(thread.id);
            result.actions.push({
              pr,
              threadId: thread.id,
              status: resolved?.isResolved ? "resolved" : "mutation_returned_unresolved",
            });
          }
        }
      } catch (error) {
        result.live.push({ pr, error: error.message });
        result.warnings.push(`live verification failed for #${pr}: ${error.message}`);
        if (options.apply) throw error;
      }
    }
  } else if (focusedPrs.length > 0) {
    result.warnings.push("--no-live skipped provider verification");
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }

  if (options.apply && result.live.some((entry) => entry.unresolvedThreads?.some((thread) => !thread.safeToResolve))) {
    process.exitCode = 1;
  }
  if (result.live.some((entry) => entry.error)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error.usage) {
    console.error(`error: ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  console.error(`error: ${error.message}`);
  process.exit(1);
});
