// "Skill health" — the library-wide dashboard: coverage rollup, the
// attention queue ("what should I look at now"), retire candidates with
// evidence, and a full status table. Reads only cheap sources: shared
// verdict rows, the cached usage window, and per-skill facts re-read
// only when an asset's updatedAt moved.

import { el, chip, fmtPct, fmtAgo, FAINT, SOFT, CARD, BUTTON, PRIMARY, NOTE } from "./dom.js";
import { loadUsage, usageBySkill, saveLocal } from "./store.js";
import { skillStatus, attentionScore, retireRank } from "./health.js";

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
    collectedAt: 0,
  };

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
    const [local, shared, provider, assets] = await Promise.all([
      plugin.loadLocal(),
      plugin.loadShared(),
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
      const row = shared.skills[summary.name] || null;
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
    title.append(
      el("div", "font-weight: 600; font-size: 14px;", "Skill Evals"),
      el("div", FAINT + "font-size: 12px;", rollup),
    );
    const spacer = el("div", "flex: 1;");
    if (state.refreshing && state.rows.length) {
      wrap.append(title, spacer, el("span", FAINT + "font-size: 12px;", "Refreshing…"));
      return wrap;
    }
    const refresh = el("button", BUTTON, "Refresh");
    refresh.title = "Re-read every skill's files (evals can change without a version bump)";
    refresh.onclick = () => void collect(true);
    wrap.append(title, spacer, refresh);
    return wrap;
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
    const nameLink = el(
      "a",
      "font-weight: 600; cursor: pointer; color: var(--color-ink); white-space: nowrap;",
      r.name,
    );
    nameLink.onclick = () => sx.ui.openAsset(r.name);
    row.append(nameLink);
    for (const reason of r.reasons.slice(0, 2)) row.append(chip(reason, "faint"));
    const action = el(
      "button",
      BUTTON + "margin-left: auto; padding: 3px 8px; font-size: 11px; white-space: nowrap;",
      r.facts.activeCount > 0 ? "Benchmark" : "Add evals",
    );
    action.onclick = () => {
      if (r.facts.activeCount > 0) void plugin.startBenchmark(r.name, 1).then(collect);
      else sx.ui.openAsset(r.name);
    };
    row.append(action);
    return row;
  }

  function retireCard(r) {
    const card = el("div", CARD);
    const head = el("div", "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    const nameLink = el(
      "a",
      "font-weight: 600; font-size: 13px; cursor: pointer; color: var(--color-ink);",
      r.name,
    );
    nameLink.onclick = () => sx.ui.openAsset(r.name);
    head.append(nameLink, chip("retire candidate", "danger"));
    const evidence =
      `Baseline passes ${fmtPct(r.row.bp)} without it · delta ${r.row.d >= 0 ? "+" : ""}${r.row.d} · ` +
      `${r.events30} uses/30d${r.everyone ? " · installed everywhere" : ""} · ` +
      `benchmarked by ${r.row.by || "a teammate"} ${fmtAgo(r.row.at * 1000)} on ${r.row.pm}`;
    const actions = el("div", "display: flex; gap: 8px; flex-wrap: wrap;");
    const open = el("button", BUTTON, "Open skill");
    open.onclick = () => sx.ui.openAsset(r.name);
    const rebench = el("button", BUTTON, "Re-benchmark");
    rebench.onclick = () => void plugin.startBenchmark(r.name, 1).then(collect);
    const dep = el("button", BUTTON, "Mark deprecated…");
    dep.onclick = () => void markDeprecated(r.name);
    const dis = el("button", BUTTON, "Dismiss");
    dis.onclick = () => void dismiss(r.name, false);
    actions.append(open, rebench, dep, dis);
    card.append(head, el("div", SOFT + "font-size: 12px;", evidence), actions);
    return card;
  }

  function table() {
    const wrap = el("div", "display: flex; flex-direction: column; gap: 6px;");
    const filters = el("div", "display: flex; gap: 6px; flex-wrap: wrap;");
    const counts = {};
    for (const r of state.rows) counts[r.status] = (counts[r.status] || 0) + 1;
    for (const status of ["", ...STATUS_ORDER.filter((s) => counts[s])]) {
      const label = status ? `${STATUS_LABEL[status]} (${counts[status]})` : `All (${state.rows.length})`;
      const b = el("button", state.filter === status ? PRIMARY : BUTTON, label);
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
        "display: flex; gap: 10px; align-items: center; padding: 6px 10px;" +
          "border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;" +
          "background: var(--color-surface); cursor: pointer;",
      );
      line.onclick = () => sx.ui.openAsset(r.name);
      const tone =
        r.status === "healthy" ? "accent" : r.status === "retire-candidate" || r.status === "failing" ? "danger" : "faint";
      line.append(
        el("span", "font-weight: 600; min-width: 160px;", r.name),
        chip(STATUS_LABEL[r.status] + (r.dismissed ? " · dismissed" : ""), tone),
        el(
          "span",
          SOFT,
          r.row ? `with ${fmtPct(r.row.wp)} · baseline ${fmtPct(r.row.bp)} · Δ ${r.row.d >= 0 ? "+" : ""}${r.row.d}` : `${r.facts.activeCount} active evals`,
        ),
        el("span", FAINT + "margin-left: auto; white-space: nowrap;", `${r.events30} uses/30d`),
      );
      wrap.append(line);
    }
    return wrap;
  }

  function render() {
    const out = [];
    if (!state.provider) out.push(providerPrompt());
    const strip = runStrip();
    if (strip) out.push(strip);
    out.push(header());
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
      out.push(el("div", "font-weight: 600; font-size: 13px;", "Up next"));
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...queue.map(queueRow));
      out.push(list);
    }

    const retire = state.rows
      .filter((r) => r.status === "retire-candidate" && !r.dismissed)
      .sort((a, b) => retireRank(b.row, b.events30) - retireRank(a.row, a.events30));
    if (retire.length) {
      out.push(
        el("div", "font-weight: 600; font-size: 13px;", `Retire candidates (${retire.length})`),
        el(
          "div",
          FAINT + "font-size: 12px;",
          "The baseline model already passes these skills' own evals — they may not be earning their keep.",
        ),
      );
      out.push(...retire.map(retireCard));
    }

    out.push(el("div", "font-weight: 600; font-size: 13px; margin-top: 4px;", "All skills"), table());
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
