// Skill Evals — generate evals for skills, benchmark them with-vs-without
// the skill through the user's AI provider, and surface the skills that
// no longer earn their keep.
//
// Benchmarks run on THIS instance, not inside a view closure: navigating
// away doesn't kill a run, every mounted view shows its progress, and
// in-progress state persists to sx.storage so an app restart can resume.

import { findEvalsFile, parseEvals, activeEvals, skillHash } from "./evals.js";
import { loadLocal, saveLocal, loadShared, mergeSaveShared, FACTS_TTL_MS } from "./store.js";
import { runBenchmark, buildSummary, estimateCalls, isCliProvider } from "./benchmark.js";
import { mountTab } from "./ui-tab.js";
import { mountMain } from "./ui-main.js";

export default class SkillEvals {
  onload(sx) {
    this.sx = sx;
    this.activeRun = null; // {skill, reps, provider, done, total, cancel}
    this.rerenders = new Set();
    sx.registerMainView({
      id: "skill-evals",
      title: "Skill Evals",
      section: "tools",
      mount: (view) => void mountMain(this, view),
    });
    sx.registerAssetTab({
      id: "evals",
      title: "Evals",
      mount: (view, ctx) => void mountTab(this, view, ctx),
    });
    sx.registerCommand({
      id: "open-health",
      title: "Skill Evals: open dashboard",
      run: () => sx.ui.openView("skill-evals"),
    });
    // Content may have changed — force a re-hash on next look.
    sx.on("asset-published", ({ name }) => this.dropHash(name));
  }

  notify() {
    for (const fn of this.rerenders) fn();
  }

  async dropHash(name) {
    const local = await loadLocal(this.sx);
    if (local.hashes[name]) {
      delete local.hashes[name];
      await saveLocal(this.sx, local);
    }
  }

  /** Cached per-skill facts: content hash + eval counts. Re-read when the
   * asset's updatedAt moved, when the entry ages past the TTL (evals can
   * change server-side without a version bump), or when forced by the
   * Refresh button. Callers pass the local doc and save it after their
   * batch. */
  async skillFacts(local, summary, force = false) {
    const cached = local.hashes[summary.name];
    const fresh =
      cached &&
      cached.updatedAt === (summary.updatedAt || "") &&
      Date.now() - (cached.checkedAt || 0) < FACTS_TTL_MS;
    if (fresh && !force) return cached;
    const files = await this.sx.assets.readFiles(summary.name);
    const evalsFile = findEvalsFile(files);
    const evals = evalsFile ? parseEvals(evalsFile.content).evals : [];
    const facts = {
      updatedAt: summary.updatedAt || "",
      checkedAt: Date.now(),
      hash: await skillHash(files),
      evalCount: evals.length,
      activeCount: activeEvals(evals).length,
    };
    local.hashes[summary.name] = facts;
    return facts;
  }

  /** Kick off (or refuse) a benchmark for one skill. Entry point for
   * both views. */
  async startBenchmark(skillName, reps) {
    const sx = this.sx;
    if (this.activeRun) {
      sx.ui.notice(`Already benchmarking ${this.activeRun.skill} — one run at a time.`);
      return;
    }
    const provider = await sx.llm.provider().catch(() => "");
    if (!provider) {
      sx.ui.notice("No AI provider configured — set one in Settings → AI provider.");
      sx.ui.openSettings("ai");
      return;
    }
    const files = await sx.assets.readFiles(skillName);
    const evalsFile = findEvalsFile(files);
    const evals = evalsFile ? parseEvals(evalsFile.content).evals : [];
    const active = activeEvals(evals);
    if (!active.length) {
      sx.ui.notice(`${skillName} has no active evals — generate some first.`);
      return;
    }
    const calls = estimateCalls(active.length, reps);
    const slow = isCliProvider(provider)
      ? " CLI providers can take minutes per call, one at a time."
      : "";
    const ok = await sx.ui.confirm(
      `Run ${calls} AI calls against "${provider}" (${active.length} evals × with/without × ${reps} run${reps > 1 ? "s" : ""}, plus grading)?${slow}`,
      "Run benchmark",
    );
    if (!ok) return;
    await this.execute({ skillName, reps, provider, files, evals, active, priorCells: [] });
  }

  /** Resume the persisted in-progress run, discarding it if the skill's
   * content changed since it started. */
  async resumeBenchmark() {
    const sx = this.sx;
    if (this.activeRun) return;
    const local = await loadLocal(sx);
    const saved = local.inProgress;
    if (!saved) return;
    const files = await sx.assets.readFiles(saved.skill);
    const hash = await skillHash(files);
    if (hash !== saved.skillHash) {
      local.inProgress = null;
      await saveLocal(sx, local);
      sx.ui.notice(`${saved.skill} changed since the interrupted run — start a fresh benchmark.`);
      this.notify();
      return;
    }
    const evalsFile = findEvalsFile(files);
    const evals = evalsFile ? parseEvals(evalsFile.content).evals : [];
    await this.execute({
      skillName: saved.skill,
      reps: saved.reps,
      provider: saved.provider,
      files,
      evals,
      active: activeEvals(evals),
      priorCells: saved.cells || [],
    });
  }

  async discardInProgress() {
    const local = await loadLocal(this.sx);
    local.inProgress = null;
    await saveLocal(this.sx, local);
    this.notify();
  }

  async execute({ skillName, reps, provider, files, evals, active, priorCells }) {
    const sx = this.sx;
    const hash = await skillHash(files);
    const evalsHash = await skillHash([
      { path: "evals", content: JSON.stringify(active.map((e) => e.eval_key)) },
    ]);
    this.activeRun = {
      skill: skillName,
      reps,
      provider,
      done: priorCells.length,
      total: active.length * 2 * reps,
      cancel: false,
    };
    this.notify();

    let lastModel = "";
    const progressCells = priorCells.slice();
    const { cells, cancelled } = await runBenchmark({
      sx: {
        llm: {
          complete: async (req) => {
            const res = await sx.llm.complete(req);
            // The executor model is the one answering evals, not judging.
            if (!req.schema) lastModel = res.model || lastModel;
            return res;
          },
        },
      },
      files,
      evals: active,
      reps,
      provider,
      priorCells,
      onCell: async (cell, done, total) => {
        progressCells.push(cell);
        if (this.activeRun) {
          this.activeRun.done = done;
          this.activeRun.total = total;
        }
        const local = await loadLocal(sx);
        local.inProgress = { skill: skillName, reps, provider, skillHash: hash, cells: progressCells };
        await saveLocal(sx, local);
        this.notify();
      },
      shouldCancel: () => this.activeRun?.cancel,
    });

    this.activeRun = null;
    if (cancelled) {
      sx.ui.notice(`Benchmark paused with ${cells.length} cells done — resume from the skill's Evals tab.`);
      this.notify();
      return;
    }

    const at = Date.now();
    const by = await sx.app.currentUser().catch(() => "");
    const { summary, sharedRow } = buildSummary({
      cells,
      evals: { total: evals.length, active: active.length },
      reps,
      provider,
      model: lastModel,
      skillHash: hash,
      evalsHash,
      by,
      at,
    });
    const local = await loadLocal(sx);
    local.runs[skillName] = [...(local.runs[skillName] || []), summary];
    local.detail[skillName] = { at, cells };
    local.inProgress = null;
    await saveLocal(sx, local);

    const names = (await sx.assets.list().catch(() => [])).map((a) => a.name);
    await mergeSaveShared(sx, names, (doc) => {
      doc.skills[skillName] = sharedRow;
    }).catch(() => sx.ui.notice("Benchmark saved locally; sharing the summary row failed."));

    sx.ui.notice(
      `Benchmark done: with ${Math.round(summary.agg.with.passMean * 100)}% vs baseline ${Math.round(
        summary.agg.without.passMean * 100,
      )}% (${summary.agg.delta >= 0 ? "+" : ""}${summary.agg.delta}).`,
    );
    this.notify();
  }

  cancelBenchmark() {
    if (this.activeRun) this.activeRun.cancel = true;
  }

  // Small shared reads the views use.
  loadLocal() {
    return loadLocal(this.sx);
  }
  loadShared() {
    return loadShared(this.sx);
  }
  mergeSaveShared(names, mutate) {
    return mergeSaveShared(this.sx, names, mutate);
  }
}
