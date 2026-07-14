// Skill Quality — the skills.new Quality tab for every vault type.
// On skills.new the scores are the server's own evaluation, surfaced
// as-is; on path/git vaults the extension evaluates locally through the
// user's AI provider and stores records in the vault's quality store.
//
// Re-evaluations run on THIS instance, not inside a view closure:
// navigating away doesn't kill a run, and every mounted view shows its
// progress.

import { evaluateLocally } from "./evaluate.js";
import { mountTab } from "./ui-tab.js";
import { mountMain } from "./ui-main.js";

const POLL_MS = 4000;
const POLL_LIMIT_MS = 5 * 60 * 1000;

export default class SkillQuality {
  onload(sx) {
    this.sx = sx;
    this.rerenders = new Set();
    this.refreshers = new Map(); // asset -> refetch fn for the mounted tab
    this.busy = new Map(); // asset -> "server" | "local"
    this.boardRefresh = null; // the mounted board's recollect fn
    sx.registerAssetTab({
      id: "quality",
      title: "Quality",
      mount: (view, ctx) => void mountTab(this, view, ctx),
    });
    sx.registerMainView({
      id: "skill-quality",
      title: "Skill Quality",
      section: "tools",
      mount: (view) => void mountMain(this, view),
    });
    sx.registerCommand({
      id: "open-quality-board",
      title: "Skill Quality: open board",
      run: () => sx.ui.openView("skill-quality"),
    });
  }

  onunload() {
    this.busy.clear();
  }

  notify() {
    for (const fn of this.rerenders) fn();
  }

  refresh(name) {
    const refetch = this.refreshers.get(name);
    if (refetch) void refetch();
    else this.notify();
    if (this.boardRefresh) void this.boardRefresh();
  }

  /** Kick off (or refuse) a re-evaluation for one skill. The backend
   * decides who evaluates: "server" (skills.new runs it; we poll) or
   * "local" (we run the rubric through the user's AI provider). */
  async reevaluate(name) {
    const sx = this.sx;
    if (this.busy.has(name)) {
      sx.ui.notice(`Already evaluating ${name}.`);
      return;
    }

    let mode;
    this.busy.set(name, "server");
    this.notify();
    try {
      ({ mode } = await sx.quality.reevaluate(name));
    } catch (err) {
      this.busy.delete(name);
      sx.ui.notice(`Evaluation failed: ${err?.message || err}`);
      this.refresh(name);
      return;
    }

    if (mode === "server") {
      // The server ran (or is running) the evaluation. Usually the
      // mutation returns after the evaluation finished, so the first
      // poll settles immediately; keep polling in case it went async.
      try {
        await this.pollUntilSettled(name);
        sx.ui.notice(`${name} re-evaluated.`);
      } catch (err) {
        sx.ui.notice(`Evaluation didn't finish: ${err?.message || err}`);
      } finally {
        this.busy.delete(name);
        this.refresh(name);
      }
      return;
    }

    // Local: this vault has no evaluator — run the rubric ourselves.
    this.busy.delete(name);
    this.notify();
    const provider = await sx.llm.provider().catch(() => "");
    if (!provider) {
      sx.ui.notice("No AI provider configured — set one in Settings → AI provider.");
      sx.ui.openSettings("ai");
      return;
    }
    const ok = await sx.ui.confirm(
      `Evaluate "${name}" with "${provider}" (one AI call scoring structure, actionability, content, and completeness)?`,
      "Evaluate",
    );
    if (!ok) return;

    this.busy.set(name, "local");
    this.notify();
    try {
      const [files, assets] = await Promise.all([
        sx.assets.readFiles(name),
        sx.assets.list().catch(() => []),
      ]);
      const record = await evaluateLocally(sx, {
        name,
        description: assets.find((a) => a.name === name)?.description || "",
        files,
      });
      await sx.quality.add(name, record);
      sx.ui.notice(`${name} evaluated: ${record.overall}/100.`);
    } catch (err) {
      sx.ui.notice(`Evaluation failed: ${err?.message || err}`);
    } finally {
      this.busy.delete(name);
      this.refresh(name);
    }
  }

  /** Poll sx.quality.get until the server reports evaluating=false. */
  async pollUntilSettled(name) {
    const deadline = Date.now() + POLL_LIMIT_MS;
    for (;;) {
      const doc = await this.sx.quality.get(name);
      if (!doc.evaluating) return doc;
      if (Date.now() > deadline) {
        throw new Error("the server is still evaluating — check back shortly");
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}
