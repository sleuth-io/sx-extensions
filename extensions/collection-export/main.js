// Collection Export — Longform's compile step, translated to a team
// asset library: a collection is the manuscript, and "compile" hands it
// to whichever agent runtime the team runs. The packaging itself is the
// host's job (sx.collections.export); this tab is the four-format menu
// in the place you're already looking at the collection.

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

const FORMATS = [
  {
    id: "claude-code",
    title: "Claude Code plugin",
    blurb:
      "A plugin directory with a marketplace manifest — the collection's skills install straight into Claude Code.",
    skillsOnly: true,
  },
  {
    id: "codex",
    title: "Codex plugin",
    blurb:
      "The same skills packaged in Codex's plugin layout, ready to drop into a Codex setup.",
    skillsOnly: true,
  },
  {
    id: "gemini",
    title: "Gemini extension",
    blurb:
      "A Gemini CLI extension bundling the collection's skills with its extension manifest.",
    skillsOnly: true,
  },
  {
    id: "zip",
    title: "Plain zip",
    blurb:
      "Every member asset as-is — all files and metadata, no agent packaging. The portable fallback.",
    skillsOnly: false,
  },
];

export default class CollectionExport {
  onload(sx) {
    this.sx = sx;
    this.exporting = false; // one export at a time, across mounts too
    sx.registerCollectionView({
      id: "export",
      title: "Export",
      mount: (view, ctx) => void this.mount(view, ctx.collection),
    });
  }

  onunload() {}

  async mount(view, collectionName) {
    const root = view.el;
    root.style.cssText = "max-width: 720px;";
    root.replaceChildren(el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Loading…"));
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
        root.replaceChildren(
          el("div", FAINT + "font-size: 12px; padding: 16px 0;", "This collection no longer exists."),
        );
        return;
      }
      if (collection.assets.length === 0) {
        root.replaceChildren(
          el(
            "div",
            FAINT + "font-size: 12px; padding: 16px 0;",
            "This collection is empty — add some assets and export them from here.",
          ),
        );
        return;
      }
      const types = new Map(assets.map((a) => [a.name, a.type]));
      const skills = collection.assets.filter((n) => types.get(n) === "skill").length;
      this.render(root, collection, skills, () => disposed);
    } catch (e) {
      if (disposed) return;
      root.replaceChildren(
        el(
          "div",
          FAINT + "font-size: 12px; padding: 8px 0;",
          "Couldn't load the collection: " + (e?.message || e),
        ),
      );
    }
  }

  render(root, collection, skills, isDisposed) {
    root.replaceChildren();
    const n = collection.assets.length;
    root.append(
      el(
        "div",
        "font-size: 13px; font-weight: 600; color: var(--color-ink); margin-bottom: 2px;",
        `Export “${collection.name}”`,
      ),
    );
    root.append(
      el(
        "div",
        FAINT + "font-size: 11px; margin-bottom: 12px;",
        `${n} asset${n === 1 ? "" : "s"}, ${skills} skill${skills === 1 ? "" : "s"}`,
      ),
    );

    const buttons = [];
    const setBusy = (busy) => {
      for (const b of buttons) b.disabled = busy;
    };
    const grid = el("div", "display: flex; flex-direction: column; gap: 8px;");
    for (const fmt of FORMATS) {
      const card = el(
        "div",
        "display: flex; gap: 12px; align-items: center; padding: 12px 14px;" +
          "border: 1px solid var(--color-line); border-radius: 10px; background: var(--color-surface);",
      );
      const info = el("div", "flex: 1; min-width: 0;");
      info.append(el("div", "font-size: 13px; font-weight: 600; color: var(--color-ink);", fmt.title));
      info.append(el("div", FAINT + "font-size: 11px; margin-top: 2px;", fmt.blurb));
      card.append(info);

      const btn = el("button", BUTTON + "flex-shrink: 0;", "Export");
      btn.onclick = async () => {
        if (this.exporting) return;
        this.exporting = true;
        setBusy(true);
        const label = btn.textContent;
        btn.textContent = "Exporting…";
        try {
          const path = await this.sx.collections.export(collection.name, fmt.id);
          // "" means the user canceled the save dialog — stay quiet.
          if (path) this.sx.ui.notice("Saved to " + path);
        } catch (e) {
          this.sx.ui.notice("Export failed: " + (e?.message || e));
        } finally {
          this.exporting = false;
          btn.textContent = label;
          if (!isDisposed()) setBusy(false);
        }
      };
      buttons.push(btn);
      card.append(btn);
      grid.append(card);
    }
    root.append(grid);

    root.append(
      el(
        "div",
        FAINT + "font-size: 11px; margin-top: 12px;",
        "Agent-plugin formats include only the collection's skill-type assets; the plain zip includes everything.",
      ),
    );
  }
}
