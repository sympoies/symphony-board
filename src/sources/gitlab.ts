// GitLab source. Mirrors the GitHub source against GitLab's GraphQL API
// (<host>/api/graphql). The board sink stays on GitHub conceptually, but GitLab
// is just another record source here.
//
// Field names validated against gitlab.com GraphQL (2026-06-02 introspection):
//   * MergeRequest has NO closing-issues field — GitLab GraphQL exposes the link
//     only from the ISSUE side via `Issue.relatedMergeRequests`. So the `closes`
//     edge is discovered from the issue, not the MR (opposite of GitHub).
//     Caveat: relatedMergeRequests is "MRs related to the issue", a superset of
//     strict closing MRs; we model it as `closes` for the workflow lifecycle.
//   * detailedMergeStatus / PipelineStatusEnum mapped to their real enum values.
// A self-hosted GitLab may differ by version; a wrong field reports
// `complete:false` with the error and never corrupts/soft-deletes data.

import { createHash } from "node:crypto";
import type { Source, SourceDescriptor, FetchOptions, FetchResult, RawRecord } from "./types.ts";
import type {
  NormalizedBundle,
  CanonicalItem,
  CanonicalEdge,
  ItemState,
  ReviewState,
  CiState,
  MergeState,
} from "../model/types.ts";
import { toLabel } from "../model/labels.ts";
import type { GqlClient } from "./graphql.ts";

const API_VERSION = "gitlab.graphql";
const PAGE_SIZE = 50;
const MAX_PAGES = 40;

function mapState(s: string | null | undefined): ItemState {
  const v = (s ?? "").toLowerCase();
  if (v === "opened") return "open";
  if (v === "merged") return "merged";
  return "closed"; // closed | locked
}

const COMMON = `id iid title webUrl createdAt updatedAt state
  author { username }
  labels(first:50){ nodes { title color } }
  userNotesCount upvotes`;

const ISSUE_Q = `query($path:ID!, $cursor:String) {
  project(fullPath:$path) {
    issues(first:${PAGE_SIZE}, after:$cursor, sort:UPDATED_DESC) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMON} closedAt }
    }
  }
}`;

const MR_Q = `query($path:ID!, $cursor:String) {
  project(fullPath:$path) {
    mergeRequests(first:${PAGE_SIZE}, after:$cursor, sort:UPDATED_DESC) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COMMON} closedAt mergedAt draft
        approved approvalsRequired
        headPipeline { status }
        detailedMergeStatus
      }
    }
  }
}`;

// relatedMergeRequests can be requested for ONLY ONE issue at a time (gitlab.com
// rejects it on an issue list), so the `closes` edge is resolved per-issue after
// the bulk page. This is an N+1 against the issue count — bounded by project
// size and mitigated by incremental sync (only changed issues are re-resolved).
const RELATED_MR_Q = `query($path:ID!, $iid:String!) {
  project(fullPath:$path) {
    issue(iid:$iid) {
      relatedMergeRequests(first:20){ nodes { id iid state } }
    }
  }
}`;

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

export class GitLabSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "gitlab/1";
  private gql: GqlClient;
  private projects: string[];

  constructor(descriptor: SourceDescriptor, gql: GqlClient, projects: string[]) {
    this.descriptor = descriptor;
    this.gql = gql;
    this.projects = projects;
  }

  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const since = opts.full ? null : opts.since;
    const records: RawRecord[] = [];
    const now = new Date().toISOString();
    let latest: string | null = null;
    let complete = true;
    let firstError: string | null = null;

    const track = (node: any): void => {
      if (!latest || node.updatedAt > latest) latest = node.updatedAt;
    };
    const toRecord = (kind: "issue" | "change_request", node: any, path: string): RawRecord => {
      node.__projectPath = path; // inject the queried path (robust vs schema variance)
      const payload = JSON.stringify(node);
      return { entityKind: kind, externalId: node.id, apiVersion: API_VERSION, fetchedAt: now, payload: node, contentHash: hash(payload) };
    };

    for (const path of this.projects) {
      // change requests (bulk)
      try {
        let cursor: string | null = null;
        mrPages: for (let page = 0; page < MAX_PAGES; page++) {
          const data: any = await this.gql(MR_Q, { path, cursor });
          const conn = data?.project?.mergeRequests;
          if (!conn) break;
          for (const node of conn.nodes) {
            if (since && node.updatedAt < since) break mrPages;
            track(node);
            records.push(toRecord("change_request", node, path));
          }
          if (!conn.pageInfo.hasNextPage) break;
          cursor = conn.pageInfo.endCursor;
        }
      } catch (err) {
        complete = false;
        firstError ??= `${path} change_request: ${(err as Error).message}`;
      }

      // issues (bulk) — then resolve relatedMergeRequests one issue at a time
      try {
        const issueNodes: any[] = [];
        let cursor: string | null = null;
        issuePages: for (let page = 0; page < MAX_PAGES; page++) {
          const data: any = await this.gql(ISSUE_Q, { path, cursor });
          const conn = data?.project?.issues;
          if (!conn) break;
          for (const node of conn.nodes) {
            if (since && node.updatedAt < since) break issuePages;
            track(node);
            issueNodes.push(node);
          }
          if (!conn.pageInfo.hasNextPage) break;
          cursor = conn.pageInfo.endCursor;
        }
        for (const node of issueNodes) {
          try {
            const d: any = await this.gql(RELATED_MR_Q, { path, iid: String(node.iid) });
            node.relatedMergeRequests = d?.project?.issue?.relatedMergeRequests ?? { nodes: [] };
          } catch (err) {
            complete = false;
            firstError ??= `${path} issue#${node.iid} relatedMergeRequests: ${(err as Error).message}`;
            node.relatedMergeRequests = { nodes: [] };
          }
          records.push(toRecord("issue", node, path));
        }
      } catch (err) {
        complete = false;
        firstError ??= `${path} issue: ${(err as Error).message}`;
      }
    }
    return { records, watermark: latest, complete, error: firstError };
  }

  normalize(raw: RawRecord): NormalizedBundle | null {
    const p = raw.payload as any;
    const sourceId = this.descriptor.sourceId;
    const self = { sourceId, externalId: raw.externalId };
    const edges: CanonicalEdge[] = [];
    const selfState = mapState(p.state);

    if (raw.entityKind === "change_request") {
      // GitLab GraphQL has no MR->issue closing field; the `closes` edge is
      // discovered from the issue side (relatedMergeRequests) below.
      const item: CanonicalItem = {
        ...this.commonItem(p, "change_request"),
        stateReason: null,
        isDraft: Boolean(p.draft),
        mergedAt: p.mergedAt ?? null,
        reviewState: mapReview(p),
        ciState: mapCi(p.headPipeline?.status),
        mergeState: mapMerge(p.detailedMergeStatus),
      };
      return { item, labels: this.labels(p), edges };
    }

    // issue: discover the `closes` edge from the issue's related MRs (GitLab
    // exposes the link only from this side). from = MR, to = this issue.
    for (const mr of p.relatedMergeRequests?.nodes ?? []) {
      edges.push({
        type: "closes",
        from: { sourceId, externalId: mr.id },
        to: self,
        fromState: mapState(mr.state),
        toState: selfState,
      });
    }
    const item: CanonicalItem = {
      ...this.commonItem(p, "issue"),
      stateReason: null,
      isDraft: null,
      mergedAt: null,
      reviewState: null,
      ciState: null,
      mergeState: null,
    };
    return { item, labels: this.labels(p), edges };
  }

  private commonItem(p: any, kind: "issue" | "change_request"): Omit<CanonicalItem, "stateReason" | "isDraft" | "mergedAt" | "reviewState" | "ciState" | "mergeState"> {
    const iidNum = Number(p.iid);
    const demand = (p.userNotesCount ?? 0) + (p.upvotes ?? 0);
    return {
      sourceId: this.descriptor.sourceId,
      externalId: p.id,
      kind,
      projectPath: p.__projectPath ?? null,
      iid: Number.isFinite(iidNum) ? iidNum : null,
      url: p.webUrl ?? "",
      title: p.title ?? null,
      state: mapState(p.state),
      stateRaw: p.state ?? null,
      author: p.author?.username ?? null,
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
      closedAt: p.closedAt ?? null,
      milestone: null,
      demand,
    };
  }

  private labels(p: any) {
    return (p.labels?.nodes ?? []).map((l: any) => toLabel(l.title, l.color ?? null));
  }
}

// approved + approvalsRequired -> a coarse review state. GitLab has no direct
// "changes requested" enum (it is expressed via unresolved discussions), so we
// map only approved / review_required here.
function mapReview(p: any): ReviewState | null {
  if (p.approved === true) return "approved";
  if ((p.approvalsRequired ?? 0) > 0) return "review_required";
  return null;
}

// PipelineStatusEnum (gitlab.com): CREATED WAITING_FOR_RESOURCE PREPARING
// WAITING_FOR_CALLBACK PENDING RUNNING FAILED SUCCESS CANCELING CANCELED
// SKIPPED MANUAL SCHEDULED.
function mapCi(status: string | null | undefined): CiState {
  const s = (status ?? "").toUpperCase();
  if (s === "SUCCESS") return "passing";
  if (s === "FAILED") return "failing";
  if (
    s === "RUNNING" || s === "PENDING" || s === "CREATED" || s === "PREPARING" ||
    s === "SCHEDULED" || s === "WAITING_FOR_RESOURCE" || s === "WAITING_FOR_CALLBACK"
  ) {
    return "pending";
  }
  return "none"; // CANCELED | CANCELING | SKIPPED | MANUAL | (none)
}

// DetailedMergeStatus (gitlab.com): UNCHECKED CHECKING MERGEABLE COMMITS_STATUS
// CI_MUST_PASS CI_STILL_RUNNING DISCUSSIONS_NOT_RESOLVED DRAFT_STATUS NOT_OPEN
// NOT_APPROVED BLOCKED_STATUS EXTERNAL_STATUS_CHECKS PREPARING JIRA_ASSOCIATION
// CONFLICT NEED_REBASE APPROVALS_SYNCING ... etc.
function mapMerge(detailed: string | null | undefined): MergeState {
  const s = (detailed ?? "").toUpperCase();
  if (s === "MERGEABLE" || s === "NOT_OPEN") return "mergeable";
  if (s === "CONFLICT" || s === "NEED_REBASE") return "conflicting";
  if (s === "" || s === "UNCHECKED" || s === "CHECKING" || s === "PREPARING" || s === "APPROVALS_SYNCING") {
    return "unknown";
  }
  // CI_MUST_PASS / CI_STILL_RUNNING / DISCUSSIONS_NOT_RESOLVED / NOT_APPROVED /
  // DRAFT_STATUS / BLOCKED_STATUS / COMMITS_STATUS / ... -> blocked
  return "blocked";
}
