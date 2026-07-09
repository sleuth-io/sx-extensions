// Repo Sync Status — Obsidian Git's Source Control + History panels, for a
// repository's asset scopes. Obsidian Git's whole appeal is ambient "am I
// in sync?" awareness plus one-panel drill-down into what changed; the sx
// analogue is: what's scoped here, when each asset last moved, and a
// reverse-chron history of scope/install/update events for this repo.
//
// True version drift ("installed ref is 2 behind") would need per-checkout
// install state the extension API doesn't expose, so instead of faking it
// this gives you the honest, actionable half — the current asset set with
// copy-ready `sx install` commands, and the audit trail behind them.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const DAY = 86400000;
const HISTORY_DAYS = 90;

const BUTTON =
  "padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 500;" +
  "border: 1px solid var(--color-line); border-radius: 8px; cursor: pointer;" +
  "background: var(--color-surface); color: var(--color-ink);";

function repoLabel(url) {
  return url.replace(/^[a-z+]+:\/\//i, "").replace(/^git@/, "").replace(/\.git$/, "");
}

function timeAgo(iso) {
  if (!iso) return "unknown";
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / DAY));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

// The audit events worth surfacing as this repo's "commit log".
const HISTORY_EVENTS = new Set([
  "asset.created",
  "asset.updated",
  "asset.removed",
  "install.set",
  "install.removed",
]);

export default class RepoSyncStatus {
  onload(sx) {
    this.sx = sx;
    sx.registerRepoView({
      id: "sync",
      title: "Sync Status",
      mount: (view, ctx) => void this.mount(view, ctx.repo),
    });
  }

  onunload() {}

  async copyAll(names) {
    const cmd = names.map((n) => `sx install ${n}`).join("\n");
    try {
      await navigator.clipboard.writeText(cmd);
      this.sx.ui.notice(`Copied ${names.length} install command${names.length === 1 ? "" : "s"}.`);
    } catch (e) {
      this.sx.ui.notice("Couldn't copy: " + (e?.message || e));
    }
  }

  async mount(view, repoUrl) {
    const root = view.el;
    root.style.cssText = "max-width: 760px;";
    root.replaceChildren(
      el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Loading repository status…"),
    );
    let disposed = false;
    view.onDispose(() => {
      disposed = true;
    });
    try {
      const [assets, repos, audit] = await Promise.all([
        this.sx.assets.list(),
        this.sx.repos.list(),
        this.sx.usage.auditEvents(HISTORY_DAYS),
      ]);
      if (disposed) return;
      const repo = repos.find((r) => r.url === repoUrl);
      const scopedNames = repo ? repo.assets : [];
      const byName = new Map(assets.map((a) => [a.name, a]));
      this.render(root, repoUrl, scopedNames, byName, audit);
    } catch (e) {
      if (disposed) return;
      root.replaceChildren(
        el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Couldn't load sync status: " + (e?.message || e)),
      );
    }
  }

  render(root, repoUrl, scopedNames, byName, audit) {
    root.replaceChildren();
    root.append(
      el("div", "font-size: 15px; font-weight: 600; padding: 6px 0 2px;", repoLabel(repoUrl)),
      el(
        "div",
        FAINT + "font-size: 12px; padding: 0 0 12px;",
        scopedNames.length === 0
          ? "Nothing scoped here yet."
          : `${scopedNames.length} asset${scopedNames.length === 1 ? "" : "s"} scoped to install in this repository.`,
      ),
    );

    // Scoped assets, with a copy-all header and per-row copy.
    if (scopedNames.length > 0) {
      const header = el("div", "display: flex; align-items: center; gap: 8px; padding: 0 0 6px;");
      header.append(el("div", "flex: 1; font-size: 13px; font-weight: 600;", "Scoped assets"));
      const copyAll = el("button", BUTTON, "Copy install commands");
      copyAll.onclick = () => void this.copyAll(scopedNames);
      header.append(copyAll);
      root.append(header);

      for (const name of scopedNames) {
        const asset = byName.get(name);
        const row = el(
          "div",
          "display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-top: 1px solid var(--color-line); font-size: 12px;",
        );
        const label = el("div", "flex: 1; min-width: 0;");
        label.append(
          el("div", "font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", name),
          asset
            ? el("div", FAINT + "font-size: 11px;", `${asset.type} · updated ${timeAgo(asset.updatedAt)}`)
            : el("div", "color: var(--color-danger); font-size: 11px;", "asset no longer exists — dangling scope"),
        );
        row.append(label);
        if (asset) {
          const open = el("button", BUTTON, "Open");
          open.onclick = () => this.sx.ui.openAsset(name);
          row.append(open);
        }
        root.append(row);
      }
    }

    // History feed — this repo's "commit log" from the audit stream.
    const repoNames = new Set(scopedNames);
    const history = audit
      .filter((ev) => HISTORY_EVENTS.has(ev.event) && repoNames.has(ev.target))
      .slice(0, 20);
    const hist = el("div", "padding: 16px 0 4px; border-top: 1px solid var(--color-line); margin-top: 14px;");
    hist.append(el("div", "font-size: 13px; font-weight: 600; padding: 0 0 6px;", `History · last ${HISTORY_DAYS} days`));
    if (history.length === 0) {
      hist.append(el("div", FAINT + "font-size: 12px;", "No recorded changes to this repo's assets in the window."));
    }
    for (const ev of history) {
      const line = el("div", "display: flex; gap: 8px; padding: 3px 0; font-size: 12px;");
      line.append(
        el("span", FAINT + "min-width: 72px;", timeAgo(ev.timestamp)),
        el("span", "font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", ev.target),
        el("span", FAINT, `${ev.event} · ${ev.actor}`),
      );
      hist.append(line);
    }
    root.append(hist);
  }
}
