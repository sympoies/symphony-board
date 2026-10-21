# Contract repo metrics reference

Field-level rules for `repo_metrics[]`: windows, totals, series, `top_actors[]` and actor identity, data quality and the activity score, with the version notes that changed them. [CONTRACT.md](CONTRACT.md) owns the version index, the envelope, the compatibility rules and every other section, and its Repo Metrics section links here.

## Repo Metrics

Version `2.2.0` added optional `repo_metrics[]` for the Repo Analytics page and
external consumers that need per-repo trends. Each row is keyed by
`(source_id, project_path)`, matching `repo_stats[]`, but the semantics are
different:

- `repo_stats[]` is full inventory over the canonical live item set of the
  configured repos (see [Config-Gated Projection](CONTRACT.md#config-gated-projection)).
- `repo_metrics[]` is scoped to one time window and must not be used as full
  inventory.

Each row contains:

- `repo_url`: optional nullable provider repo URL, added in `3.2.0`. It is
  emitted only for supported GitHub/GitLab source descriptors and valid provider
  project paths. Use it as a display/navigation convenience, not as identity.
- `window`: `active_since` for static emits or `time_range` for `/api/range`,
  always with `basis: "repo_activity"`, inclusive UTC `from` / `to`, and an
  explicit bucket width (`2h`, `4h`, `6h`, `day`, `week`, or `month`; the sub-day
  widths cover 1-3 day windows — see Version `3.5.0`).
- `totals`: selected-window counts for active/opened/closed items, opened /
  closed / merged change requests, activity event categories, activity score,
  edge lifecycle, and open-vocabulary breakdown maps.
- `series[]`: bucketed points using the same stats shape as `totals`.
- `top_actors[]`: bounded actor summaries. This is an aggregate list, not an
  unbounded user directory. See "Actor identity" below.
- `data_quality`: whether activity rows exist for the repo
  (`activity_available`), the earliest (`observed_since`) and latest
  (`last_activity_at`) observed activity timestamps, and notes for provider or
  coverage gaps. Both timestamps are the repo's all-time bounds (computed across
  every activity row, not just the window), so they can sit outside `window`;
  both are `null` when no activity row carries a parseable instant. The UI
  derives the Repo Analytics coverage badge from these against the window — see
  the `3.0.0` note below.

### Actor identity

`top_actors[]` groups by a canonical actor identity, not by raw display string,
so one human collapses to one row instead of duplicating across a provider
username (issues/PRs/MRs) and several commit author names (commits). Added in
`2.3.0`, each actor row carries:

- `actor_key`: the stable identity the row is grouped on. It is scheme-prefixed
  and **never contains a raw email**:
  - `provider-user:<source_id>:<username>` when the record carries a provider
    username (issue/PR/MR authors, pushes, and account-linked commits).
  - `email:<hash>` when only a commit email is available (account-less git
    authorship); the address is hashed, so it groups records that share an
    address without exposing the address.
  - `name:<normalized>` as a final fallback.
  - `person:<slug>` when a producer-side config identity map merged several of
    the above into one declared human (see below). Treat `actor_key` as an
    opaque, open-vocabulary string — match it, do not parse it.
  Username wins over email so a person's account-linked commits join their
  issues/PRs instead of splitting into a separate email-keyed row. Two records
  that share neither a username nor an email stay separate even when their
  display name matches — except where a config identity explicitly joins them.
- `display_name`: the deterministically chosen name for the identity — the
  config identity's declared name when one applies, otherwise the most frequently
  observed raw name, tie-broken case-insensitively then by code unit.
- `aliases`: the other distinct display names observed for the identity, sorted;
  omitted when there is only one.
- `actor`: a backward-compatibility display field equal to `display_name`, kept
  so pre-`2.3.0` consumers keep rendering. Render `display_name` and key React
  lists on `actor_key`.
- `profile_url`: the actor's canonical provider profile page, added in `3.4.0`.
  It is usually `https://<host>/<username>` on a supported GitHub/GitLab source;
  GitHub App bots may use the provider-reported `https://<host>/apps/<slug>` URL.
  It is emitted for a `provider-user:<source_id>:<username>` identity, and for a
  config-merged `person:<slug>` identity via the provider username **observed on
  this source** (a `person` row is per-source, so the absorbed provider-user
  sub-identity supplies it). It is **omitted** when no username was observed on
  this source — `email:<hash>` / `name:<normalized>` authorship — and for
  unsupported sources. A config identity's declared usernames are host-agnostic,
  so they are never guessed onto a source (that could link a wrong-host profile).
  Like `repo_url`, treat it as a display/navigation convenience, not identity.

An optional producer-side **config identity map** (`identities[]` in
`config/sources.json`) can declare that several of the keys above are one human —
the cross-facet case the automatic key can't bridge, such as a GitLab person
whose issues carry a username while their commits carry only an email. Matching
identities collapse into one `person:<slug>` row named by the config, with the
other observed names as `aliases`. This is producer/display config (read at emit
time, never stored, never exposing raw email); it changes which `actor_key`
values appear but not the contract shape, so it is not a version change. Identity
entries are global unless they include `source_ids[]`; a scoped entry only
matches actors while building repo metrics for those provider source ids. Scope
broad name aliases when the same commit display name may appear on another host
for a different account.

`top_actors[]` also omits CI/dependency **bots** as noise. The producer
auto-drops the unambiguous markers — a GitHub `[bot]` login suffix and GitLab
service-account usernames (`project_`/`group_<id>_bot_…`) — and an optional
config `exclude_actors[]` list drops unmarked ones (e.g. `dependabot`,
`github-code-quality`) by username or display-name match. Excluded actors are
hidden only from this bounded list; their activity still counts in `totals` and
`series`. Like the identity map, this is producer/display config and not a
contract shape or version change.

The producer currently derives repo metrics from canonical item, label, edge,
and activity rows. That means item lifecycle metrics are available even when a
provider has no activity rows, while commit/push/comment/review metrics depend
on the activity fetch surfaces and their retention/coverage. Consumers should
show `data_quality` rather than treating missing activity as true zero activity.

`reviews` and `approvals` are activity-event counts, defined as:

- `reviews`: number of `review` activity events in the window (see [Activities](contract-activities-reference.md#activities)).
  On GitHub this counts every submitted PR review (approve / changes-requested /
  comment); on GitLab it counts current MR approvers (GitLab exposes no other
  review event). It is **not** the count of items currently carrying a
  `review_state` — that is `by_review_state`.
- `approvals`: the subset of those events whose `action` is `approved`. On
  GitLab every review event is an approval, so `approvals == reviews`; on GitHub
  `approvals <= reviews`.

Because GitHub and GitLab expose different review surfaces, treat `reviews` as
"available review signal per provider" and `approvals` as the cross-provider
comparable subset. A repo with `data_quality.activity_available: true` and
`reviews: 0` genuinely had no review activity in the window.

Version `3.0.0` **removed** `data_quality.truncated` from each repo metric row.
It was always `false`: repo metrics are derived from the full canonical item /
edge / activity store, never from the windowed `items[]` payload, so a per-repo
metric row is never truncated. The genuine truncation signal lives at the
top-level `item_window.truncated`. No replacement field is added — the producer
keeps emitting `activity_available`, `observed_since`, and `last_activity_at`,
and the Repo Analytics "Quality" badge now derives a coverage verdict from them
against the metric's window (no producer-side enum): `no activity` when
`activity_available` is false; `idle` when `last_activity_at` predates the
window (real dormancy, not a data gap); `partial` when `observed_since` falls
inside the window (earlier counts are missing, not zero); otherwise `active`.
This is a major bump because removing a field is breaking per the rules below.

Version `3.5.0` added sub-day `repo_metrics[].window.bucket` widths (`2h`, `4h`,
`6h`) for short windows. A 1-, 2-, or 3-day range now tiles its `series[]` into
12 fixed-width points (12 × 2h / 4h / 6h) aligned to the zone's local clock,
instead of collapsing into 1-3 flat buckets, so the Repo Analytics TREND
sparkline shows an intraday shape (the UI caps the sparkline at 16 bars, so 12
fits without truncation). Windows of 4+ days are unchanged (`day`/`week`/`month`).
It is additive within contract major v3 — a new enum member on the existing
`bucket` field; the `series[]` shape is unchanged. Consumers that branch on
`bucket` should treat an unrecognized width as an opaque series point rather than
rejecting it.

Version `3.2.0` added optional nullable `repo_metrics[].repo_url` so consumers can
link a Repo Analytics row back to its provider repository without reconstructing
provider URL rules. It is additive within contract major v3. The row key remains
`(source_id, project_path)`, and `repo_url` may be `null` when the source kind,
host, or path cannot produce a safe provider URL.

Version `3.4.0` added optional `repo_metrics[].top_actors[].profile_url`, the
per-actor counterpart to `repo_url`: the actor's canonical provider profile page
(usually `https://<host>/<username>`, or a provider-reported GitHub App bot URL
such as `https://<host>/apps/<slug>`) so consumers can link a handle to its
GitHub/GitLab profile without reconstructing provider URL rules. It is additive
within contract major v3 and follows the same omit-when-absent rule as the
sibling `aliases` field. It is present for a
`provider-user:<source_id>:<username>` identity and for a config-merged
`person:<slug>` identity via the provider username observed
on this source; it is omitted for email/name authorship with no observed
username and for unsupported sources. See "Actor identity" above.

Version `2.5.0` added `data_quality.last_activity_at` to each repo metric row —
the most recent observed activity instant (max `occurred_at`), the counterpart to
the existing earliest `observed_since`. The producer always emits it (`null` when
no activity row has a parseable timestamp); the Repo Analytics page renders it as
"last active" instead of the earliest-observed instant.

Version `2.4.0` added optional `activity_score` to the repo metric stats shape.
The current producer emits it for every repo metric totals row and series point
as an **unweighted sum** of the in-window event counts:

```text
activity_score =
  commits +
  issues_opened +
  change_requests_opened +
  change_requests_merged +
  comments +
  reviews +
  approvals
```

`issues_opened` is `max(0, items_opened - change_requests_opened)` so a PR/MR is
not also counted as an issue. `items_active` and `pushes` are deliberately not
included: active items are inventory, while push events overlap with commits,
which already capture code activity. The producer emitted a weighted score
(commits ×0.25, issues ×2, change requests opened ×3 / merged ×4, comments ×0.5,
reviews / approvals ×1.5) through contract 4.x; it was simplified to the plain
sum above because the weighting was opaque and a flat event count is easier to
reason about. The field type is unchanged (`number`, `>= 0`), so this is a
producer recalibration, not a contract shape change: every value is now a whole
number, but consumers must keep treating it as an opaque sortable signal.

Open maps such as `by_activity_kind`, `by_activity_action`, `by_edge_type`,
`by_review_state`, `by_ci_state`, `by_merge_state`, and `by_label_scope` are
deliberately open vocabulary. Do not hard-fail on an unknown key.
