// GitHub source. Reads issues and pull requests from configured repos via the
// GraphQL v4 API and normalizes them into the canonical model. The issue<->PR
// `closes` edge is read from BOTH endpoints (issue.closedByPullRequestsReferences
// and pr.closingIssuesReferences) so reconcileEdges converges them.

import { createHash } from "node:crypto";
import type { Source, SourceDescriptor, FetchOptions, FetchResult, RawRecord, RefreshCandidate } from "./types.ts";
import type {
  NormalizedBundle,
  CanonicalItem,
  CanonicalEdge,
  CanonicalActivity,
  ItemState,
  ReviewState,
  CiState,
  MergeState,
} from "../model/types.ts";
import { toLabel } from "../model/labels.ts";
import { itemActivities, stableActivityId } from "../model/activity.ts";
import { deriveActorKey } from "../model/actor.ts";
import { providerPushUrl } from "../provider-links.ts";
import type { GqlClient } from "./graphql.ts";
import type { RestClient } from "./rest.ts";
import { log } from "../log.ts";

const API_VERSION = "github.graphql.v4";
const PAGE_SIZE = 50;
const MAX_PAGES = 40; // safety cap (~2000 items/connection)
// Safety cap for paginated REST activity surfaces (per_page=100 -> 2000 records
// per surface per project). Sized so a fresh-DB full sweep can cover a year of
// an active repo: nils-cli runs ~1006 commits / ~1600 push events per 365d,
// which a 10-page (1000) cap truncated to ~7-8 months.
const MAX_REST_PAGES = 20;

function mapState(s: string | null | undefined): ItemState {
  if (s === "OPEN") return "open";
  if (s === "MERGED") return "merged";
  return "closed";
}

const REF_NODE = `id number url state repository { nameWithOwner }`;
// Submitted pull request reviews — the trustworthy review-event surface (issue
// #93). `state` is PENDING|COMMENTED|APPROVED|CHANGES_REQUESTED|DISMISSED;
// PENDING reviews have a null `submittedAt` and are skipped in normalize.
const REVIEWS = `reviews(first:50){ nodes { id author { login } state submittedAt url } }`;
// Incoming cross-references — "X mentioned this item". `source` is always an
// Issue or PR (never a commit), and `willCloseTarget` flags the ones that are
// really a `closes` link, which we skip (closingIssuesReferences covers those).
const MENTIONS = `timelineItems(itemTypes:[CROSS_REFERENCED_EVENT], first:30){
    nodes { ... on CrossReferencedEvent {
      willCloseTarget
      source { __typename ... on Issue { id state } ... on PullRequest { id state } }
    } }
  }`;
const COMMON = `__typename id number title url createdAt updatedAt closedAt state
  author { login } repository { nameWithOwner }
  labels(first:50){ nodes { name color } }
  comments { totalCount } reactions { totalCount }
  ${MENTIONS}`;

const ISSUE_Q = `query($owner:String!, $name:String!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    issues(first:${PAGE_SIZE}, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMON} stateReason
        closedByPullRequestsReferences(first:20, includeClosedPrs:true){ nodes { ${REF_NODE} } }
      }
    }
  }
}`;

const PR_Q = `query($owner:String!, $name:String!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequests(first:${PAGE_SIZE}, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMON} mergedAt isDraft reviewDecision mergeable
        commits(last:1){ nodes { commit { statusCheckRollup { state } } } }
        ${REVIEWS}
        closingIssuesReferences(first:20){ nodes { ${REF_NODE} } }
      }
    }
  }
}`;

const PR_BY_NUMBER_Q = `query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) { ${COMMON} mergedAt isDraft reviewDecision mergeable
      commits(last:1){ nodes { commit { statusCheckRollup { state } } } }
      ${REVIEWS}
      closingIssuesReferences(first:20){ nodes { ${REF_NODE} } }
    }
  }
}`;

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

export class GitHubSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "github/2";
  private gql: GqlClient;
  private projects: string[];
  private rest: RestClient | null;

  constructor(descriptor: SourceDescriptor, gql: GqlClient, projects: string[], rest: RestClient | null = null) {
    this.descriptor = descriptor;
    this.gql = gql;
    this.projects = projects;
    this.rest = rest;
  }

  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const since = opts.full ? null : opts.since;
    const records: RawRecord[] = [];
    const now = new Date().toISOString();
    let latest: string | null = null;
    let complete = true;
    let firstError: string | null = null;

    for (const project of this.projects) {
      log.info(`[${this.descriptor.sourceId}] project ${project}: GraphQL fetch start`);
      const [owner, name] = project.split("/");
      for (const kind of ["issue", "change_request"] as const) {
        const before = records.length;
        let failed = false;
        try {
          let cursor: string | null = null;
          for (let page = 0; page < MAX_PAGES; page++) {
            const data: any = await this.gql(kind === "issue" ? ISSUE_Q : PR_Q, { owner, name, cursor });
            const conn = data?.repository?.[kind === "issue" ? "issues" : "pullRequests"];
            if (!conn) break;
            let stop = false;
            for (const node of conn.nodes) {
              if (since && node.updatedAt < since) {
                stop = true;
                break;
              }
              if (!latest || node.updatedAt > latest) latest = node.updatedAt;
              const payload = JSON.stringify(node);
              records.push({
                entityKind: kind,
                externalId: node.id,
                apiVersion: API_VERSION,
                fetchedAt: now,
                payload: node,
                contentHash: hash(payload),
              });
            }
            if (stop || !conn.pageInfo.hasNextPage) break;
            cursor = conn.pageInfo.endCursor;
          }
        } catch (err) {
          failed = true;
          log.warn(`[${this.descriptor.sourceId}] project ${project}: ${kind} fetch failed: ${(err as Error).message}`);
          complete = false;
          firstError ??= `${project} ${kind}: ${(err as Error).message}`;
        } finally {
          const suffix = failed ? " before failure" : "";
          log.info(`[${this.descriptor.sourceId}] project ${project}: ${kind} fetched ${records.length - before} records${suffix}`);
        }
      }
    }
    if (this.rest) {
      for (const project of this.projects) {
        log.info(`[${this.descriptor.sourceId}] project ${project}: activity fetch start`);
        try {
          const activity = await this.fetchRepoActivity(project, since, now);
          records.push(...activity.records);
          if (activity.latest && (!latest || activity.latest > latest)) latest = activity.latest;
          log.info(`[${this.descriptor.sourceId}] project ${project}: activity fetched ${activity.records.length} records`);
        } catch (err) {
          log.warn(`[${this.descriptor.sourceId}] project ${project}: activity fetch failed: ${(err as Error).message}`);
          complete = false;
          firstError ??= `${project} activity: ${(err as Error).message}`;
        }
      }
    }
    return { records, watermark: latest, complete, error: firstError };
  }

  async fetchRefresh(candidates: RefreshCandidate[], _opts: FetchOptions): Promise<FetchResult> {
    const records: RawRecord[] = [];
    const now = new Date().toISOString();
    const configuredProjects = new Set(this.projects);
    const seen = new Set<string>();
    let complete = true;
    let firstError: string | null = null;

    for (const candidate of candidates) {
      if (!configuredProjects.has(candidate.projectPath)) continue;
      const key = `${candidate.projectPath}#${candidate.iid}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const [owner, name] = candidate.projectPath.split("/");
      if (!owner || !name) continue;
      try {
        const data: any = await this.gql(PR_BY_NUMBER_Q, { owner, name, number: candidate.iid });
        const node = data?.repository?.pullRequest;
        if (!node) continue;
        const payload = JSON.stringify(node);
        records.push({
          entityKind: "change_request",
          externalId: node.id,
          apiVersion: API_VERSION,
          fetchedAt: now,
          payload: node,
          contentHash: hash(payload),
        });
      } catch (err) {
        complete = false;
        firstError ??= `${candidate.projectPath} #${candidate.iid} ci refresh: ${(err as Error).message}`;
      }
    }

    return { records, watermark: null, complete, error: firstError };
  }

  normalize(raw: RawRecord): NormalizedBundle | null {
    if (raw.entityKind === "activity") return this.normalizeActivity(raw);

    const p = raw.payload as any;
    const sourceId = this.descriptor.sourceId;
    const self = { sourceId, externalId: raw.externalId };
    const edges: CanonicalEdge[] = [];

    if (raw.entityKind === "issue") {
      const selfState = mapState(p.state);
      for (const pr of p.closedByPullRequestsReferences?.nodes ?? []) {
        edges.push({
          type: "closes",
          from: { sourceId, externalId: pr.id },
          to: self,
          fromState: mapState(pr.state),
          toState: selfState,
        });
      }
      edges.push(...this.mentionEdges(p, self, selfState));
      const item: CanonicalItem = {
        ...this.commonItem(p, "issue"),
        stateReason: p.stateReason ? String(p.stateReason).toLowerCase() : null,
        isDraft: null,
        mergedAt: null,
        reviewState: null,
        ciState: null,
        mergeState: null,
      };
      return { item, labels: this.labels(p), edges, activities: itemActivities(item) };
    }

    // change_request (pull request)
    const selfState = mapState(p.state);
    for (const iss of p.closingIssuesReferences?.nodes ?? []) {
      edges.push({
        type: "closes",
        from: self,
        to: { sourceId, externalId: iss.id },
        fromState: selfState,
        toState: mapState(iss.state),
      });
    }
    edges.push(...this.mentionEdges(p, self, selfState));
    const item: CanonicalItem = {
      ...this.commonItem(p, "change_request"),
      stateReason: null,
      isDraft: Boolean(p.isDraft),
      mergedAt: p.mergedAt ?? null,
      reviewState: mapReview(p.reviewDecision),
      ciState: mapCi(p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
      // Mergeability is only meaningful while the PR is open. GitHub stops
      // computing it after merge/close and returns `UNKNOWN`, which would
      // otherwise surface as a misleading `merge: unknown` badge next to the
      // `merged` lifecycle state. Drop it for non-open items.
      mergeState: selfState === "open" ? mapMerge(p.mergeable) : null,
    };
    return { item, labels: this.labels(p), edges, activities: [...itemActivities(item), ...this.reviewActivities(p, item)] };
  }

  // Submitted PR reviews -> `review` activity rows (issue #93). Each submission
  // is an event with a real `submittedAt`; PENDING (unsubmitted) reviews are
  // skipped. Pure: derived only from the PR payload, so it replays from raw.
  private reviewActivities(p: any, item: CanonicalItem): CanonicalActivity[] {
    const out: CanonicalActivity[] = [];
    const sourceId = this.descriptor.sourceId;
    for (const r of p.reviews?.nodes ?? []) {
      const occurredAt = r?.submittedAt;
      if (!occurredAt) continue; // PENDING / never submitted
      const action = mapReviewAction(String(r.state ?? ""));
      out.push({
        sourceId,
        externalId: stableActivityId(["review", p.id, r.id ?? occurredAt]),
        kind: "review",
        action,
        projectPath: item.projectPath,
        targetKind: "change_request",
        target: { sourceId, externalId: p.id },
        targetIid: item.iid,
        title: item.title,
        url: r.url ?? item.url ?? null,
        actor: r.author?.login ?? null,
        actorKey: deriveActorKey({ sourceId, username: r.author?.login ?? null }),
        occurredAt,
        summary: reviewSummary(action, item.iid),
        details: { state: r.state ?? null },
      });
    }
    return out;
  }

  private async fetchRepoActivity(project: string, since: string | null, now: string): Promise<{ records: RawRecord[]; latest: string | null }> {
    if (!this.rest) return { records: [], latest: null };
    const [owner, name] = project.split("/");
    const defaultBranch = await this.fetchDefaultBranch(owner, name);
    const records: RawRecord[] = [];
    let latest: string | null = null;

    for (let page = 1; page <= MAX_REST_PAGES; page++) {
      const commits = await this.rest<any[]>(`repos/${owner}/${name}/commits`, {
        per_page: 100,
        page,
        ...(since ? { since } : {}),
      });
      for (const commit of commits ?? []) {
        const occurred = commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? null;
        if (!occurred) continue;
        if (!latest || occurred > latest) latest = occurred;
        const payload = { __activityKind: "github_commit", project, defaultBranch, commit };
        const payloadJson = JSON.stringify(payload);
        records.push({
          entityKind: "activity",
          externalId: stableActivityId(["commit", project, commit.sha]),
          apiVersion: `${API_VERSION}.rest`,
          fetchedAt: now,
          payload,
          contentHash: hash(payloadJson),
        });
      }
      if ((commits ?? []).length < 100) break;
    }

    for (let page = 1; page <= MAX_REST_PAGES; page++) {
      // `year` is the widest window the activity API offers (time_period has no
      // larger value), so a full sweep — the fresh-DB rebuild path — backfills
      // as much push/branch history as the provider will give. Incremental
      // sweeps stay narrow: the watermark already bounds what is new.
      const repoActivity = await this.rest<any[]>(`repos/${owner}/${name}/activity`, {
        per_page: 100,
        page,
        time_period: since ? "month" : "year",
      });
      for (const event of repoActivity ?? []) {
        const occurred = event?.pushed_at ?? null;
        if (!occurred) continue;
        if (!latest || occurred > latest) latest = occurred;
        const payload = { __activityKind: "github_repo_activity", project, event };
        const payloadJson = JSON.stringify(payload);
        records.push({
          entityKind: "activity",
          externalId: stableActivityId(["repo-activity", project, event.push_type, event.ref, event.before, event.after, occurred]),
          apiVersion: `${API_VERSION}.rest`,
          fetchedAt: now,
          payload,
          contentHash: hash(payloadJson),
        });
      }
      if ((repoActivity ?? []).length < 100) break;
    }
    return { records, latest };
  }

  private async fetchDefaultBranch(owner: string | undefined, name: string | undefined): Promise<string | null> {
    if (!this.rest || !owner || !name) return null;
    try {
      const repo = await this.rest<any>(`repos/${owner}/${name}`);
      return cleanText(repo?.default_branch);
    } catch {
      return null;
    }
  }

  private normalizeActivity(raw: RawRecord): NormalizedBundle | null {
    const p = raw.payload as any;
    const kind = p?.__activityKind;
    if (kind === "github_commit") {
      const commit = p.commit ?? {};
      const sha = String(commit.sha ?? "");
      const occurredAt = commit.commit?.committer?.date ?? commit.commit?.author?.date;
      if (!sha || !occurredAt) return null;
      const title = firstLine(commit.commit?.message);
      const body = messageBody(commit.commit?.message);
      const actor = commit.author?.login ?? commit.commit?.author?.name ?? commit.commit?.committer?.name ?? null;
      // Prefer the linked account login (groups with this person's issues/PRs);
      // fall back to the commit email for account-less commits, then the name.
      const actorKey = deriveActorKey({
        sourceId: this.descriptor.sourceId,
        username: commit.author?.login ?? null,
        email: commit.commit?.author?.email ?? commit.commit?.committer?.email ?? null,
        name: commit.commit?.author?.name ?? commit.commit?.committer?.name ?? null,
      });
      const activity: CanonicalActivity = {
        sourceId: this.descriptor.sourceId,
        externalId: raw.externalId,
        kind: "commit",
        action: "committed",
        projectPath: p.project ?? commit.repository?.full_name ?? null,
        targetKind: "commit",
        target: null,
        targetIid: null,
        title,
        url: commit.html_url ?? null,
        actor,
        actorKey,
        occurredAt,
        summary: `Committed ${sha.slice(0, 7)}${p.project ? ` in ${p.project}` : ""}`,
        details: commitDetails(sha, title, body, p.defaultBranch),
      };
      return { item: null, labels: [], edges: [], activities: [activity] };
    }
    if (kind === "github_repo_activity") {
      const event = p.event ?? {};
      const occurredAt = event.pushed_at;
      if (!occurredAt) return null;
      const ref = String(event.ref ?? "");
      const pushType = String(event.push_type ?? "push");
      const targetKind = ref.startsWith("refs/tags/") ? "tag" : ref.startsWith("refs/heads/") ? "branch" : "ref";
      const action = mapRepoActivityAction(pushType);
      const projectPath = p.project ?? null;
      const activity: CanonicalActivity = {
        sourceId: this.descriptor.sourceId,
        externalId: raw.externalId,
        kind: targetKind === "ref" ? "repository" : targetKind,
        action,
        projectPath,
        targetKind,
        target: null,
        targetIid: null,
        title: shortRef(ref) ?? ref,
        url: providerPushUrl(this.descriptor, projectPath, action, ref, event.before, event.after),
        actor: event.pusher?.login ?? null,
        actorKey: deriveActorKey({ sourceId: this.descriptor.sourceId, username: event.pusher?.login ?? null }),
        occurredAt,
        summary: repoActivitySummary(action, ref, projectPath),
        details: {
          ref,
          before: event.before ?? null,
          after: event.after ?? null,
          push_type: pushType,
        },
      };
      return { item: null, labels: [], edges: [], activities: [activity] };
    }
    return null;
  }

  // Incoming cross-references → `mentions` edges (source mentioned this item).
  // Skips closing references (the `closes` edge already covers those) and any
  // event without a resolvable source id.
  private mentionEdges(p: any, self: { sourceId: string; externalId: string }, selfState: ItemState): CanonicalEdge[] {
    const out: CanonicalEdge[] = [];
    for (const ev of p.timelineItems?.nodes ?? []) {
      const src = ev?.source;
      if (!src?.id || ev.willCloseTarget) continue;
      out.push({
        type: "mentions",
        from: { sourceId: self.sourceId, externalId: src.id },
        to: self,
        fromState: mapState(src.state),
        toState: selfState,
      });
    }
    return out;
  }

  private commonItem(p: any, kind: "issue" | "change_request"): Omit<CanonicalItem, "stateReason" | "isDraft" | "mergedAt" | "reviewState" | "ciState" | "mergeState"> {
    const demand = (p.comments?.totalCount ?? 0) + (p.reactions?.totalCount ?? 0);
    return {
      sourceId: this.descriptor.sourceId,
      externalId: p.id,
      kind,
      projectPath: p.repository?.nameWithOwner ?? null,
      iid: typeof p.number === "number" ? p.number : null,
      url: p.url ?? "",
      title: p.title ?? null,
      state: mapState(p.state),
      stateRaw: p.state ?? null,
      author: p.author?.login ?? null,
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
      closedAt: p.closedAt ?? null,
      milestone: null,
      demand,
    };
  }

  private labels(p: any) {
    return (p.labels?.nodes ?? []).map((l: any) => toLabel(l.name, l.color ?? null));
  }
}

function firstLine(s: unknown): string | null {
  if (typeof s !== "string") return null;
  return s.split(/\r?\n/, 1)[0]?.trim() || null;
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function messageBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return cleanText(value.split(/\r?\n/).slice(1).join("\n"));
}

function commitDetails(sha: string, message: string | null, body: string | null, branch: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = { sha, message };
  if (body) details.body = body;
  const branchName = cleanText(branch);
  if (branchName) {
    details.branch = branchName;
    details.ref = `refs/heads/${branchName}`;
  }
  return details;
}

function shortRef(ref: string): string | null {
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "") || null;
}

function mapRepoActivityAction(pushType: string): string {
  if (pushType === "force_push") return "force_pushed";
  if (pushType === "branch_creation") return "created";
  if (pushType === "branch_deletion") return "deleted";
  if (pushType === "pr_merge") return "merged";
  if (pushType === "merge_queue_merge") return "merged";
  return "pushed";
}

function repoActivitySummary(action: string, ref: string, project: string | null): string {
  const target = shortRef(ref) ?? ref;
  const suffix = project ? ` in ${project}` : "";
  if (action === "created") return `Created ${target}${suffix}`;
  if (action === "deleted") return `Deleted ${target}${suffix}`;
  if (action === "force_pushed") return `Force-pushed ${target}${suffix}`;
  if (action === "merged") return `Merged into ${target}${suffix}`;
  return `Pushed ${target}${suffix}`;
}

// PullRequestReviewState -> a review activity action. Everything submitted is a
// `review` activity (issue #93); only APPROVED is also counted as an approval.
function mapReviewAction(state: string): string {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes_requested";
  if (state === "DISMISSED") return "dismissed";
  return "reviewed"; // COMMENTED and any future submitted state
}

function reviewSummary(action: string, iid: number | null): string {
  const ref = iid != null ? ` #${iid}` : "";
  if (action === "approved") return `Approved change request${ref}`;
  if (action === "changes_requested") return `Requested changes on change request${ref}`;
  if (action === "dismissed") return `Dismissed review on change request${ref}`;
  return `Reviewed change request${ref}`;
}

function mapReview(d: string | null | undefined): ReviewState | null {
  if (d === "APPROVED") return "approved";
  if (d === "CHANGES_REQUESTED") return "changes_requested";
  if (d === "REVIEW_REQUIRED") return "review_required";
  return null;
}

function mapCi(s: string | null | undefined): CiState {
  const c = (s ?? "").toUpperCase();
  if (c === "SUCCESS") return "passing";
  if (c === "FAILURE" || c === "ERROR") return "failing";
  if (c === "PENDING" || c === "EXPECTED") return "pending";
  return "none";
}

function mapMerge(m: string | null | undefined): MergeState {
  if (m === "MERGEABLE") return "mergeable";
  if (m === "CONFLICTING") return "conflicting";
  return "unknown";
}
