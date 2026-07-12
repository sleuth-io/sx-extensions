// The per-skill "Evals" tab, styled after skills.new's: an action
// toolbar, an impact panel (badge + With/Without bars), collapsible
// per-eval results, tight eval cards, and the unified benchmark history.

import { el, chip, fmtPct, fmtAgo, FAINT, SOFT, CARD, BUTTON, SMALL_BUTTON, NOTE } from "./dom.js";
import { findEvalsFile, parseEvals, activeEvals } from "./evals.js";
import { generateEvals, writeEvalsDraft, DEFAULT_COUNT } from "./generate.js";
import { DELTA_MARGINAL, DELTA_NONE } from "./health.js";

const TOOL =
  "background: none; border: 0; padding: 4px 6px; font: inherit; font-size: 12px;" +
  "font-weight: 500; cursor: pointer; color: var(--color-accent); white-space: nowrap;";

export async function mountTab(plugin, view, ctx) {
  const sx = plugin.sx;
  const name = ctx.assetName;
  const state = {
    disposed: false,
    loading: true,
    isSkill: true,
    files: [],
    evals: [],
    invalid: false,
    provider: "",
    history: [], // normalized verdict rows, newest first (unified store)
    detail: null, // local RunDetail (grade transcripts stay per-user)
    inProgress: null,
    busy: "",
    perEvalOpen: false,
    expanded: new Set(),
    reps: 1,
  };

  const rerender = () => {
    if (state.disposed) return;
    view.el.style.cssText = "display: flex; flex-direction: column; gap: 10px;";
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

  async function refresh() {
    state.loading = true;
    rerender();
    const [assets, provider, local, history] = await Promise.all([
      sx.assets.list().catch(() => []),
      sx.llm.provider().catch(() => ""),
      plugin.loadLocal(),
      plugin.benchmarkHistory(name),
    ]);
    const summary = assets.find((a) => a.name === name);
    state.isSkill = !summary || summary.type === "skill";
    state.provider = provider || "";
    if (state.isSkill) {
      state.files = await sx.assets.readFiles(name).catch(() => []);
      const evalsFile = findEvalsFile(state.files);
      const parsed = evalsFile ? parseEvals(evalsFile.content) : { evals: [], invalid: false };
      state.evals = parsed.evals;
      state.invalid = parsed.invalid;
    }
    state.history = history;
    state.detail = local.detail[name] || null;
    state.inProgress = local.inProgress?.skill === name ? local.inProgress : null;
    state.loading = false;
    rerender();
  }

  async function onGenerate(replaceAll) {
    if (!state.provider) {
      sx.ui.openSettings("ai");
      return;
    }
    if (replaceAll) {
      const ok = await sx.ui.confirm(
        `Replace all ${state.evals.length} evals for ${name} with freshly generated ones?`,
        "Regenerate all",
      );
      if (!ok) return;
    }
    state.busy = "Generating evals with your AI provider…";
    rerender();
    try {
      const assets = await sx.assets.list().catch(() => []);
      const description = assets.find((a) => a.name === name)?.description || "";
      const generated = await generateEvals(sx, {
        name,
        description,
        files: state.files,
        existing: replaceAll ? [] : state.evals,
        count: DEFAULT_COUNT,
      });
      if (!generated.length) {
        sx.ui.notice("The provider returned no usable evals — try again.");
        return;
      }
      const next = replaceAll ? generated : [...state.evals, ...generated];
      const res = await writeEvalsDraft(sx, name, state.files, next);
      sx.ui.notice(res.message);
    } catch (err) {
      sx.ui.notice(`Eval generation failed: ${err?.message || err}`);
    } finally {
      state.busy = "";
      await refresh();
    }
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
      el(
        "span",
        "",
        "No AI provider configured — pick one (an installed CLI, a local Ollama model, or your own API key) to generate evals and run benchmarks.",
      ),
      link,
    );
    return row;
  }

  /** "Evals · 12 (10 active)" plus the skills.new-style action toolbar. */
  function toolbar() {
    const row = el(
      "div",
      "display: flex; gap: 2px; align-items: center; flex-wrap: wrap; padding: 2px 0;" +
        "border-bottom: 1px solid var(--color-line); padding-bottom: 8px;",
    );
    row.append(
      el("div", "font-weight: 600; font-size: 13px; margin-right: 6px;", "Evals"),
      el(
        "span",
        FAINT + "font-size: 12px; margin-right: auto;",
        state.evals.length ? `${state.evals.length} · ${activeEvals(state.evals).length} active` : "none yet",
      ),
    );
    if (state.evals.length) {
      const run = el("button", TOOL, "▷ Run benchmark");
      run.onclick = () => void plugin.startBenchmark(name, state.reps).then(refresh);
      const reps = el("select", SMALL_BUTTON + "padding: 2px 4px;");
      for (const n of [1, 3]) {
        const opt = el("option", "", `×${n}`);
        opt.value = String(n);
        reps.append(opt);
      }
      reps.title = "Runs per configuration";
      reps.value = String(state.reps);
      reps.onchange = () => (state.reps = Number(reps.value));
      row.append(run, reps, el("span", FAINT, "·"));
    }
    const gen = el("button", TOOL, "✦ Generate");
    gen.onclick = () => void onGenerate(false);
    row.append(gen);
    if (state.evals.length) {
      const regen = el("button", TOOL, "↻ Re-generate all");
      regen.onclick = () => void onGenerate(true);
      row.append(regen);
    }
    return row;
  }

  function bar(label, rate, tone) {
    const row = el("div", "display: flex; align-items: center; gap: 10px;");
    const track = el(
      "div",
      "flex: 1; height: 7px; border-radius: 999px; background: var(--color-canvas);" +
        "border: 1px solid var(--color-line); overflow: hidden;",
    );
    track.append(
      el(
        "div",
        `height: 100%; width: ${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%; background: ${tone};`,
      ),
    );
    row.append(
      el("span", FAINT + "font-size: 12px; width: 56px;", label),
      track,
      el("span", SOFT + "font-size: 12px; width: 44px; text-align: right;", fmtPct(rate)),
    );
    return row;
  }

  /** The skills.new-style impact panel: hex badge, three bars, date,
   * and a collapsible per-eval breakdown. */
  function impactPanel() {
    const latest = state.history[0];
    if (!latest) {
      return el(
        "div",
        NOTE,
        "Never benchmarked. Run a benchmark to measure this skill's impact — with-skill vs without-skill, graded by your AI provider.",
      );
    }
    const good = latest.d >= DELTA_MARGINAL;
    const bad = latest.d <= DELTA_NONE;
    const badgeColor = good ? "#0e9f6e" : bad ? "var(--color-danger)" : "var(--color-ink-faint)";
    const panel = el("div", CARD + "gap: 10px;");

    const top = el("div", "display: flex; gap: 16px; align-items: center;");
    const badge = el(
      "div",
      `width: 76px; height: 84px; flex: none; display: flex; align-items: center; justify-content: center;` +
        `background: ${badgeColor}; color: white; font-weight: 700; font-size: 17px;` +
        `clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);`,
      `${latest.d >= 0 ? "+" : ""}${Math.round(latest.d * 100)}%`,
    );
    const bars = el("div", "flex: 1; display: flex; flex-direction: column; gap: 7px;");
    bars.append(
      bar("Impact", Math.abs(latest.d), badgeColor),
      bar("With", latest.wp, "#0e9f6e"),
      bar("Without", latest.bp, "var(--color-ink-faint)"),
    );
    top.append(badge, bars);
    panel.append(top);

    const perEval = latest.perEval?.length
      ? latest.perEval
      : (state.history.find((h) => h.perEval?.length) || {}).perEval;
    const foot = el("div", "display: flex; gap: 8px; align-items: center;");
    if (perEval?.length) {
      const toggle = el(
        "a",
        FAINT + "font-size: 12px; cursor: pointer;",
        `${state.perEvalOpen ? "▾" : "▸"} Per-eval results`,
      );
      toggle.onclick = () => {
        state.perEvalOpen = !state.perEvalOpen;
        rerender();
      };
      foot.append(toggle);
    }
    const who = latest.src === "server" ? "skills.new" : latest.pm || "app";
    foot.append(
      el(
        "span",
        FAINT + "font-size: 11px; margin-left: auto;",
        `${fmtAgo(latest.at * 1000)} · ${who}${latest.by ? ` · ${latest.by}` : ""}${
          latest.notes?.length ? ` · ${latest.notes[0]}` : ""
        }`,
      ),
    );
    panel.append(foot);

    if (state.perEvalOpen && perEval?.length) {
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      for (const p of perEval) {
        const line = el("div", "display: flex; gap: 10px; align-items: center; font-size: 12px;");
        line.append(
          el("code", "font-family: var(--font-mono); font-size: 11px; min-width: 180px;", p.key),
          chip(
            p.status.replace(/_/g, " "),
            p.status === "passing" ? "accent" : p.status === "failing" ? "danger" : "faint",
          ),
          el("span", SOFT, `with ${fmtPct(p.withPass)} · without ${fmtPct(p.withoutPass)}`),
        );
        list.append(line);
      }
      panel.append(list);
    }

    if (state.history.length > 1) {
      const prev = state.history
        .slice(1, 4)
        .map(
          (h) =>
            `${fmtAgo(h.at * 1000)} Δ ${h.d >= 0 ? "+" : ""}${h.d} (${h.src === "server" ? "skills.new" : "app"})`,
        )
        .join(" · ");
      panel.append(el("div", FAINT + "font-size: 11px;", `Previous runs: ${prev}`));
    }
    return panel;
  }

  function runStrip() {
    const r = plugin.activeRun;
    if (!r) return null;
    const strip = el(
      "div",
      NOTE + "display: flex; gap: 10px; align-items: center;",
      `Benchmarking ${r.skill}… ${r.done}/${r.total} cells`,
    );
    if (r.skill === name) {
      const cancel = el("button", SMALL_BUTTON, "Cancel");
      cancel.onclick = () => plugin.cancelBenchmark();
      strip.append(cancel);
    }
    return strip;
  }

  function resumeBanner() {
    if (!state.inProgress || plugin.activeRun) return null;
    const row = el(
      "div",
      NOTE + "display: flex; gap: 10px; align-items: center;",
      `An interrupted benchmark for ${name} has ${state.inProgress.cells?.length || 0} finished cells.`,
    );
    const resume = el("button", BUTTON, "Resume");
    resume.onclick = () => void plugin.resumeBenchmark().then(refresh);
    const discard = el("button", SMALL_BUTTON, "Discard");
    discard.onclick = () => void plugin.discardInProgress().then(refresh);
    row.append(resume, discard);
    return row;
  }

  function evalCard(spec) {
    const latest = state.history[0];
    const card = el("div", CARD + "gap: 6px;" + (spec.is_active ? "" : "opacity: 0.55;"));
    const head = el("div", "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    head.append(
      el("code", "font-family: var(--font-mono); font-size: 12px; font-weight: 600;", spec.eval_key),
      chip(spec.category, spec.category === "edge-case" ? "accent" : "faint"),
    );
    if (!spec.is_active) head.append(chip("inactive", "faint"));
    const per = latest?.perEval?.find((p) => p.key === spec.eval_key);
    if (per) {
      head.append(
        chip(
          per.status.replace(/_/g, " "),
          per.status === "passing" ? "accent" : per.status === "failing" ? "danger" : "faint",
        ),
      );
    }
    card.append(head);

    const prompt = el("div", SOFT + "font-size: 12px; line-height: 1.5;", spec.prompt);
    prompt.style.display = "-webkit-box";
    prompt.style.webkitLineClamp = "2";
    prompt.style.webkitBoxOrient = "vertical";
    prompt.style.overflow = "hidden";
    card.append(prompt);

    const open = state.expanded.has(spec.eval_key);
    const toggle = el(
      "a",
      FAINT + "font-size: 12px; cursor: pointer;",
      `${open ? "▾" : "▸"} ${spec.expectations.length} expectation${spec.expectations.length === 1 ? "" : "s"}`,
    );
    toggle.onclick = () => {
      open ? state.expanded.delete(spec.eval_key) : state.expanded.add(spec.eval_key);
      rerender();
    };
    card.append(toggle);

    if (open) {
      const exp = el("ul", "margin: 0; padding-left: 18px; font-size: 12px;" + SOFT);
      for (const x of spec.expectations) exp.append(el("li", "", x));
      card.append(exp);
      for (const c of (state.detail?.cells || []).filter((x) => x.evalKey === spec.eval_key)) {
        const box = el("div", NOTE);
        const title = c.error
          ? `${c.config} · run ${c.rep} · errored: ${c.error}`
          : `${c.config} · run ${c.rep} · ${fmtPct(c.passRate)}`;
        box.append(el("div", "font-weight: 600; font-size: 12px;", title));
        for (const g of c.grades || []) {
          box.append(
            el(
              "div",
              (g.pass ? SOFT : "color: var(--color-danger);") + "font-size: 12px;",
              `${g.pass ? "✓" : "✗"} ${g.text} — ${g.reason}`,
            ),
          );
        }
        card.append(box);
      }
    }
    return card;
  }

  function render() {
    if (!state.isSkill) {
      return [el("div", FAINT + "font-size: 13px; padding: 8px;", "Evals apply to skills — this asset type has none.")];
    }
    if (state.loading) {
      return [el("div", FAINT + "font-size: 13px; padding: 8px;", "Loading evals…")];
    }
    const out = [];
    if (!state.provider) out.push(providerPrompt());
    const strip = runStrip();
    if (strip) out.push(strip);
    const banner = resumeBanner();
    if (banner) out.push(banner);
    if (state.busy) out.push(el("div", NOTE, state.busy));
    out.push(toolbar(), impactPanel());
    if (state.invalid) {
      out.push(el("div", NOTE + "color: var(--color-danger);", "evals/evals.json exists but couldn't be parsed — regenerate or fix it by hand."));
    }
    if (!state.evals.length) {
      out.push(
        el(
          "div",
          FAINT + "font-size: 13px;",
          "No evals yet. Generate a starter set — they land in a draft you review and publish, as evals/evals.json inside the skill (the same format skills.new ships).",
        ),
      );
    } else {
      out.push(...state.evals.map(evalCard));
    }
    return out;
  }

  rerender();
  await refresh();
}
