// GitLab source. Mirrors the GitHub source against GitLab's GraphQL API
// (<host>/api/graphql). The board sink stays on GitHub conceptually, but GitLab
// is just another record source here.
//
// VALIDATION NOTE (see docs/DESIGN.md "Open items"): the exact field names below
// are written from the GitLab GraphQL schema as best understood and need a live
// check against the TARGET instance/version, especially:
//   * MergeRequest.closesIssues  — the issue<->MR `closes` edge (point 1's spine)
//   * detailedMergeStatus enum values
//   * headPipeline.status enum casing
// If a field name is wrong the fetch reports `complete:false` with the error and
// the engine records it WITHOUT corrupting/soft-deleting data — safe to iterate.

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
        closesIssues { nodes { id iid state } }
      }
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

    for (const path of this.projects) {
      for (const kind of ["issue", "change_request"] as const) {
        try {
          let cursor: string | null = null;
          for (let page = 0; page < MAX_PAGES; page++) {
            const data: any = await this.gql(kind === "issue" ? ISSUE_Q : MR_Q, { path, cursor });
            const conn = data?.project?.[kind === "issue" ? "issues" : "mergeRequests"];
            if (!conn) break;
            let stop = false;
            for (const node of conn.nodes) {
              if (since && node.updatedAt < since) {
                stop = true;
                break;
              }
              if (!latest || node.updatedAt > latest) latest = node.updatedAt;
              node.__projectPath = path; // inject the queried path (robust vs schema variance)
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
          complete = false;
          firstError ??= `${path} ${kind}: ${(err as Error).message}`;
        }
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
      for (const iss of p.closesIssues?.nodes ?? []) {
        edges.push({
          type: "closes",
          from: self,
          to: { sourceId, externalId: iss.id },
          fromState: selfState,
          toState: mapState(iss.state),
        });
      }
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

    // issue: GitLab does not expose closing MRs from the issue side in this
    // query; the `closes` edge is discovered from the MR side and reconciled.
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

function mapCi(status: string | null | undefined): CiState {
  const s = (status ?? "").toUpperCase();
  if (s === "SUCCESS") return "passing";
  if (s === "FAILED") return "failing";
  if (s === "RUNNING" || s === "PENDING" || s === "CREATED" || s === "SCHEDULED" || s === "MANUAL") return "pending";
  return "none";
}

function mapMerge(detailed: string | null | undefined): MergeState {
  const s = (detailed ?? "").toUpperCase();
  if (s === "MERGEABLE" || s === "NOT_OPEN") return "mergeable";
  if (s === "CONFLICT" || s === "BROKEN_STATUS") return "conflicting";
  if (s === "") return "unknown";
  // CI_MUST_PASS / DISCUSSIONS_NOT_RESOLVED / NOT_APPROVED / DRAFT_STATUS / ...
  return "blocked";
}
