// Collection Doctor — Obsidian's Zoottelkeeper and folder-health plugins,
// translated to what a shared collection actually rots from: thin
// descriptions nobody can trigger on, assets that haven't been touched in
// two quarters, members nobody has used in 90 days, and skills so large
// they blow the context they're meant to save. One score, findings you
// can click straight into.
//
// An ownership check would belong here too, but AssetSummary carries no
// owner field in this API version — skipped rather than guessed.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

const DAY = 86400000;
const THIN_DESCRIPTION = 40; // chars — below this, agents can't route to it
const STALE_DAYS = 180;
const UNUSED_DAYS = 90; // matches the single events(90) call
const HUGE_WORDS = 8000;

/** Run fn over items with at most n in flight — a member scan shouldn't
 *  be a serial chain of round-trips. */
async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// Score = 100 minus weighted deductions. Each check's total is capped so
// one systemic problem (say, a legacy import with no descriptions) reads
// as "fix this class of thing", not an automatic zero.
const CHECKS = [
  {
    id: "description",
    title: "Missing or thin descriptions",
    weight: 8,
    cap: 30,
    hint: "Descriptions under 40 characters give agents and teammates nothing to route on.",
  },
  {
    id: "stale",
    title: "Stale assets",
    weight: 6,
    cap: 24,
    hint: `Not updated in over ${STALE_DAYS} days — still accurate?`,
  },
  {
    id: "unused",
    title: "Unused assets",
    weight: 5,
    cap: 20,
    hint: `No usage events in ${UNUSED_DAYS} days — candidates to promote, merge, or retire.`,
  },
  {
    id: "huge",
    title: "Very large assets",
    weight: 10,
    cap: 20,
    hint: `Over ${HUGE_WORDS.toLocaleString()} words — consider splitting before it eats an agent's context.`,
  },
];

function scoreColor(score) {
  // The token set has no success/warning colors, so the green and amber
  // reuse metric-charts' palette values; red stays the danger token.
  if (score >= 85) return "#0e9f6e";
  if (score >= 60) return "#d97706";
  return "var(--color-danger)";
}

function scoreLabel(score) {
  if (score >= 85) return "Healthy";
  if (score >= 60) return "Needs attention";
  return "Unhealthy";
}

export default class CollectionDoctor {
  onload(sx) {
    this.sx = sx;
    sx.registerCollectionView({
      id: "doctor",
      title: "Collection Health",
      mount: (view, ctx) => void this.mount(view, ctx.collection),
    });
  }

  onunload() {}

  /** Word counts for the member assets, via a persistent per-asset cache
   *  keyed by updatedAt — an unchanged asset is never re-read across
   *  restarts, and entries for other collections' members survive. */
  async wordCounts(members, allAssets) {
    const saved = await this.sx.storage.loadData().catch(() => null);
    const scanCache = { ...((saved && saved.scanCache) || {}) };
    let dirty = false;
    // Assets that vanished from the vault take their cache entries along.
    const live = new Set(allAssets.map((a) => a.name));
    for (const name of Object.keys(scanCache)) {
      if (!live.has(name)) {
        delete scanCache[name];
        dirty = true;
      }
    }
    const counts = new Map();
    const stale = [];
    for (const m of members) {
      const stamp = m.updatedAt || m.name;
      const hit = scanCache[m.name];
      if (hit && hit.stamp === stamp) counts.set(m.name, hit.data);
      else stale.push({ m, stamp });
    }
    await pool(stale, 8, async ({ m, stamp }) => {
      try {
        const files = await this.sx.assets.readFiles(m.name);
        const words = files.reduce(
          (n, f) => n + f.content.split(/\s+/).filter(Boolean).length,
          0,
        );
        counts.set(m.name, words);
        scanCache[m.name] = { stamp, data: words };
        dirty = true;
      } catch {
        // unreadable asset — skip the size check for it, and leave no
        // cache entry so the next mount retries instead of trusting a
        // failure
      }
    });
    if (dirty) {
      // Best effort, preserving whatever else lives in this storage doc.
      void this.sx.storage
        .saveData({ ...(saved || {}), scanCache })
        .catch(() => {});
    }
    return counts;
  }

  /** Every finding names an asset and says why; findings drive both the
   *  score and the clickable rows. */
  buildReport(members, use90, words) {
    const now = Date.now();
    const findings = { description: [], stale: [], unused: [], huge: [] };
    for (const m of members) {
      const desc = (m.description || "").trim();
      if (desc.length < THIN_DESCRIPTION) {
        findings.description.push({
          name: m.name,
          detail: desc ? `description is only ${desc.length} chars` : "no description",
        });
      }
      if (m.updatedAt) {
        const age = (now - new Date(m.updatedAt).getTime()) / DAY;
        if (age > STALE_DAYS) {
          findings.stale.push({
            name: m.name,
            detail: `last updated ${Math.round(age)}d ago`,
          });
        }
      }
      if ((use90.get(m.name) || 0) === 0) {
        findings.unused.push({
          name: m.name,
          detail: `no usage events in ${UNUSED_DAYS} days`,
        });
      }
      const w = words.get(m.name);
      if (w !== undefined && w > HUGE_WORDS) {
        findings.huge.push({ name: m.name, detail: `${w.toLocaleString()} words` });
      }
    }
    let score = 100;
    const sections = [];
    for (const check of CHECKS) {
      const rows = findings[check.id];
      const applied = Math.min(check.cap, check.weight * rows.length);
      score -= applied;
      // Impact per finding — the cap spreads across a check's rows, so
      // "fix first" surfaces the checks still costing the most per fix.
      for (const row of rows) row.impact = rows.length ? applied / rows.length : 0;
      sections.push({ check, rows, applied });
    }
    const fixFirst = sections
      .flatMap((s) => s.rows.map((r) => ({ ...r, title: s.check.title })))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 3);
    return { score: Math.max(0, Math.round(score)), sections, fixFirst };
  }

  async mount(view, collectionName) {
    const root = view.el;
    root.style.cssText = "max-width: 760px;";
    root.replaceChildren(
      el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Checking collection health…"),
    );
    let disposed = false;
    view.onDispose(() => {
      disposed = true;
    });
    try {
      // ONE events(90) call, aggregated per asset — never one per member.
      const [assets, collections, events] = await Promise.all([
        this.sx.assets.list(),
        this.sx.assets.listCollections(),
        this.sx.usage.events(UNUSED_DAYS),
      ]);
      if (disposed) return;
      const collection = collections.find((c) => c.name === collectionName);
      if (!collection) {
        this.empty(root, "This collection no longer exists.");
        return;
      }
      const byName = new Map(assets.map((a) => [a.name, a]));
      const members = collection.assets.map((n) => byName.get(n)).filter(Boolean);
      const gone = collection.assets.length - members.length;
      if (members.length === 0) {
        this.empty(
          root,
          "This collection has no assets yet — add some and the health report appears here.",
        );
        return;
      }
      const use90 = new Map();
      for (const ev of events) {
        use90.set(ev.assetName, (use90.get(ev.assetName) || 0) + 1);
      }
      const words = await this.wordCounts(members, assets);
      if (disposed) return;
      this.render(root, this.buildReport(members, use90, words), members.length, gone);
    } catch (e) {
      if (disposed) return;
      root.replaceChildren(
        el(
          "div",
          FAINT + "font-size: 12px; padding: 8px 0;",
          "Couldn't build the health report: " + (e?.message || e),
        ),
      );
    }
  }

  empty(root, message) {
    root.replaceChildren(el("div", FAINT + "font-size: 12px; padding: 16px 0;", message));
  }

  assetRow({ name, detail }, label) {
    const row = el(
      "button",
      "display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left;" +
        "padding: 7px 10px; border: 1px solid var(--color-line); border-radius: 8px;" +
        "background: transparent; cursor: pointer; color: var(--color-ink); font: inherit;",
    );
    row.addEventListener("click", () => this.sx.ui.openAsset(name));
    row.append(el("span", "font-size: 13px; font-weight: 600;", name));
    row.append(el("span", FAINT + "font-size: 11px;", detail));
    if (label) {
      row.append(
        el(
          "span",
          "margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 999px;" +
            "background: var(--color-accent-soft); color: var(--color-accent); flex-shrink: 0;",
          label,
        ),
      );
    }
    return row;
  }

  heading(text) {
    return el(
      "div",
      "font-size: 12px; font-weight: 600; color: var(--color-ink);" +
        "margin: 16px 0 6px; text-transform: uppercase; letter-spacing: 0.04em;",
      text,
    );
  }

  render(root, report, memberCount, gone) {
    root.replaceChildren();

    const head = el("div", "display: flex; gap: 14px; align-items: baseline; margin-bottom: 4px;");
    head.append(
      el(
        "div",
        `font-size: 40px; font-weight: 700; line-height: 1; color: ${scoreColor(report.score)};`,
        String(report.score),
      ),
    );
    const meta = el("div");
    meta.append(
      el(
        "div",
        "font-size: 13px; font-weight: 600; color: var(--color-ink);",
        scoreLabel(report.score),
      ),
    );
    meta.append(
      el(
        "div",
        FAINT + "font-size: 11px;",
        `${memberCount} asset${memberCount === 1 ? "" : "s"} checked` +
          (gone ? ` · ${gone} listed asset${gone === 1 ? "" : "s"} no longer exist` : ""),
      ),
    );
    head.append(meta);
    root.append(head);

    const total = report.sections.reduce((n, s) => n + s.rows.length, 0);
    if (total === 0) {
      root.append(
        el(
          "div",
          FAINT + "font-size: 12px; padding: 12px 0;",
          "No findings — every asset is described, current, used, and a sane size.",
        ),
      );
      return;
    }

    root.append(this.heading("Fix first"));
    const top = el("div", "display: flex; flex-direction: column; gap: 5px;");
    for (const f of report.fixFirst) top.append(this.assetRow(f, f.title));
    root.append(top);

    for (const { check, rows, applied } of report.sections) {
      if (rows.length === 0) continue;
      root.append(this.heading(`${check.title} (${rows.length}) · −${applied}`));
      root.append(el("div", FAINT + "font-size: 11px; margin-bottom: 6px;", check.hint));
      const list = el("div", "display: flex; flex-direction: column; gap: 5px;");
      for (const f of rows) list.append(this.assetRow(f));
      root.append(list);
    }

    root.append(
      el(
        "div",
        FAINT + "font-size: 11px; margin-top: 14px;",
        "Ownership isn't checked — asset summaries carry no owner in this API version.",
      ),
    );
  }
}
