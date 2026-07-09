// Team Pulse — Obsidian's Contribution Graph + Tracker, made multi-person.
// Obsidian has no notion of "other people", so this is the one adaptation
// that only exists because sx has teams: a GitHub-style contribution row
// PER MEMBER, a leaderboard of who adopts the most, and the assets the
// team leans on. The library-wide Activity Heatmap answers "is the
// library alive?"; this answers "who's driving it, and on what?".

const WEEKS = 26; // half a year reads at a glance without dwarfing the rows
const DAY_MS = 86400_000;

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const SHADE_ALPHA = ["0.18", "0.4", "0.65", "1"];

// Bulk vault reads (teams, a half-year of usage events) are vault-wide,
// not team-specific — the same pull serves every team, filtered per
// member client-side. Cache them on the instance for a short window so
// re-opening the tab, or flipping between two teams' Pulse, doesn't
// re-hit the vault. Usage drifts slowly enough that sub-TTL staleness is
// invisible; past the TTL the next open refreshes. Failures aren't
// cached, so a blip doesn't stick.
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

// Persistent, incremental window load: fetch the window once and save it,
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
  // Persist only when incremental is available AND it fits the cap;
  // otherwise drop the entry so a later load can't merge onto a stale or
  // truncated base.
  const doc = { ...(saved || {}) };
  if (fetchSince && events.length <= MAX_PERSIST) doc[storeKey] = { events, newest };
  else delete doc[storeKey];
  void sx.storage.saveData(doc).catch(() => {});
  return events;
}


function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/** Quantile thresholds over nonzero day counts → 4 intensity steps, so
 *  a light user and a heavy user each get a full palette. */
function thresholds(counts) {
  const sorted = [...counts].sort((a, b) => a - b);
  if (sorted.length === 0) return [1, 2, 3];
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return [q(0.25), q(0.5), q(0.75)];
}

function shadeFor(count, th) {
  if (count <= 0) return "var(--color-line)";
  let step = 0;
  if (count > th[2]) step = 3;
  else if (count > th[1]) step = 2;
  else if (count > th[0]) step = 1;
  return `color-mix(in srgb, var(--color-accent) ${Number(SHADE_ALPHA[step]) * 100}%, transparent)`;
}

export default class TeamPulse {
  onload(sx) {
    this.sx = sx;
    this.cache = new Map();
    sx.registerTeamView({
      id: "pulse",
      title: "Team Pulse",
      mount: (view, ctx) => void this.mount(view, ctx.team),
    });
  }

  onunload() {}

  /** Memoize a bulk read on the instance for CACHE_TTL. Concurrent
   *  callers share one in-flight promise; a rejection is evicted so the
   *  next call retries instead of serving a cached failure. */
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

  /** Rolling window of usage events, persistently + incrementally cached
   *  (see incremental()). */
  loadUsage(days) {
    const since = this.sx.usage.eventsSince
      ? (iso) => this.sx.usage.eventsSince(iso)
      : null;
    return this.cached(`usage:${days}`, () =>
      incremental(this.sx, `usage:${days}`, days, (d) => this.sx.usage.events(d), since, USAGE_KEY),
    );
  }

  /** Rolling window of audit events, persistently + incrementally cached. */
  loadAudit(days) {
    const since = this.sx.usage.auditEventsSince
      ? (iso) => this.sx.usage.auditEventsSince(iso)
      : null;
    return this.cached(`audit:${days}`, () =>
      incremental(this.sx, `audit:${days}`, days, (d) => this.sx.usage.auditEvents(d), since, AUDIT_KEY),
    );
  }

  async mount(view, teamName) {
    const root = view.el;
    root.style.cssText = "max-width: 820px;";
    root.replaceChildren(
      el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Loading team activity…"),
    );
    let disposed = false;
    view.onDispose(() => {
      disposed = true;
    });
    try {
      const days = WEEKS * 7;
      const [teams, events] = await Promise.all([
        this.cached("teams", () => this.sx.teams.list()),
        // Incremental + persistent (loadUsage); degrade to an empty grid
        // if usage is unavailable rather than failing the whole view.
        this.loadUsage(days).catch(() => []),
      ]);
      if (disposed) return;
      const team = teams.find((t) => t.name === teamName);
      if (!team) {
        this.empty(root, "This team no longer exists.");
        return;
      }
      if (team.members.length === 0) {
        this.empty(root, "No members yet — add teammates and their activity appears here.");
        return;
      }
      this.render(root, team, events, days);
    } catch (e) {
      if (disposed) return;
      root.replaceChildren(
        el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Couldn't load team pulse: " + (e?.message || e)),
      );
    }
  }

  empty(root, message) {
    root.replaceChildren(el("div", FAINT + "font-size: 13px; padding: 16px 0;", message));
  }

  render(root, team, events, days) {
    root.replaceChildren();
    const members = team.members.map((m) => m.toLowerCase());
    const memberSet = new Set(members);

    // Per (member, day) counts, plus per-member totals and per-asset totals
    // — all from one pass over the team's members' events.
    const perMember = new Map(members.map((m) => [m, new Map()]));
    const totals = new Map(members.map((m) => [m, 0]));
    const perAsset = new Map();
    const now = Date.now();
    const start = now - (days - 1) * DAY_MS;
    for (const ev of events) {
      const actor = (ev.actor || "").toLowerCase();
      if (!memberSet.has(actor)) continue;
      const t = new Date(ev.timestamp).getTime();
      if (t < start) continue;
      const key = dayKey(new Date(ev.timestamp));
      const m = perMember.get(actor);
      m.set(key, (m.get(key) || 0) + 1);
      totals.set(actor, (totals.get(actor) || 0) + 1);
      perAsset.set(ev.assetName, (perAsset.get(ev.assetName) || 0) + 1);
    }

    const allCounts = [];
    for (const m of perMember.values()) allCounts.push(...m.values());
    const th = thresholds(allCounts);

    // The grid needs whole weeks ending today; align the first column to a
    // Sunday so weekday rows line up like GitHub's.
    const end = new Date(dayKey(new Date(now)));
    const startCol = new Date(end.getTime() - (WEEKS * 7 - 1) * DAY_MS);
    startCol.setDate(startCol.getDate() - startCol.getDay());

    root.append(
      el("div", "font-size: 13px; font-weight: 600; padding: 6px 0;", "Contributions"),
      el("div", FAINT + "font-size: 11px; padding: 0 0 8px;", `Usage events per member, last ${WEEKS} weeks`),
    );

    // One row per member, ranked by total so the most active read first.
    const ranked = [...members].sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0));
    for (const member of ranked) {
      const row = el("div", "display: flex; align-items: center; gap: 10px; padding: 3px 0;");
      row.append(el("div", "width: 150px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", member));
      const grid = el("div", `display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 8px); gap: 2px;`);
      const dayCounts = perMember.get(member);
      for (let w = 0; w < WEEKS; w++) {
        for (let d = 0; d < 7; d++) {
          const cell = new Date(startCol.getTime() + (w * 7 + d) * DAY_MS);
          if (cell.getTime() > now) {
            grid.append(el("div", "width: 8px; height: 8px;"));
            continue;
          }
          const c = dayCounts.get(dayKey(cell)) || 0;
          const sq = el("div", `width: 8px; height: 8px; border-radius: 2px; background: ${shadeFor(c, th)};`);
          sq.title = `${dayKey(cell)}: ${c} event${c === 1 ? "" : "s"}`;
          grid.append(sq);
        }
      }
      row.append(grid);
      row.append(el("div", FAINT + "font-size: 11px; min-width: 40px; text-align: right;", String(totals.get(member) || 0)));
      root.append(row);
    }

    // Leaderboard + top assets, side by side.
    const cols = el("div", "display: flex; gap: 24px; padding: 16px 0 4px; border-top: 1px solid var(--color-line); margin-top: 14px;");

    const board = el("div", "flex: 1;");
    board.append(el("div", "font-size: 13px; font-weight: 600; padding: 0 0 6px;", "Most active"));
    const active = ranked.filter((m) => (totals.get(m) || 0) > 0).slice(0, 5);
    if (active.length === 0) board.append(el("div", FAINT + "font-size: 12px;", "No activity yet."));
    for (const m of active) {
      const line = el("div", "display: flex; gap: 8px; padding: 2px 0; font-size: 12px;");
      line.append(el("span", "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", m), el("span", FAINT, String(totals.get(m))));
      board.append(line);
    }
    const idle = members.length - active.length;
    if (idle > 0) board.append(el("div", FAINT + "font-size: 11px; padding: 4px 0 0;", `${idle} member${idle === 1 ? "" : "s"} with no activity`));

    const top = el("div", "flex: 1;");
    top.append(el("div", "font-size: 13px; font-weight: 600; padding: 0 0 6px;", "Most-used assets"));
    const topAssets = [...perAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (topAssets.length === 0) top.append(el("div", FAINT + "font-size: 12px;", "No usage yet."));
    for (const [name, count] of topAssets) {
      const btn = el(
        "button",
        "display: flex; gap: 8px; width: 100%; text-align: left; padding: 2px 4px; font: inherit;" +
          "font-size: 12px; border: 0; border-radius: 6px; cursor: pointer; background: transparent; color: var(--color-ink);",
      );
      btn.append(el("span", "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", name), el("span", FAINT, String(count)));
      btn.addEventListener("mouseenter", () => (btn.style.background = "var(--color-accent-soft)"));
      btn.addEventListener("mouseleave", () => (btn.style.background = "transparent"));
      btn.addEventListener("click", () => this.sx.ui.openAsset(name));
      top.append(btn);
    }

    cols.append(board, top);
    root.append(cols);
  }
}
