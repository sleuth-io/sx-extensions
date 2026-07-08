// Metric Charts — an sx analogue of Obsidian's Tracker (the
// query→aggregate→render pipeline) and Charts (the render vocabulary).
// The shipped widgets answer fixed questions; this lets a lead ask THEIR
// question and pin it. DSL example:
//
//   source: usage          # usage | audit
//   event: install         # audit only: filter by event substring
//   asset: deploy          # substring filter on asset/target
//   days: 60
//   groupBy: week          # day | week | month
//   split: team            # team | user | asset | none
//   render: bar            # line | bar | summary
//   title: Installs by team

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const COLORS = ["#4f46e5", "#0e9f6e", "#d97706", "#db2777", "#0891b2", "#7c3aed"];
const DAY_MS = 86400_000;

function parseSpec(text) {
  const spec = { source: "usage", days: 30, groupBy: "week", split: "none", render: "line", title: "" };
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.+?)\s*$/);
    if (m) spec[m[1]] = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : m[2];
  }
  spec.days = Math.min(365, Math.max(1, spec.days | 0 || 30));
  if (!["day", "week", "month"].includes(spec.groupBy)) spec.groupBy = "week";
  if (!["line", "bar", "summary"].includes(spec.render)) spec.render = "line";
  return spec;
}

function bucketKey(iso, groupBy) {
  if (groupBy === "day") return iso.slice(0, 10);
  if (groupBy === "month") return iso.slice(0, 7);
  // Day/month buckets slice the ISO string (UTC), so weeks must be
  // computed in UTC too or labels drift across the timezone boundary.
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

// Identical windows are memoized for this long — several pinned charts
// (or a re-run of the same spec) share one fetch instead of pulling the
// same events over the bridge again.
const FETCH_TTL_MS = 60_000;

export default class MetricCharts {
  onload(sx) {
    this.sx = sx;
    this.eventCache = new Map(); // "source:days" -> {at, promise}
    this.teamCache = null; // {at, promise}
    sx.registerSidebarPanel({
      id: "metrics",
      title: "Metrics",
      mount: (view) => void this.mountPanel(view),
    });
    sx.registerDashboardWidget({
      id: "pinned-metrics",
      title: "Pinned metrics",
      mount: (view) => void this.mountWidget(view),
    });
  }

  onunload() {}

  /** Events for a source+window, memoized (in-flight promise shared) so
   * pinned charts with identical windows don't each round-trip. Failures
   * are evicted, never cached. */
  fetchEvents(source, days) {
    const key = source + ":" + days;
    const hit = this.eventCache.get(key);
    if (hit && Date.now() - hit.at < FETCH_TTL_MS) return hit.promise;
    const promise =
      source === "audit"
        ? this.sx.usage.auditEvents(days)
        : this.sx.usage.events(days);
    this.eventCache.set(key, { at: Date.now(), promise });
    promise.catch(() => this.eventCache.delete(key));
    return promise;
  }

  async run(spec, teamsByMember) {
    const events = await this.fetchEvents(spec.source, spec.days);
    const series = new Map(); // splitKey -> Map(bucket -> count)
    let total = 0;
    for (const e of events) {
      const asset = spec.source === "audit" ? e.target : e.assetName;
      if (spec.asset && !String(asset).includes(spec.asset)) continue;
      if (spec.event && spec.source === "audit" && !e.event.includes(spec.event)) continue;
      let key = "all";
      if (spec.split === "user") key = e.actor.split("@")[0];
      else if (spec.split === "asset") key = asset;
      else if (spec.split === "team") key = teamsByMember.get(e.actor) || "(no team)";
      const buckets = series.get(key) || new Map();
      const b = bucketKey(e.timestamp, spec.groupBy);
      buckets.set(b, (buckets.get(b) || 0) + 1);
      series.set(key, buckets);
      total++;
    }
    // Top 5 series by volume; stable x-axis across the window.
    const top = [...series.entries()]
      .map(([k, m]) => ({ k, m, sum: [...m.values()].reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.sum - a.sum)
      .slice(0, 5);
    const allBuckets = new Set();
    const now = Date.now();
    for (let t = now - spec.days * DAY_MS; t <= now; t += DAY_MS) {
      allBuckets.add(bucketKey(new Date(t).toISOString(), spec.groupBy));
    }
    const xs = [...allBuckets].sort();
    return { xs, top, total };
  }

  render(root, spec, data) {
    root.replaceChildren();
    root.append(
      el("div", "font-size: 12px; font-weight: 600; padding: 2px 0;", spec.title || `${spec.source} by ${spec.groupBy}`),
    );
    if (data.total === 0) {
      root.append(el("div", FAINT + "font-size: 11px;", "No matching events."));
      return;
    }
    if (spec.render === "summary") {
      root.append(
        el("div", "font-size: 20px; font-weight: 600;", data.total.toLocaleString()),
        el("div", FAINT + "font-size: 11px;", `events in ${spec.days} days · top: ${data.top[0]?.k ?? "—"}`),
      );
      return;
    }
    const W = 340, H = 120, P = 6;
    const max = Math.max(1, ...data.top.flatMap((s) => data.xs.map((x) => s.m.get(x) || 0)));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.cssText = "width: 100%; height: auto;";
    const xw = (W - 2 * P) / Math.max(1, data.xs.length - (spec.render === "line" ? 1 : 0));
    data.top.forEach((s, si) => {
      const color = COLORS[si % COLORS.length];
      if (spec.render === "line") {
        const pts = data.xs.map((x, i) => {
          const v = s.m.get(x) || 0;
          return `${P + i * xw},${H - P - (v / max) * (H - 2 * P)}`;
        });
        const path = document.createElementNS(svg.namespaceURI, "polyline");
        path.setAttribute("points", pts.join(" "));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", color);
        path.setAttribute("stroke-width", "1.5");
        svg.append(path);
      } else {
        data.xs.forEach((x, i) => {
          const v = s.m.get(x) || 0;
          if (!v) return;
          const bw = Math.max(2, xw / data.top.length - 1);
          const rect = document.createElementNS(svg.namespaceURI, "rect");
          rect.setAttribute("x", String(P + i * xw + si * bw));
          rect.setAttribute("y", String(H - P - (v / max) * (H - 2 * P)));
          rect.setAttribute("width", String(bw));
          rect.setAttribute("height", String((v / max) * (H - 2 * P)));
          rect.setAttribute("fill", color);
          const t = document.createElementNS(svg.namespaceURI, "title");
          t.textContent = `${s.k} · ${x}: ${v}`;
          rect.append(t);
          svg.append(rect);
        });
      }
    });
    root.append(svg);
    const legend = el("div", "display: flex; gap: 10px; flex-wrap: wrap;");
    data.top.forEach((s, si) => {
      const item = el("span", FAINT + "font-size: 10px;");
      item.prepend(
        el("span", `display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 3px; background: ${COLORS[si % COLORS.length]};`),
      );
      item.append(document.createTextNode(`${s.k} (${s.sum})`));
      legend.append(item);
    });
    root.append(legend);
  }

  teamMap() {
    // Same memo shape as fetchEvents: membership barely changes, and the
    // panel refetched it on every Run while the widget fetched it again.
    if (this.teamCache && Date.now() - this.teamCache.at < FETCH_TTL_MS) {
      return this.teamCache.promise;
    }
    const promise = (async () => {
      const map = new Map();
      try {
        for (const t of await this.sx.teams.list()) {
          for (const m of t.members) if (!map.has(m)) map.set(m, t.name);
        }
      } catch {
        // backend without teams — split: team degrades to "(no team)"
      }
      return map;
    })();
    this.teamCache = { at: Date.now(), promise };
    return promise;
  }

  async mountPanel(view) {
    const saved = (await this.sx.storage.loadData().catch(() => null)) || {};
    const editor = el(
      "textarea",
      "width: 100%; box-sizing: border-box; min-height: 96px; padding: 6px 8px;" +
        "font-family: var(--font-mono); font-size: 10px; line-height: 1.5;" +
        "border: 1px solid var(--color-line); border-radius: 8px;" +
        "background: var(--color-canvas); color: var(--color-ink);" +
        "outline: none; resize: vertical;",
    );
    editor.value = saved.draft || "source: usage\ndays: 60\ngroupBy: week\nsplit: user\nrender: bar\ntitle: Uses by person";
    editor.spellcheck = false;
    const out = el("div", "margin-top: 6px;");
    const row = el("div", "display: flex; gap: 6px; margin-top: 6px;");
    const runBtn = el("button", "flex: 1; border: 1px solid var(--color-line); border-radius: 8px; background: none; padding: 4px 0; font: inherit; font-size: 11px; cursor: pointer; color: var(--color-ink-soft);", "Run");
    const pinBtn = el("button", "flex: 1; border: 1px solid var(--color-line); border-radius: 8px; background: none; padding: 4px 0; font: inherit; font-size: 11px; cursor: pointer; color: var(--color-ink-soft);", "Pin to dashboard");
    row.append(runBtn, pinBtn);
    view.el.append(editor, row, out);
    const run = async () => {
      out.replaceChildren(el("div", FAINT + "font-size: 11px;", "Running…"));
      try {
        const spec = parseSpec(editor.value);
        const data = await this.run(spec, await this.teamMap());
        this.render(out, spec, data);
        // Reload before saving — the widget may have written pins since
        // this panel captured its copy.
        const fresh = (await this.sx.storage.loadData().catch(() => null)) || {};
        fresh.draft = editor.value;
        void this.sx.storage.saveData(fresh);
      } catch (e) {
        out.replaceChildren(el("div", FAINT + "font-size: 11px;", "Failed: " + e));
      }
    };
    runBtn.addEventListener("click", () => void run());
    pinBtn.addEventListener("click", async () => {
      const fresh = (await this.sx.storage.loadData().catch(() => null)) || {};
      fresh.pinned = [...(fresh.pinned || []), editor.value].slice(-4);
      await this.sx.storage.saveData(fresh);
      this.sx.ui.notice("Pinned — see the Pinned metrics dashboard widget.");
    });
  }

  async mountWidget(view) {
    const saved = (await this.sx.storage.loadData().catch(() => null)) || {};
    const pinned = saved.pinned || [];
    view.el.replaceChildren();
    if (pinned.length === 0) {
      view.el.append(
        el("div", FAINT + "font-size: 12px; padding: 10px 12px;", "No pinned metrics — author one in the Metrics tool (sidebar → Tools) and pin it."),
      );
      return;
    }
    const teamsByMember = await this.teamMap();
    for (const [i, text] of pinned.entries()) {
      const box = el("div", "padding: 8px 12px;" + (i > 0 ? "border-top: 1px solid var(--color-line);" : ""));
      const spec = parseSpec(text);
      try {
        this.render(box, spec, await this.run(spec, teamsByMember));
      } catch (e) {
        box.append(el("div", FAINT + "font-size: 11px;", "Failed: " + e));
      }
      const unpin = el("button", FAINT + "background: none; border: none; font-size: 10px; cursor: pointer; padding: 2px 0;", "unpin");
      unpin.addEventListener("click", async () => {
        // Reload and match by content — our captured index may be stale
        // if the panel pinned or another unpin ran since we mounted.
        const fresh = (await this.sx.storage.loadData().catch(() => null)) || {};
        const idx = (fresh.pinned || []).indexOf(text);
        if (idx !== -1) {
          fresh.pinned = fresh.pinned.filter((_, j) => j !== idx);
          await this.sx.storage.saveData(fresh);
        }
        void this.mountWidget(view);
      });
      box.append(unpin);
      view.el.append(box);
    }
  }
}
