// Team Digest — an sx analogue of Obsidian's Periodic Notes weekly-review
// ritual. The heatmap shows a hot Tuesday; a digest says WHAT moved and
// names names. It generates as a DRAFT asset — a human reviews, annotates,
// and chooses to publish — so library health gets an archived, linkable
// history instead of a dashboard glance.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const DAY_MS = 86400_000;

/** [start, end) of the last COMPLETE ISO week, plus its label. */
function lastCompleteWeek(now) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Monday=0
  const thisMonday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const start = new Date(thisMonday.getTime() - 7 * DAY_MS);
  const end = thisMonday;
  // ISO week-numbering year AND week both come from the week's Thursday
  // — a Monday in late December can belong to next year's W01.
  const thursday = new Date(start.getTime() + 3 * DAY_MS);
  const jan4 = new Date(thursday.getFullYear(), 0, 4);
  const week1Monday = new Date(
    jan4.getFullYear(), 0, 4 - ((jan4.getDay() + 6) % 7),
  );
  const week = 1 + Math.round((thursday - week1Monday) / (7 * DAY_MS));
  return { start, end, label: `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}` };
}

function within(iso, start, end) {
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t < end.getTime();
}

export default class TeamDigest {
  onload(sx) {
    this.sx = sx;
    sx.registerCommand({
      id: "generate-digest",
      title: "Team digest for last week",
      menu: "new",
      hint: "Summarize changes and usage as a draft",
      run: () => void this.generate(),
    });
    sx.registerDashboardWidget({
      id: "team-digest",
      title: "Team digest",
      mount: (view) => void this.mountWidget(view),
    });
  }

  onunload() {}

  async mountWidget(view) {
    const saved = (await this.sx.storage.loadData().catch(() => null)) || {};
    const week = lastCompleteWeek(Date.now());
    view.el.replaceChildren();
    const box = el("div", "padding: 12px;");
    box.append(
      el(
        "div",
        "font-size: 13px; font-weight: 600;",
        saved.lastPeriod === week.label
          ? `Digest for ${week.label} generated`
          : `Digest for ${week.label} not generated yet`,
      ),
      el(
        "div",
        FAINT + "font-size: 11px; margin: 2px 0 8px;",
        "A reviewable draft summarizing last week's changes and usage.",
      ),
    );
    const btn = el(
      "button",
      "border: 1px solid var(--color-line); border-radius: 8px; background: none;" +
        "padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer;" +
        "color: var(--color-ink-soft);",
      saved.lastPeriod === week.label ? "Regenerate" : "Generate digest",
    );
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Generating…";
      await this.generate();
      btn.disabled = false;
      btn.textContent = "Regenerate";
    });
    box.append(btn);
    view.el.append(box);
  }

  async generate() {
    try {
      const week = lastCompleteWeek(Date.now());
      const prevStart = new Date(week.start.getTime() - 7 * DAY_MS);
      const [assets, events, audit] = await Promise.all([
        this.sx.assets.list(),
        this.sx.usage.events(21),
        this.sx.usage.auditEvents(21).catch(() => []),
      ]);

      // Usage per asset, this week vs the week before.
      const thisWeek = new Map();
      const prevWeek = new Map();
      const actors = new Set();
      for (const e of events) {
        if (within(e.timestamp, week.start, week.end)) {
          thisWeek.set(e.assetName, (thisWeek.get(e.assetName) || 0) + 1);
          actors.add(e.actor);
        } else if (within(e.timestamp, prevStart, week.start)) {
          prevWeek.set(e.assetName, (prevWeek.get(e.assetName) || 0) + 1);
        }
      }
      const movers = [...new Set([...thisWeek.keys(), ...prevWeek.keys()])]
        .map((name) => ({
          name,
          now: thisWeek.get(name) || 0,
          before: prevWeek.get(name) || 0,
        }))
        .map((m) => ({ ...m, delta: m.now - m.before }))
        .filter((m) => Math.abs(m.delta) >= 3)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 5);

      // Changes: audit events inside the week, grouped per asset.
      const changes = new Map();
      const authors = new Map();
      for (const e of audit) {
        if (!within(e.timestamp, week.start, week.end)) continue;
        if (e.targetType && e.targetType !== "asset") continue;
        const list = changes.get(e.target) || [];
        list.push(e);
        changes.set(e.target, list);
        if (e.actor) authors.set(e.actor, (authors.get(e.actor) || 0) + 1);
      }

      // Stale but load-bearing: used this week, untouched for 90+ days.
      const staleUsed = assets.filter((a) => {
        if (!thisWeek.has(a.name) || !a.updatedAt) return false;
        return Date.now() - new Date(a.updatedAt).getTime() > 90 * DAY_MS;
      }).slice(0, 5);

      const lines = [
        "---",
        `name: team-digest-${week.label.toLowerCase()}`,
        `description: Library digest for ${week.label} — changes, usage movers, and attention items`,
        "---",
        `# Team digest — ${week.label}`,
        "",
        "## TL;DR",
        `- ${[...thisWeek.values()].reduce((a, b) => a + b, 0)} asset uses by ${actors.size} people (prev week: ${[...prevWeek.values()].reduce((a, b) => a + b, 0)})`,
        `- ${changes.size} assets changed by ${authors.size} contributors`,
        movers[0]
          ? `- Biggest mover: ${movers[0].name} (${movers[0].delta > 0 ? "+" : ""}${movers[0].delta} uses)`
          : "- No significant usage movement",
        "",
      ];
      if (changes.size > 0) {
        lines.push("## Published & changed");
        for (const [target, list] of [...changes.entries()].slice(0, 10)) {
          const who = [...new Set(list.map((e) => e.actor.split("@")[0]))].join(", ");
          lines.push(`- \`${target}\` — ${list.length} change${list.length > 1 ? "s" : ""} by ${who}`);
        }
        lines.push("");
      }
      if (movers.length > 0) {
        lines.push("## Usage movers");
        for (const m of movers) {
          lines.push(`- \`${m.name}\`: ${m.before} → ${m.now} (${m.delta > 0 ? "+" : ""}${m.delta})`);
        }
        lines.push("");
      }
      if (staleUsed.length > 0) {
        lines.push("## Needs attention — used weekly, unedited 90+ days");
        for (const a of staleUsed) lines.push(`- \`${a.name}\``);
        lines.push("");
      }
      if (authors.size > 0) {
        lines.push("## Contributors");
        for (const [actor, n] of [...authors.entries()].sort((a, b) => b[1] - a[1])) {
          lines.push(`- ${actor.split("@")[0]}: ${n} change${n > 1 ? "s" : ""}`);
        }
      }

      const created = await this.sx.drafts.create({
        name: `team-digest-${week.label.toLowerCase()}`,
        files: [{ path: "SKILL.md", content: lines.join("\n") + "\n" }],
      });
      await this.sx.storage.saveData({ lastPeriod: week.label });
      this.sx.ui.notice(`Digest draft for ${week.label} created — review and publish it.`);
      return created;
    } catch (e) {
      this.sx.ui.notice("Couldn't generate the digest: " + e);
    }
  }
}
