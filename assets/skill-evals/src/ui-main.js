// "Skill health" — the library-wide dashboard: coverage rollup, the
// attention queue ("what should I look at now"), retire candidates with
// evidence, and a full status table. Reads only cheap sources: shared
// verdict rows, the cached usage window, and per-skill facts re-read
// only when an asset's updatedAt moved.

import {
  el,
  chip,
  fmtPct,
  fmtAgo,
  menuButton,
  sectionLabel,
  FAINT,
  SOFT,
  SMALL_BUTTON,
  NOTE,
} from "./dom.js";
import { loadUsage, usageBySkill, saveLocal } from "./store.js";
import { skillStatus, attentionScore, retireRank } from "./health.js";

// One fixed name-column width across queue, retire, and table rows so
// the status chips align into a scannable column.
const NAME_COL =
  "font-weight: 600; width: 220px; flex: none; overflow: hidden;" +
  "text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--color-ink);";

const STATUS_HELP = [
  ["No evals", "Nothing to measure yet — generate a starter set."],
  ["Not benchmarked", "Has evals, but no benchmark has run."],
  [
    "Stale",
    "The skill (or your AI provider) changed since its last benchmark — the verdict may no longer apply. Re-benchmark.",
  ],
  [
    "Failing",
    "Fails its own evals even WITH the skill loaded. Fix the skill, or use Improve evals to recalibrate a bad eval suite — this is not a deletion signal.",
  ],
  [
    "Retire candidate",
    "The baseline model passes this skill's evals WITHOUT it (delta ≈ 0). It may not be earning its keep — deprecate or retire it.",
  ],
  ["Marginal", "Passes, but adds little over the baseline."],
  ["Healthy", "Clear uplift over the baseline — the skill earns its keep."],
];

const STATUS_LABEL = {
  "no-evals": "No evals",
  "not-benchmarked": "Not benchmarked",
  stale: "Stale",
  failing: "Failing",
  "retire-candidate": "Retire candidate",
  marginal: "Marginal",
  healthy: "Healthy",
};
const STATUS_ORDER = [
  "retire-candidate",
  "failing",
  "no-evals",
  "not-benchmarked",
  "stale",
  "marginal",
  "healthy",
];

async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export async function mountMain(plugin, view) {
  const sx = plugin.sx;
  const state = {
    disposed: false,
    status: "Loading library…",
    refreshing: false,
    provider: "",
    rows: [],
    dismissed: {},
    filter: "",
    showLegend: false,
    collectedAt: 0,
  };

  // Deep-link to the skill's Evals tab — the dashboard's rows are about
  // evals, so that's where every skill link lands.
  const openEvals = (name) => sx.ui.openAsset(name, { tab: "evals" });

  const rerender = () => {
    if (state.disposed) return;
    view.el.style.cssText = "display: flex; flex-direction: column; gap: 12px;";
    view.el.replaceChildren(...render());
  };
  plugin.rerenders.add(rerender);
  const providerWatch = window.setInterval(() => {
    void sx.llm
      .provider()
      .then((p) => {
        if ((p || "") !== state.provider) {
          state.provider = p || "";
          rerender();
        }
      })
      .catch(() => {});
  }, 2000);
  view.onDispose(() => {
    state.disposed = true;
    plugin.rerenders.delete(rerender);
    window.clearInterval(providerWatch);
  });

  async function collect(force = false) {
    if (state.refreshing) return;
    state.refreshing = true;
    // With a cached board on screen, refresh quietly behind it; only a
    // first-ever load shows the blocking status line.
    state.status = state.rows.length ? "" : "Loading library…";
    rerender();
    const [local, shared, verdicts, provider, assets] = await Promise.all([
      plugin.loadLocal(),
      plugin.loadShared(),
      plugin.latestVerdicts(),
      sx.llm.provider().catch(() => ""),
      sx.assets.list().catch(() => []),
    ]);
    state.provider = provider || "";
    state.dismissed = shared.dismissed || {};
    const skills = assets.filter((a) => a.type === "skill");
    const events = await loadUsage(sx, local);
    const usage = usageBySkill(events);

    let done = 0;
    const rows = [];
    await pool(skills, 8, async (summary) => {
      if (state.disposed) return;
      const facts = await plugin
        .skillFacts(local, summary, force)
        .catch(() => ({ hash: "", evalCount: 0, activeCount: 0 }));
      done++;
      if (done % 10 === 0 && !state.rows.length) {
        state.status = `Reading skills… ${done}/${skills.length}`;
        rerender();
      }
      const row = verdicts[summary.name] || null;
      const hasEvals = facts.activeCount > 0;
      const dismissed = !!state.dismissed[summary.name];
      const events30 = usage[summary.name] || 0;
      const status = skillStatus({
        hasEvals,
        row,
        currentHash: facts.hash,
        provider: state.provider,
      });
      const attn = attentionScore({
        hasEvals,
        row,
        currentHash: facts.hash,
        provider: state.provider,
        events30,
        updatedAtMs: summary.updatedAt ? new Date(summary.updatedAt).getTime() : 0,
        dismissed,
      });
      rows.push({
        name: summary.name,
        description: summary.description,
        facts,
        row,
        status,
        score: attn.score,
        reasons: attn.reasons,
        events30,
        dismissed,
      });
    });
    await saveLocal(sx, local); // persist refreshed hash + usage caches

    // Reach refinement for the queue's head only — installations() is a
    // per-asset call, so the whole library never pays for it.
    const head = rows.slice().sort((a, b) => b.score - a.score).slice(0, 10);
    await pool(head, 4, async (r) => {
      const inst = await sx.assets.installations(r.name).catch(() => null);
      if (!inst) return;
      const attn = attentionScore({
        hasEvals: r.facts.activeCount > 0,
        row: r.row,
        currentHash: r.facts.hash,
        provider: state.provider,
        events30: r.events30,
        installRows: { everyone: inst.everyone, count: inst.installations.length },
        updatedAtMs: 0,
        dismissed: r.dismissed,
      });
      r.score = attn.score;
      r.reasons = attn.reasons;
      r.everyone = inst.everyone;
    });

    state.rows = rows;
    state.status = "";
    state.refreshing = false;
    state.collectedAt = Date.now();
    // Persist the computed board so the next mount renders instantly
    // instead of re-reading the library from scratch.
    const snapshot = await plugin.loadLocal();
    snapshot.board = { rows, dismissed: state.dismissed, provider: state.provider, collectedAt: state.collectedAt };
    await saveLocal(sx, snapshot);
    rerender();
  }

  async function markDeprecated(name) {
    const ok = await sx.ui.confirm(
      `Mark ${name} as deprecated? This publishes a metadata-only revision (content untouched) so teammates see the status.`,
      "Mark deprecated",
    );
    if (!ok) return;
    try {
      await sx.writeAssetMetadata(name, { status: "deprecated" });
      sx.ui.notice(`${name} marked deprecated.`);
    } catch (err) {
      sx.ui.notice(`Couldn't update metadata: ${err?.message || err}`);
    }
    await collect();
  }

  async function dismiss(name, undo) {
    const by = await sx.app.currentUser().catch(() => "");
    const names = state.rows.map((r) => r.name);
    await plugin.mergeSaveShared(names, (doc) => {
      if (undo) delete doc.dismissed[name];
      else doc.dismissed[name] = { by, at: new Date().toISOString() };
    });
    await collect();
  }

  function header() {
    const wrap = el("div", "display: flex; gap: 10px; align-items: center; flex-wrap: wrap;");
    const title = el("div", "");
    const skills = state.rows.length;
    const withEvals = state.rows.filter((r) => r.facts.activeCount > 0).length;
    const benched = state.rows.filter((r) => r.row).length;
    const retire = state.rows.filter((r) => r.status === "retire-candidate" && !r.dismissed).length;
    const failing = state.rows.filter((r) => r.status === "failing").length;
    const rollup = skills
      ? `${skills} skills · ${withEvals} with evals (${Math.round((withEvals / skills) * 100)}%) · ` +
        `${benched} benchmarked · ${retire} retire candidate${retire === 1 ? "" : "s"} · ${failing} failing`
      : "No skills in this library yet.";
    // The app chrome already titles this view — one rollup line is enough.
    title.append(el("div", SOFT + "font-size: 13px;", rollup));
    const spacer = el("div", "flex: 1;");
    const help = el("button", SMALL_BUTTON + "border-radius: 999px; line-height: 1;", "?");
    help.title = "What the statuses mean";
    help.onclick = () => {
      state.showLegend = !state.showLegend;
      rerender();
    };
    if (state.refreshing && state.rows.length) {
      wrap.append(title, spacer, el("span", FAINT + "font-size: 12px;", "Refreshing…"), help);
      return wrap;
    }
    const refresh = el("button", SMALL_BUTTON, "Refresh");
    refresh.title = "Re-read every skill's files (evals can change without a version bump)";
    refresh.onclick = () => void collect(true);
    wrap.append(title, spacer, refresh, help);
    return wrap;
  }

  function legend() {
    const panel = el("div", NOTE + "display: flex; flex-direction: column; gap: 5px;");
    for (const [label, meaning] of STATUS_HELP) {
      const line = el("div", "display: flex; gap: 8px; align-items: baseline;");
      line.append(
        el("span", "font-weight: 600; font-size: 12px; width: 120px; flex: none;", label),
        el("span", SOFT + "font-size: 12px;", meaning),
      );
      panel.append(line);
    }
    return panel;
  }

  function providerPrompt() {
    const row = el("div", NOTE + "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    const link = el(
      "a",
      "color: var(--color-accent); cursor: pointer; text-decoration: underline;",
      "Open AI settings",
    );
    link.onclick = (e) => {
      e.preventDefault();
      sx.ui.openSettings("ai");
    };
    row.append(
      el("span", "", "No AI provider configured — benchmarks and eval generation need one."),
      link,
    );
    return row;
  }

  function runStrip() {
    const r = plugin.activeRun;
    if (!r) return null;
    return el(
      "div",
      NOTE,
      `Benchmarking ${r.skill}… ${r.done}/${r.total} cells. Progress and cancel live on the skill's Evals tab.`,
    );
  }

  function queueRow(r) {
    const row = el(
      "div",
      "display: flex; gap: 8px; align-items: center; padding: 6px 10px;" +
        "border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;" +
        "background: var(--color-surface);",
    );
    const nameLink = el("a", NAME_COL, r.name);
    nameLink.title = r.name;
    nameLink.onclick = () => openEvals(r.name);
    row.append(nameLink);
    for (const reason of r.reasons.slice(0, 2)) row.append(chip(reason, "faint"));
    const action = el(
      "button",
      SMALL_BUTTON + "margin-left: auto;",
      r.facts.activeCount > 0 ? "Benchmark" : "Add evals",
    );
    action.onclick = () => {
      if (r.facts.activeCount > 0) void plugin.startBenchmark(r.name, 1).then(collect);
      else openEvals(r.name);
    };
    row.append(action);
    return row;
  }

  function retireRow(r) {
    const row = el(
      "div",
      "display: flex; flex-direction: column; gap: 3px; padding: 6px 10px;" +
        "border: 1px solid var(--color-line); border-radius: 8px;" +
        "background: var(--color-surface);",
    );
    const head = el("div", "display: flex; gap: 8px; align-items: center;");
    const nameLink = el("a", NAME_COL + "font-size: 12px;", r.name);
    nameLink.title = r.name;
    nameLink.onclick = () => openEvals(r.name);
    head.append(
      nameLink,
      chip("retire candidate", "danger"),
      menuButton([
        { label: "Open evals", run: () => openEvals(r.name) },
        { label: "Re-benchmark", run: () => void plugin.startBenchmark(r.name, 1).then(collect) },
        { label: "Mark deprecated…", run: () => void markDeprecated(r.name) },
        { label: "Dismiss", run: () => void dismiss(r.name, false), danger: true },
      ]),
    );
    const evidence =
      `Baseline passes ${fmtPct(r.row.bp)} without it · Δ ${r.row.d >= 0 ? "+" : ""}${r.row.d} · ` +
      `${r.events30} uses/30d${r.everyone ? " · installed everywhere" : ""} · ` +
      `by ${r.row.by || "a teammate"} ${fmtAgo(r.row.at * 1000)} on ${r.row.pm}`;
    row.append(head, el("div", FAINT + "font-size: 11px;", evidence));
    return row;
  }

  function table() {
    const wrap = el("div", "display: flex; flex-direction: column; gap: 6px;");
    const filters = el("div", "display: flex; gap: 6px; flex-wrap: wrap;");
    const counts = {};
    for (const r of state.rows) counts[r.status] = (counts[r.status] || 0) + 1;
    for (const status of ["", ...STATUS_ORDER.filter((s) => counts[s])]) {
      const label = status ? `${STATUS_LABEL[status]} (${counts[status]})` : `All (${state.rows.length})`;
      const active = state.filter === status;
      const b = el(
        "button",
        SMALL_BUTTON +
          "border-radius: 999px;" +
          (active ? "background: var(--color-accent); border-color: var(--color-accent); color: white;" : ""),
        label,
      );
      b.onclick = () => {
        state.filter = status;
        rerender();
      };
      filters.append(b);
    }
    wrap.append(filters);

    const rows = state.rows
      .filter((r) => !state.filter || r.status === state.filter)
      .sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.score - a.score,
      );
    for (const r of rows) {
      const line = el(
        "div",
        "display: flex; gap: 10px; align-items: center; padding: 4px 10px;" +
          "border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;" +
          "background: var(--color-surface); cursor: pointer;",
      );
      line.onclick = () => openEvals(r.name);
      const tone =
        r.status === "healthy" ? "accent" : r.status === "retire-candidate" || r.status === "failing" ? "danger" : "faint";
      // The status chip already says "no evals" — skip redundant detail
      // text, and skip the usage figure entirely when it's zero.
      const detail = r.row
        ? `with ${fmtPct(r.row.wp)} · baseline ${fmtPct(r.row.bp)} · Δ ${r.row.d >= 0 ? "+" : ""}${r.row.d}`
        : r.facts.activeCount > 0
          ? `${r.facts.activeCount} active eval${r.facts.activeCount === 1 ? "" : "s"}`
          : "";
      const name = el("span", NAME_COL, r.name);
      name.title = r.name;
      line.append(name, chip(STATUS_LABEL[r.status] + (r.dismissed ? " · dismissed" : ""), tone));
      if (detail) line.append(el("span", SOFT + "white-space: nowrap;", detail));
      line.append(el("span", "flex: 1;"));
      if (r.events30 > 0) {
        line.append(el("span", FAINT + "white-space: nowrap;", `${r.events30} uses/30d`));
      }
      line.append(rowMenu(r));
      wrap.append(line);
    }
    return wrap;
  }

  /** Contextual actions per table row. Failing skills get "Improve
   * evals" (recalibrate the suite from benchmark feedback) — deletion
   * is only suggested for retire candidates, and even that stays a
   * confirmed, human choice. */
  function rowMenu(r) {
    const items = [{ label: "Open evals", run: () => openEvals(r.name) }];
    if (r.facts.activeCount > 0) {
      items.push({
        label: r.row ? "Re-benchmark" : "Run benchmark",
        run: () => void plugin.startBenchmark(r.name, 1).then(collect),
      });
    } else {
      items.push({ label: "Generate evals", run: () => openEvals(r.name) });
    }
    if (r.row && r.facts.activeCount > 0) {
      items.push({ label: "Improve evals…", run: () => void plugin.improveEvalsFor(r.name) });
    }
    if (r.status === "retire-candidate") {
      items.push({ label: "Mark deprecated…", run: () => void markDeprecated(r.name) });
      items.push(
        r.dismissed
          ? { label: "Undismiss", run: () => void dismiss(r.name, true) }
          : { label: "Dismiss", run: () => void dismiss(r.name, false), danger: true },
      );
    }
    const menu = menuButton(items);
    menu.style.marginLeft = "0";
    menu.onclick = (e) => e.stopPropagation(); // keep the row click from firing
    return menu;
  }

  function render() {
    const out = [];
    if (!state.provider) out.push(providerPrompt());
    const strip = runStrip();
    if (strip) out.push(strip);
    out.push(header());
    if (state.showLegend) out.push(legend());
    if (state.status) {
      out.push(el("div", FAINT + "font-size: 13px; padding: 8px;", state.status));
      return out;
    }
    if (!state.rows.length) return out;

    const queue = state.rows
      .filter((r) => r.score >= 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (queue.length) {
      out.push(sectionLabel("Up next"));
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...queue.map(queueRow));
      out.push(list);
    }

    const retire = state.rows
      .filter((r) => r.status === "retire-candidate" && !r.dismissed)
      .sort((a, b) => retireRank(b.row, b.events30) - retireRank(a.row, a.events30));
    if (retire.length) {
      const label = sectionLabel(`Retire candidates (${retire.length})`);
      label.title = "The baseline model already passes these skills' own evals — they may not be earning their keep.";
      out.push(label);
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...retire.map(retireRow));
      out.push(list);
    }

    out.push(sectionLabel("All skills"), table());
    return out;
  }

  rerender();
  // Cached-first: the last computed board renders immediately (no blank
  // "loading" screen on remount); a background pass then refreshes it —
  // reading files only for skills whose updatedAt moved or whose facts
  // aged past the TTL, and pulling usage incrementally.
  const cachedBoard = (await plugin.loadLocal()).board;
  if (cachedBoard?.rows?.length && !state.disposed) {
    state.rows = cachedBoard.rows;
    state.dismissed = cachedBoard.dismissed || {};
    state.provider = cachedBoard.provider || "";
    state.collectedAt = cachedBoard.collectedAt || 0;
    state.status = "";
    rerender();
  }
  await collect();
}
