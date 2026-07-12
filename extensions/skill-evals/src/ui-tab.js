// The per-skill "Evals" tab: see the skill's evals, generate new ones
// into a draft, run/resume benchmarks, and read the last run's verdict.

import { el, chip, rateBar, fmtPct, fmtAgo, FAINT, SOFT, CARD, BUTTON, PRIMARY, NOTE } from "./dom.js";
import { findEvalsFile, parseEvals, activeEvals } from "./evals.js";
import { generateEvals, writeEvalsDraft, DEFAULT_COUNT } from "./generate.js";

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
    latest: null, // newest local RunSummary
    detail: null, // local RunDetail for this skill
    sharedRow: null,
    inProgress: null,
    busy: "",
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
    const [assets, provider, local, shared] = await Promise.all([
      sx.assets.list().catch(() => []),
      sx.llm.provider().catch(() => ""),
      plugin.loadLocal(),
      plugin.loadShared(),
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
    state.latest = (local.runs[name] || []).at(-1) || null;
    state.detail = local.detail[name] || null;
    state.inProgress = local.inProgress?.skill === name ? local.inProgress : null;
    state.sharedRow = shared.skills[name] || null;
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

  function verdictStrip() {
    const wrap = el("div", CARD);
    const counts = `${state.evals.length} evals · ${activeEvals(state.evals).length} active`;
    const head = el("div", "display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;");
    head.append(el("div", "font-weight: 600; font-size: 13px;", counts));
    const s = state.latest;
    if (s) {
      head.append(
        el(
          "span",
          FAINT + "font-size: 12px;",
          `Last benchmark ${fmtAgo(s.at)} on ${s.provider}${s.errors ? ` · ${s.errors} cells failed to grade` : ""}`,
        ),
      );
      wrap.append(head);
      const bars = el("div", "display: flex; gap: 18px; flex-wrap: wrap; align-items: center;");
      bars.append(rateBar("with", s.agg.with.passMean), rateBar("without", s.agg.without.passMean));
      const deltaTone = s.agg.delta > 0.05 ? "accent" : "danger";
      bars.append(chip(`delta ${s.agg.delta >= 0 ? "+" : ""}${s.agg.delta}`, deltaTone));
      if (s.agg.annotation) bars.append(el("span", SOFT + "font-size: 12px;", s.agg.annotation));
      wrap.append(bars);
    } else if (state.sharedRow) {
      const r = state.sharedRow;
      head.append(
        el(
          "span",
          FAINT + "font-size: 12px;",
          `Benchmarked by ${r.by || "a teammate"} ${fmtAgo(r.at * 1000)} on ${r.pm}: with ${fmtPct(
            r.wp,
          )} vs baseline ${fmtPct(r.bp)} (delta ${r.d >= 0 ? "+" : ""}${r.d}).`,
        ),
      );
      wrap.append(head);
    } else {
      head.append(el("span", FAINT + "font-size: 12px;", "Never benchmarked."));
      wrap.append(head);
    }
    return wrap;
  }

  function actionsRow() {
    const row = el("div", "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    const gen = el("button", state.evals.length ? BUTTON : PRIMARY, `Generate ${DEFAULT_COUNT} evals`);
    gen.onclick = () => void onGenerate(false);
    row.append(gen);
    if (state.evals.length) {
      const regen = el("button", BUTTON, "Regenerate all…");
      regen.onclick = () => void onGenerate(true);
      row.append(regen);

      const reps = el("select", BUTTON + "padding: 4px 6px;");
      for (const n of [1, 3]) {
        const opt = el("option", "", `${n} run${n > 1 ? "s" : ""}/config`);
        opt.value = String(n);
        reps.append(opt);
      }
      reps.value = String(state.reps);
      reps.onchange = () => (state.reps = Number(reps.value));
      const run = el("button", PRIMARY, "Run benchmark");
      run.onclick = () => void plugin.startBenchmark(name, state.reps).then(refresh);
      row.append(reps, run);
    }
    return row;
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
      const cancel = el("button", BUTTON, "Cancel");
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
    const resume = el("button", PRIMARY, "Resume");
    resume.onclick = () => void plugin.resumeBenchmark().then(refresh);
    const discard = el("button", BUTTON, "Discard");
    discard.onclick = () => void plugin.discardInProgress().then(refresh);
    row.append(resume, discard);
    return row;
  }

  function evalCard(spec) {
    const card = el("div", CARD + (spec.is_active ? "" : "opacity: 0.55;"));
    const head = el("div", "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    head.append(
      el("code", "font-family: var(--font-mono); font-size: 12px;", spec.eval_key),
      chip(spec.category, spec.category === "edge-case" ? "accent" : "faint"),
    );
    if (!spec.is_active) head.append(chip("inactive", "faint"));
    const per = state.latest?.perEval.find((p) => p.key === spec.eval_key);
    if (per) {
      head.append(
        chip(
          per.status.replace(/_/g, " "),
          per.status === "passing" ? "accent" : per.status === "failing" ? "danger" : "faint",
        ),
      );
    }
    card.append(head, el("div", "font-size: 13px; line-height: 1.45;", spec.prompt));
    const exp = el("ul", "margin: 0; padding-left: 18px; font-size: 12px;" + SOFT);
    for (const x of spec.expectations) exp.append(el("li", "", x));
    card.append(exp);
    if (per) {
      const bars = el("div", "display: flex; gap: 18px; flex-wrap: wrap;");
      bars.append(rateBar("with", per.withPass), rateBar("without", per.withoutPass));
      card.append(bars);
    }
    const cells = (state.detail?.cells || []).filter((c) => c.evalKey === spec.eval_key);
    if (cells.length) {
      const toggle = el(
        "a",
        FAINT + "font-size: 12px; cursor: pointer; text-decoration: underline;",
        state.expanded.has(spec.eval_key) ? "Hide last run detail" : "Show last run detail",
      );
      toggle.onclick = () => {
        state.expanded.has(spec.eval_key)
          ? state.expanded.delete(spec.eval_key)
          : state.expanded.add(spec.eval_key);
        rerender();
      };
      card.append(toggle);
      if (state.expanded.has(spec.eval_key)) {
        for (const c of cells) {
          const box = el("div", NOTE);
          const title = c.error
            ? `${c.config} · run ${c.rep} · errored: ${c.error}`
            : `${c.config} · run ${c.rep} · ${fmtPct(c.passRate)}`;
          box.append(el("div", "font-weight: 600; font-size: 12px;", title));
          for (const g of c.grades || []) {
            box.append(el("div", (g.pass ? SOFT : "color: var(--color-danger);") + "font-size: 12px;", `${g.pass ? "✓" : "✗"} ${g.text} — ${g.reason}`));
          }
          if (c.output) {
            box.append(el("div", FAINT + "font-size: 11px; white-space: pre-wrap; font-family: var(--font-mono);", c.output));
          }
          card.append(box);
        }
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
    out.push(verdictStrip(), actionsRow());
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
