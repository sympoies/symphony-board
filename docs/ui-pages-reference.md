# UI pages reference

Per-page behavior of the read-only UI in `packages/ui`. The [design record](DESIGN.md#ui)
owns the UI's boundary (a read-only consumer of the contract) and the two Tauri shells;
the emitted data is defined in [CONTRACT.md](CONTRACT.md). Moved here verbatim from the
design record's former `UI > Pages` list.

Pages:

- **Live**: opt-in realtime webhook event feed (off by default). It does not
  read the contract; it streams from the Live receiver (see [Live Event Stream
  (Realtime)](DESIGN.md#live-event-stream-realtime)). The tab renders once
  enabled and hides only when the connection
  is definitely unavailable, so a slow snapshot seed can still be opened and
  retried. Its detail supports left/right swipes; Settings owns preview lines
  and hidden event types.
- **Board**: 5 columns, in order `Trackers`, `Open`, `Closed`, `Follow-up`,
  `Change requests`. `Open` and `Closed` are the status columns: status is the
  item's own state (open, or closed/merged), not derived from relationship
  edges. The other three are Spotlight lanes. `Trackers` leads the board with
  issues labeled `workflow::tracking`: open trackers first, closed ones folded
  behind a `Closed (N)` toggle. `Follow-up` keeps issues labeled
  `workflow::follow-up` in any state, and `Change requests` lists open change
  requests only. Spotlight lanes are cross-cuts, so their counts do not sum to
  the item total. A tracker card says how far its program is and what can start
  next: `done/total` over the tracker's children (the targets of its `parent`
  edges), up to three ready children by name then `+N`, and the in-review and
  blocked counts when non-zero. The rules live in `packages/ui/src/program.ts`,
  a pure, view-agnostic module: a child is done when closed or merged;
  otherwise blocked when a `blocks` edge into it comes from an item that is not
  done; otherwise in review when a `closes` edge into it comes from an open
  item; otherwise ready. An endpoint's state is its loaded item row's, falling
  back to the edge's state, and unknown counts as open. A tracker without
  children shows no progress. The lane stays label-selected: `parent` edges
  never add an issue to it, because anyone who can write an issue can write a
  phase table while only triagers set the label. An open tracker is listed
  whatever the date range: the producer pins open labeled trackers into every
  projection (window reason `program_tracker`, capped at the newest 100, see
  [Contract](CONTRACT.md)), and the Trackers lane — only that
  lane — also takes those rows when they are outside the range. Item facets and
  source/repo visibility apply to them; the status columns, the summary stats,
  and the other lanes keep to primary-window items. Closed trackers appear only
  when in range. The Board uses the shared date range and filters primary
  cards by item `updated_at`. For the default static window it can consume a
  matching `boardWindow` aggregate when no viewer-local filters are active. For
  custom `/api/range` responses and viewer-local filters, it computes scoped
  summary stats locally from the returned window.
- **Graph**: relationship view built from edge-connected items. It supports the
  shared date range, relation type toggles, side-list search, focus subgraphs,
  a program view for trackers, and
  board-card deep-links like `#/graph?focus=<ref>` (the `focus` ref alone drives
  the side-list focus view and the focus subgraph; the global search bar is a
  cross-tab filter and is never seeded by navigation). Focus is URL-backed both
  ways: side-list clicks, canvas node-body clicks (which focus the node — the
  node title is the anchor to the provider page), and focus exits all write
  `?focus=` back to the hash, so a focused view is shareable and the browser
  back button steps through focus changes. Search helps locate an item in the
  overview, but is visibly suspended in focus so a narrow lookup cannot erase
  the item's multi-hop neighborhood; the query stays URL-backed and resumes on
  focus exit. Explicit facets and persistent visibility choices remain active.
  In overview, the side list is the
  relationship inventory for the selected range before the mention canvas
  declutter is applied, so mention-only items remain discoverable without a
  redundant per-card canvas-visibility cue. The overview has one toggle per
  relation type present in the loaded edges — an unknown type gets one like any
  other — with every type on except `mentions`, which keeps its all / issues /
  change requests target filter; the toggles are page state, not route or
  stored state, and focus always draws every type. The five known types are
  distinguishable without colour: `closes` solid in its lifecycle colour,
  `blocks` heavy, `parent` dash-dotted, `mentions` short-dashed, `relates`
  long-dashed. A type the UI does not know draws with the default stroke, the
  `closes` line in the muted colour. The legend keys the types on the canvas.
  The side list names an item's strongest
  relation: `closes`, then `blocks`, `parent`, `mentions`, `relates`.
  Disconnected overview components
  are laid out independently and packed into a compact canvas; focus retains
  the roomier single-neighborhood layout. Graph overview summary stats
  are still scoped to the rendered canvas after the range, relation type
  toggles, search, and facets. Focus view uses a separate `focus` summary for the
  focused subgraph instead of reusing overview totals. Contract aggregates are
  used only for the default overview (every type on except mentions) when the
  static window exactly matches an emitted aggregate row; custom range responses
  compute from the returned edges.
  Overview remains range-windowed, but focus is a canonical-history inspection:
  the UI calls `GET /api/graph-neighborhood?ref=<ref>&depth=<1..5>&mentions=all`,
  defaults to one hop, and remembers an explicit depth across focus exit and
  re-entry during the app session. All edges, including mentions, are walked as
  undirected for membership while retaining their original direction. The
  projection is deterministic across cycles and caps a response
  at 200 nodes / 500 edges. It reports whether depth or a safety cap limited the
  result. A static/local
  file deployment cannot query the store, so it keeps the previous loaded
  one-hop fallback and labels that limitation in the focus view. The focused
  canvas card has a theme-aware target marker and outline; a Locate target
  control centers it at readable zoom when a deeper neighborhood is crowded.
  Focusing a program tracker — an item with outgoing `parent` edges in the focus
  data — opens its program view instead: the tracker is the header (title,
  state, `done/total`), its children are the nodes, and `parent` edges are
  implied rather than drawn. Children sit in columns left to right, each one
  column after its last prerequisite, in program order within a column, joined
  by the transitive reduction of the `blocks` edges among them (gate contraction
  makes the raw set dense; a cycle has no reduction, so then every edge is
  drawn and the header says so). Each child carries its status marker and its
  delivering change requests, attached underneath by `closes`; a child without
  an item row is an untracked node. Child order and status are the Board's
  (`packages/ui/src/program.ts`, rule stated under **Board** above), read from
  the same kind of edge set: persistent visibility applies, item facets and
  search do not, so a program reads the same on both pages. A `blocks` edge
  into a child from outside the program therefore blocks it without being
  drawn. The columns are laid out directly rather than by dagre, whose
  coordinate assignment spreads a layer that depends on a whole layer over
  several times its own height. A view toggle switches to the ordinary
  neighborhood and back; `scope=neighborhood` on the route records that choice,
  while its absence (every older focus link) means the program view, and a new
  focus always starts on its default. With a server the view loads
  `GET /api/graph-neighborhood?ref=<ref>&scope=program` — directly when the
  loaded window already shows the tracker's children (always, for a pinned open
  tracker), otherwise after the ordinary neighborhood response shows them; a
  static/local-file deployment reads the same scope from the loaded edges.
  Whether the focus is a tracker is one test over the edges the viewer can see,
  used both to load the program scope and to draw it, so a tracker whose
  children are all in hidden repos or sources loads and draws as an ordinary
  neighborhood, and a program response that shows no child is treated as a
  failed request. When the program request fails — a server that predates the
  scope answers it with a one-hop neighborhood, which the client rejects — the
  program is still drawn and the focus line says from what: the loaded edges
  when the loaded window showed the children, else the neighborhood response
  that did, which can lack the edges that decide a child's status.
- **Activity**: newest-first feed of commit, repository/project event, and
  item-transition records. It uses the same date range as Board and Graph. The
  range is applied before its route-backed source/repo/kind/action facets and
  search, and the page virtualizes
  matching rows so large activity histories remain scrollable without flooding
  the DOM. Rows link to `activities[].url` only when the producer supplied a
  reliable provider destination.
  A row is two lines, like a commit row. The first holds the action, the item's
  number and title (or a commit's short sha and subject, or the branch), and on
  the right the item's current state or a commit's line counts. The second holds
  the repository, the actor, and chips: a review comment's file and line, or a
  push's from → to. Selecting a row opens a detail pane above the overview, with
  everything the event knows: the item as it is now (state, review, CI, labels,
  comment and review-thread counts, the start of its description), the event's
  own facts, and the other in-range events on the same item. A wide screen opens
  the pane on the newest row, pinned, so a reload never swaps the event being
  read; following the newest row is the viewer's choice, as on Commits. A pinned
  row a filter removes falls back to following on a wide screen and closes the
  reader on a phone. Below the split floor the pane is a
  route-backed reader (`activityDetail=1`) with previous / next and swipe, as
  on Commits. The pane quotes a comment's words only when the contract already
  carries them in `review_threads[]` (a GitHub review comment by node id, a
  GitLab note by its `#note_<id>` anchor); an issue comment shows no text.
  From 1400px the page takes the Commits pane tiers (`COMMITS_STACK_QUERY`,
  `COMMITS_PANES_QUERY`), and its layout is also a `.commits-split`, so the two
  pages share one set of tier rules. The middle column holds the detail above
  an overview of panes: summary tiles (events, people, repos, active and busiest
  days, comments, reviews, merges, opened items, pushes); the year's rhythm
  with its facts; events per day stacked by kind, action, repository or person;
  a day-by-hour grid; review verdicts; and the busiest issues and change
  requests, each of which opens its newest event. The rail holds Who (share,
  repositories, active days, per-day sparkline), Where (share, active days,
  sparkline), Branches, What and How. Where, What, How and a verdict toggle
  the route-backed facets. In the laptop tier a rail list cut at its eight rows
  ends in "Show all N", which opens it in place; "Show fewer" folds it back. Every pane reads the rows the feed renders, except
  the rhythm, which reads `activity_daily`. Below 1400px the page keeps its two
  columns and the plain overview; the old who / where / when rail is gone.
- **Items**: newest-updated issue and PR/MR list over `items[]`, scoped by the
  shared date range and item lens. It is a lookup surface for cross-source,
  cross-repo work items, not a replacement for the Board's relationship/status
  workflow view. Rows link to provider items and preserve the shared Graph focus
  affordance for related items.
- **Commits**: commit-only SCM log over `activities[]`, styled separately from
  Activity so it behaves like a provider-neutral commit history. It keeps source,
  repo, branch, and author filters local to the page, links each message to the provider
  commit URL, exposes short SHAs with copy buttons, expands commit body text
  when available, and shows branch choices only when commit rows carry ref
  details. Detail selection is manual by default; a device-local Settings opt-in
  follows the newest visible commit and advances when newer data or a changed
  commit filter produces a new first row. The detail identifies that state as
  `Following latest`; selecting another row changes it to `Pinned`, and the
  in-pane `follow latest` action releases the pin. Provider-specific signals
  such as GitHub Verified badges or check counts are intentionally omitted
  until the contract has comparable GitHub and GitLab semantics.
  The phone reader open state is route-backed as `commitDetail=1`, like the
  Live, Reviews, and Items readers. Browser/Android Back closes the reader
  before leaving Commits; the selected commit and follow/pin mode remain local.
  On phone widths, tapping a commit opens a full-screen reading view with two
  panes: the selected commit detail and its changed-file list. Info and Files
  switch between separate scrolling content areas beneath a fixed control,
  matching the other phone detail views without covering scrolled text.
  The entire reader, including blank space, accepts the same left/right swipes
  as Live and Items: left moves to the older commit and right to the newer one
  in the filtered list, stopping at either end. Swiping pins the commit,
  preserves the active Info/Files pane, and resets detail/files scrolling.
  Newer/Older controls are hidden in desktop split views; in the phone reader
  they stay at the viewport bottom outside both scrolling panes. Short Info and
  Files cards fill the remaining reading area like Live; longer content scrolls
  without moving the footer.
  Links, controls, vertical gestures, and scrollable code retain their behavior.
  The tap fetches the files even when the desktop rail's file-stats setting is
  off. Back returns to the commit list. Following a newer commit does not open
  the reading view or fetch its files by itself.
  At 761–1211 CSS pixels, the list stays beside a scrollable detail/files
  column. Filters collapse behind a summary and expand inline; selecting a
  commit prioritizes its detail over the range overview and resets the right
  column to the top. The visible compact detail fetches files and keeps them
  synchronized while following latest, without changing the device setting. At 1212–1279px the overview and digest
  rail stack in one column beside the list; from 1280px Commits shows the list,
  overview, and rail as three columns.
  Up to 1399px the two supporting columns hold the plain digest and reach the
  bottom of the list by growing their charts. From 1400px
  (`COMMITS_STACK_MIN_WIDTH_PX`, the laptop tier) they carry the full set of
  panes described below, stacked one module per column at 36 / 32 / 32
  (40 / 30 / 30 from 1960px, where that keeps the list on one-line rows), and
  each column scrolls inside itself; every list in them stops at eight rows,
  Largest commits and Change requests scroll within 320px, and the author
  rows keep share, active days and the per-day line (lines and repos stay in
  the row's accessible name). A laptop screen has the height for these panes
  but not the width for two side by side. From 2480px
  (`COMMITS_PANES_MIN_WIDTH_PX`) they are two-up grids instead, the split is
  32 / 34 / 34, and spare height goes to lists rather than to marks: every
  chart keeps a designed height, and Largest commits, Top repos, and Top
  branches take what is left and scroll inside their pane. A ranked row's hover
  tip, on every page, shows only when it adds something: the whole name of a
  label the row cuts or shortens, and on a filter row what a click does. In
  the row layouts it sits over its own row from the name, and the count column
  never moves. In the three-column
  layouts the list's wrapping card puts the sha and its actions beside the
  subject only, so the repository, author and chips below it use the card's
  full width. The pane tiers add a stacked per-day chart (by type, repo, or
  author), lines changed per day, a day-by-hour grid in place of the hour
  strip, Largest commits (a row pins that commit), commit scopes, per-row
  facts on the ranked facets, a 12-month streak summary under the rhythm
  calendar, and a comparison with the preceding period on the commit count.
  The comparison reads `activity_daily`, which counts every commit, so it is
  shown only while no source, repo, branch, or author filter is active and no
  repository or source is hidden in Settings, only when the aggregate reaches
  back far enough to cover the earlier window, and only when the rows on screen
  account for the aggregate's own count for the selected range (within 2%) —
  which is what hides it when the feed is windowed shorter than the range.
  Every pane derives from the rows the list renders or from `activity_daily`;
  none needs a fetch of its own.
  A merge commit (`details.merge`) is tagged `merge` where its line counts
  would be, so it no longer reads as a commit whose counts are unknown, and a
  device-local toolbar toggle leaves merges out of the list and of every pane;
  the period comparison is withheld while it is on. The repository's default
  branch (`details.default_branch`) is drawn first and emphasized on a commit's
  branch chips. In the pane tiers the per-day chart can also be split by
  default branch vs. side branch or by merge vs. commit, a Merges tile appears
  when the range has any, and Top branches leads with the default branches and
  states the share of commits on one. A row from a producer that names no
  default branch is left out of that share rather than counted as a side branch.
  A commit that names its change request (`details.change_request`) shows the
  number as a chip on its row and a Change request row in its detail with the
  item's title, state, review and CI when the item is loaded. The chip opens
  the Items page narrowed to that item when it is one of that page's rows, and
  the provider page when it is loaded only as a support row. The pane tiers
  add a Change requests pane beside Largest commits (the range's commits
  regrouped by the change request they belong to: commits, lines, and how long
  a merged one was open) and a tile counting default-branch commits that landed
  without one. That tile counts only explicit "none" answers on non-merge
  commits, so a provider that cannot resolve every commit never inflates it.
  The pane tiers' last rail pane answers "where did the work land" three
  ways behind one switch: Hot files and Hot directories from the producer's
  file aggregate (`commit_file_stats`), and Commit scopes from the subjects.
  The file views state their coverage ("N of M scanned"), and a row narrows the
  list and every pane to the commits that touched that path; a chip in the
  toolbar clears it. The aggregate is per repository, so it is re-ranked
  exactly across the repositories on screen but cannot be re-ranked for one
  author's or one branch's commits: under either filter the pane shows scopes
  only, and the "files changed" tile is withheld.
  Selected content cards share a subtle theme-aware fill and border across
  Commits, Items, Live, Reviews, and the Graph list; selection paints the
  rounded card rather than virtual-row spacing. Keyboard focus remains visible.
- **Reviews**: current provider review-thread inbox over top-level
  `review_threads[]`, not a review-event feed. It uses the shared date range and
  item lens, lists each synced thread with current resolved/outdated state,
  file/line metadata, and compact comment previews, and shows repo-level
  thread breakdown/trends. Metrics' non-zero `Threads` cells deep-link
  here with source/repo/unresolved filters.
- **Metrics** (`#/repo-analytics`, formerly Repo Analytics): per-repo totals
  and trends from `repo_metrics[]`. It uses
  the shared date range and source/state/kind/search controls, ranks repos by
  contract `activity_score`, renders compact trend bars from contract series
  buckets, and shows a coverage badge (`active` / `partial` / `idle` /
  `no activity`) so a window with missing or merely dormant activity does not
  look like healthy in-range activity. Repo names link through
  `repo_metrics[].repo_url` when present; non-zero metric values deep-link to the
  source-aware Activity or Commits view for the same date range.
- **Settings**: browser-local display preferences, organized into expandable
  Connection & sync, Appearance, Navigation, Board & repositories, Commits,
  and Live groups. Appearance opens by default; an unconfigured client also
  opens Connection & sync. The writer-owned Sources editor remains separate.
  The default tab order is Live (when enabled), Commits, Activity, Metrics,
  Board, Graph, Items, Reviews. A device whose saved order is the old default
  gets the new default; any other saved order has Commits moved to the front of
  the content tabs once, and later custom orders persist. The default landing
  tab is Live, which falls back to Activity while the Live tab is off. It can
  hide repos or whole
  sources, set the default shared date range preset, and set per-repo color
  overrides in `localStorage`. It also stores the opt-in that keeps Commits
  detail on the newest visible row; the detail itself exposes the current
  following/pinned state and can resume following without returning to Settings.
  These preferences are a pre-filter or
  presentation choice before every contract-backed page (Board, Graph,
  Activity, Commits, Items, Reviews, Metrics) computes its view. They are view-only; the daemon keeps syncing every
  configured source. When the URL has no explicit `from` / `to`, new browsers
  default to `this week`, calculated from Sunday in the contract's configured
  `timezone` (default UTC).

The UI supports contract major v4. It warns when a different major is loaded.
