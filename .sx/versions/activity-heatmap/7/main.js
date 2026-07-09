// Activity Heatmap — an sx analogue of Obsidian's Heatmap Calendar /
// Contribution Graph. The originals make users assemble {date,intensity}
// entries by hand in dataviewjs; sx already streams usage and audit
// events, so the same GitHub-style grid renders "is our library alive?"
// with zero setup. Weeks are columns, weekdays rows, today outlined;
// intensity buckets are quantiles over nonzero days (one team's 3/day
// and another's 300/day both get a full palette).

const WEEKS = 52;
const DAY_MS = 86400_000;

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/** Quantile thresholds over the nonzero day counts → 4 intensity steps. */
function thresholds(counts) {
  const sorted = [...counts].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return [q(0.25), q(0.5), q(0.75)];
}

const SHADE_ALPHA = ["0.18", "0.4", "0.65", "1"];

const CACHE_TTL = 60_000;
const MAX_PERSIST = 30000; // event rows — well under the 10 MB local cap, even with two windows cached

function mergeDedup(existing, incoming, keyOf) {
  const seen = new Set(existing.map(keyOf));
  const out = existing.slice();
  for (const e of incoming) {
    const k = keyOf(e);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}
const USAGE_KEY = (e) => `${e.timestamp}|${e.actor}|${e.assetName}|${e.assetVersion}`;
const AUDIT_KEY = (e) => `${e.timestamp}|${e.event}|${e.target}|${e.actor}`;

// Persistent, incremental window load: fetch the year once and save it,
// then on later loads pull only events newer than the newest cached one
// and merge — a reload, even across restarts, transfers almost nothing.
// The server's `since` filter is `>=`, so the boundary event repeats;
// mergeDedup drops it. Falls back to a plain windowed fetch when the app
// predates usage.eventsSince (fetchSince == null).
async function incremental(sx, storeKey, days, fetchWindow, fetchSince, keyOf) {
  const cutoffMs = Date.now() - days * 86400000;
  const saved = await sx.storage.loadData().catch(() => null);
  const prior = saved && saved[storeKey];
  let events;
  if (prior && prior.newest && fetchSince) {
    const delta = await fetchSince(prior.newest).catch(() => null);
    events = delta
      ? mergeDedup(prior.events || [], delta, keyOf)
      : await fetchWindow(days);
  } else {
    events = await fetchWindow(days);
  }
  events = events.filter((e) => new Date(e.timestamp).getTime() >= cutoffMs);
  const newest = events.reduce((m, e) => (e.timestamp > m ? e.timestamp : m), "");
  const doc = { ...(saved || {}) };
  if (fetchSince && events.length <= MAX_PERSIST) doc[storeKey] = { events, newest };
  else delete doc[storeKey];
  void sx.storage.saveData(doc).catch(() => {});
  return events;
}

export default class ActivityHeatmap {
  onload(sx) {
    this.sx = sx;
    this.loadGen = 0; // a stale load must never paint over a newer one
    this.cache = new Map();
    sx.registerDashboardWidget({
      id: "activity-heatmap",
      title: "Activity heatmap · last year",
      mount: (view) => void this.mount(view),
    });
  }

  onunload() {}

  /** Memoize a bulk read on the instance for CACHE_TTL; a rejection is
   *  evicted so the next call retries. */
  cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.promise;
    const promise = Promise.resolve()
      .then(fn)
      .catch((e) => {
        if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
        throw e;
      });
    this.cache.set(key, { at: Date.now(), promise });
    return promise;
  }

  loadUsage(days) {
    const since = this.sx.usage.eventsSince
      ? (iso) => this.sx.usage.eventsSince(iso)
      : null;
    return this.cached(`usage:${days}`, () =>
      incremental(this.sx, `usage:${days}`, days, (d) => this.sx.usage.events(d), since, USAGE_KEY),
    );
  }

  loadAudit(days) {
    const since = this.sx.usage.auditEventsSince
      ? (iso) => this.sx.usage.auditEventsSince(iso)
      : null;
    return this.cached(`audit:${days}`, () =>
      incremental(this.sx, `audit:${days}`, days, (d) => this.sx.usage.auditEvents(d), since, AUDIT_KEY),
    );
  }

  async mount(view) {
    const saved = (await this.sx.storage.loadData().catch(() => null)) || {};
    this.metric = saved.metric === "edits" ? "edits" : "usage";
    // Per-mount cache: usage and edits come from different endpoints, so
    // the first toggle to each metric fetches — but toggling BACK to a
    // metric already loaded this mount reuses it instead of pulling a
    // year of events over the bridge again.
    this.dayCache = {};
    view.el.replaceChildren(
      el("div", FAINT + "font-size: 12px; padding: 10px 12px;", "Loading a year of activity…"),
    );
    await this.load(view.el);
  }

  /** Fetches and renders the metric current at call time. Failures
   *  render in place; a stale load never paints over a newer one. */
  async load(root) {
    const metric = this.metric; // this.metric can change while we await
    const gen = ++this.loadGen;
    const cached = this.dayCache[metric];
    if (cached) {
      this.render(root, cached, metric);
      return;
    }
    try {
      // Fetch the grid's full span: WEEKS*7 days plus up to 6 extra so
      // the Sunday-aligned first column isn't falsely empty.
      const events =
        metric === "edits"
          ? await this.loadAudit(WEEKS * 7 + 6)
          : await this.loadUsage(WEEKS * 7 + 6);
      if (gen !== this.loadGen) return;
      // date -> {count, byAsset: Map, byTarget: Map}
      const days = new Map();
      for (const e of events) {
        const key = e.timestamp.slice(0, 10);
        const entry = days.get(key) || { count: 0, items: new Map() };
        entry.count++;
        const label = metric === "edits" ? e.event + " " + e.target : e.assetName;
        entry.items.set(label, (entry.items.get(label) || 0) + 1);
        days.set(key, entry);
      }
      this.dayCache[metric] = days; // successes only — failures retry
      this.render(root, days, metric);
    } catch (e) {
      if (gen !== this.loadGen) return;
      root.replaceChildren(
        el("div", FAINT + "font-size: 12px; padding: 10px 12px;", "Couldn't load activity: " + e),
      );
    }
  }

  render(root, days, metric) {
    root.replaceChildren();

    // Header: metric toggle + totals + streaks.
    const total = [...days.values()].reduce((sum, d) => sum + d.count, 0);
    let streak = 0;
    let longest = 0;
    let run = 0;
    for (let i = 364; i >= 0; i--) {
      const key = dayKey(new Date(Date.now() - i * DAY_MS));
      if (days.has(key)) {
        run++;
        longest = Math.max(longest, run);
      } else {
        run = 0;
      }
    }
    // Current streak counts back from today (or yesterday, to be kind).
    for (let i = 0; i < 365; i++) {
      const key = dayKey(new Date(Date.now() - i * DAY_MS));
      if (days.has(key)) streak++;
      else if (i > 0) break;
    }

    const header = el(
      "div",
      "display: flex; align-items: baseline; gap: 10px; padding: 10px 12px 4px;",
    );
    header.append(
      el("span", "font-size: 18px; font-weight: 600;", total.toLocaleString()),
      el(
        "span",
        FAINT + "font-size: 11px;",
        (metric === "edits" ? "library changes" : "asset uses") +
          " this year · streak " + streak + "d · longest " + longest + "d",
      ),
    );
    // A text link, not a button — it shares the stats row's baseline
    // and must not inflate its height.
    const toggle = el(
      "a",
      "margin-left: auto; font-size: 11px; color: var(--color-accent);" +
        "cursor: pointer; white-space: nowrap;",
      metric === "edits" ? "show usage" : "show edits",
    );
    toggle.addEventListener("click", () => {
      this.metric = metric === "edits" ? "usage" : "edits";
      // Merge, don't overwrite — the storage doc also holds the
      // incremental event cache written by incremental().
      void this.sx.storage
        .loadData()
        .then((cur) => this.sx.storage.saveData({ ...(cur || {}), metric: this.metric }))
        .catch(() => {});
      root.replaceChildren(
        el("div", FAINT + "font-size: 12px; padding: 10px 12px;", "Loading…"),
      );
      void this.load(root); // load catches its own failures, like mount
    });
    header.append(toggle);
    root.append(header);

    // The grid: WEEKS columns × 7 rows, today in the last column.
    const nonzero = [...days.values()].map((d) => d.count);
    const [t1, t2, t3] = nonzero.length ? thresholds(nonzero) : [1, 2, 3];
    const scroller = el("div", "overflow-x: auto; padding: 2px 12px 4px;");
    const grid = el(
      "div",
      "display: grid; grid-auto-flow: column; gap: 2px;" +
        `grid-template-rows: repeat(7, 8px); width: max-content;`,
    );
    // UTC throughout: days are bucketed by timestamp.slice(0, 10) (a
    // UTC date), so weekday alignment must use UTC too or the two
    // conventions disagree near midnight.
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const start = new Date(today.getTime() - (WEEKS * 7 - 1) * DAY_MS);
    // Align the first column to start on a Sunday.
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const detail = el("div", "padding: 0 12px 10px;");
    for (let d = new Date(start); d <= today; d = new Date(d.getTime() + DAY_MS)) {
      const key = dayKey(d);
      const entry = days.get(key);
      const cell = el(
        "div",
        "width: 8px; height: 8px; border-radius: 2px; cursor: pointer;" +
          (entry
            ? `background: color-mix(in srgb, var(--color-accent) ${
                Math.round(
                  Number(
                    SHADE_ALPHA[
                      entry.count > t3 ? 3 : entry.count > t2 ? 2 : entry.count > t1 ? 1 : 0
                    ],
                  ) * 100,
                )
              }%, var(--color-canvas));`
            : "background: var(--color-line); opacity: 0.55;") +
          (key === dayKey(today) ? "outline: 1px solid var(--color-accent);" : ""),
      );
      cell.title = key + " — " + (entry ? entry.count : 0) + (metric === "edits" ? " changes" : " uses");
      if (entry) {
        cell.addEventListener("click", () => this.showDay(detail, key, entry, metric));
      }
      grid.append(cell);
    }
    scroller.append(grid);
    root.append(scroller, detail);
    // Most recent activity is on the right.
    scroller.scrollLeft = scroller.scrollWidth;
  }

  showDay(detail, key, entry, metric) {
    detail.replaceChildren();
    detail.append(
      el(
        "div",
        "font-size: 11px; font-weight: 600; padding: 4px 0 2px;",
        key + " — " + entry.count + (metric === "edits" ? " changes" : " uses"),
      ),
    );
    const items = [...entry.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [label, count] of items) {
      detail.append(
        el("div", FAINT + "font-size: 11px;", label + (count > 1 ? " ×" + count : "")),
      );
    }
  }
}
