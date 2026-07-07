// Asset Relations — an sx analogue of Obsidian's Strange New Worlds
// (reference counts) and Breadcrumbs (typed relations). TF-IDF (the
// related-assets extension) answers "what is SIMILAR?"; this answers
// "what DEPENDS on this?" — exact name references between assets, plus
// derived edges from collections and co-usage. References are names in
// prose, so matching is tiered: backticked names always count, bare
// mentions only when distinctive (hyphenated or long).

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A name is distinctive enough to match bare (unbackticked) prose. */
function distinctive(name) {
  return name.includes("-") || name.length >= 8;
}

export default class AssetRelations {
  onload(sx) {
    this.sx = sx;
    this.index = null;
    sx.registerAssetTab({
      id: "relations",
      title: "Relations",
      mount: (view, ctx) => void this.mountTab(view, ctx.assetName),
    });
    sx.registerDashboardWidget({
      id: "structure-health",
      title: "Library structure",
      mount: (view) => void this.mountWidget(view),
    });
    sx.onBeforePublish((ctx) => this.checkPublish(ctx));
  }

  onunload() {
    this.index = null;
  }

  // ---- Index: name references + derived edges ----

  async build() {
    if (this.index && Date.now() - this.index.builtAt < 60_000) {
      return this.index;
    }
    const [assets, collections, events] = await Promise.all([
      this.sx.assets.list(),
      this.sx.assets.listCollections().catch(() => []),
      this.sx.usage.events(30).catch(() => []),
    ]);
    const names = assets.map((a) => a.name);
    const nameSet = new Set(names);
    // out.get(A) = [{to, line, context, tier}] — A's markdown mentions `to`.
    const out = new Map();
    const inbound = new Map();
    for (const summary of assets) {
      const refs = [];
      try {
        const files = await this.sx.assets.readFiles(summary.name);
        for (const f of files) {
          if (!/\.(md|markdown)$/i.test(f.path)) continue;
          const lines = f.content.split("\n");
          lines.forEach((line, i) => {
            for (const name of names) {
              if (name === summary.name || !line.includes(name)) continue;
              let tier = null;
              if (new RegExp("`" + escapeRe(name) + "`").test(line)) {
                tier = "backtick";
              } else if (
                distinctive(name) &&
                new RegExp("(^|[^\\w-])" + escapeRe(name) + "($|[^\\w-])").test(line)
              ) {
                tier = "mention";
              }
              if (tier && !refs.some((r) => r.to === name && r.line === i + 1)) {
                refs.push({
                  to: name,
                  file: f.path,
                  line: i + 1,
                  context: line.trim().slice(0, 120),
                  tier,
                });
              }
            }
          });
        }
      } catch {
        // unreadable asset — no edges from it
      }
      out.set(summary.name, refs);
      for (const r of refs) {
        const list = inbound.get(r.to) || [];
        list.push({ from: summary.name, ...r });
        inbound.set(r.to, list);
      }
    }
    // Collection siblings.
    const siblings = new Map();
    for (const c of collections) {
      for (const a of c.assets) {
        if (!nameSet.has(a)) continue;
        const set = siblings.get(a) || new Map();
        for (const b of c.assets) {
          if (b !== a && nameSet.has(b)) set.set(b, c.name);
        }
        siblings.set(a, set);
      }
    }
    // Co-usage: same actor, same day, above a small threshold.
    const byActorDay = new Map();
    for (const e of events) {
      const key = e.actor + "|" + e.timestamp.slice(0, 10);
      const set = byActorDay.get(key) || new Set();
      set.add(e.assetName);
      byActorDay.set(key, set);
    }
    const coUse = new Map();
    for (const set of byActorDay.values()) {
      const list = [...set].filter((n) => nameSet.has(n));
      for (const a of list) {
        for (const b of list) {
          if (a === b) continue;
          const m = coUse.get(a) || new Map();
          m.set(b, (m.get(b) || 0) + 1);
          coUse.set(a, m);
        }
      }
    }
    const usage = new Map();
    for (const e of events) {
      usage.set(e.assetName, (usage.get(e.assetName) || 0) + 1);
    }
    this.index = { builtAt: Date.now(), assets, out, inbound, siblings, coUse, usage };
    return this.index;
  }

  // ---- Relations tab ----

  async mountTab(view, assetName) {
    view.el.replaceChildren(el("div", FAINT + "font-size: 12px;", "Mapping relations…"));
    try {
      const idx = await this.build();
      view.el.replaceChildren();
      const sections = [
        ["References", (idx.out.get(assetName) || []).map((r) => ({
          name: r.to, detail: `${r.file}:${r.line} — ${r.context}`,
        }))],
        ["Referenced by", (idx.inbound.get(assetName) || []).map((r) => ({
          name: r.from, detail: `${r.file}:${r.line} — ${r.context}`,
        }))],
        ["Same collection", [...(idx.siblings.get(assetName) || new Map())].map(
          ([name, coll]) => ({ name, detail: "in " + coll }),
        )],
        ["Co-used", [...(idx.coUse.get(assetName) || new Map())]
          .filter(([, n]) => n >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([name, n]) => ({ name, detail: `together ${n}× in 30 days` }))],
      ];
      let any = false;
      for (const [title, rows] of sections) {
        if (rows.length === 0) continue;
        any = true;
        view.el.append(
          el(
            "div",
            "font-size: 12px; font-weight: 600; margin: 10px 0 4px;",
            `${title} (${rows.length})`,
          ),
        );
        for (const row of rows.slice(0, 12)) {
          const btn = el(
            "button",
            "display: block; width: 100%; text-align: left; background: none;" +
              "border: none; padding: 3px 0; font: inherit; cursor: pointer;",
          );
          btn.append(
            el("span", "font-size: 12px; color: var(--color-accent);", row.name),
            el("span", FAINT + "font-size: 11px; display: block;", row.detail),
          );
          btn.addEventListener("click", () => this.sx.ui.openAsset(row.name));
          view.el.append(btn);
        }
      }
      if (!any) {
        view.el.append(
          el(
            "div",
            FAINT + "font-size: 12px; padding: 8px 0;",
            "No relations found — nothing references this asset and it references nothing.",
          ),
        );
      }
    } catch (e) {
      view.el.replaceChildren(
        el("div", FAINT + "font-size: 12px;", "Couldn't map relations: " + e),
      );
    }
  }

  // ---- Structure-health widget ----

  async mountWidget(view) {
    view.el.replaceChildren(
      el("div", FAINT + "font-size: 12px; padding: 10px 12px;", "Analyzing structure…"),
    );
    try {
      const idx = await this.build();
      view.el.replaceChildren();
      const hubs = [...idx.inbound.entries()]
        .map(([name, refs]) => ({ name, n: refs.length }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 5);
      const orphans = idx.assets
        .filter(
          (a) =>
            (idx.inbound.get(a.name) || []).length === 0 &&
            (idx.usage.get(a.name) || 0) === 0,
        )
        .slice(0, 6);

      const section = (title) =>
        el(
          "div",
          FAINT + "font-size: 10px; padding: 8px 12px 2px; text-transform: uppercase; letter-spacing: 0.05em;",
          title,
        );
      const row = (name, detail) => {
        const btn = el(
          "button",
          "display: flex; width: calc(100% - 24px); margin: 0 12px; gap: 8px;" +
            "background: none; border: none; padding: 2px 0; font: inherit;" +
            "font-size: 12px; cursor: pointer; align-items: baseline;",
        );
        btn.append(
          el("span", "color: var(--color-accent); text-align: left;", name),
          el("span", FAINT + "font-size: 11px; margin-left: auto;", detail),
        );
        btn.addEventListener("click", () => this.sx.ui.openAsset(name));
        return btn;
      };

      if (hubs.length > 0 && hubs[0].n > 0) {
        view.el.append(section("load-bearing (most referenced)"));
        for (const h of hubs.filter((x) => x.n > 0)) {
          view.el.append(row(h.name, h.n + " refs in"));
        }
      }
      view.el.append(section(`orphans — unreferenced and unused (${orphans.length})`));
      if (orphans.length === 0) {
        view.el.append(
          el("div", FAINT + "font-size: 12px; padding: 2px 12px 10px;", "None — tidy library."),
        );
      } else {
        for (const o of orphans) view.el.append(row(o.name, "archive candidate"));
        view.el.append(el("div", "height: 10px;"));
      }
    } catch (e) {
      view.el.replaceChildren(
        el("div", FAINT + "font-size: 12px; padding: 10px 12px;", "Couldn't analyze: " + e),
      );
    }
  }

  // ---- Publish checks: broken references + edit impact ----

  async checkPublish(ctx) {
    const warnings = [];
    try {
      const idx = await this.build();
      const known = new Set(idx.assets.map((a) => a.name));
      for (const f of ctx.files) {
        if (!/\.(md|markdown)$/i.test(f.path)) continue;
        for (const m of f.content.matchAll(/`([a-z][a-z0-9-]{2,63})`/g)) {
          const name = m[1];
          if (known.has(name) || name === ctx.name || !name.includes("-")) continue;
          // Near-miss to a real asset ⇒ probably a typo'd reference.
          const close = [...known].find(
            (k) => k.includes(name) || name.includes(k),
          );
          if (close) {
            warnings.push({
              message: `References \`${name}\`, which doesn't exist`,
              detail: `Did you mean ${close}? (${f.path})`,
            });
          }
        }
      }
      const inbound = (idx.inbound.get(ctx.name) || []).length;
      if (inbound >= 3) {
        warnings.push({
          message: `${inbound} other assets reference ${ctx.name}`,
          detail: "Changing its behavior or name may break them — check the Relations tab.",
        });
      }
    } catch {
      // index unavailable — no warnings rather than a broken publish sheet
    }
    return warnings.slice(0, 5);
  }
}
