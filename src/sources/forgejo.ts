// Forgejo REST source, certified initially against Codeberg's Forgejo 16 API.
// Network work stays in fetch; normalize is pure and replayable.

import { createHash } from "node:crypto";
import type { CiState, CanonicalActivity, CanonicalEdge, CanonicalItem, ItemState, NormalizedBundle } from "../model/types.ts";
import { deriveActorKey } from "../model/actor.ts";
import { itemActivities, stableActivityId } from "../model/activity.ts";
import { toLabel } from "../model/labels.ts";
import { cleanProviderBody } from "../model/text.ts";
import { log } from "../log.ts";
import type { RestClient } from "./rest.ts";
import type { FetchOptions, FetchResult, RawRecord, RefreshCandidate, Source, SourceDescriptor } from "./types.ts";

const SUPPORTED_MAJOR = 16;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 200;

export interface ForgejoSourceOptions {
  maxPages?: number;
}

interface ItemRef {
  externalId: string;
  kind: "issue" | "change_request";
  state: ItemState;
  iid: number;
}

interface ForgejoCapabilities {
  apiVersion: string;
  pageSize: number;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstLine(value: unknown): string | null {
  const text = cleanText(value);
  return text?.split(/\r?\n/, 1)[0]?.trim() || null;
}

function messageBody(value: unknown): string | null {
  const text = cleanText(value);
  return text ? cleanText(text.split(/\r?\n/).slice(1).join("\n")) : null;
}

function itemExternalId(issue: any): string | null {
  const id = typeof issue?.id === "number" || typeof issue?.id === "string" ? String(issue.id) : "";
  return id ? `item:${id}` : null;
}

function mapState(value: unknown, merged = false): ItemState {
  if (merged) return "merged";
  return String(value ?? "").toLowerCase() === "open" ? "open" : "closed";
}

function mapCi(status: any): CiState | null {
  if (!status) return null;
  const state = String(status.state ?? "").toLowerCase();
  if (state === "success") return "passing";
  if (state === "failure" || state === "error" || state === "warning") return "failing";
  if (state === "pending" || state === "running") return "pending";
  if ((status.total_count ?? status.statuses?.length ?? 0) === 0) return "none";
  return null;
}

function reviewAction(state: unknown): string | null {
  const value = String(state ?? "").toUpperCase();
  if (value === "PENDING") return null;
  if (value === "APPROVED") return "approved";
  if (value === "REQUEST_CHANGES" || value === "CHANGES_REQUESTED") return "changes_requested";
  if (value === "DISMISSED") return "dismissed";
  return "reviewed";
}

function issueNumberFromUrl(...values: unknown[]): number | null {
  for (const value of values) {
    const text = cleanText(value);
    const match = text?.match(/\/(?:issues|pulls)\/(\d+)(?:[#/?]|$)/);
    const number = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return null;
}

function occurredAtForCommit(commit: any): string | null {
  return cleanText(commit?.created) ?? cleanText(commit?.commit?.committer?.date) ?? cleanText(commit?.commit?.author?.date);
}

export class ForgejoSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "forgejo/1";
  private readonly maxPages: number;
  private readonly rest: RestClient;
  private readonly projects: string[];

  constructor(
    descriptor: SourceDescriptor,
    rest: RestClient,
    projects: string[],
    opts: ForgejoSourceOptions = {},
  ) {
    this.descriptor = descriptor;
    this.rest = rest;
    this.projects = projects;
    this.maxPages = Math.max(1, Math.floor(opts.maxPages ?? DEFAULT_MAX_PAGES));
  }

  private async list(path: string, params: Record<string, string | number | boolean | null | undefined>, limit: number): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const value = await this.rest<any>(path, { ...params, page, limit });
      if (!Array.isArray(value)) throw new Error(`${path}: expected a list response`);
      out.push(...value);
      if (value.length < limit) return out;
    }
    throw new Error(`${path}: page cap ${this.maxPages} reached`);
  }

  private async capabilities(): Promise<ForgejoCapabilities> {
    const version = await this.rest<any>("version");
    const versionText = cleanText(version?.version);
    const major = versionText ? Number(versionText.match(/^(\d+)/)?.[1]) : NaN;
    if (!Number.isSafeInteger(major)) throw new Error("Forgejo version response did not contain a major version");
    if (major !== SUPPORTED_MAJOR) throw new Error(`unsupported Forgejo major ${major}; certified major is ${SUPPORTED_MAJOR}`);

    const settings = await this.rest<any>("settings/api");
    const advertised = Number(settings?.max_response_items);
    if (!Number.isSafeInteger(advertised) || advertised < 1) throw new Error("Forgejo API settings omitted max_response_items");
    return { apiVersion: `forgejo.api.v1.server-${major}`, pageSize: Math.min(DEFAULT_PAGE_SIZE, advertised) };
  }

  private async fetchItemPayload(
    issue: any,
    project: string,
    repository: any,
    prefix: string,
    iid: number,
    pageSize: number,
    partial: (label: string, err: unknown) => void,
    track: (value: unknown) => void,
  ): Promise<any> {
    const isPull = Boolean(issue?.pull_request);
    const payload: any = {
      issue,
      project,
      repository,
      dependencies: [],
      blocks: [],
      pull: null,
      reviews: [],
      combinedStatus: null,
    };
    track(issue?.updated_at);

    for (const [surface, key] of [["dependencies", "dependencies"], ["blocks", "blocks"]] as const) {
      try {
        payload[key] = await this.list(`${prefix}/issues/${iid}/${surface}`, {}, pageSize);
      } catch (err) {
        partial(`${project} #${iid} ${surface}`, err);
      }
    }

    if (!isPull) return payload;

    try {
      payload.pull = await this.rest<any>(`${prefix}/pulls/${iid}`);
      const headSha = cleanText(payload.pull?.head?.sha);
      if (!headSha) throw new Error("pull response omitted head sha");
      payload.combinedStatus = await this.rest<any>(`${prefix}/commits/${encodeURIComponent(headSha)}/status`, { page: 1, limit: pageSize });
      const statusCount = Number(payload.combinedStatus?.total_count ?? payload.combinedStatus?.statuses?.length ?? 0);
      if (statusCount > (payload.combinedStatus?.statuses?.length ?? 0)) {
        throw new Error(`combined status response truncated (${payload.combinedStatus?.statuses?.length ?? 0}/${statusCount})`);
      }
    } catch (err) {
      partial(`${project} #${iid} pull/status`, err);
    }

    try {
      const reviews = await this.list(`${prefix}/pulls/${iid}/reviews`, {}, pageSize);
      for (const review of reviews) {
        track(review?.submitted_at ?? review?.updated_at);
        const expectedComments = Number(review?.comments_count ?? 0);
        if (expectedComments > 0) {
          const comments = await this.rest<any>(`${prefix}/pulls/${iid}/reviews/${encodeURIComponent(String(review.id))}/comments`);
          if (!Array.isArray(comments)) throw new Error(`review ${review.id} comments response was not a list`);
          if (comments.length < expectedComments) throw new Error(`review ${review.id} comments truncated (${comments.length}/${expectedComments})`);
          review.comments = comments;
          for (const comment of comments) track(comment?.updated_at ?? comment?.created_at);
        } else {
          review.comments = [];
        }
      }
      payload.reviews = reviews;
    } catch (err) {
      partial(`${project} #${iid} reviews`, err);
    }

    return payload;
  }

  private async listCommits(
    path: string,
    params: Record<string, string | number | boolean | null | undefined>,
    limit: number,
    since: string | null,
  ): Promise<any[]> {
    const out: any[] = [];
    let previousInstant: string | null = null;
    let newestFirst = true;

    for (let page = 1; page <= this.maxPages; page++) {
      const value = await this.rest<any>(path, { ...params, page, limit });
      if (!Array.isArray(value)) throw new Error(`${path}: expected a list response`);
      let crossedWatermark = false;
      for (const commit of value) {
        const occurredAt = occurredAtForCommit(commit);
        if (!occurredAt) {
          newestFirst = false;
          continue;
        }
        if (previousInstant && occurredAt > previousInstant) newestFirst = false;
        previousInstant = occurredAt;
        if (since && occurredAt < since) crossedWatermark = true;
        else out.push(commit);
      }
      if (value.length < limit) return out;
      if (since && newestFirst && crossedWatermark) return out;
    }
    throw new Error(`${path}: page cap ${this.maxPages} reached`);
  }

  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const now = new Date().toISOString();
    let latest: string | null = null;
    let complete = true;
    let firstError: string | null = null;
    const records: RawRecord[] = [];
    const since = opts.full ? null : opts.since;

    const track = (value: unknown): void => {
      const instant = cleanText(value);
      if (instant && (!latest || instant > latest)) latest = instant;
    };
    const partial = (label: string, err: unknown): void => {
      const message = `${label}: ${(err as Error).message}`;
      complete = false;
      firstError ??= message;
      log.warn(`[${this.descriptor.sourceId}] ${message}`);
    };

    let capabilities: ForgejoCapabilities;
    try {
      capabilities = await this.capabilities();
    } catch (err) {
      return { records: [], watermark: null, complete: false, error: (err as Error).message };
    }
    const { apiVersion, pageSize } = capabilities;

    for (const project of this.projects) {
      const [owner, repoName] = project.split("/");
      const prefix = `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repoName!)}`;
      let repository: any;
      try {
        repository = await this.rest<any>(prefix);
        if (!repository?.id || !cleanText(repository?.default_branch)) throw new Error("repository response omitted id/default_branch");
      } catch (err) {
        partial(`${project} repository`, err);
        continue;
      }

      let issues: any[] = [];
      let pulls: any[] = [];
      for (const [kind, target] of [["issues", issues], ["pulls", pulls]] as const) {
        try {
          target.push(...await this.list(`${prefix}/issues`, {
            type: kind,
            state: "all",
            ...(since ? { since } : {}),
          }, pageSize));
        } catch (err) {
          partial(`${project} ${kind}`, err);
        }
      }

      const refs = new Map<number, ItemRef>();
      for (const issue of [...issues, ...pulls]) {
        const externalId = itemExternalId(issue);
        const iid = Number(issue?.number);
        if (!externalId || !Number.isSafeInteger(iid) || iid < 1) {
          partial(`${project} item`, new Error("item response omitted immutable id/number"));
          continue;
        }
        refs.set(iid, {
          externalId,
          iid,
          kind: issue?.pull_request ? "change_request" : "issue",
          state: mapState(issue?.state),
        });
      }

      for (const issue of [...issues, ...pulls]) {
        const externalId = itemExternalId(issue);
        const iid = Number(issue?.number);
        if (!externalId || !Number.isSafeInteger(iid) || iid < 1) continue;
        const isPull = Boolean(issue?.pull_request);
        const payload = await this.fetchItemPayload(issue, project, repository, prefix, iid, pageSize, partial, track);

        const encoded = JSON.stringify(payload);
        records.push({
          entityKind: isPull ? "change_request" : "issue",
          externalId,
          apiVersion,
          fetchedAt: now,
          payload,
          contentHash: hash(encoded),
        });
      }

      try {
        const comments = await this.list(`${prefix}/issues/comments`, { ...(since ? { since } : {}) }, pageSize);
        for (const comment of comments) {
          const iid = issueNumberFromUrl(comment?.issue_url, comment?.pull_request_url, comment?.html_url);
          if (iid === null) {
            partial(`${project} comment ${comment?.id ?? "?"}`, new Error("comment omitted a resolvable item number"));
            continue;
          }
          let target = refs.get(iid);
          if (!target) {
            try {
              const issue = await this.rest<any>(`${prefix}/issues/${iid}`);
              const externalId = itemExternalId(issue);
              if (!externalId) throw new Error("item lookup omitted immutable id");
              target = { externalId, iid, kind: issue?.pull_request ? "change_request" : "issue", state: mapState(issue?.state) };
              refs.set(iid, target);
            } catch (err) {
              partial(`${project} comment ${comment?.id ?? "?"} target`, err);
              continue;
            }
          }
          track(comment?.updated_at ?? comment?.created_at);
          const payload = { activityKind: "comment", project, comment, target };
          records.push({
            entityKind: "activity",
            externalId: `comment:${String(comment.id)}`,
            apiVersion,
            fetchedAt: now,
            payload,
            contentHash: hash(JSON.stringify(payload)),
          });
        }
      } catch (err) {
        partial(`${project} comments`, err);
      }

      try {
        const commits = await this.listCommits(`${prefix}/commits`, {
          sha: repository.default_branch,
          stat: false,
          verification: false,
          files: false,
        }, pageSize, since);
        for (const commit of commits) {
          const occurredAt = occurredAtForCommit(commit);
          if (!occurredAt || (since && occurredAt < since)) continue;
          track(occurredAt);
          const payload = { activityKind: "commit", project, defaultBranch: repository.default_branch, commit };
          records.push({
            entityKind: "activity",
            externalId: stableActivityId(["commit", project, commit.sha]),
            apiVersion,
            fetchedAt: now,
            payload,
            contentHash: hash(JSON.stringify(payload)),
          });
        }
      } catch (err) {
        partial(`${project} commits`, err);
      }
    }

    return { records, watermark: complete ? latest : null, complete, error: firstError };
  }

  async fetchRefresh(candidates: RefreshCandidate[], _opts: FetchOptions): Promise<FetchResult> {
    const configured = new Set(this.projects);
    const now = new Date().toISOString();
    const records: RawRecord[] = [];
    let complete = true;
    let firstError: string | null = null;
    const seen = new Set<string>();
    let capabilities: ForgejoCapabilities;
    try {
      capabilities = await this.capabilities();
    } catch (err) {
      return { records: [], watermark: null, complete: false, error: (err as Error).message };
    }
    const partial = (label: string, err: unknown): void => {
      const message = `${label}: ${(err as Error).message}`;
      complete = false;
      firstError ??= message;
      log.warn(`[${this.descriptor.sourceId}] ${message}`);
    };
    const track = (_value: unknown): void => {};
    for (const candidate of candidates) {
      const key = `${candidate.projectPath}#${candidate.iid}`;
      if (!configured.has(candidate.projectPath) || seen.has(key)) continue;
      seen.add(key);
      const [owner, repo] = candidate.projectPath.split("/");
      const prefix = `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}`;
      try {
        const issue = await this.rest<any>(`${prefix}/issues/${candidate.iid}`);
        const externalId = itemExternalId(issue);
        if (!externalId || externalId !== candidate.externalId || !issue?.pull_request) throw new Error("refresh item identity/type mismatch");
        const payload = await this.fetchItemPayload(
          issue,
          candidate.projectPath,
          null,
          prefix,
          candidate.iid,
          capabilities.pageSize,
          partial,
          track,
        );
        records.push({
          entityKind: "change_request",
          externalId,
          apiVersion: capabilities.apiVersion,
          fetchedAt: now,
          payload,
          contentHash: hash(JSON.stringify(payload)),
        });
      } catch (err) {
        complete = false;
        firstError ??= `${candidate.projectPath} #${candidate.iid} refresh: ${(err as Error).message}`;
      }
    }
    return { records, watermark: null, complete, error: firstError };
  }

  normalize(raw: RawRecord): NormalizedBundle | null {
    if (raw.entityKind === "activity") return this.normalizeActivity(raw);
    const payload = raw.payload as any;
    const issue = payload?.issue ?? {};
    const pull = payload?.pull;
    const kind = raw.entityKind === "change_request" ? "change_request" : "issue";
    const state = mapState(pull?.state ?? issue?.state, Boolean(pull?.merged));
    const item: CanonicalItem = {
      sourceId: this.descriptor.sourceId,
      externalId: raw.externalId,
      kind,
      projectPath: cleanText(payload?.project),
      iid: Number.isSafeInteger(Number(issue?.number)) ? Number(issue.number) : null,
      url: cleanText(pull?.html_url) ?? cleanText(issue?.html_url) ?? "",
      title: cleanText(issue?.title),
      body: cleanProviderBody(issue?.body),
      state,
      stateRaw: cleanText(pull?.state ?? issue?.state),
      stateReason: null,
      isDraft: kind === "change_request" && typeof pull?.draft === "boolean" ? pull.draft : null,
      author: cleanText(issue?.user?.login),
      createdAt: cleanText(issue?.created_at),
      updatedAt: cleanText(issue?.updated_at),
      closedAt: cleanText(pull?.closed_at ?? issue?.closed_at),
      mergedAt: kind === "change_request" ? cleanText(pull?.merged_at) : null,
      reviewState: null,
      ciState: kind === "change_request" ? mapCi(payload?.combinedStatus) : null,
      mergeState: kind === "change_request" && state === "open"
        ? pull?.mergeable === true ? "mergeable" : pull?.mergeable === false ? "conflicting" : "unknown"
        : null,
      openReviewThreads: null,
      totalReviewThreads: null,
      commentTotal: typeof issue?.comments === "number" ? issue.comments : null,
      milestone: cleanText(issue?.milestone?.title),
      demand: typeof issue?.comments === "number" ? issue.comments : null,
    };

    const edges: CanonicalEdge[] = [];
    const self = { sourceId: this.descriptor.sourceId, externalId: raw.externalId };
    for (const dependency of payload?.dependencies ?? []) {
      const externalId = itemExternalId(dependency);
      if (!externalId) continue;
      edges.push({ type: "blocked_by", from: self, to: { sourceId: this.descriptor.sourceId, externalId }, fromState: state, toState: mapState(dependency?.state) });
    }
    for (const blocked of payload?.blocks ?? []) {
      const externalId = itemExternalId(blocked);
      if (!externalId) continue;
      edges.push({ type: "blocks", from: self, to: { sourceId: this.descriptor.sourceId, externalId }, fromState: state, toState: mapState(blocked?.state) });
    }

    const activities = itemActivities(item);
    if (kind === "change_request") activities.push(...this.reviewActivities(payload?.reviews ?? [], item));
    return {
      item,
      labels: Array.isArray(issue?.labels) ? issue.labels.map((label: any) => toLabel(String(label?.name ?? ""), cleanText(label?.color))).filter((label: any) => label.name) : [],
      edges,
      activities,
    };
  }

  private reviewActivities(reviews: any[], item: CanonicalItem): CanonicalActivity[] {
    const out: CanonicalActivity[] = [];
    const target = { sourceId: item.sourceId, externalId: item.externalId };
    for (const review of reviews) {
      const action = reviewAction(review?.state);
      const occurredAt = cleanText(review?.submitted_at ?? review?.updated_at);
      if (action && occurredAt && review?.id != null) {
        const actor = cleanText(review?.user?.login);
        out.push({
          sourceId: item.sourceId,
          externalId: `review:${String(review.id)}`,
          kind: "review",
          action,
          projectPath: item.projectPath,
          targetKind: "change_request",
          target,
          targetIid: item.iid,
          title: item.title,
          url: cleanText(review?.html_url) ?? item.url,
          actor,
          actorKey: deriveActorKey({ sourceId: item.sourceId, username: actor }),
          occurredAt,
          summary: action === "approved" ? `Approved change request #${item.iid}` : `Reviewed change request #${item.iid}`,
          details: { state: review?.state ?? null, review_id: review.id },
        });
      }
      for (const comment of review?.comments ?? []) {
        const commentAt = cleanText(comment?.created_at ?? comment?.updated_at);
        if (!commentAt || comment?.id == null) continue;
        const actor = cleanText(comment?.user?.login);
        out.push({
          sourceId: item.sourceId,
          externalId: `review-comment:${String(comment.id)}`,
          kind: "review",
          action: "commented",
          projectPath: item.projectPath,
          targetKind: "change_request",
          target,
          targetIid: item.iid,
          title: item.title,
          url: cleanText(comment?.html_url) ?? item.url,
          actor,
          actorKey: deriveActorKey({ sourceId: item.sourceId, username: actor }),
          occurredAt: commentAt,
          summary: `Commented on review for change request #${item.iid}`,
          details: { review_id: review?.id ?? null, comment_id: comment.id, path: cleanText(comment?.path), line: comment?.position ?? null },
        });
      }
    }
    return out;
  }

  private normalizeActivity(raw: RawRecord): NormalizedBundle | null {
    const payload = raw.payload as any;
    if (payload?.activityKind === "comment") {
      const comment = payload.comment ?? {};
      const target = payload.target as ItemRef | undefined;
      const occurredAt = cleanText(comment?.created_at ?? comment?.updated_at);
      if (!target || !occurredAt) return null;
      const actor = cleanText(comment?.user?.login);
      const activity: CanonicalActivity = {
        sourceId: this.descriptor.sourceId,
        externalId: raw.externalId,
        kind: "comment",
        action: "commented",
        projectPath: cleanText(payload.project),
        targetKind: target.kind,
        target: { sourceId: this.descriptor.sourceId, externalId: target.externalId },
        targetIid: target.iid,
        title: null,
        url: cleanText(comment?.html_url),
        actor,
        actorKey: deriveActorKey({ sourceId: this.descriptor.sourceId, username: actor }),
        occurredAt,
        summary: `Commented on ${target.kind === "change_request" ? "change request" : "issue"} #${target.iid}`,
        details: { comment_id: comment?.id ?? null, updated_at: cleanText(comment?.updated_at) },
      };
      return { item: null, labels: [], edges: [], activities: [activity] };
    }
    if (payload?.activityKind === "commit") {
      const commit = payload.commit ?? {};
      const sha = cleanText(commit?.sha);
      const occurredAt = occurredAtForCommit(commit);
      if (!sha || !occurredAt) return null;
      const actor = cleanText(commit?.author?.login) ?? cleanText(commit?.commit?.author?.name) ?? cleanText(commit?.commit?.committer?.name);
      const title = firstLine(commit?.commit?.message);
      const body = messageBody(commit?.commit?.message);
      const details: Record<string, unknown> = { sha, message: title, branch: payload.defaultBranch, ref: `refs/heads/${payload.defaultBranch}` };
      if (body) details.body = body;
      const activity: CanonicalActivity = {
        sourceId: this.descriptor.sourceId,
        externalId: raw.externalId,
        kind: "commit",
        action: "committed",
        projectPath: cleanText(payload.project),
        targetKind: "commit",
        target: null,
        targetIid: null,
        title,
        url: cleanText(commit?.html_url),
        actor,
        actorKey: deriveActorKey({
          sourceId: this.descriptor.sourceId,
          username: cleanText(commit?.author?.login),
          email: cleanText(commit?.commit?.author?.email ?? commit?.commit?.committer?.email),
          name: cleanText(commit?.commit?.author?.name ?? commit?.commit?.committer?.name),
        }),
        occurredAt,
        summary: `Committed ${sha.slice(0, 8)}${payload.project ? ` in ${payload.project}` : ""}`,
        details,
      };
      return { item: null, labels: [], edges: [], activities: [activity] };
    }
    return null;
  }
}
