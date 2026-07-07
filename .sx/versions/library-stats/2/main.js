// Library Stats — an sx analogue of Obsidian's Vault Statistics and
// Better Word Count. The originals put ambient numbers (notes, words,
// size) in the status bar; here they're a dashboard widget with the two
// questions a team library adds: which assets are bloated, and is the
// library still growing? Word counts cache by updatedAt in per-plugin
// storage — the same incremental-recompute trick Vault Statistics uses.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

function words(text) {
  const body = text.replace(/^---[\s\S]*?\n---\n/, ""); // frontmatter isn't prose
  return body.split(/\s+/).filter(Boolean).length;
}

export default class LibraryStats {
  onload(sx) {
    this.sx = sx;
    sx.registerDashboardWidget({
      id: "library-stats",
      title: "Library stats",
      mount: (view) => void this.mount(view),
    });
  }

  onunload() {}

  async mount(view) {
    view.el.replaceChildren(
      el("div", FAINT + "font-size: 12px; padding: 10px 12px;", "Counting…"),
    );
    try {
      const [assets, audit, cacheRaw] = await Promise.all([
        this.sx.assets.list(),
        this.sx.usage.auditEvents(90).catch(() => []),
        this.sx.storage.loadData().catch(() => null),
      ]);
      const cache = (cacheRaw && cacheRaw.words) || {};
      const fresh = {};
      let totalWords = 0;
      let totalFiles = 0;
      const byType = new Map();
      const sizes = [];
      for (const summary of assets) {
        byType.set(summary.type, (byType.get(summary.type) || 0) + 1);
        const key = summary.name + "@" + (summary.updatedAt || "");
        let entry = cache[key];
        if (entry) {
          fresh[key] = entry;
        } else {
          try {
            const files = await this.sx.assets.readFiles(summary.name);
            entry = {
              files: files.length,
              words: files
                .filter((f) => /\.(md|markdown)$/i.test(f.path))
                .reduce((sum, f) => sum + words(f.content), 0),
            };
            fresh[key] = entry;
          } catch {
            // unreadable — show 0 this pass, but leave the cache entry
            // absent so the next mount retries instead of trusting a failure
            entry = { files: 0, words: 0 };
          }
        }
        totalWords += entry.words;
        totalFiles += entry.files;
        sizes.push({ name: summary.name, words: entry.words });
      }
      void this.sx.storage.saveData({ words: fresh });
      sizes.sort((a, b) => b.words - a.words);

      // Publishes per week for the sparkline (12 buckets, oldest first).
      const weekly = new Array(12).fill(0);
      for (const e of audit) {
        if (!/publish/i.test(e.event)) continue;
        const age = Date.now() - new Date(e.timestamp).getTime();
        // Older than the window drops out; it doesn't pile into bucket 0.
        if (age < 0 || age >= 12 * 7 * 86400_000) continue;
        const bucket = 11 - Math.floor(age / (7 * 86400_000));
        weekly[bucket]++;
      }

      this.render(view.el, { assets, byType, totalWords, totalFiles, sizes, weekly });
    } catch (e) {
      view.el.replaceChildren(
        el("div", FAINT + "font-size: 12px; padding: 10px 12px;", "Couldn't compute stats: " + e),
      );
    }
  }

  render(root, stats) {
    root.replaceChildren();
    const strip = el(
      "div",
      "display: flex; gap: 18px; flex-wrap: wrap; padding: 10px 12px 6px;",
    );
    const big = (value, label) => {
      const box = el("div", "");
      box.append(
        el("div", "font-size: 18px; font-weight: 600;", value.toLocaleString()),
        el("div", FAINT + "font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;", label),
      );
      return box;
    };
    strip.append(
      big(stats.assets.length, "assets"),
      big(stats.totalFiles, "files"),
      big(stats.totalWords, "words"),
    );
    root.append(strip);

    const types = [...stats.byType.entries()].sort((a, b) => b[1] - a[1]);
    root.append(
      el(
        "div",
        FAINT + "font-size: 11px; padding: 0 12px 8px;",
        types.map(([t, n]) => n + " " + t + (n === 1 ? "" : "s")).join(" · "),
      ),
    );

    // 12-week publish sparkline.
    const maxWeek = Math.max(1, ...stats.weekly);
    const spark = el(
      "div",
      "display: flex; align-items: flex-end; gap: 3px; height: 28px; padding: 0 12px 4px;",
    );
    for (const n of stats.weekly) {
      const bar = el(
        "div",
        "width: 10px; border-radius: 2px 2px 0 0;" +
          `height: ${Math.max(2, Math.round((n / maxWeek) * 26))}px;` +
          `background: ${n > 0 ? "var(--color-accent)" : "var(--color-line)"};` +
          (n === 0 ? "opacity: 0.5;" : ""),
      );
      bar.title = n + " publishes";
      spark.append(bar);
    }
    root.append(
      spark,
      el("div", FAINT + "font-size: 10px; padding: 0 12px 8px;", "publishes · last 12 weeks"),
    );

    const top = stats.sizes.filter((s) => s.words > 0).slice(0, 5);
    if (top.length > 0) {
      root.append(
        el(
          "div",
          FAINT + "font-size: 10px; padding: 4px 12px 2px; text-transform: uppercase; letter-spacing: 0.05em;",
          "largest assets",
        ),
      );
      for (const s of top) {
        const row = el(
          "button",
          "display: flex; width: calc(100% - 24px); margin: 0 12px; gap: 8px;" +
            "background: none; border: none; padding: 2px 0; font: inherit;" +
            "font-size: 12px; cursor: pointer; align-items: baseline;",
        );
        row.addEventListener("click", () => this.sx.ui.openAsset(s.name));
        row.append(
          el("span", "color: var(--color-accent); text-align: left;", s.name),
          el("span", FAINT + "font-size: 11px; margin-left: auto;", s.words.toLocaleString() + " words"),
        );
        root.append(row);
      }
      root.append(el("div", "height: 10px;"));
    }
  }
}
