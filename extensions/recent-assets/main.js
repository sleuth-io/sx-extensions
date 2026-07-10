// Recent Assets — an sx analogue of Obsidian's Recent Files. The
// original hooks file-open events into a move-to-front LRU list; sx
// already records every asset touch as a usage event, so the list works
// retroactively and team-wide with no event hooking at all. Pinned rows
// (per-plugin storage) stay glued to the top — the inverse of the
// original's bookmark exclusion, and more useful in a team library.

const MAX_ROWS = 5;

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.round(hours / 24);
  if (days < 30) return days + "d ago";
  return Math.round(days / 30) + "mo ago";
}

export default class RecentAssets {
  onload(sx) {
    this.sx = sx;
    this.pins = new Set();
    this.mountGen = 0; // newest mount wins; stale mounts stand down
    sx.registerSidebarPanel({
      id: "recent",
      title: "Recent",
      mount: (view) => void this.mount(view),
    });
  }

  onunload() {}

  async mount(view) {
    // A discarded StrictMode first mount must not reset this.pins (or
    // repaint) after the surviving mount finishes.
    const gen = ++this.mountGen;
    view.el.replaceChildren(
      el("div", FAINT + "font-size: 11px; padding: 2px 8px;", "Loading…"),
    );
    try {
      const [saved, events, assets] = await Promise.all([
        this.sx.storage.loadData(),
        this.sx.usage.events(30),
        this.sx.assets.list(),
      ]);
      if (gen !== this.mountGen) return;
      this.pins = new Set((saved && saved.pins) || []);
      const known = new Map(assets.map((a) => [a.name, a]));

      // Latest event per asset, plus a 7-day touch count for the badge.
      const latest = new Map();
      const weekCount = new Map();
      const weekAgo = Date.now() - 7 * 86400_000;
      for (const e of events) {
        if (!known.has(e.assetName)) continue; // deleted assets drop out
        const prev = latest.get(e.assetName);
        if (!prev || e.timestamp > prev.timestamp) latest.set(e.assetName, e);
        if (new Date(e.timestamp).getTime() >= weekAgo) {
          weekCount.set(e.assetName, (weekCount.get(e.assetName) || 0) + 1);
        }
      }
      const rows = [...latest.values()]
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, MAX_ROWS)
        .map((e) => ({
          name: e.assetName,
          type: known.get(e.assetName).type,
          when: e.timestamp,
          actor: e.actor,
          week: weekCount.get(e.assetName) || 0,
        }));
      // Pinned rows first (kept even with no recent events).
      for (const pin of this.pins) {
        if (known.has(pin) && !rows.some((r) => r.name === pin)) {
          rows.push({ name: pin, type: known.get(pin).type, when: "", actor: "", week: 0 });
        }
      }
      this.render(view.el, rows);
    } catch (e) {
      if (gen !== this.mountGen) return;
      view.el.replaceChildren(
        el(
          "div",
          FAINT + "font-size: 11px; padding: 2px 8px; line-height: 1.5;",
          "Couldn't load recent activity: " + e,
        ),
      );
    }
  }

  render(root, rows) {
    // Sorted here (not in mount) so a pin toggle re-sorts on re-render.
    rows.sort((a, b) => {
      const pa = this.pins.has(a.name) ? 0 : 1;
      const pb = this.pins.has(b.name) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return a.when < b.when ? 1 : -1;
    });
    root.replaceChildren();
    if (rows.length === 0) {
      // Match the sidebar's section-label indentation so the empty
      // state doesn't float loose in the nav.
      root.append(
        el(
          "div",
          FAINT + "font-size: 11px; padding: 2px 8px; line-height: 1.5;",
          "No activity in the last 30 days.",
        ),
      );
      return;
    }
    for (const row of rows) {
      const pinned = this.pins.has(row.name);
      // One quiet line per asset, in the sidebar's own row grammar
      // (13px rows are core navigation; these are 12px and ink-soft so
      // the panel reads as subordinate content, not more nav). The
      // actor and week count live in the tooltip, not the row.
      const item = el(
        "div",
        "display: flex; align-items: center; gap: 6px; padding: 3px 8px;" +
          "border-radius: 6px; cursor: pointer;",
      );
      const details = [];
      if (row.when) details.push(relativeTime(row.when));
      if (row.actor) details.push(row.actor.split("@")[0]);
      if (row.week > 1) details.push(row.week + " uses this week");
      item.title = row.name + (details.length ? " — " + details.join(" · ") : "");
      item.addEventListener("mouseenter", () => {
        item.style.background = "var(--color-canvas)";
        name.style.color = "var(--color-ink)";
        pin.style.visibility = "visible";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "transparent";
        name.style.color = "var(--color-ink-soft)";
        pin.style.visibility = pinned ? "visible" : "hidden";
      });
      item.addEventListener("click", () => this.sx.ui.openAsset(row.name));

      const name = el(
        "span",
        "font-size: 12px; color: var(--color-ink-soft); min-width: 0; flex: 1;" +
          "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
        row.name,
      );
      const meta = el(
        "span",
        FAINT + "font-size: 10px; white-space: nowrap;",
        row.when ? relativeTime(row.when) : "",
      );
      item.append(name, meta);

      const pin = el(
        "button",
        "background: none; border: none; cursor: pointer; padding: 0 2px;" +
          "font-size: 11px; color: " +
          (pinned ? "var(--color-accent)" : "var(--color-ink-faint)") +
          "; visibility: " + (pinned ? "visible" : "hidden") + ";",
        "⌖",
      );
      pin.title = pinned ? "Unpin" : "Pin to top";
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        // Reload pins right before mutating so we never clobber pins
        // saved by another mount with state captured at render time.
        void this.sx.storage
          .loadData()
          .then((saved) => {
            this.pins = new Set((saved && saved.pins) || []);
            if (pinned) this.pins.delete(row.name);
            else this.pins.add(row.name);
            return this.sx.storage.saveData({ pins: [...this.pins] });
          })
          .then(() => this.render(root, rows))
          .catch((err) => this.sx.ui.notice("Couldn't save pin: " + err));
      });
      item.append(pin);
      root.append(item);
    }
  }
}
