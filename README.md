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

An earlier **Library Search** extension (Omnisearch-inspired) was retired:
ranked full-text content search is built into the sx app's main search box
as of 2.1.0.

## Installing

In the sx app: **Settings → Extensions → Browse marketplace…**, then Install.
Installed extensions arrive disabled; enabling one shows exactly what it can
access before it runs.

From the command line, against your own vault:

```bash
sx add extensions/<name> --yes
```

## Authoring

Each extension is a folder with `plugin.json` (manifest), `main.js` (a single
self-contained ES module against the SxAPI), and `metadata.toml` (vault
packaging). See the [authoring guide](https://github.com/sleuth-io/sx/blob/main/docs/app-plugin-authoring.md).

Style note: extensions style themselves with the app's design tokens
(`var(--color-ink)`, `var(--color-accent)`, …) via inline styles — never
utility class names, which aren't part of the API contract.
