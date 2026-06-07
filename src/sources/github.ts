// GitHub source. Reads issues and pull requests from configured repos via the
// GraphQL v4 API and normalizes them into the canonical model. The issue<->PR
// `closes` edge is read from BOTH endpoints (issue.closedByPullRequestsReferences
// and pr.closingIssuesReferences) so reconcileEdges converges them.

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

const API_VERSION = "github.graphql.v4";
const PAGE_SIZE = 50;
const MAX_PAGES = 40; // safety cap (~2000 items/connection)

function mapState(s: string | null | undefined): ItemState {
  if (s === "OPEN") return "open";
  if (s === "MERGED") return "merged";
  return "closed";
}

const REF_NODE = `id number url state repository { nameWithOwner }`;
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
        closingIssuesReferences(first:20){ nodes { ${REF_NODE} } }
      }
    }
  }
}`;

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

export class GitHubSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "github/1";
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

    for (const project of this.projects) {
      const [owner, name] = project.split("/");
      for (const kind of ["issue", "change_request"] as const) {
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
          complete = false;
          firstError ??= `${project} ${kind}: ${(err as Error).message}`;
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
      return { item, labels: this.labels(p), edges };
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
    return { item, labels: this.labels(p), edges };
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
