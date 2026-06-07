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
//
// Cross-reference edges (issue #13), validated against gitlab.com (2026-06-07):
//   * There is NO `relatedIssues` field and no CrossReferencedEvent equivalent on
//     the GraphQL Issue/MergeRequest. The links live in human-readable SYSTEM
//     notes on the mentioned/linked item:
//       "mentioned in issue #5"         -> issue #5 references this item   (mentions)
//       "mentioned in merge request !3" -> MR !3 references this item       (mentions)
//       "mentioned in commit <sha>"     -> ignored (not an issue/MR)
//       "marked as related to #6"       -> linked-related to issue #6       (relates)
//     So BOTH `mentions` and `relates` are parsed out of system notes. We fetch
//     notes per item (an N+1, like relatedMergeRequests — inlining notes in the
//     bulk page would exceed GitLab's GraphQL complexity limit), resolve the
//     referenced iid -> the item's global id via the items seen this sweep, and
//     attach the resolved endpoints to the raw payload so `normalize` stays pure.
//     Brittle by nature: note wording is locale/version dependent, and a ref to
//     an UNTRACKED project (not in the sweep) can't be resolved to a global id
//     and is dropped. A wrong field reports `complete:false` and never corrupts.
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
const NOTES_PAGE = 50; // system notes per item (fetched per-item to stay under the complexity limit)

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

// Per-issue resolve (one item at a time — relatedMergeRequests is rejected on a
// list, and notes(first:N) inlined in the bulk page would exceed the complexity
// limit). One round-trip per issue fetches BOTH the closing MRs and the system
// notes (mentions + relates). Bounded by issue count; cheap under incremental.
const ISSUE_RESOLVE_Q = `query($path:ID!, $iid:String!) {
  project(fullPath:$path) {
    issue(iid:$iid) {
      relatedMergeRequests(first:20){ nodes { id iid state } }
      notes(first:${NOTES_PAGE}){ nodes { system body } }
    }
  }
}`;

// Per-MR resolve: just the system notes (an MR has no issue-link / closing field
// on its own side).
const MR_RESOLVE_Q = `query($path:ID!, $iid:String!) {
  project(fullPath:$path) {
    mergeRequest(iid:$iid) {
      notes(first:${NOTES_PAGE}){ nodes { system body } }
    }
  }
}`;

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");

// --- system-note cross-reference parsing -------------------------------------

interface NoteRef {
  projectPath: string | null; // null = same project as the item carrying the note
  kind: "issue" | "change_request";
  iid: string;
}
interface ResolvedRef {
  externalId: string;
  state: string | null;
}

// Parse a trailing "<path>#N" / "<path>!N" reference token. '#' = issue, '!' = MR.
function parseRefToken(token: string): NoteRef | null {
  const m = /^(.*?)([#!])(\d+)$/.exec(token.trim());
  if (!m) return null;
  return { projectPath: m[1] ? m[1] : null, kind: m[2] === "!" ? "change_request" : "issue", iid: m[3]! };
}

// "mentioned in issue #5" / "mentioned in merge request !3" — but NOT
// "mentioned in commit <sha>" (no #/! ref, so parseRefToken returns null).
function parseMention(body: string): NoteRef | null {
  const m = /^mentioned in (?:issue|merge request) (.+)$/.exec(body.trim());
  return m ? parseRefToken(m[1]!) : null;
}

// "marked as related to #6" (GitLab issue links are issue<->issue).
function parseRelate(body: string): NoteRef | null {
  const m = /^marked as related to (.+)$/.exec(body.trim());
  return m ? parseRefToken(m[1]!) : null;
}

const indexKey = (project: string | null, kind: string, iid: string): string =>
  `${project ?? ""}\0${kind}\0${iid}`;

export class GitLabSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "gitlab/2";
  private gql: GqlClient;
  private projects: string[];

  constructor(descriptor: SourceDescriptor, gql: GqlClient, projects: string[]) {
    this.descriptor = descriptor;
    this.gql = gql;
    this.projects = projects;
  }

  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const since = opts.full ? null : opts.since;
    const now = new Date().toISOString();
    let latest: string | null = null;
    let complete = true;
    let firstError: string | null = null;

    const track = (node: any): void => {
      if (!latest || node.updatedAt > latest) latest = node.updatedAt;
    };
    // All items seen this sweep, kept until the map is built (cross-reference
    // resolution needs every item's iid -> global id, possibly cross-project).
    const collected: Array<{ kind: "issue" | "change_request"; node: any; project: string }> = [];

    // --- pass 1: bulk-fetch every project's MRs and issues ---
    for (const path of this.projects) {
      try {
        let cursor: string | null = null;
        mrPages: for (let page = 0; page < MAX_PAGES; page++) {
          const data: any = await this.gql(MR_Q, { path, cursor });
          const conn = data?.project?.mergeRequests;
          if (!conn) break;
          for (const node of conn.nodes) {
            if (since && node.updatedAt < since) break mrPages;
            track(node);
            node.__projectPath = path; // inject the queried path (robust vs schema variance)
            collected.push({ kind: "change_request", node, project: path });
          }
          if (!conn.pageInfo.hasNextPage) break;
          cursor = conn.pageInfo.endCursor;
        }
      } catch (err) {
        complete = false;
        firstError ??= `${path} change_request: ${(err as Error).message}`;
      }

      try {
        let cursor: string | null = null;
        issuePages: for (let page = 0; page < MAX_PAGES; page++) {
          const data: any = await this.gql(ISSUE_Q, { path, cursor });
          const conn = data?.project?.issues;
          if (!conn) break;
          for (const node of conn.nodes) {
            if (since && node.updatedAt < since) break issuePages;
            track(node);
            node.__projectPath = path;
            collected.push({ kind: "issue", node, project: path });
          }
          if (!conn.pageInfo.hasNextPage) break;
          cursor = conn.pageInfo.endCursor;
        }
      } catch (err) {
        complete = false;
        firstError ??= `${path} issue: ${(err as Error).message}`;
      }
    }

    // iid -> { global id, state } for every item seen, keyed by (project, kind, iid).
    const index = new Map<string, ResolvedRef>();
    for (const { kind, node, project } of collected) {
      index.set(indexKey(project, kind, String(node.iid)), { externalId: node.id, state: node.state });
    }

    // --- pass 2: per-item resolve (closing MRs for issues; system notes for all),
    // then turn the notes into resolved mention/relate endpoints on the payload ---
    const records: RawRecord[] = [];
    for (const { kind, node, project } of collected) {
      try {
        if (kind === "issue") {
          const d: any = await this.gql(ISSUE_RESOLVE_Q, { path: project, iid: String(node.iid) });
          const issue = d?.project?.issue;
          node.relatedMergeRequests = issue?.relatedMergeRequests ?? { nodes: [] };
          node.notes = issue?.notes ?? { nodes: [] };
        } else {
          const d: any = await this.gql(MR_RESOLVE_Q, { path: project, iid: String(node.iid) });
          node.notes = d?.project?.mergeRequest?.notes ?? { nodes: [] };
        }
      } catch (err) {
        complete = false;
        firstError ??= `${project} ${kind}#${node.iid} resolve: ${(err as Error).message}`;
        node.relatedMergeRequests ??= { nodes: [] };
        node.notes ??= { nodes: [] };
      }
      const { mentions, relates } = this.resolveNoteRefs(node, project, index);
      node.__mentions = mentions;
      node.__relates = relates;
      const payload = JSON.stringify(node);
      records.push({ entityKind: kind, externalId: node.id, apiVersion: API_VERSION, fetchedAt: now, payload: node, contentHash: hash(payload) });
    }
    return { records, watermark: latest, complete, error: firstError };
  }

  // Parse this item's system notes into resolved mention/relate endpoints. The
  // referenced iid is looked up in the sweep's index (same project by default,
  // or the explicit cross-project path); unresolvable refs (untracked project)
  // are dropped. Pure-string work; uses only data already fetched.
  private resolveNoteRefs(node: any, selfProject: string, index: Map<string, ResolvedRef>): { mentions: ResolvedRef[]; relates: ResolvedRef[] } {
    const mentions: ResolvedRef[] = [];
    const relates: ResolvedRef[] = [];
    const lookup = (ref: NoteRef): ResolvedRef | null => index.get(indexKey(ref.projectPath ?? selfProject, ref.kind, ref.iid)) ?? null;
    for (const n of node.notes?.nodes ?? []) {
      if (!n?.system) continue;
      const body = String(n.body ?? "");
      const mref = parseMention(body);
      if (mref) {
        const hit = lookup(mref);
        if (hit) mentions.push(hit);
        continue;
      }
      const rref = parseRelate(body);
      if (rref) {
        const hit = lookup(rref);
        if (hit) relates.push(hit);
      }
    }
    return { mentions, relates };
  }

  normalize(raw: RawRecord): NormalizedBundle | null {
    const p = raw.payload as any;
    const sourceId = this.descriptor.sourceId;
    const self = { sourceId, externalId: raw.externalId };
    const edges: CanonicalEdge[] = [];
    const selfState = mapState(p.state);

    if (raw.entityKind === "change_request") {
      // No issue-link / closing field on the MR side; mentions come from notes.
      edges.push(...this.mentionEdges(p, self, selfState, new Set()));
      const item: CanonicalItem = {
        ...this.commonItem(p, "change_request"),
        stateReason: null,
        isDraft: Boolean(p.draft),
        mergedAt: p.mergedAt ?? null,
        reviewState: mapReview(p),
        ciState: mapCi(p.headPipeline?.status),
        // Mergeability is only meaningful while the MR is open. A merged MR
        // reports `detailedMergeStatus: NOT_OPEN` (-> "mergeable") and a missing
        // status falls through to "unknown"; both are noise beside the `merged`
        // lifecycle state. Drop it for non-open items, matching GitHub.
        mergeState: selfState === "open" ? mapMerge(p.detailedMergeStatus) : null,
      };
      return { item, labels: this.labels(p), edges };
    }

    // issue: discover the `closes` edge from the issue's related MRs (GitLab
    // exposes the link only from this side). from = MR, to = this issue.
    const closesFrom = new Set<string>();
    for (const mr of p.relatedMergeRequests?.nodes ?? []) {
      edges.push({
        type: "closes",
        from: { sourceId, externalId: mr.id },
        to: self,
        fromState: mapState(mr.state),
        toState: selfState,
      });
      closesFrom.add(mr.id);
    }
    edges.push(...this.relateEdges(p, self, selfState));
    // Skip mentions that duplicate a closes edge (the closing MR is "mentioned in"
    // the issue too), mirroring the GitHub source's willCloseTarget skip.
    edges.push(...this.mentionEdges(p, self, selfState, closesFrom));
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

  // Resolved cross-references → `mentions` edges (referencer -> self). Skips a
  // self-reference and any referencer already covered by a `closes` edge.
  private mentionEdges(p: any, self: { sourceId: string; externalId: string }, selfState: ItemState, skipFrom: Set<string>): CanonicalEdge[] {
    const out: CanonicalEdge[] = [];
    for (const m of (p.__mentions ?? []) as ResolvedRef[]) {
      if (!m.externalId || m.externalId === self.externalId || skipFrom.has(m.externalId)) continue;
      out.push({
        type: "mentions",
        from: { sourceId: self.sourceId, externalId: m.externalId },
        to: self,
        fromState: mapState(m.state),
        toState: selfState,
      });
    }
    return out;
  }

  // Resolved "related to" links → `relates` edges. The link is symmetric (both
  // issues carry the note), so endpoints are canonicalized (lexicographic order)
  // — reconcileEdges then merges the two reports into a single edge.
  private relateEdges(p: any, self: { sourceId: string; externalId: string }, selfState: ItemState): CanonicalEdge[] {
    const out: CanonicalEdge[] = [];
    for (const r of (p.__relates ?? []) as ResolvedRef[]) {
      if (!r.externalId || r.externalId === self.externalId) continue;
      const a = { ref: self.externalId, state: selfState as ItemState | null };
      const b = { ref: r.externalId, state: mapState(r.state) as ItemState | null };
      const [lo, hi] = a.ref < b.ref ? [a, b] : [b, a];
      out.push({
        type: "relates",
        from: { sourceId: self.sourceId, externalId: lo.ref },
        to: { sourceId: self.sourceId, externalId: hi.ref },
        fromState: lo.state,
        toState: hi.state,
      });
    }
    return out;
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
