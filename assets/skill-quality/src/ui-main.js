// "Skill Quality" — the library-wide board, modeled on Skill Evals'
// dashboard: a rollup header, an attention queue ("what should I look
// at now"), retire candidates with evidence, the high-quality exemplars,
// and a filterable full table. Every row deep-links to the skill's
// Quality tab and carries its next action.
//
// Reads are cheap: one bulk sx.quality.latest(), one asset list, one
// 30-day usage window — no per-skill file reads.

import {
  el,
  chip,
  scoreColor,
  sectionLabel,
  menuButton,
  fmtAgo,
  FAINT,
  SOFT,
  SMALL_BUTTON,
  NOTE,
} from "./dom.js";
import {
  classifyStatus,
  attentionScore,
  retireRank,
  weakestCategory,
  rollup,
  STATUS_ORDER,
  STATUS_LABEL,
  STATUS_HELP,
} from "./board.js";

// One fixed name-column width across queue, retire, and table rows so
// the status chips align into a scannable column.
const NAME_COL =
  "font-weight: 600; width: 220px; flex: none; overflow: hidden;" +
  "text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--color-ink);";

const SCORE_PILL =
  "display: inline-flex; align-items: center; justify-content: center; width: 34px;" +
  "border-radius: 999px; font-size: 11px; font-weight: 700; color: white; padding: 1px 0;";

function scorePill(overall) {
  return el("span", SCORE_PILL + `background: ${scoreColor(overall)};`, String(overall));
}

export async function mountMain(plugin, view) {
  const sx = plugin.sx;
  const state = {
    disposed: false,
    status: "Loading library…",
    refreshing: false,
    rows: [],
    filter: "",
    showLegend: false,
  };

  const openQuality = (name) => sx.ui.openAsset(name, { tab: "quality" });

  const rerender = () => {
    if (state.disposed) return;
    view.el.style.cssText = "display: flex; flex-direction: column; gap: 12px;";
    view.el.replaceChildren(...render());
  };
  plugin.rerenders.add(rerender);
  view.onDispose(() => {
    state.disposed = true;
    plugin.rerenders.delete(rerender);
  });

  async function collect() {
    if (state.refreshing) return;
    state.refreshing = true;
    state.status = state.rows.length ? "" : "Loading library…";
    rerender();
    try {
      const [latest, assets, events] = await Promise.all([
        sx.quality.latest().catch(() => ({})),
        sx.assets.list().catch(() => []),
        sx.usage.events(30).catch(() => []),
      ]);
      const uses = {};
      for (const e of events) uses[e.assetName] = (uses[e.assetName] || 0) + 1;

      state.rows = assets
        .filter((a) => a.type === "skill")
        .map((a) => {
          const record = latest[a.name] || null;
          const status = classifyStatus({ record, updatedAt: a.updatedAt });
          const attn = attentionScore({
            status,
            overall: record?.overall ?? 0,
            uses30: uses[a.name] || 0,
          });
          return {
            name: a.name,
            description: a.description,
            record,
            status,
            overall: record?.overall ?? null,
            uses30: uses[a.name] || 0,
            score: attn.score,
            reasons: attn.reasons,
          };
        });
    } finally {
      state.status = "";
      state.refreshing = false;
      rerender();
    }
  }
  plugin.boardRefresh = collect;
  view.onDispose(() => {
    if (plugin.boardRefresh === collect) plugin.boardRefresh = null;
  });

  async function evaluate(name) {
    await plugin.reevaluate(name);
    await collect();
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

  function header() {
    const wrap = el("div", "display: flex; gap: 10px; align-items: center; flex-wrap: wrap;");
    const r = rollup(state.rows);
    const bits = r.skills
      ? [
          `${r.skills} skills`,
          `${r.evaluated} evaluated (${Math.round((r.evaluated / r.skills) * 100)}%)`,
          r.avg !== null ? `avg ${r.avg}` : null,
          `${r.high} high quality`,
          `${r.low + r.retire} low`,
          r.retire ? `${r.retire} retire candidate${r.retire === 1 ? "" : "s"}` : null,
        ].filter(Boolean)
      : ["No skills in this library yet."];
    wrap.append(el("div", SOFT + "font-size: 13px;", bits.join(" · ")));
    wrap.append(el("div", "flex: 1;"));
    const help = el("button", SMALL_BUTTON + "border-radius: 999px; line-height: 1;", "?");
    help.title = "What the statuses mean";
    help.onclick = () => {
      state.showLegend = !state.showLegend;
      rerender();
    };
    if (state.refreshing && state.rows.length) {
      wrap.append(el("span", FAINT + "font-size: 12px;", "Refreshing…"), help);
      return wrap;
    }
    const refresh = el("button", SMALL_BUTTON, "Refresh");
    refresh.onclick = () => void collect();
    wrap.append(refresh, help);
    return wrap;
  }

  function legend() {
    const panel = el("div", NOTE + "display: flex; flex-direction: column; gap: 5px;");
    for (const [label, meaning] of STATUS_HELP) {
      const line = el("div", "display: flex; gap: 8px; align-items: baseline;");
      line.append(
        el("span", "font-weight: 600; font-size: 12px; width: 130px; flex: none;", label),
        el("span", SOFT + "font-size: 12px;", meaning),
      );
      panel.append(line);
    }
    return panel;
  }

  function busyStrip() {
    const names = [...plugin.busy.keys()];
    if (!names.length) return null;
    return el("div", NOTE, `Evaluating ${names.join(", ")}… results land on each skill's Quality tab.`);
  }

  function evaluateButton(r) {
    const btn = el("button", SMALL_BUTTON + "margin-left: auto;", r.record ? "Re-evaluate" : "Evaluate");
    if (plugin.busy.has(r.name)) {
      btn.textContent = "Evaluating…";
      btn.style.opacity = "0.6";
      btn.style.pointerEvents = "none";
    } else {
      btn.onclick = (e) => {
        e.stopPropagation();
        void evaluate(r.name);
      };
    }
    return btn;
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
    nameLink.onclick = () => openQuality(r.name);
    row.append(nameLink);
    for (const reason of r.reasons.slice(0, 2)) row.append(chip(reason, "faint"));
    row.append(evaluateButton(r));
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
    nameLink.onclick = () => openQuality(r.name);
    head.append(
      nameLink,
      scorePill(r.overall),
      chip("retire candidate", "danger"),
      menuButton([
        { label: "Open quality", run: () => openQuality(r.name) },
        { label: "Re-evaluate", run: () => void evaluate(r.name) },
        { label: "Mark deprecated…", run: () => void markDeprecated(r.name), danger: true },
      ]),
    );
    const worst = weakestCategory(r.record);
    const improvement = r.record?.insights?.improvements?.[0];
    const evidence = [
      `scored ${r.overall} (Inadequate)`,
      worst ? `weakest: ${worst.label} ${worst.score}%` : null,
      r.uses30 ? `${r.uses30} uses/30d` : "unused in 30d",
      r.record?.at ? `evaluated ${fmtAgo(Date.parse(r.record.at))}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    row.append(head, el("div", FAINT + "font-size: 11px;", evidence));
    if (improvement) row.append(el("div", FAINT + "font-size: 11px;", `top issue: ${improvement}`));
    return row;
  }

  function exemplaryRow(r) {
    const row = el(
      "div",
      "display: flex; gap: 8px; align-items: center; padding: 6px 10px;" +
        "border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;" +
        "background: var(--color-surface);",
    );
    const nameLink = el("a", NAME_COL, r.name);
    nameLink.title = r.name;
    nameLink.onclick = () => openQuality(r.name);
    row.append(nameLink, scorePill(r.overall), chip("template-worthy", "accent"));
    const strength = r.record?.insights?.strengths?.[0];
    if (strength) {
      row.append(el("span", FAINT + "font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", strength));
    }
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
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          (a.overall ?? 101) - (b.overall ?? 101),
      );
    for (const r of rows) {
      const line = el(
        "div",
        "display: flex; gap: 10px; align-items: center; padding: 4px 10px;" +
          "border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;" +
          "background: var(--color-surface); cursor: pointer;",
      );
      line.onclick = () => openQuality(r.name);
      const tone =
        r.status === "exemplary" || r.status === "good"
          ? "accent"
          : r.status === "retire-candidate" || r.status === "low"
            ? "danger"
            : "faint";
      const name = el("span", NAME_COL, r.name);
      name.title = r.name;
      line.append(name);
      if (r.overall !== null) line.append(scorePill(r.overall));
      line.append(chip(STATUS_LABEL[r.status], tone));
      const worst = r.record && r.status !== "exemplary" ? weakestCategory(r.record) : null;
      if (worst) line.append(el("span", SOFT + "white-space: nowrap;", `weakest: ${worst.label} ${worst.score}%`));
      line.append(el("span", "flex: 1;"));
      if (r.uses30 > 0) line.append(el("span", FAINT + "white-space: nowrap;", `${r.uses30} uses/30d`));
      line.append(rowMenu(r));
      wrap.append(line);
    }
    return wrap;
  }

  function rowMenu(r) {
    const items = [
      { label: "Open quality", run: () => openQuality(r.name) },
      { label: r.record ? "Re-evaluate" : "Evaluate", run: () => void evaluate(r.name) },
    ];
    if (r.status === "retire-candidate") {
      items.push({ label: "Mark deprecated…", run: () => void markDeprecated(r.name), danger: true });
    }
    const menu = menuButton(items);
    menu.style.marginLeft = "0";
    menu.onclick = (e) => e.stopPropagation(); // keep the row click from firing
    return menu;
  }

  function render() {
    const out = [];
    const strip = busyStrip();
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

    const retire = state.rows.filter((r) => r.status === "retire-candidate").sort(retireRank);
    if (retire.length) {
      const label = sectionLabel(`Retire candidates (${retire.length})`);
      label.title =
        "Scored Inadequate — missing essential elements. Improve substantially or deprecate.";
      out.push(label);
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...retire.map(retireRow));
      out.push(list);
    }

    const exemplary = state.rows
      .filter((r) => r.status === "exemplary")
      .sort((a, b) => b.overall - a.overall)
      .slice(0, 5);
    if (exemplary.length) {
      const label = sectionLabel(`High quality (${exemplary.length})`);
      label.title = "Exemplary skills — point new authors at these as templates.";
      out.push(label);
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...exemplary.map(exemplaryRow));
      out.push(list);
    }

    out.push(sectionLabel("All skills"), table());
    return out;
  }

  rerender();
  await collect();
}
