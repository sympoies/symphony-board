// Seed a throwaway gitlab.com fixture project with issues + MRs spanning every
// state and edge lifecycle, mirroring scripts/fixtures/seed-github-fixture.sh, so the UI
// can be reviewed with TWO sources (exercises the source filter + per-source
// health). glab is only authenticated against the self-hosted instance, so this
// drives the gitlab.com REST API directly with $GITLAB_TOKEN (api scope).
//
// GitLab models the issue<->MR link from the ISSUE side (relatedMergeRequests),
// so a "Closes #N" MR auto-relates; lifecycle is derived from the MR + issue
// states exactly like GitHub.
//
//   GITLAB_TOKEN=... node scripts/fixtures/seed-gitlab-fixture.mjs [namespace/path]
//      default path: symphony-board-fixture (under the token user's namespace)
const HOST = "https://gitlab.com";
const TOKEN = process.env.GITLAB_TOKEN;
if (!TOKEN) throw new Error("GITLAB_TOKEN not set");
const PATH = process.argv[2] || "symphony-board-fixture";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${HOST}/api/v4${path}`, {
    method,
    headers: { "PRIVATE-TOKEN": TOKEN, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

// --- project ---------------------------------------------------------------
const proj = await api("POST", "/projects", {
  name: PATH,
  path: PATH,
  visibility: "private",
  initialize_with_readme: true,
  description: "Throwaway fixture for symphony-board e2e (GitLab side).",
});
const id = proj.id;
const base = proj.default_branch || "main";
console.log(`project: ${proj.path_with_namespace} (id ${id}, default ${base})`);

// --- labels ----------------------------------------------------------------
for (const [name, color] of [["bug", "#d73a4a"], ["enhancement", "#a2eeef"], ["priority::high", "#b60205"], ["priority::low", "#0e8a16"]]) {
  await api("POST", `/projects/${id}/labels`, { name, color }).catch((e) => console.log("label warn:", e.message));
}

// --- issues ----------------------------------------------------------------
const issue = (title, opts = {}) => api("POST", `/projects/${id}/issues`, { title, ...opts });
const iAbandon = await issue("Webhook retries storm the API", { labels: "bug" });
const iFixed = await issue("Off-by-one in pagination cursor", { labels: "bug" });
const iProgress = await issue("Add a dark-mode toggle", { labels: "enhancement,priority::high" });
const iDoc = await issue("Write the API quickstart", { labels: "enhancement,priority::low" });
const iClosed = await issue("Migrate to gRPC", {});
const iOpen = await issue("Audit dependency licenses", { labels: "bug" });
await api("PUT", `/projects/${id}/issues/${iClosed.iid}`, { state_event: "close" });
console.log(`issues: abandon=#${iAbandon.iid} fixed=#${iFixed.iid} progress=#${iProgress.iid} doc=#${iDoc.iid} closed=#${iClosed.iid} open=#${iOpen.iid}`);

// --- branch+commit helper, then MRs ---------------------------------------
async function branchCommit(branch, file, content, msg) {
  await api("POST", `/projects/${id}/repository/commits`, {
    branch,
    start_branch: base,
    commit_message: msg,
    actions: [{ action: "create", file_path: file, content }],
  });
}
const mr = (source, title, description, labels) =>
  api("POST", `/projects/${id}/merge_requests`, { source_branch: source, target_branch: base, title, description, labels });

async function mergeWithRetry(iid) {
  for (let i = 0; i < 8; i++) {
    try {
      return await api("PUT", `/projects/${id}/merge_requests/${iid}/merge`, {});
    } catch (e) {
      if (i === 7) throw e;
      await sleep(1500); // GitLab computes mergeability async right after creation
    }
  }
}

// fulfilled: merge an MR that closes iFixed
await branchCommit("fix-pagination", "pagination.txt", "fix cursor", "fix: pagination off-by-one");
const mrFul = await mr("fix-pagination", "Fix pagination cursor", `Closes #${iFixed.iid}`, "bug");
await mergeWithRetry(mrFul.iid);

// declared (in progress): open MR closes iProgress
await branchCommit("feat-darkmode", "darkmode.txt", "wip dark mode", "feat: dark mode (wip)");
const mrDec = await mr("feat-darkmode", "Add dark-mode toggle", `Closes #${iProgress.iid}`, "enhancement,priority::high");

// declared via a DRAFT MR closing iDoc (GitLab draft = "Draft:" title prefix)
await branchCommit("docs-quickstart", "quickstart.txt", "draft docs", "docs: api quickstart (draft)");
const mrDraft = await mr("docs-quickstart", "Draft: API quickstart", `Closes #${iDoc.iid}`, "priority::low");

// broken: an MR referencing iAbandon, then closed unmerged
await branchCommit("fix-webhooks", "webhooks.txt", "abandoned", "fix: webhook retries (abandoned)");
const mrBrk = await mr("fix-webhooks", "Abandoned webhook fix", `Closes #${iAbandon.iid}`, "bug");
await api("PUT", `/projects/${id}/merge_requests/${mrBrk.iid}`, { state_event: "close" });

console.log(`MRs: fulfilled=!${mrFul.iid}(merged) declared=!${mrDec.iid}(open) draft=!${mrDraft.iid}(draft) broken=!${mrBrk.iid}(closed)`);
console.log(`done: ${proj.web_url}`);
