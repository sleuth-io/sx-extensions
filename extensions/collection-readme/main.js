// Collection Readme — Obsidian's Waypoint and Folder Notes, translated
// to a team library: every collection deserves an index page. This tab
// generates a markdown README for the collection — grouped by type, one
// line per asset, install hint at the bottom — to copy anywhere or save
// as a draft. It's metadata-only and cheap, so it regenerates live on
// every mount; no cache to go stale.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const BUTTON =
  "padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 500;" +
  "border: 1px solid var(--color-line); border-radius: 8px; cursor: pointer;" +
  "background: var(--color-surface); color: var(--color-ink);";

// Section titles for the common types; anything else gets a plain plural.
const TYPE_LABELS = {
  skill: "Skills",
  rule: "Rules",
  command: "Commands",
  agent: "Agents",
  mcp: "MCP servers",
  hook: "Hooks",
  "app-plugin": "App plugins",
};
const TYPE_ORDER = ["skill", "rule", "command", "agent", "mcp", "hook", "app-plugin"];

function typeLabel(type) {
  return TYPE_LABELS[type] || type.charAt(0).toUpperCase() + type.slice(1) + "s";
}

function truncate(text, max) {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** Members grouped by type: common types first in a fixed order, the
 *  rest alphabetically, assets keeping the collection's own order. */
function groupByType(members) {
  const groups = new Map();
  for (const m of members) {
    const list = groups.get(m.type) || [];
    list.push(m);
    groups.set(m.type, list);
  }
  const order = (t) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return [...groups.entries()].sort(
    (a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]),
  );
}

function buildMarkdown(collection, groups) {
  const lines = [`# ${collection.name}`, ""];
  if (collection.description) lines.push(collection.description, "");
  for (const [type, members] of groups) {
    lines.push(`## ${typeLabel(type)}`, "");
    for (const m of members) {
      const desc = m.description ? ` — ${truncate(m.description, 120)}` : "";
      lines.push(`- **${m.name}**${desc}`);
    }
    lines.push("");
  }
  lines.push("---", "");
  lines.push(`Install this collection with \`sx install --collection ${collection.name}\`.`);
  return lines.join("\n") + "\n";
}

export default class CollectionReadme {
  onload(sx) {
    this.sx = sx;
    sx.registerCollectionView({
      id: "readme",
      title: "Index",
      mount: (view, ctx) => void this.mount(view, ctx.collection),
    });
  }

  onunload() {}

  async mount(view, collectionName) {
    const root = view.el;
    root.style.cssText = "max-width: 720px;";
    root.replaceChildren(el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Building index…"));
    let disposed = false;
    view.onDispose(() => {
      disposed = true;
    });
    try {
      const [assets, collections] = await Promise.all([
        this.sx.assets.list(),
        this.sx.assets.listCollections(),
      ]);
      if (disposed) return;
      const collection = collections.find((c) => c.name === collectionName);
      if (!collection) {
        this.empty(root, "This collection no longer exists.");
        return;
      }
      const byName = new Map(assets.map((a) => [a.name, a]));
      const members = collection.assets.map((n) => byName.get(n)).filter(Boolean);
      if (members.length === 0) {
        this.empty(root, "This collection is empty — nothing to index yet.");
        return;
      }
      const gone = collection.assets.length - members.length;
      const groups = groupByType(members);
      this.render(root, collection, groups, buildMarkdown(collection, groups), gone);
    } catch (e) {
      if (disposed) return;
      root.replaceChildren(
        el(
          "div",
          FAINT + "font-size: 12px; padding: 8px 0;",
          "Couldn't build the index: " + (e?.message || e),
        ),
      );
    }
  }

  empty(root, message) {
    root.replaceChildren(el("div", FAINT + "font-size: 12px; padding: 16px 0;", message));
  }

  async copy(markdown) {
    try {
      await navigator.clipboard.writeText(markdown);
      this.sx.ui.notice("Markdown copied to clipboard.");
    } catch (e) {
      this.sx.ui.notice("Couldn't copy: " + (e?.message || e));
    }
  }

  async saveDraft(collection, markdown) {
    const name = `${collection.name}-readme`;
    const ok = await this.sx.ui.confirm(
      `Create a draft “${name}” containing this index? It stays a draft — publishing is up to you.`,
      "Create draft",
    );
    if (!ok) return;
    try {
      await this.sx.drafts.create({
        name,
        files: [{ path: "README.md", content: markdown }],
      });
      this.sx.ui.notice(`Draft “${name}” created — review and publish it manually when ready.`);
    } catch (e) {
      this.sx.ui.notice("Couldn't create the draft: " + (e?.message || e));
    }
  }

  render(root, collection, groups, markdown, gone) {
    root.replaceChildren();

    const actions = el("div", "display: flex; gap: 8px; margin-bottom: 14px;");
    const copyBtn = el("button", BUTTON, "Copy markdown");
    copyBtn.onclick = () => void this.copy(markdown);
    const draftBtn = el("button", BUTTON, "Save as draft…");
    draftBtn.onclick = () => void this.saveDraft(collection, markdown);
    actions.append(copyBtn, draftBtn);
    root.append(actions);

    // The preview mirrors the markdown one-to-one: what you copy is
    // exactly what you see, just without the styling.
    const page = el(
      "div",
      "padding: 16px 18px; border: 1px solid var(--color-line); border-radius: 10px;" +
        "background: var(--color-surface);",
    );
    page.append(
      el(
        "div",
        "font-size: 18px; font-weight: 700; color: var(--color-ink); margin-bottom: 4px;",
        collection.name,
      ),
    );
    if (collection.description) {
      page.append(
        el("div", "font-size: 12px; color: var(--color-ink-soft);", collection.description),
      );
    }
    for (const [type, members] of groups) {
      page.append(
        el(
          "div",
          "font-size: 13px; font-weight: 600; color: var(--color-ink); margin: 14px 0 6px;",
          typeLabel(type),
        ),
      );
      for (const m of members) {
        const row = el("div", "display: flex; gap: 6px; align-items: baseline; padding: 2px 0;");
        row.append(el("span", "font-size: 12px; font-weight: 600; color: var(--color-ink);", m.name));
        if (m.description) {
          row.append(
            el("span", FAINT + "font-size: 12px; min-width: 0;", "— " + truncate(m.description, 120)),
          );
        }
        page.append(row);
      }
    }
    page.append(
      el(
        "div",
        FAINT +
          "font-size: 11px; font-family: ui-monospace, monospace; margin-top: 14px;" +
          "padding-top: 10px; border-top: 1px solid var(--color-line);",
        `sx install --collection ${collection.name}`,
      ),
    );
    root.append(page);

    if (gone) {
      root.append(
        el(
          "div",
          FAINT + "font-size: 11px; margin-top: 8px;",
          `${gone} listed asset${gone === 1 ? "" : "s"} no longer exist and were left out.`,
        ),
      );
    }
  }
}
