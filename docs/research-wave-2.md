# Wave 2 research: candidate extensions (2026-07-07)

Deep-dives of 15 popular Obsidian plugins for sx-marketplace applicability,
each researched individually (internals, popularity, honest fit verdict,
implementation sketch, exact API expansions). Download counts from the
official obsidian-releases stats, 2026-07-07.

Wave 1 shipped: asset-query (Dataview), related-assets (Smart Connections),
recent-assets, activity-heatmap, library-stats, smart-templates,
style-linter — plus content search absorbed into the app's main search.

## Proposals (10, after merging convergent dives)

### 1. Asset Relations — from Strange New Worlds (129k) + Breadcrumbs (208k)
Exact-reference index over asset markdown (backtick-name matching, tiered
confidence) plus derived edges (collection siblings, co-usage, co-authors).
Surfaces: "Referenced by" asset tab with context lines, orphans/hubs
dashboard widget (zero-inbound + unused = archive candidate), broken-
reference and edit-impact publish warnings, small radial SVG ego-graph
(deliberately NOT a Juggl-style canvas). TF-IDF answers "similar";
this answers "depends on". **API: none for v1.**

### 2. Claude Assist — from Copilot (1.5M) + Claudian (1.2M) + Text Generator (549k)
Three interactions only: (a) ask-the-library chat with clickable citations,
(b) critique-this-draft as a *prompt* (trigger clarity, overlap with
published skills — judgment the rule-based linter can't make), (c) new
skill from description → draft, seeded with top-used similar skills as
exemplars. Direct Anthropic Messages API + hand-rolled SSE; keyword+TF-IDF
prefilter + long context, NO embedding index (Copilot's own default is
lexical). Never publishes. ~1.5-2.5k lines, justified.
**API: `net:fetch` (host-scoped allowlist) + `secrets.get/set`
(keychain-backed) — the whole AI category unlocks on these two.**

### 3. Review Rota — from Spaced Repetition (550k)
Stale-skill review queue: SM-2-style interval growth on "still good"
(30d→45d→68d→cap by usage), shortening on "needs update", ±10% fuzz so
reviews don't clump, priority = overdue × log(usage). Deterministic
assignment weighted toward the asset's recent users. Verdicts are actions:
reviewed / needs-update (spawns flagged draft) / deprecate. Publishing
resets the clock via onBeforePublish.
**API: `storage.shared` (team-scoped KV) is THE blocker — per-user state
makes a rota meaningless. Solo mode possible without.**

### 4. Library Grid & Board — from Projects (424k, archived) + DB Folder (330k, archived) + Kanban (2.4M)
One plugin, two tabs. Grid: editable metadata table (owner/status/keywords)
across many assets at once — the one thing core query tables can't do,
with a last-used column from usage data. Board: draft→publish pipeline
lanes (Incoming/Drafting/In Review/Ready), KV-backed stages,
onBeforePublish warns when publishing from the wrong lane. Read-only
table/calendar/gallery views rejected as core duplicates.
**API: `assets.writeMetadata` (blocker), `drafts.list()`, `views:main`.**

### 5. sx-metrics — from Tracker (346k) + Charts (230k)
Pinnable chart DSL (yaml-ish codeblock): source usage/audit/assets, filter,
groupBy day/week/month, split by team/user/asset, render line/bar/summary —
hand-rolled SVG, no chart lib. Asset-content mode (regex/frontmatter scans:
"how many skills declare allowed-tools"). Month view dropped (heatmap owns
it). **API: since/until + filter params on usage/audit reads (required at
scale), `teams.list()` for team split.**

### 6. Library Complete — from Various Complements (509k)
Editor autocomplete: asset/collection names (ranked by team usage),
frontmatter keys→observed values, curated team glossary in KV. Prevention
where the style linter is cure.
**API: `editor.registerCompletionSource()` — the richest editor hook.**

### 7. Draft Refactor — from Note Refactor (332k)
Extract selection → new draft (heading levels normalized); extract section
→ bundled references/ file in the same draft (progressive disclosure — the
canonical fix for bloated skills); split-by-heading with confirm preview.
**API: `editor.getSelection/replaceSelection`, `drafts.addFile/update`.**

### 8. Table Tidy — from Advanced Tables (3.0M)
Pure text-in/text-out pipe-table formatter (the original's architecture):
format/sort/align/CSV-export commands + ragged-table publish warning.
The warning half works on today's API.
**API: `editor.replaceRange/getCursor/getValue`, editor-scoped commands.**

### 9. Team Digest — from Periodic Notes (709k)
Weekly digest generated as a DRAFT asset (reviewable, publishable,
archived): week-over-week deltas — publishes/edits grouped per asset,
usage risers/fallers, unadopted new assets, stale-but-load-bearing,
contributor share. Empty sections suppressed. Command + Monday nudge
widget; no cron needed for v1. **API: none required.**

### 10. Taxonomy Health — from Tag Wrangler (998k) + Metadata Menu (259k)
Vocabulary audit: every frontmatter key/tag with counts, casing/plural
collision candidates, orphan values; curated team vocabulary; publish
warning on new-vocabulary drift. Bulk RENAME deliberately refused — it
needs `drafts.createRevision(assetId)` (draft revisions of published
assets) to stay inside the human-publish invariant.
**API: none for the audit half.**

## Rejected (researched, honest no)

- **Homepage (1.2M)** — sx already boots to a purpose-built dashboard;
  the residue is a ~30-line core "start view" preference, not a plugin.
- **Commander (550k)** — needs surface abundance and all-day dwell time
  sx doesn't have; ⌘K is the right-sized answer.
- **Iconize (2.1M, deprecated upstream)** — cosmetic, needs invasive DOM
  hooks, per-user icons on shared assets is bikeshedding-as-a-service.
- **Juggl-style graph canvas (127k, unmaintained 3 years)** — graph-porn
  at few-hundred-asset scale; the useful residue (ego-graph) folds into
  Asset Relations.
- **Embedding/vector RAG index** — Copilot's own default path is lexical;
  sx's corpus fits in context after prefiltering.

## API expansion menu (deduplicated, by unlock)

| Cluster | Members | Unlocks |
|---|---|---|
| Editor API | getValue/getCursor/getSelection/replaceSelection/replaceRange, registerEditorCommand, registerCompletionSource | Library Complete, Draft Refactor, Table Tidy |
| Drafts+metadata | drafts.list/update/addFile, assets.writeMetadata, views:main | Grid & Board (and richer Claude Assist loops via drafts.updateFiles) |
| Network+secrets | net:fetch (host-scoped), secrets.get/set (keychain) | Claude Assist (and future digest delivery) |
| Team state | storage.shared (team-scoped KV, LWW) | Review Rota as a real rota |
| Query bounds | since/until+filters on usage/audit, teams.list() | sx-metrics |
| Ambient/infra | ui.registerAssetBadge, events.assetsChanged, events.scheduled, assets.backlinks in core, drafts.createRevision | Badges for Relations+Rota; index invalidation; unattended digests; Taxonomy renames |

Explicitly not worth adding: app.onStartup, layout.setDefaultView,
ui.registerToolbarButton, keybindings.register — only the rejected
plugins wanted them.
