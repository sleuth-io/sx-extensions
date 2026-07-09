// Repo Doctor — the Collection Doctor's score with Obsidian Janitor's
// gap-hunting folded in, pointed at one repository's scoped assets. A
// repo's scope set rots in ways a collection's doesn't: scopes left
// pointing at deleted assets ("broken links"), a repo carrying assets
// nobody working in it ever uses, plus the usual stale and thin ones.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

// Every read here is vault-wide (all assets, all repo scopes, the usage
// window) — none is repo-specific; the report filters to the repo
// client-side. Cache them on the instance for a short window so
// re-opening the tab or switching between repos doesn't re-hit the vault.
// Sub-TTL staleness is invisible for a health view; failures aren't
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


const DAY = 86400000;
const THIN_DESCRIPTION = 40;
const STALE_DAYS = 180;
const UNUSED_DAYS = 90;

const CHECKS = [
  {
    id: "broken",
    title: "Broken scopes",
    weight: 15,
    cap: 45,
    hint: "Scoped to this repo but the asset no longer exists — clear the dangling scope.",
  },
  {
    id: "unused",
    title: "Never used here",
    weight: 5,
    cap: 20,
    hint: `No usage events in ${UNUSED_DAYS} days — does this repo really need it scoped?`,
  },
  {
    id: "stale",
    title: "Stale assets",
    weight: 6,
    cap: 20,
    hint: `Not updated in over ${STALE_DAYS} days — still right for this repo?`,
  },
  {
    id: "description",
    title: "Missing or thin descriptions",
    weight: 6,
    cap: 18,
    hint: "Descriptions under 40 characters give agents and teammates nothing to route on.",
  },
];

function scoreColor(score) {
  if (score >= 85) return "#0e9f6e";
  if (score >= 60) return "#d97706";
  return "var(--color-danger)";
}

function scoreLabel(score) {
  if (score >= 85) return "Healthy";
  if (score >= 60) return "Needs attention";
  return "Unhealthy";
}

function repoLabel(url) {
  return url.replace(/^[a-z+]+:\/\//i, "").replace(/^git@/, "").replace(/\.git$/, "");
}

export default class RepoDoctor {
  onload(sx) {
    this.sx = sx;
    this.cache = new Map();
    sx.registerRepoView({
      id: "doctor",
      title: "Repo Health",
      mount: (view, ctx) => void this.mount(view, ctx.repo),
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

  buildReport(scopedNames, byName, use90) {
    const now = Date.now();
    const findings = { broken: [], unused: [], stale: [], description: [] };
    for (const name of scopedNames) {
      const asset = byName.get(name);
      if (!asset) {
        // Scoped here but not among live assets — a dangling scope row.
        findings.broken.push({ name, detail: "asset no longer exists", broken: true });
        continue;
      }
      if ((use90.get(name) || 0) === 0) {
        findings.unused.push({ name, detail: `no usage events in ${UNUSED_DAYS} days`, asset: true });
      }
      if (asset.updatedAt) {
        const age = (now - new Date(asset.updatedAt).getTime()) / DAY;
        if (age > STALE_DAYS) {
          findings.stale.push({ name, detail: `last updated ${Math.round(age)}d ago`, asset: true });
        }
      }
      const desc = (asset.description || "").trim();
      if (desc.length < THIN_DESCRIPTION) {
        findings.description.push({
          name,
          detail: desc ? `description is only ${desc.length} chars` : "no description",
          asset: true,
        });
      }
    }
    let score = 100;
    const sections = [];
    for (const check of CHECKS) {
      const rows = findings[check.id];
      const applied = Math.min(check.cap, check.weight * rows.length);
      score -= applied;
      for (const row of rows) row.impact = rows.length ? applied / rows.length : 0;
      sections.push({ check, rows, applied });
    }
    const fixFirst = sections
      .flatMap((s) => s.rows.map((r) => ({ ...r, title: s.check.title })))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 3);
    return { score: Math.max(0, Math.round(score)), sections, fixFirst };
  }

  async mount(view, repoUrl) {
    const root = view.el;
    root.style.cssText = "max-width: 760px;";
    root.replaceChildren(
      el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Checking repository health…"),
    );
    let disposed = false;
    view.onDispose(() => {
      disposed = true;
    });
    try {
      const [assets, repos, events] = await Promise.all([
        this.cached("assets", () => this.sx.assets.list()),
        this.cached("repos", () => this.sx.repos.list()),
        // Incremental + persistent; usage degrades to empty rather than
        // failing the view — the broken-scope and metadata checks still
        // render.
        this.loadUsage(UNUSED_DAYS).catch(() => []),
      ]);
      if (disposed) return;
      const repo = repos.find((r) => r.url === repoUrl);
      const scopedNames = repo ? repo.assets : [];
      if (scopedNames.length === 0) {
        this.empty(root, "Nothing is scoped to this repository yet — the health report appears once assets install here.");
        return;
      }
      const byName = new Map(assets.map((a) => [a.name, a]));
      const use90 = new Map();
      for (const ev of events) use90.set(ev.assetName, (use90.get(ev.assetName) || 0) + 1);
      this.render(root, this.buildReport(scopedNames, byName, use90), repoUrl, scopedNames.length);
    } catch (e) {
      if (disposed) return;
      root.replaceChildren(
        el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Couldn't compute repo health: " + (e?.message || e)),
      );
    }
  }

  empty(root, message) {
    root.replaceChildren(el("div", FAINT + "font-size: 13px; padding: 16px 0;", message));
  }

  render(root, report, repoUrl, count) {
    root.replaceChildren();
    const head = el("div", "display: flex; align-items: baseline; gap: 14px; padding: 10px 0 14px;");
    head.append(
      el("div", `font-size: 40px; font-weight: 700; color: ${scoreColor(report.score)};`, String(report.score)),
      el("div", "font-size: 15px; font-weight: 600;", scoreLabel(report.score)),
      el("div", FAINT + "font-size: 12px;", `${count} scoped asset${count === 1 ? "" : "s"} · ${repoLabel(repoUrl)}`),
    );
    root.append(head);

    if (report.fixFirst.length > 0 && report.score < 100) {
      const strip = el("div", "display: flex; flex-direction: column; gap: 4px; padding: 0 0 12px;");
      strip.append(el("div", FAINT + "font-size: 11px; font-weight: 600;", "FIX FIRST"));
      for (const f of report.fixFirst) strip.append(el("div", "font-size: 12px;", `${f.name} — ${f.detail}`));
      root.append(strip);
    }

    for (const { check, rows, applied } of report.sections) {
      const section = el("div", "padding: 10px 0; border-top: 1px solid var(--color-line);");
      const title = el("div", "display: flex; align-items: baseline; gap: 8px;");
      title.append(
        el("div", "font-size: 13px; font-weight: 600;", check.title),
        el("div", FAINT + "font-size: 11px;", rows.length === 0 ? "all clear" : `${rows.length} · −${applied} pts`),
      );
      section.append(title, el("div", FAINT + "font-size: 11px; padding: 2px 0 6px;", check.hint));
      for (const row of rows.slice(0, 12)) {
        if (row.asset) {
          const btn = el(
            "button",
            "display: flex; gap: 8px; width: 100%; text-align: left; padding: 4px 6px; font: inherit;" +
              "font-size: 12px; border: 0; border-radius: 6px; cursor: pointer; background: transparent; color: var(--color-ink);",
          );
          btn.append(el("span", "font-weight: 500;", row.name), el("span", FAINT, row.detail));
          btn.addEventListener("mouseenter", () => (btn.style.background = "var(--color-accent-soft)"));
          btn.addEventListener("mouseleave", () => (btn.style.background = "transparent"));
          btn.addEventListener("click", () => this.sx.ui.openAsset(row.name));
          section.append(btn);
        } else {
          const line = el("div", "display: flex; gap: 8px; padding: 4px 6px; font-size: 12px;");
          line.append(
            el("span", "font-weight: 500;", row.name),
            el("span", FAINT, row.detail),
          );
          section.append(line);
        }
      }
      if (rows.length > 12) section.append(el("div", FAINT + "font-size: 11px; padding: 2px 6px;", `+${rows.length - 12} more`));
      root.append(section);
    }
  }
}
