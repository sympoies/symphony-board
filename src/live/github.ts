// Pure GitHub WebhookProvider adapter. Maps (X-GitHub-Event, action) to neutral
// live-event records; no network, no IO, replayable against captured payloads.
// Encodes the GitHub-specific quirks: issue_comment fires for issues AND PRs
// (disambiguate via issue.pull_request); a PR merge arrives as action=closed +
// merged:true (no `merged` action); the review verdict is in review.state;
// review threads carry resolved/unresolved. Unknown events/actions yield [].
// `raw` is scrubbed of secret-bearing fields before it is returned.
import type { IncomingHttpHeaders } from "node:http";
import {
  toProviderNumber,
  type LiveActor,
  type LiveCategory,
  type LiveEventInput,
  type LiveTarget,
} from "./types.ts";
import {
  headerValue,
  scrubSecrets,
  type AdaptCtx,
  type WebhookProvider,
} from "./provider.ts";
import { verifyGithubSignature, type VerifyResult } from "./verify.ts";

export const GITHUB_SOURCE_ID = "github:github.com";

// Decision (#316 item 11): "labeled"/"unlabeled" are deliberately NOT surfaced
// in the realtime feed. Label churn is high-volume and low-signal (bots relabel
// constantly), and the canonical sync already reflects the resulting label state
// on the work item; the live stream is for human-meaningful activity. Add these
// actions only if a concrete need for realtime label events appears.
const ISSUE_ACTIONS = new Set(["opened", "closed", "reopened", "edited"]);
const ISSUE_COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);
const PR_ACTIONS = new Set([
  "opened",
  "closed",
  "reopened",
  "edited",
  "ready_for_review",
]);
const REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);
const REVIEW_COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);
const REVIEW_THREAD_ACTIONS = new Set(["resolved", "unresolved"]);

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNum(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function asBool(v: unknown): boolean {
  return v === true;
}

function ghActor(sender: Record<string, unknown> | null): LiveActor | null {
  if (!sender) return null;
  return {
    login: asStr(sender.login),
    display_name: asStr(sender.name),
    avatar_url: asStr(sender.avatar_url),
    profile_url: asStr(sender.html_url),
  };
}

function ghTarget(
  kind: string,
  obj: Record<string, unknown> | null,
  repoPath: string | null,
  // The canonical source id of THIS delivery's route, so a non-default GitHub
  // source (e.g. GitHub Enterprise) yields targets whose source_id matches the
  // event's, keeping downstream (source_id, external_id) matching consistent.
  sourceId: string,
): LiveTarget | null {
  if (!obj) return null;
  return {
    kind,
    source_id: sourceId,
    project_path: repoPath,
    number: toProviderNumber(asNum(obj.number)),
    external_id: asStr(obj.node_id),
    title: asStr(obj.title),
    url: asStr(obj.html_url),
  };
}

function nameOf(actor: LiveActor | null): string {
  return actor?.login ?? "someone";
}

// A commit row attributes to the commit AUTHOR (who wrote it), not the pusher.
// GitHub's commit author carries name/email and, when the email maps to a
// GitHub account, a `username`; it never carries an avatar/profile. When the
// pusher authored the commit we enrich those from `sender` so a direct push
// shows the author's avatar. With no identifiable author we fall back to the
// pusher actor so the row never reads as "someone".
function ghCommitActor(
  authorObj: Record<string, unknown> | null,
  sender: Record<string, unknown> | null,
): LiveActor | null {
  const senderActor = ghActor(sender);
  const login = authorObj ? asStr(authorObj.username) : null;
  const displayName = authorObj ? asStr(authorObj.name) : null;
  if (login === null && displayName === null) return senderActor;
  if (login !== null && senderActor && senderActor.login === login) {
    return {
      login,
      display_name: displayName ?? senderActor.display_name,
      avatar_url: senderActor.avatar_url,
      profile_url: senderActor.profile_url,
    };
  }
  return { login, display_name: displayName, avatar_url: null, profile_url: null };
}

// The display name for a commit row: prefer the GitHub login, then the git
// author name, then a neutral fallback. (Plain `nameOf` only knows `login`,
// which a commit author often lacks.)
function commitName(actor: LiveActor | null): string {
  return actor?.login ?? actor?.display_name ?? "someone";
}

function reviewVerb(state: string | null, action: string): string {
  if (action === "dismissed" || state === "dismissed") {
    return "dismissed a review on";
  }
  if (state === "approved") return "approved";
  if (state === "changes_requested") return "requested changes on";
  return "reviewed";
}

export class GithubWebhookProvider implements WebhookProvider {
  readonly id = "github" as const;
  readonly eventHeaderName = "x-github-event";
  readonly hookIdHeaderName = "x-github-hook-id";

  verify(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
    secrets: readonly string[],
  ): VerifyResult {
    return verifyGithubSignature(
      rawBody,
      headers["x-hub-signature-256"],
      secrets,
    );
  }

  deliveryId(headers: IncomingHttpHeaders): string | null {
    return headerValue(headers, "x-github-delivery");
  }

  isControlEvent(headers: IncomingHttpHeaders, _parsed: unknown): boolean {
    return headerValue(headers, "x-github-event") === "ping";
  }

  toLiveEvents(parsed: unknown, ctx: AdaptCtx): LiveEventInput[] {
    const payload = asObj(parsed);
    if (!payload) return [];
    const action = asStr(payload.action);
    const repo = asObj(payload.repository);
    const repoPath = repo ? asStr(repo.full_name) : null;
    const actor = ghActor(asObj(payload.sender));
    const raw = scrubSecrets(payload) as Record<string, unknown>;

    const make = (fields: {
      category: LiveCategory;
      target: LiveTarget | null;
      title: string | null;
      body: string | null;
      url: string | null;
      occurred_at: string | null;
      review_state?: string | null;
      provider_details?: Record<string, unknown> | null;
      // Per-event actor override. Most events attribute to the delivery sender;
      // a push attributes each row to that commit's author instead.
      actor?: LiveActor | null;
      // Per-event raw override. Single-event deliveries persist the whole scrubbed
      // payload; a push slices it to ONE commit per row (make({ raw: … })) so a
      // multi-commit push does not duplicate the full commits[] into every
      // fan-out row's raw_json (O(N^2) store; GitHub allows up to 2048/push).
      raw?: Record<string, unknown> | null;
    }): LiveEventInput => ({
      event_id: ctx.deliveryId,
      source_id: ctx.sourceId,
      provider: "github",
      received_at: ctx.receivedAt,
      occurred_at: fields.occurred_at,
      event_type: ctx.eventHeader,
      action,
      category: fields.category,
      actor: fields.actor ?? actor,
      target: fields.target,
      title: fields.title,
      body: fields.body,
      url: fields.url,
      review_state: fields.review_state ?? null,
      delivery: {
        delivery_id: ctx.deliveryId,
        event_header: ctx.eventHeader,
        hook_id: ctx.hookId ?? null,
        signature_status: "verified",
      },
      provider_details: fields.provider_details ?? null,
      raw: fields.raw ?? raw,
    });

    switch (ctx.eventHeader) {
      case "issues": {
        if (action === null || !ISSUE_ACTIONS.has(action)) return [];
        const issue = asObj(payload.issue);
        const target = ghTarget("issue", issue, repoPath, ctx.sourceId);
        const num = target?.number ?? "";
        return [
          make({
            category: "issue",
            target,
            title: `${nameOf(actor)} ${action} issue #${num}`,
            body: issue ? asStr(issue.body) : null,
            url: issue ? asStr(issue.html_url) : null,
            occurred_at: issue ? asStr(issue.updated_at) : null,
          }),
        ];
      }
      case "issue_comment": {
        if (action === null || !ISSUE_COMMENT_ACTIONS.has(action)) return [];
        const issue = asObj(payload.issue);
        const comment = asObj(payload.comment);
        const isPr = issue !== null && asObj(issue.pull_request) !== null;
        const target = ghTarget(
          isPr ? "change_request" : "issue",
          issue,
          repoPath,
          ctx.sourceId,
        );
        const num = target?.number ?? "";
        const where = isPr ? "PR" : "issue";
        const verb =
          action === "created"
            ? "commented on"
            : action === "deleted"
              ? "deleted a comment on"
              : "edited a comment on";
        return [
          make({
            category: "comment",
            target,
            title: `${nameOf(actor)} ${verb} ${where} #${num}`,
            body: comment ? asStr(comment.body) : null,
            url: comment
              ? asStr(comment.html_url)
              : issue
                ? asStr(issue.html_url)
                : null,
            occurred_at: comment
              ? (asStr(comment.updated_at) ?? asStr(comment.created_at))
              : null,
          }),
        ];
      }
      case "pull_request": {
        if (action === null || !PR_ACTIONS.has(action)) return [];
        const pr = asObj(payload.pull_request);
        const target = ghTarget("change_request", pr, repoPath, ctx.sourceId);
        const num = target?.number ?? "";
        const merged = action === "closed" && asBool(pr?.merged);
        return [
          make({
            category: "change_request",
            target,
            title: merged
              ? `${nameOf(actor)} merged PR #${num}`
              : `${nameOf(actor)} ${action} PR #${num}`,
            body: pr ? asStr(pr.body) : null,
            url: pr ? asStr(pr.html_url) : null,
            occurred_at: pr ? asStr(pr.updated_at) : null,
            provider_details: { merged, draft: asBool(pr?.draft) },
          }),
        ];
      }
      case "pull_request_review": {
        if (action === null || !REVIEW_ACTIONS.has(action)) return [];
        const review = asObj(payload.review);
        const pr = asObj(payload.pull_request);
        const target = ghTarget("change_request", pr, repoPath, ctx.sourceId);
        const num = target?.number ?? "";
        const state = review ? asStr(review.state) : null;
        return [
          make({
            category: "review",
            target,
            title: `${nameOf(actor)} ${reviewVerb(state, action)} PR #${num}`,
            body: review ? asStr(review.body) : null,
            url: review
              ? asStr(review.html_url)
              : pr
                ? asStr(pr.html_url)
                : null,
            occurred_at: review ? asStr(review.submitted_at) : null,
            review_state: state,
          }),
        ];
      }
      case "pull_request_review_comment": {
        if (action === null || !REVIEW_COMMENT_ACTIONS.has(action)) return [];
        const comment = asObj(payload.comment);
        const pr = asObj(payload.pull_request);
        const target = ghTarget("change_request", pr, repoPath, ctx.sourceId);
        const num = target?.number ?? "";
        return [
          make({
            category: "review_comment",
            target,
            title: `${nameOf(actor)} commented on PR #${num} (review)`,
            body: comment ? asStr(comment.body) : null,
            url: comment
              ? asStr(comment.html_url)
              : pr
                ? asStr(pr.html_url)
                : null,
            occurred_at: comment
              ? (asStr(comment.updated_at) ?? asStr(comment.created_at))
              : null,
          }),
        ];
      }
      case "pull_request_review_thread": {
        if (action === null || !REVIEW_THREAD_ACTIONS.has(action)) return [];
        const pr = asObj(payload.pull_request);
        const target = ghTarget("change_request", pr, repoPath, ctx.sourceId);
        const num = target?.number ?? "";
        return [
          make({
            category: "review_thread",
            target,
            title: `${nameOf(actor)} ${action} a review thread on PR #${num}`,
            body: null,
            url: pr ? asStr(pr.html_url) : null,
            occurred_at: null,
          }),
        ];
      }
      case "push": {
        // A push has no `action` and carries an array of commits, so — unlike
        // every single-item case above — it fans OUT to one live-event per
        // commit. The receiver assigns each its ordinal in array order; dedup is
        // (source_id, event_id, ordinal). A branch-delete or tag push carries no
        // commits and yields nothing (no synthetic "branch deleted" row).
        const commits = Array.isArray(payload.commits)
          ? (payload.commits as unknown[])
          : [];
        // The scrubbed commit objects, parallel by index to `commits`, so each
        // fan-out row can carry ONLY its own commit in `raw` instead of the whole
        // (potentially 2048-long) commits[] array repeated per row.
        const rawCommits = Array.isArray(raw.commits) ? (raw.commits as unknown[]) : [];
        const ref = asStr(payload.ref);
        const branch = ref?.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref;
        const sender = asObj(payload.sender);
        const details = ref ? { ref, branch } : null;
        const out: LiveEventInput[] = [];
        for (let i = 0; i < commits.length; i++) {
          const commit = asObj(commits[i]);
          const sha = commit ? asStr(commit.id) : null;
          if (!commit || !sha) continue;
          const message = asStr(commit.message) ?? "";
          const subject = message.split("\n", 1)[0] ?? "";
          const commitActor = ghCommitActor(asObj(commit.author), sender);
          const url = asStr(commit.url);
          // Per-commit raw: the constant-size delivery envelope (ref, repository,
          // pusher, installation, …, all already scrubbed) with `commits` narrowed
          // to this row's single commit — keeping replay context without the
          // per-row fan-out of the full array.
          const rawSlice: Record<string, unknown> = {
            ...raw,
            commits: i < rawCommits.length ? [rawCommits[i]] : [],
          };
          out.push(
            make({
              category: "commit",
              actor: commitActor,
              raw: rawSlice,
              target: {
                kind: "commit",
                source_id: ctx.sourceId,
                project_path: repoPath,
                number: null,
                external_id: sha,
                title: subject || null,
                url,
              },
              title: `${commitName(commitActor)} committed ${sha.slice(0, 7)}`,
              body: message || null,
              url,
              occurred_at: asStr(commit.timestamp),
              provider_details: details,
            }),
          );
        }
        return out;
      }
      default:
        return [];
    }
  }
}
