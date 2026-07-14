# sx-extensions

The shared extensions marketplace for the [sx](https://github.com/sleuth-io/sx)
desktop app. This repository is itself an sx vault: every extension is an
`app-plugin` asset, browsable and installable from **Settings → Extensions →
Browse marketplace** inside the app.

Each extension here is an sx-native take on one of the most popular
[Obsidian](https://obsidian.md) community plugins — same proven idea,
rebuilt for a team AI-asset library.

| Extension | Inspired by | What it adds |
| --- | --- | --- |
| **Asset Query** | Dataview (4.5M downloads) | Pinnable live query tables over assets, frontmatter, and usage fields |
| **Related Assets** | Smart Connections (1.1M) | TF-IDF similar-asset tab with the shared terms that drove each match |
| **Recent Assets** | Recent Files | Team-wide recently-touched sidebar with pinning |
| **Activity Heatmap** | Heatmap Calendar | GitHub-style year grid of usage or edits, streaks, day drill-down |
| **Library Stats** | Vault Statistics / Better Word Count | Assets/files/words big numbers, largest assets, publish sparkline |
| **Smart Templates** | Templater (4.8M) / QuickAdd (1.9M) | `{{prompt:…}}` placeholder templates that scaffold new drafts |
| **Style Linter** | Linter (1.0M) | Toggleable formatting rules at publish time, a per-asset Style tab, and whole-library lint |
| **Asset Relations** | Strange New Worlds + Breadcrumbs | Referenced-by tab, orphans-and-hubs widget, broken-reference and edit-impact publish warnings |
| **Team Digest** | Periodic Notes (709k) | Weekly library digest generated as a reviewable draft: changes, usage movers, attention items |
| **Table Tidy** | Advanced Tables (3.0M) | Formats markdown tables in the draft editor; ragged-table publish warnings |
| **Draft Refactor** | Note Refactor (332k) | Extract a selection into its own draft with a reference left behind |
| **Metric Charts** | Tracker + Charts | Chart DSL over usage/audit events with pinnable dashboard charts |
| **Library Grid & Board** | Projects + DB Folder + Kanban | Editable metadata grid and a draft pipeline board with publish-stage warnings |
| **Claude Assist** | Smart Composer / Copilot-class assistants | Ask the library with cited answers, critique a draft as a prompt, draft a skill from a description — your own Claude API key, kept in the OS keychain |
| **Review Rota** | Spaced Repetition + review workflows | Adaptive review due dates per asset, fair team rotation, shared verdicts (reviewed / needs update / deprecate); publishing resets the clock |
| **Collection Doctor** | Zoottelkeeper / folder health | 0–100 collection health score with clickable findings: thin descriptions, stale, unused, oversized |
| **Collection Export** | Longform compile | Export a collection as a Claude Code plugin, Codex plugin, Gemini extension, or plain zip |
| **Collection Readme** | Waypoint + Folder Notes | Markdown index of a collection, grouped by type, ready to copy or save as a README draft |
| **Team Doctor** | Zoottelkeeper + Vault Changelog | 0–100 team health score — stale shares, assets the team never uses, thin descriptions, inactive members — plus a this-week digest |
| **Team Pulse** | Contribution Graph + Tracker | A GitHub-style contribution grid per member, an adoption leaderboard, and the team's most-used assets |
| **Repo Doctor** | Janitor + folder health | 0–100 health score for a repo's scoped assets, flagging broken scopes, never-used, stale, and thin ones |
| **Repo Sync Status** | Obsidian Git | What's scoped to a repo, when each asset last changed, an install-command copy button, and a history feed |
| **Skill Evals** | skills.new evals + Anthropic skill-creator | Generate evals per skill (drafted into `evals/evals.json`, skills.new-compatible), benchmark with-vs-without the skill through your AI provider, and a Skill health view surfacing retire candidates the baseline already passes |
| **Skill Quality** | skills.new quality | The skills.new Quality tab for every skill — overall score, Structure/Actionability/Content/Completeness bars, concrete insights — plus a library-wide quality board with an attention queue, retire candidates, and high-quality exemplars. Read from the server on skills.new, evaluated by your AI provider on file vaults |

The **Team** and **Repo** extensions need the sx app's `views:team` /
`views:repo` slots (SxAPI 1.7.0). The **Collection** trio needs
`views:collection` (1.6.0). **Skill Evals** needs `llm:use` and
`views:asset-tab`, and `benchmarks` (SxAPI 1.10.0, app 2.2.3+).
**Skill Quality** needs `quality` (SxAPI 1.12.0, app 2.3.0+).

An earlier **Library Search** extension (Omnisearch-inspired) was retired:
ranked full-text content search is built into the sx app's main search box
as of 2.1.0.

## Installing

In the sx app: **Settings → Extensions → Browse marketplace…**, then Install.
Installed extensions arrive disabled; enabling one shows exactly what it can
access before it runs.

From the command line, against your own vault:

```bash
sx add ./extensions/<name> --yes
```

## Distribution and install counts

Version archives live as assets on the rolling [downloads release](https://github.com/sleuth-io/sx-extensions/releases/tag/downloads),
not in the tree: CI (`.github/workflows/publish-releases.yml`) uploads each
newly published `<name>-<version>.zip` and rewrites its `sx.toml` entry to a
hash-pinned `[assets.source-http]` URL. Installing an extension downloads
that asset, so GitHub's per-asset download counts are the (anonymous)
install counter — a nightly job aggregates them into `stats.json`, which
the sx app shows as install counts and a "Most installed" sort. `catalog.json`
(also CI-generated) is what the app's marketplace browser reads, so browsing
never downloads bundles or skews the counts.

After merging a new extension or version, run `sx add ./extensions/<name>`
against this vault as before — CI takes care of the release migration on
the next push to main.

## Authoring

Each extension is a folder with `plugin.json` (manifest), `main.js` (a single
self-contained ES module against the SxAPI), and `metadata.toml` (vault
packaging). See the [authoring guide](https://github.com/sleuth-io/sx/blob/main/docs/app-plugin-authoring.md).

Style note: extensions style themselves with the app's design tokens
(`var(--color-ink)`, `var(--color-accent)`, …) via inline styles — never
utility class names, which aren't part of the API contract.
