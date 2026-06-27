// GitHub source. Reads issues and pull requests from configured repos via the
// GraphQL v4 API and normalizes them into the canonical model. The issue<->PR
// `closes` edge is read from BOTH endpoints (issue.closedByPullRequestsReferences
// and pr.closingIssuesReferences) so reconcileEdges converges them.

import { createHash } from "node:crypto";
import type { Source, SourceDescriptor, SourceOptions, FetchOptions, FetchResult, RawRecord, RefreshCandidate, ResolveOutcome } from "./types.ts";
import type {
  NormalizedBundle,
  CanonicalItem,
  CanonicalEdge,
  CanonicalActivity,
  CanonicalReviewThread,
  ItemState,
  ReviewState,
  CiState,
  MergeState,
} from "../model/types.ts";
import { toLabel } from "../model/labels.ts";
import { cleanProviderBody } from "../model/text.ts";
import { itemActivities, stableActivityId } from "../model/activity.ts";
import { deriveActorKey } from "../model/actor.ts";
import { providerObservedProfileUrl, providerPushUrl, type ProviderLinkSource } from "../provider-links.ts";
import type { GqlClient } from "./graphql.ts";
import type { RestClient } from "./rest.ts";
import { mapWithConcurrency, resolveConcurrency } from "../lib/concurrency.ts";
import { log } from "../log.ts";

const API_VERSION = "github.graphql.v4";
const PAGE_SIZE = 50;
const MAX_PAGES = 40; // safety cap (~2000 items/connection)
// Safety cap for paginated REST activity surfaces (per_page=100 -> 2000 records
// per surface per project). Sized so a fresh-DB full sweep can cover a year of
// an active repo: nils-cli runs ~1006 commits / ~1600 push events per 365d,
// which a 10-page (1000) cap truncated to ~7-8 months.
const MAX_REST_PAGES = 20;
// GitHub's compare API serves at most 250 commits for a base...head range, so
// three 100-commit pages always cover everything the provider will return.
const MAX_COMPARE_PAGES = 3;

function mapState(s: string | null | undefined): ItemState {
  if (s === "OPEN") return "open";
  if (s === "MERGED") return "merged";
  return "closed";
}

const REF_NODE = `id number url state repository { nameWithOwner }`;
// Submitted pull request reviews — the trustworthy review-event surface.
// `state` is PENDING|COMMENTED|APPROVED|CHANGES_REQUESTED|DISMISSED;
// PENDING reviews have a null `submittedAt` and are skipped in normalize.
const REVIEWS = `reviews(first:50){ nodes { id author { login url __typename } state submittedAt url } }`;
// Review threads with their resolution state — the "is this review resolved?"
// signal (a PR-level, point-in-time count, NOT per review event). GitHub has no
// unresolved-count aggregate, so `open` is counted from the nodes. `first:100`
// covers every real PR; if one somehow has more (`pageInfo.hasNextPage`), the
// node-derived `open` would be a misleading floor, so the count is reported as
// unknown (null) for that PR rather than wrong (see reviewThreadCounts).
const REVIEW_THREADS = `reviewThreads(first:100){ totalCount pageInfo { hasNextPage } nodes {
  id isResolved isOutdated path line startLine resolvedBy { login }
  comments(first:10){ totalCount nodes { id author { login avatarUrl } body url createdAt updatedAt } }
  latestComment: comments(last:1){ nodes { createdAt updatedAt } }
} }`;
// Incoming cross-references — "X mentioned this item". `source` is always an
// Issue or PR (never a commit), and `willCloseTarget` flags the ones that are
// really a `closes` link, which we skip (closingIssuesReferences covers those).
const MENTIONS = `timelineItems(itemTypes:[CROSS_REFERENCED_EVENT], first:30){
    nodes { ... on CrossReferencedEvent {
      willCloseTarget
      source { __typename ... on Issue { id state } ... on PullRequest { id state } }
    } }
  }`;
const COMMON = `__typename id number title body url createdAt updatedAt closedAt state
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
      nodes { ${COMMON} totalCommentsCount mergedAt isDraft reviewDecision mergeable
        commits(last:1){ nodes { commit { statusCheckRollup { state } } } }
        ${REVIEWS}
        ${REVIEW_THREADS}
        closingIssuesReferences(first:20){ nodes { ${REF_NODE} } }
      }
    }
  }
}`;

const PR_BY_NUMBER_Q = `query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) { ${COMMON} totalCommentsCount mergedAt isDraft reviewDecision mergeable
      commits(last:1){ nodes { commit { statusCheckRollup { state } } } }
      ${REVIEWS}
      ${REVIEW_THREADS}
      closingIssuesReferences(first:20){ nodes { ${REF_NODE} } }
    }
  }
}`;

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

export class GitHubSource implements Source {
  readonly descriptor: SourceDescriptor;
  // github/4: review-thread comments now carry avatarUrl in the canonical output.
  // github/5: review/comment activity details carry provider actor profile URLs.
  // github/6: items carry provider body text for detail views.
  // github/7: items carry provider-native comment/conversation totals.
  readonly normalizerVersion = "github/7";
  private gql: GqlClient;
  private projects: string[];
  private rest: RestClient | null;
  private commitBranches: "all" | "default";
  private projectClients: ReadonlyMap<string, { gql: GqlClient; rest: RestClient | null }>;
  private partialReason: string | null;

  constructor(descriptor: SourceDescriptor, gql: GqlClient, projects: string[], rest: RestClient | null = null, opts: SourceOptions = {}) {
    this.descriptor = descriptor;
    this.gql = gql;
    this.projects = projects;
    this.rest = rest;
    this.commitBranches = opts.commitBranches ?? "all";
    this.projectClients = opts.projectClients ?? new Map();
    this.partialReason = opts.partialReason ?? null;
  }

  private clientsFor(project: string): { gql: GqlClient; rest: RestClient | null } {
    return this.projectClients.get(project) ?? { gql: this.gql, rest: this.rest };
  }

  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const since = opts.full ? null : opts.since;
    const records: RawRecord[] = [];
    const now = new Date().toISOString();
    let latest: string | null = null;
    let complete = this.partialReason === null;
    let firstError: string | null = this.partialReason;
    if (this.partialReason) {
      log.warn(`[${this.descriptor.sourceId}] ${this.partialReason}; marking sweep partial so unseen projects are not tombstoned`);
    }

    for (const project of this.projects) {
      log.info(`[${this.descriptor.sourceId}] project ${project}: GraphQL fetch start`);
      const [owner, name] = project.split("/");
      const { gql } = this.clientsFor(project);
      for (const kind of ["issue", "change_request"] as const) {
        const before = records.length;
        let failed = false;
        try {
          let cursor: string | null = null;
          for (let page = 0; page < MAX_PAGES; page++) {
            const data: any = await gql(kind === "issue" ? ISSUE_Q : PR_Q, { owner, name, cursor });
            const conn = data?.repository?.[kind === "issue" ? "issues" : "pullRequests"];
            if (!conn) break;
            let stop = false;
            for (const node of conn.nodes) {
              if (since && node.updatedAt < since) {
                stop = true;
                break;
              }
              if (!latest || node.updatedAt > latest) latest = node.updatedAt;
              // A PR with more than the first 100 review threads only returns its
              // first page, so normalize emits no thread detail for it. If this
              // were treated as a complete sweep, the source-wide
              // softDeleteUnseenReviewThreads would tombstone that PR's stored
              // threads (none re-seen). Mark the sweep partial so the disappearance
              // rule keeps them — better stale than wrongly deleted.
              if (kind === "change_request" && node.reviewThreads?.pageInfo?.hasNextPage) {
                complete = false;
                log.warn(`[${this.descriptor.sourceId}] ${project} PR #${node.number}: >100 review threads; marking sweep partial so unseen threads are not tombstoned`);
              }
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
    for (const project of this.projects) {
      const { rest } = this.clientsFor(project);
      if (!rest) continue;
      log.info(`[${this.descriptor.sourceId}] project ${project}: activity fetch start`);
      try {
        const activity = await this.fetchRepoActivity(project, since, now, rest);
        records.push(...activity.records);
        if (activity.latest && (!latest || activity.latest > latest)) latest = activity.latest;
        log.info(`[${this.descriptor.sourceId}] project ${project}: activity fetched ${activity.records.length} records`);
      } catch (err) {
        log.warn(`[${this.descriptor.sourceId}] project ${project}: activity fetch failed: ${(err as Error).message}`);
        complete = false;
        firstError ??= `${project} activity: ${(err as Error).message}`;
      }
    }
    // When configured projects were omitted for a missing token (partialReason),
    // this sweep only saw a subset of the source. The watermark is strictly
    // per-source, so advancing it to the max updatedAt of the covered repos
    // would make the next incremental start past the omitted repo's older,
    // still-unread events — silently skipping them once its token is added.
    // Return null so updateSyncState's COALESCE/GREATEST keeps the prior
    // watermark and the next incremental re-reads from where it was. A non-
    // partial run (including a partial-for-other-reasons sweep, e.g. a PR with
    // >100 review threads, which still covers every project) advances normally.
    const watermark = this.partialReason ? null : latest;
    return { records, watermark, complete, error: firstError };
  }

  async fetchRefresh(candidates: RefreshCandidate[], _opts: FetchOptions): Promise<FetchResult> {
    const now = new Date().toISOString();
    const configuredProjects = new Set(this.projects);
    // Filter + dedupe first (cheap, pure), then resolve the survivors at a
    // bounded concurrency — each is an independent per-PR round-trip.
    const seen = new Set<string>();
    const targets = candidates.filter((candidate) => {
      if (!configuredProjects.has(candidate.projectPath)) return false;
      const key = `${candidate.projectPath}#${candidate.iid}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const results = await mapWithConcurrency<RefreshCandidate, ResolveOutcome>(targets, resolveConcurrency(), async (candidate) => {
      // Parse the path once, here, so the validate-and-use pair can't drift; a
      // malformed path yields nothing rather than erroring the sweep.
      const [owner, name] = candidate.projectPath.split("/");
      if (!owner || !name) return { record: null, error: null };
      const { gql } = this.clientsFor(candidate.projectPath);
      try {
        const data: any = await gql(PR_BY_NUMBER_Q, { owner, name, number: candidate.iid });
        const node = data?.repository?.pullRequest;
        if (!node) return { record: null, error: null };
        const payload = JSON.stringify(node);
        const record: RawRecord = {
          entityKind: "change_request",
          externalId: node.id,
          apiVersion: API_VERSION,
          fetchedAt: now,
          payload: node,
          contentHash: hash(payload),
        };
        return { record, error: null };
      } catch (err) {
        return { record: null, error: `${candidate.projectPath} #${candidate.iid} ci refresh: ${(err as Error).message}` };
      }
    });

    const records: RawRecord[] = [];
    let complete = true;
    let firstError: string | null = null;
    for (const r of results) {
      if (r.error) {
        complete = false;
        firstError ??= r.error;
      }
      if (r.record) records.push(r.record);
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
        openReviewThreads: null,
        totalReviewThreads: null,
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
    const threads = reviewThreadCounts(p);
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
      openReviewThreads: threads.open,
      totalReviewThreads: threads.total,
    };
    return {
      item,
      labels: this.labels(p),
      edges,
      activities: [...itemActivities(item), ...this.reviewActivities(p, item)],
      reviewThreads: this.reviewThreads(p, item),
    };
  }

  // Submitted PR reviews -> `review` activity rows. Each submission
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
        details: reviewDetails(this.descriptor, r),
      });
    }
    return out;
  }

  private reviewThreads(p: any, item: CanonicalItem): CanonicalReviewThread[] {
    const rt = p?.reviewThreads;
    if (!rt || rt.pageInfo?.hasNextPage) return [];
    const out: CanonicalReviewThread[] = [];
    for (const t of rt.nodes ?? []) {
      if (!t?.id) continue;
      const comments = (t.comments?.nodes ?? [])
        .filter((c: any) => c?.id)
        .map((c: any) => ({
          id: String(c.id),
          author: c.author?.login ?? null,
          avatarUrl: cleanText(c.author?.avatarUrl),
          body: cleanText(c.body),
          url: cleanText(c.url),
          createdAt: cleanText(c.createdAt),
          updatedAt: cleanText(c.updatedAt),
        }));
      // The preview is `comments(first:10)` (the OLDEST ten), so for a >10-comment
      // thread it omits the newest comment. `latestComment` is a `comments(last:1)`
      // alias on the same connection, fetched purely to recover the true newest
      // comment instant for recency sorting, independent of the preview size.
      const latestComment = (t.latestComment?.nodes ?? []).find((c: any) => c) ?? null;
      const lastCommentAt = latestComment
        ? (cleanText(latestComment.updatedAt) ?? cleanText(latestComment.createdAt))
        : null;
      out.push({
        sourceId: this.descriptor.sourceId,
        externalId: String(t.id),
        projectPath: item.projectPath,
        target: { sourceId: this.descriptor.sourceId, externalId: p.id },
        targetIid: item.iid,
        title: item.title,
        url: comments[0]?.url ?? item.url ?? null,
        isResolved: Boolean(t.isResolved),
        isOutdated: typeof t.isOutdated === "boolean" ? t.isOutdated : null,
        resolvedBy: t.resolvedBy?.login ?? null,
        path: cleanText(t.path),
        line: typeof t.line === "number" ? t.line : null,
        startLine: typeof t.startLine === "number" ? t.startLine : null,
        commentsTotal: typeof t.comments?.totalCount === "number" ? t.comments.totalCount : comments.length,
        comments,
        lastCommentAt,
      });
    }
    return out;
  }

  private async fetchRepoActivity(project: string, since: string | null, now: string, rest: RestClient): Promise<{ records: RawRecord[]; latest: string | null }> {
    const [owner, name] = project.split("/");
    const defaultBranch = await this.fetchDefaultBranch(owner, name, rest);
    const records: RawRecord[] = [];
    let latest: string | null = null;

    // Push/branch events come first: besides being activity records themselves,
    // they are the discovery surface for the side-branch commit expansion below.
    //
    // The repository-activity endpoint is cursor-paginated through the Link
    // header and silently ignores `page` (and an id passed as `before`), so
    // without header access one sweep can only read the newest 100 events. The
    // incremental cadence keeps steady-state coverage complete; a fresh-DB full
    // sweep backfills at most this one page of push history. `year` is still
    // the widest window the API offers, so the full sweep asks for it.
    const pushEvents: any[] = [];
    const repoActivity = await rest<any[]>(`repos/${owner}/${name}/activity`, {
      per_page: 100,
      time_period: since ? "month" : "year",
    });
    for (const event of repoActivity ?? []) {
      // Real events carry `timestamp` / `activity_type` / `actor`; the
      // `pushed_at` / `push_type` fallbacks keep legacy fixtures replayable.
      const occurred = event?.timestamp ?? event?.pushed_at ?? null;
      if (!occurred) continue;
      pushEvents.push(event);
      if (!latest || occurred > latest) latest = occurred;
      const payload = { __activityKind: "github_repo_activity", project, event };
      const payloadJson = JSON.stringify(payload);
      records.push({
        entityKind: "activity",
        externalId: stableActivityId(["repo-activity", project, event.activity_type ?? event.push_type, event.ref, event.before, event.after, occurred]),
        apiVersion: `${API_VERSION}.rest`,
        fetchedAt: now,
        payload,
        contentHash: hash(payloadJson),
      });
    }

    const commentActivity = await this.fetchRepoCommentActivity(project, owner, name, since, now, rest);
    records.push(...commentActivity.records);
    if (commentActivity.latest && (!latest || commentActivity.latest > latest)) latest = commentActivity.latest;

    // One entry per sha; a commit seen on several branch feeds unions its
    // membership instead of emitting duplicate records.
    const bySha = new Map<string, { commit: any; branches: string[] }>();
    const addCommit = (commit: any, branch: string | null): void => {
      const sha = String(commit?.sha ?? "");
      const occurred = commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? null;
      if (!sha || !occurred) return;
      if (!latest || occurred > latest) latest = occurred;
      const entry = bySha.get(sha) ?? { commit, branches: [] };
      if (branch && !entry.branches.includes(branch)) entry.branches.push(branch);
      bySha.set(sha, entry);
    };

    for (let page = 1; page <= MAX_REST_PAGES; page++) {
      const commits = await rest<any[]>(`repos/${owner}/${name}/commits`, {
        per_page: 100,
        page,
        ...(since ? { since } : {}),
      });
      for (const commit of commits ?? []) addCommit(commit, defaultBranch);
      if ((commits ?? []).length < 100) break;
    }

    // Side branches carry only their branch-unique commits (`base...head`),
    // never the shared default history a plain per-branch feed would re-serve —
    // that keeps both the labels meaningful and the cost at one or two calls
    // per live branch per sweep.
    for (const branch of this.sideBranches(pushEvents, defaultBranch, since)) {
      try {
        for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
          const cmp = await rest<any>(
            `repos/${owner}/${name}/compare/${encodeURIComponent(defaultBranch!)}...${encodeURIComponent(branch)}`,
            { per_page: 100, page },
          );
          const commits: any[] = cmp?.commits ?? [];
          for (const commit of commits) addCommit(commit, branch);
          if (commits.length < 100) break;
        }
      } catch (err) {
        // A 404 means the branch vanished between its push event and the
        // compare — branch lifecycle, not an incomplete sweep.
        if (!/^REST HTTP 404\b/.test((err as Error).message)) throw err;
        log.info(`[${this.descriptor.sourceId}] project ${project}: side branch ${branch} gone before compare; skipped`);
      }
    }

    for (const { commit, branches } of bySha.values()) {
      const payload = {
        __activityKind: "github_commit",
        project,
        defaultBranch,
        branches: orderedBranches(branches, defaultBranch),
        commit,
      };
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
    return { records, latest };
  }

  private async fetchRepoCommentActivity(project: string, owner: string | undefined, name: string | undefined, since: string | null, now: string, rest: RestClient): Promise<{ records: RawRecord[]; latest: string | null }> {
    if (!owner || !name) return { records: [], latest: null };
    const records: RawRecord[] = [];
    let latest: string | null = null;
    const surfaces = [
      { path: `repos/${owner}/${name}/issues/comments`, activityKind: "github_issue_comment", idPrefix: "issue-comment" },
      { path: `repos/${owner}/${name}/pulls/comments`, activityKind: "github_pr_review_comment", idPrefix: "pr-review-comment" },
    ];

    for (const surface of surfaces) {
      for (let page = 1; page <= MAX_REST_PAGES; page++) {
        const comments = await rest<any[]>(surface.path, {
          per_page: 100,
          page,
          sort: "updated",
          direction: "desc",
          ...(since ? { since } : {}),
        });
        for (const comment of comments ?? []) {
          const updated = cleanText(comment?.updated_at) ?? cleanText(comment?.created_at);
          if (!updated) continue;
          if (!latest || updated > latest) latest = updated;
          const payload = { __activityKind: surface.activityKind, project, comment };
          const payloadJson = JSON.stringify(payload);
          records.push({
            entityKind: "activity",
            externalId: stableActivityId([surface.idPrefix, project, comment?.node_id ?? comment?.id ?? comment?.html_url ?? updated]),
            apiVersion: `${API_VERSION}.rest`,
            fetchedAt: now,
            payload,
            contentHash: hash(payloadJson),
          });
        }
        if ((comments ?? []).length < 100) break;
      }
    }

    return { records, latest };
  }

  // Live side branches worth a compare. The latest push event per branch decides
  // liveness (a deletion wins), the default branch and tags never qualify, and an
  // incremental sweep only revisits branches pushed at/after the watermark —
  // older pushes were already expanded by the sweep that saw them.
  private sideBranches(pushEvents: any[], defaultBranch: string | null, since: string | null): string[] {
    if (this.commitBranches === "default" || !defaultBranch) return [];
    const latestPush = new Map<string, { at: string; deleted: boolean }>();
    for (const event of pushEvents) {
      const ref = String(event?.ref ?? "");
      if (!ref.startsWith("refs/heads/")) continue;
      const branch = ref.slice("refs/heads/".length);
      if (!branch || branch === defaultBranch) continue;
      const at = String(event?.timestamp ?? event?.pushed_at ?? "");
      const prev = latestPush.get(branch);
      if (!prev || at > prev.at) latestPush.set(branch, { at, deleted: String(event?.activity_type ?? event?.push_type ?? "") === "branch_deletion" });
    }
    return [...latestPush.entries()]
      .filter(([, v]) => !v.deleted && (!since || v.at >= since))
      .map(([branch]) => branch)
      .sort();
  }

  private async fetchDefaultBranch(owner: string | undefined, name: string | undefined, rest: RestClient): Promise<string | null> {
    if (!owner || !name) return null;
    try {
      const repo = await rest<any>(`repos/${owner}/${name}`);
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
        details: commitDetails(sha, title, body, payloadBranches(p)),
      };
      return { item: null, labels: [], edges: [], activities: [activity] };
    }
    if (kind === "github_repo_activity") {
      const event = p.event ?? {};
      // Real repository-activity events carry `timestamp` / `activity_type` /
      // `actor`; the `pushed_at` / `push_type` / `pusher` fallbacks keep legacy
      // fixtures and any payload stored in that shape replayable.
      const occurredAt = event.timestamp ?? event.pushed_at;
      if (!occurredAt) return null;
      const ref = String(event.ref ?? "");
      const pushType = String(event.activity_type ?? event.push_type ?? "push");
      const actorLogin = event.actor?.login ?? event.pusher?.login ?? null;
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
        actor: actorLogin,
        actorKey: deriveActorKey({ sourceId: this.descriptor.sourceId, username: actorLogin }),
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
    if (kind === "github_issue_comment" || kind === "github_pr_review_comment") {
      const comment = p.comment ?? {};
      const occurredAt = cleanText(comment.created_at) ?? cleanText(comment.updated_at);
      if (!occurredAt) return null;
      const projectPath = p.project ?? null;
      const isReviewComment = kind === "github_pr_review_comment";
      const target = gitHubCommentTarget(comment, isReviewComment);
      const actorLogin = comment.user?.login ?? null;
      const activity: CanonicalActivity = {
        sourceId: this.descriptor.sourceId,
        externalId: raw.externalId,
        kind: "comment",
        action: "commented",
        projectPath,
        targetKind: target.kind,
        target: null,
        targetIid: target.iid,
        title: null,
        url: cleanText(comment.html_url),
        actor: actorLogin,
        actorKey: deriveActorKey({ sourceId: this.descriptor.sourceId, username: actorLogin }),
        occurredAt,
        summary: commentSummary(target.kind, target.iid, projectPath),
        details: commentDetails(this.descriptor, comment, isReviewComment),
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

  private commonItem(p: any, kind: "issue" | "change_request"): Omit<CanonicalItem, "stateReason" | "isDraft" | "mergedAt" | "reviewState" | "ciState" | "mergeState" | "openReviewThreads" | "totalReviewThreads"> {
    const issueCommentTotal = typeof p.comments?.totalCount === "number" ? p.comments.totalCount : null;
    const commentTotal = kind === "change_request" && typeof p.totalCommentsCount === "number" ? p.totalCommentsCount : issueCommentTotal;
    const demand = (p.comments?.totalCount ?? 0) + (p.reactions?.totalCount ?? 0);
    return {
      sourceId: this.descriptor.sourceId,
      externalId: p.id,
      kind,
      projectPath: p.repository?.nameWithOwner ?? null,
      iid: typeof p.number === "number" ? p.number : null,
      url: p.url ?? "",
      title: p.title ?? null,
      body: cleanProviderBody(p.body),
      state: mapState(p.state),
      stateRaw: p.state ?? null,
      author: p.author?.login ?? null,
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
      closedAt: p.closedAt ?? null,
      milestone: null,
      commentTotal,
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

// Branch detail for a commit row: `branch`/`ref` carry the primary branch (the
// default branch whenever the commit is on it), and multi-branch membership
// adds the full `branches`/`refs` lists (see docs/CONTRACT.md activity details).
function commitDetails(sha: string, message: string | null, body: string | null, branches: string[]): Record<string, unknown> {
  const details: Record<string, unknown> = { sha, message };
  if (body) details.body = body;
  const primary = branches[0];
  if (primary) {
    details.branch = primary;
    details.ref = `refs/heads/${primary}`;
  }
  if (branches.length > 1) {
    details.branches = branches;
    details.refs = branches.map((b) => `refs/heads/${b}`);
  }
  return details;
}

// Branch membership stored on a commit payload. Payloads written before the
// multi-branch expansion only carry `defaultBranch`; replay keeps honoring them.
function payloadBranches(p: any): string[] {
  const fromPayload = Array.isArray(p?.branches)
    ? (p.branches as unknown[]).map(cleanText).filter((b): b is string => b !== null)
    : [];
  if (fromPayload.length > 0) return fromPayload;
  const fallback = cleanText(p?.defaultBranch);
  return fallback ? [fallback] : [];
}

// Default branch first, side branches alphabetical — a stable order so a
// commit's payload content hash does not churn between sweeps.
function orderedBranches(branches: string[], defaultBranch: string | null): string[] {
  const sides = branches.filter((b) => b !== defaultBranch).sort();
  return defaultBranch && branches.includes(defaultBranch) ? [defaultBranch, ...sides] : sides;
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

function gitHubCommentTarget(comment: any, isReviewComment: boolean): { kind: "issue" | "change_request"; iid: number | null } {
  if (isReviewComment) {
    return { kind: "change_request", iid: numberFromPaths(comment?.html_url, comment?.pull_request_url) };
  }
  const htmlUrl = cleanText(comment?.html_url);
  if (htmlUrl?.includes("/pull/")) return { kind: "change_request", iid: numberFromPaths(htmlUrl, comment?.issue_url) };
  return { kind: "issue", iid: numberFromPaths(htmlUrl, comment?.issue_url) };
}

function numberFromPaths(...values: unknown[]): number | null {
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    const m = text.match(/\/(?:issues|pull|pulls)\/(\d+)(?:[#/?]|$)/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

function reviewDetails(source: ProviderLinkSource, review: any): Record<string, unknown> {
  const details: Record<string, unknown> = { state: review.state ?? null };
  addDetail(details, "actor_profile_url", providerObservedProfileUrl(source, review.author?.url));
  addDetail(details, "actor_type", cleanText(review.author?.__typename));
  return details;
}

function commentDetails(source: ProviderLinkSource, comment: any, isReviewComment: boolean): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  addDetail(details, "comment_id", comment?.id);
  addDetail(details, "node_id", cleanText(comment?.node_id));
  addDetail(details, "updated_at", cleanText(comment?.updated_at));
  addDetail(details, "author_association", cleanText(comment?.author_association));
  addDetail(details, "actor_profile_url", providerObservedProfileUrl(source, comment?.user?.html_url));
  addDetail(details, "actor_type", cleanText(comment?.user?.type));
  if (isReviewComment) {
    addDetail(details, "path", cleanText(comment?.path));
    addDetail(details, "line", comment?.line);
    addDetail(details, "side", cleanText(comment?.side));
    addDetail(details, "commit_id", cleanText(comment?.commit_id));
    addDetail(details, "original_commit_id", cleanText(comment?.original_commit_id));
    addDetail(details, "in_reply_to_id", comment?.in_reply_to_id);
  }
  return details;
}

function addDetail(details: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  details[key] = value;
}

function commentSummary(kind: string | null, iid: number | null, project: string | null): string {
  const target =
    kind === "change_request"
      ? `change request${iid != null ? ` #${iid}` : ""}`
      : kind === "issue"
        ? `issue${iid != null ? ` #${iid}` : ""}`
        : "work item";
  return `Commented on ${target}${project ? ` in ${project}` : ""}`;
}

// PullRequestReviewState -> a review activity action. Everything submitted is a
// `review` activity; only APPROVED is also counted as an approval.
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

// Open/total review threads from a PR payload. `total` is the connection's
// totalCount; `open` counts unresolved nodes in the fetched page. If the PR has
// more threads than one page (`pageInfo.hasNextPage`), the node-derived `open`
// would only be a lower bound, so both are reported as unknown (null) rather
// than a misleading floor — the rare big-PR case the contract'd otherwise show
// as 0 open. Returns nulls when the PR carried no reviewThreads field, so an old
// replayed payload stays null rather than 0.
function reviewThreadCounts(p: any): { open: number | null; total: number | null } {
  const rt = p?.reviewThreads;
  if (!rt) return { open: null, total: null };
  if (rt.pageInfo?.hasNextPage) return { open: null, total: null };
  const nodes: any[] = Array.isArray(rt.nodes) ? rt.nodes : [];
  const open = nodes.reduce((n: number, t: any) => n + (t?.isResolved ? 0 : 1), 0);
  const total = typeof rt.totalCount === "number" ? rt.totalCount : nodes.length;
  return { open, total };
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
