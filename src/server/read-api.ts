// One read-route inventory for standalone and the read-only API sidecar.
// Hosts supply fresh config and deployment capabilities; writer routes stay outside.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.ts";
import { handleRangeRequest } from "./range.ts";
import { handleStatsRequest } from "./stats.ts";
import { handleReviewCandidatesRequest } from "./review-candidates.ts";
import { handleActionableRequest } from "./actionable.ts";
import { handleGraphNeighborhoodRequest } from "./graph-neighborhood.ts";
import { handleActivityDailyRequest } from "./activity-daily.ts";
import { handleCapabilitiesRequest, type CapabilitiesOptions } from "./capabilities.ts";
import { sendJson } from "./http.ts";

type ReadHandler = (cfg: AppConfig, url: URL, res: ServerResponse, req: IncomingMessage) => Promise<void>;
const STORE_ROUTES: Readonly<Record<string, ReadHandler>> = {
  "/api/range": (cfg, url, res, req) => handleRangeRequest(cfg, url, res, req.headers["accept-encoding"]),
  "/api/stats": handleStatsRequest,
  "/api/review-candidates": handleReviewCandidatesRequest,
  "/api/actionable": handleActionableRequest,
  "/api/graph-neighborhood": async (cfg, url, res, req) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    try {
      await handleGraphNeighborhoodRequest(cfg, url, res, req.headers["accept-encoding"], controller.signal);
    } finally {
      req.removeListener("aborted", abort);
    }
  },
};

export interface ReadApiOptions {
  freshConfig: () => AppConfig;
  contractOut: string;
  capabilities: () => CapabilitiesOptions;
}

export async function handleReadApiRequest(
  opts: ReadApiOptions, req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  if ((req.method ?? "GET") !== "GET") return false;
  if (url.pathname === "/api/activity-daily") {
    handleActivityDailyRequest(opts.contractOut, res, req.headers["accept-encoding"]);
    return true;
  }
  if (url.pathname === "/api/capabilities") {
    await handleCapabilitiesRequest(opts.capabilities(), res);
    return true;
  }
  const handler = Object.hasOwn(STORE_ROUTES, url.pathname) ? STORE_ROUTES[url.pathname] : undefined;
  if (!handler) return false;
  let cfg: AppConfig;
  try {
    cfg = opts.freshConfig();
  } catch (err) {
    sendJson(res, 500, { error: "config_error", message: err instanceof Error ? err.message : String(err) });
    return true;
  }
  await handler(cfg, url, res, req);
  return true;
}
