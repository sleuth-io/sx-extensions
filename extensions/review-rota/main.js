// Review Rota — Obsidian's spaced-repetition review plugins, translated
// to the thing a team library actually needs: every asset carries a
// review due date that adapts to how heavily it's used, reviews rotate
// fairly across the team, and verdicts are shared state (storage:shared)
// so nobody reviews what a teammate just cleared. Publishing an asset
// resets its clock.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const BUTTON =
  "padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 500;" +
  "border: 1px solid var(--color-line); border-radius: 8px; cursor: pointer;" +
  "background: var(--color-surface); color: var(--color-ink);";

const DAY = 86400000;
const BASE_INTERVAL = 30; // days, first review cycle
const GROWTH = 1.5; // each clean review stretches the interval…
// …up to a cap set by how much the asset is actually used: heavily used
// assets never go longer than a quarter unreviewed, dormant ones can
// sleep for a year.
const CAPS = { heavy: 90, medium: 180, light: 365 };

/** Deterministic 32-bit hash — fuzz and assignment must agree on every
 * machine, so no randomness anywhere. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function usageTier(events90) {
  if (events90 >= 20) return "heavy";
  if (events90 >= 5) return "medium";
  return "light";
}

/** Due date: lastReview + interval, ±10% deterministic fuzz so a bulk
 * import doesn't make the whole library fall due the same Monday. */
function dueDate(assetName, lastReviewMs, intervalDays) {
  const fuzz = 1 + ((hash(assetName) % 2001) - 1000) / 10000; // 0.9–1.1
  return lastReviewMs + intervalDays * fuzz * DAY;
}

/** Fair, stable assignment: everyone sees the same assignee for the
 * same asset+due-week without any coordination. */
function assignee(assetName, dueMs, pool) {
  if (pool.length === 0) return "";
  const week = Math.floor(dueMs / (7 * DAY));
  return pool[hash(assetName + ":" + week) % pool.length];
}

export default class ReviewRota {
  onload(sx) {
    this.sx = sx;
    this.filter = "due";
    sx.registerMainView({
      id: "rota",
      title: "Review Rota",
      mount: (view) => void this.mount(view),
    });
    // A publish IS a review — whoever shipped the new revision just
    // looked at the whole asset.
    sx.on("asset-published", ({ name }) => void this.onPublished(name));
    sx.onBeforePublish((ctx) => this.publishGate(ctx));
  }

  onunload() {}

  async state() {
    const s = await this.sx.sharedStorage.load().catch(() => null);
    return s && typeof s === "object" && s.assets ? s : { assets: {} };
  }

  entry(state, name) {
    return state.assets[name] || {};
  }

  async saveVerdict(name, mutate) {
    const state = await this.state();
    const e = this.entry(state, name);
    mutate(e);
    e.history = (e.history || []).slice(-4);
    state.assets[name] = e;
    await this.sx.sharedStorage.save(state);
  }

  // ---- Rota computation ----

  async rows() {
    const [assets, events, userStats, teams, me, state] = await Promise.all([
      this.sx.assets.list(),
      this.sx.usage.events(90),
      this.sx.usage.userStats(30),
      this.sx.teams.list().catch(() => []),
      this.sx.app.currentUser().catch(() => ""),
      this.state(),
    ]);
    const use90 = new Map();
    const use30 = new Map();
    const cutoff30 = Date.now() - 30 * DAY;
    for (const ev of events) {
      use90.set(ev.assetName, (use90.get(ev.assetName) || 0) + 1);
      if (new Date(ev.timestamp).getTime() >= cutoff30) {
        use30.set(ev.assetName, (use30.get(ev.assetName) || 0) + 1);
      }
    }
    // The reviewer pool: team members if teams exist, otherwise everyone
    // the vault knows. Sorted for cross-machine determinism.
    let pool = [...new Set(teams.flatMap((t) => t.members))];
    if (pool.length === 0) pool = [...(userStats.knownUsers || [])];
    pool.sort();

    const now = Date.now();
    const rows = [];
    for (const a of assets) {
      const e = this.entry(state, a.name);
      if (e.deprecated) continue;
      const interval = e.intervalDays || BASE_INTERVAL;
      const last = e.lastReview
        ? new Date(e.lastReview).getTime()
        : a.updatedAt
          ? new Date(a.updatedAt).getTime()
          : now - BASE_INTERVAL * DAY; // unknown age: due now
      const due = dueDate(a.name, last, interval);
      const overdueDays = Math.max(0, (now - due) / DAY);
      const priority = overdueDays * Math.log2(2 + (use30.get(a.name) || 0));
      rows.push({
        asset: a,
        entry: e,
        interval,
        due,
        overdueDays,
        priority,
        tier: usageTier(use90.get(a.name) || 0),
        use30: use30.get(a.name) || 0,
        assignee: assignee(a.name, due, pool),
      });
    }
    rows.sort((x, y) => y.priority - x.priority || x.due - y.due);
    return { rows, me };
  }

  // ---- Verdicts ----

  async markReviewed(name, tier) {
    await this.saveVerdict(name, (e) => {
      const current = e.intervalDays || BASE_INTERVAL;
      e.intervalDays = Math.min(Math.round(current * GROWTH), CAPS[tier]);
      e.lastReview = new Date().toISOString();
      e.flag = null;
      e.flagNote = null;
      (e.history = e.history || []).push({
        at: e.lastReview,
        by: this.myEmail,
        verdict: "reviewed",
      });
    });
    this.sx.ui.notice(`${name}: reviewed — next review in a longer cycle`);
  }

  async markNeedsUpdate(name, note) {
    await this.saveVerdict(name, (e) => {
      e.flag = "needs-update";
      e.flagNote = note;
      e.flagBy = this.myEmail;
      (e.history = e.history || []).push({
        at: new Date().toISOString(),
        by: this.myEmail,
        verdict: "needs-update",
      });
    });
    this.sx.ui.notice(`${name}: flagged as needing an update`);
  }

  async deprecate(name) {
    const ok = await this.sx.ui.confirm(
      `Mark “${name}” as deprecated? Its status changes for everyone (a new metadata revision) and it leaves the rota.`,
      "Deprecate",
    );
    if (!ok) return;
    await this.sx.writeAssetMetadata(name, { status: "deprecated" });
    await this.saveVerdict(name, (e) => {
      e.deprecated = true;
      (e.history = e.history || []).push({
        at: new Date().toISOString(),
        by: this.myEmail,
        verdict: "deprecate",
      });
    });
    this.sx.ui.notice(`${name}: deprecated`);
  }

  async onPublished(name) {
    const state = await this.state();
    // Only write when there's something to reset — publishes are common
    // and every save syncs (and commits, on git vaults).
    const e = this.entry(state, name);
    if (!e.lastReview && !e.flag) return;
    await this.saveVerdict(name, (entry) => {
      entry.lastReview = new Date().toISOString();
      entry.flag = null;
      entry.flagNote = null;
    });
  }

  async publishGate(ctx) {
    const state = await this.state();
    const e = this.entry(state, ctx.name);
    if (e.flag === "needs-update") {
      return [
        {
          message: `${ctx.name} is flagged “needs update”${e.flagBy ? " by " + e.flagBy : ""}`,
          detail:
            (e.flagNote ? e.flagNote + " — " : "") +
            "publishing clears the flag and resets its review clock.",
        },
      ];
    }
  }

  // ---- The view ----

  async mount(view) {
    const root = view.el;
    root.style.cssText = "max-width: 860px;";
    root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Loading rota…"));
    let disposed = false;
    view.onDispose(() => {
      disposed = true;
    });
    const draw = async () => {
      const { rows, me } = await this.rows();
      this.myEmail = me;
      if (disposed) return;
      root.replaceChildren();

      const header = el("div", "display: flex; gap: 8px; align-items: center; margin-bottom: 12px;");
      const dueCount = rows.filter((r) => r.overdueDays > 0).length;
      header.appendChild(
        el(
          "div",
          "font-size: 13px; font-weight: 600; color: var(--color-ink);",
          dueCount ? `${dueCount} asset${dueCount === 1 ? "" : "s"} due for review` : "Nothing due — the library is current",
        ),
      );
      const spacer = el("div", "flex: 1;");
      header.appendChild(spacer);
      for (const f of ["due", "all"]) {
        const b = el(
          "button",
          BUTTON + (this.filter === f ? "border-color: var(--color-accent); color: var(--color-accent);" : ""),
          f === "due" ? "Due" : "Everything",
        );
        b.onclick = () => {
          this.filter = f;
          void draw();
        };
        header.appendChild(b);
      }
      root.appendChild(header);

      const visible = this.filter === "due" ? rows.filter((r) => r.overdueDays > 0) : rows;
      if (visible.length === 0) {
        root.appendChild(
          el(
            "div",
            FAINT + "font-size: 12px; padding: 16px 0;",
            this.filter === "due"
              ? "No reviews due. Verdicts and clocks are shared with your whole team."
              : "No assets yet.",
          ),
        );
        return;
      }

      const list = el("div", "display: flex; flex-direction: column; gap: 6px;");
      for (const r of visible) list.appendChild(this.row(r, me, draw));
      root.appendChild(list);
      root.appendChild(
        el(
          "div",
          FAINT + "font-size: 11px; margin-top: 12px;",
          "Cycles start at 30 days and stretch ×1.5 per clean review, capped by usage " +
            "(heavy 90d, medium 180d, light 365d). Assignments rotate deterministically; " +
            "publishing an asset counts as a review.",
        ),
      );
    };
    await draw();
  }

  row(r, me, redraw) {
    const wrap = el(
      "div",
      "display: flex; gap: 10px; align-items: center; padding: 8px 10px;" +
        "border: 1px solid var(--color-line); border-radius: 10px; background: var(--color-surface);",
    );
    const info = el("div", "flex: 1; min-width: 0;");
    const title = el("div", "display: flex; gap: 6px; align-items: baseline;");
    const nameLink = el(
      "a",
      "font-size: 13px; font-weight: 600; color: var(--color-ink); cursor: pointer;" +
        "text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
      r.asset.name,
    );
    nameLink.onclick = () => this.sx.ui.openAsset(r.asset.name);
    title.appendChild(nameLink);
    if (r.entry.flag === "needs-update") {
      title.appendChild(
        el(
          "span",
          "font-size: 10px; padding: 1px 6px; border-radius: 999px;" +
            "background: var(--color-accent-soft); color: var(--color-accent);",
          "needs update",
        ),
      );
    }
    info.appendChild(title);
    const overdue = r.overdueDays > 0;
    const dueText = overdue
      ? `${Math.ceil(r.overdueDays)}d overdue`
      : `due in ${Math.max(1, Math.round((r.due - Date.now()) / DAY))}d`;
    const mine = me && r.assignee === me;
    info.appendChild(
      el(
        "div",
        "font-size: 11px; " + (overdue ? "color: var(--color-danger);" : FAINT),
        `${dueText} · ${r.interval}d cycle (${r.tier} use) · ` +
          (r.assignee ? (mine ? "assigned to you" : `assigned to ${r.assignee}`) : "unassigned") +
          (r.entry.flagNote ? ` · “${r.entry.flagNote}”` : ""),
      ),
    );
    wrap.appendChild(info);

    const actions = el("div", "display: flex; gap: 6px; flex-shrink: 0;");
    const reviewed = el("button", BUTTON, "Reviewed");
    reviewed.onclick = async () => {
      await this.markReviewed(r.asset.name, r.tier);
      void redraw();
    };
    const needs = el("button", BUTTON, "Needs update");
    needs.onclick = () => {
      // Swap the action row for an inline note input (no window.prompt
      // in the app webview).
      actions.replaceChildren();
      const note = el(
        "input",
        "padding: 4px 8px; font: inherit; font-size: 12px; width: 200px;" +
          "border: 1px solid var(--color-line); border-radius: 8px;" +
          "background: var(--color-canvas); color: var(--color-ink); outline: none;",
      );
      note.placeholder = "What does it need?";
      const save = el("button", BUTTON, "Flag");
      save.onclick = async () => {
        await this.markNeedsUpdate(r.asset.name, note.value.trim());
        void redraw();
      };
      const cancel = el("button", BUTTON, "Cancel");
      cancel.onclick = () => void redraw();
      note.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save.click();
        if (e.key === "Escape") cancel.click();
      });
      actions.append(note, save, cancel);
      note.focus();
    };
    const dep = el("button", BUTTON + "color: var(--color-danger);", "Deprecate");
    dep.onclick = async () => {
      await this.deprecate(r.asset.name);
      void redraw();
    };
    actions.append(reviewed, needs, dep);
    wrap.appendChild(actions);
    return wrap;
  }
}
