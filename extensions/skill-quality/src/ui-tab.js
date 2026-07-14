// The per-skill "Quality" tab, styled after skills.new's: score badge,
// four category bars, the assessment summary, and collapsible insights.

import {
  el,
  chip,
  scoreBadge,
  progressBar,
  sectionLabel,
  fmtAgo,
  FAINT,
  SOFT,
  CARD,
  NOTE,
  PRIMARY,
} from "./dom.js";
import { skillHash } from "./files.js";

const CATEGORY_LABELS = [
  ["structure", "Structure"],
  ["actionability", "Actionability"],
  ["content", "Content"],
  ["completeness", "Completeness"],
];

export async function mountTab(plugin, view, ctx) {
  const sx = plugin.sx;
  const name = ctx.assetName;
  const state = {
    disposed: false,
    loading: true,
    unsupported: false,
    doc: { evaluating: false, records: [] },
    currentHash: "",
    insightsOpen: true,
  };

  const rerender = () => {
    if (state.disposed) return;
    view.el.style.cssText = "display: flex; flex-direction: column; gap: 10px;";
    view.el.replaceChildren(...render());
  };
  plugin.rerenders.add(rerender);
  view.onDispose(() => {
    state.disposed = true;
    plugin.rerenders.delete(rerender);
  });

  async function refresh() {
    state.loading = true;
    rerender();
    try {
      const [doc, files] = await Promise.all([
        sx.quality.get(name),
        sx.assets.readFiles(name).catch(() => []),
      ]);
      state.doc = doc;
      state.currentHash = files.length ? await skillHash(files) : "";
    } catch (err) {
      state.unsupported = true;
      state.error = err?.message || String(err);
    }
    state.loading = false;
    rerender();
  }

  function render() {
    if (state.loading) return [el("div", FAINT + "padding: 8px;", "Loading quality…")];
    if (state.unsupported) {
      return [
        el(
          "div",
          NOTE,
          "This library's backend doesn't support quality storage yet — update the vault's server (or the app) to use quality scores.",
        ),
      ];
    }

    const busy = plugin.busy.get(name);
    const evaluating = busy || state.doc.evaluating;
    const record = state.doc.records[0];
    const nodes = [];

    // Header: title + re-evaluate.
    const header = el("div", "display: flex; align-items: center; gap: 8px;");
    header.append(el("div", "font-size: 14px; font-weight: 600;", "Quality"));
    const btn = el(
      "button",
      PRIMARY + "margin-left: auto;" + (evaluating ? "opacity: 0.6; pointer-events: none;" : ""),
      evaluating ? "Evaluating…" : record ? "Re-evaluate" : "Evaluate",
    );
    btn.onclick = () => void plugin.reevaluate(name);
    header.append(btn);
    nodes.push(header);

    if (!record) {
      nodes.push(
        el(
          "div",
          NOTE,
          evaluating
            ? "Evaluating this skill — results will appear here shortly."
            : "This skill hasn't been evaluated yet. Evaluate scores its structure, actionability, content, and completeness with concrete improvement suggestions.",
        ),
      );
      return nodes;
    }

    // Score panel: badge + category bars.
    const panel = el("div", CARD);
    const row = el("div", "display: flex; align-items: center; gap: 16px;");
    row.append(scoreBadge(record.overall));
    const bars = el("div", "flex: 1; display: flex; flex-direction: column; gap: 6px;");
    for (const [key, label] of CATEGORY_LABELS) {
      const score = record.categories?.[key];
      if (typeof score === "number") bars.append(progressBar(label, score));
    }
    row.append(bars);
    panel.append(row);

    // Provenance line: when, who, source, trend, staleness.
    const meta = el("div", "display: flex; align-items: center; gap: 6px; flex-wrap: wrap;");
    if (record.at) meta.append(el("span", FAINT + "font-size: 11px;", `Evaluated ${fmtAgo(Date.parse(record.at))}`));
    if (record.by) meta.append(el("span", FAINT + "font-size: 11px;", `by ${record.by}`));
    meta.append(chip(record.source === "server" ? "skills.new" : record.executor?.model || "local", "faint"));
    const prior = state.doc.records[1];
    if (prior && typeof prior.overall === "number") {
      const delta = record.overall - prior.overall;
      if (delta !== 0) meta.append(chip(`${delta > 0 ? "+" : ""}${delta} vs last`, delta > 0 ? "accent" : "danger"));
    }
    if (record.skill_hash && state.currentHash && record.skill_hash !== state.currentHash) {
      meta.append(chip("skill changed since evaluation", "danger"));
    }
    panel.append(meta);
    nodes.push(panel);

    // Summary.
    if (record.summary) nodes.push(el("div", NOTE, record.summary));

    // Insights.
    const insights = record.insights || {};
    const sections = [
      ["Strengths", insights.strengths],
      ["Areas for Improvement", insights.improvements],
      ["Recommendations", insights.recommendations],
    ].filter(([, items]) => items?.length);
    if (sections.length) {
      const details = el("details", "display: flex; flex-direction: column; gap: 4px;");
      details.open = state.insightsOpen;
      details.ontoggle = () => (state.insightsOpen = details.open);
      const summary = el("summary", SOFT + "cursor: pointer; font-size: 12px; font-weight: 600;", "Insights");
      details.append(summary);
      for (const [label, items] of sections) {
        details.append(sectionLabel(label));
        const list = el("ul", "margin: 2px 0 6px; padding-left: 18px; display: flex; flex-direction: column; gap: 3px;");
        for (const item of items) {
          list.append(el("li", SOFT + "font-size: 12px; line-height: 1.45;", item));
        }
        details.append(list);
      }
      nodes.push(details);
    }

    // Footer stats.
    if (record.stats) {
      const bits = [];
      if (record.stats.file_count != null) bits.push(`${record.stats.file_count} file${record.stats.file_count === 1 ? "" : "s"}`);
      if (record.stats.word_count != null) bits.push(`${record.stats.word_count} words`);
      if (bits.length) nodes.push(el("div", FAINT + "font-size: 11px;", bits.join(" · ")));
    }

    return nodes;
  }

  plugin.refreshers.set(name, refresh);
  view.onDispose(() => {
    if (plugin.refreshers.get(name) === refresh) plugin.refreshers.delete(name);
  });
  await refresh();
}
