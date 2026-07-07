// Team Digest — an sx analogue of Obsidian's Periodic Notes weekly-review
// ritual. The heatmap shows a hot Tuesday; a digest says WHAT moved and
// names names. It renders right in the widget for the dashboard glance,
// and can be saved as a DRAFT asset — a human reviews, annotates, and
// chooses to publish — so library health gets an archived, linkable
// history too.

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

/** The draft's markdown, serialized from the same sections the widget
 *  renders: "## " headings, "- " items, asset names in backticks. */
function toMarkdown(week, sections) {
  const lines = [
    "---",
    `name: team-digest-${week.label.toLowerCase()}`,
    `description: Library digest for ${week.label} — changes, usage movers, and attention items`,
    "---",
    `# Team digest — ${week.label}`,
    "",
  ];
  for (const section of sections) {
    lines.push(`## ${section.title}`);
    for (const item of section.items) {
      const asset = item.asset ? "`" + item.asset + "`" : "";
      lines.push("- " + [asset, item.text].filter(Boolean).join(" "));
    }
    lines.push("");
  }
  return lines.join("\n");
}

export default class TeamDigest {
  onload(sx) {
    this.sx = sx;
    sx.registerCommand({
      id: "generate-digest",
      title: "Team digest for last week",
      menu: "new",
      hint: "Summarize changes and usage as a draft",
      run: () => void this.generateDraft(),
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
      el("div", "font-size: 13px; font-weight: 600;", `Digest for ${week.label}`),
      el(
        "div",
        FAINT + "font-size: 11px; margin: 2px 0 8px;",
        "Summarizes last week's changes and usage. The digest renders here — save it as a draft to share it.",
      ),
    );
    const btn = el(
      "button",
      "border: 1px solid var(--color-line); border-radius: 8px; background: none;" +
        "padding: 5px 12px; font: inherit; font-size: 12px; cursor: pointer;" +
        "color: var(--color-ink-soft);",
      "Generate digest",
    );
    const output = el("div", "");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Generating…";
      try {
        const digest = await this.build();
        await this.sx.storage.saveData({
          lastPeriod: digest.week.label,
          sections: digest.sections,
        });
        this.renderDigest(output, digest);
      } catch (e) {
        this.sx.ui.notice("Couldn't generate the digest: " + e);
      }
      btn.disabled = false;
      btn.textContent = "Regenerate";
    });
    box.append(btn, output);
    view.el.append(box);
    // A digest generated earlier for this week survives a remount.
    if (saved.lastPeriod === week.label && Array.isArray(saved.sections)) {
      btn.textContent = "Regenerate";
      this.renderDigest(output, { week, sections: saved.sections });
    }
  }

  renderDigest(root, digest) {
    root.replaceChildren();
    const body = el(
      "div",
      "margin-top: 10px; padding-top: 4px; border-top: 1px solid var(--color-line);" +
        "max-height: 320px; overflow-y: auto;",
    );
    for (const section of digest.sections) {
      body.append(
        el(
          "div",
          FAINT +
            "font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;" +
            "padding: 8px 0 2px;",
          section.title,
        ),
      );
      for (const item of section.items) {
        const row = el("div", "font-size: 12px; padding: 1px 0; color: var(--color-ink-soft);");
        if (item.asset) {
          row.append(el("span", "color: var(--color-accent);", item.asset));
          if (item.text) row.append(document.createTextNode(" " + item.text));
        } else {
          row.textContent = item.text;
        }
        body.append(row);
      }
    }
    const save = el(
      "a",
      "display: inline-block; margin-top: 8px; font-size: 11px;" +
        "color: var(--color-accent); cursor: pointer;",
      "Save as draft",
    );
    save.addEventListener("click", () => void this.saveDraft(digest));
    root.append(body, save);
  }

  /** Command path: build and save as a draft in one step. */
  async generateDraft() {
    try {
      const digest = await this.build();
      await this.sx.storage.saveData({
        lastPeriod: digest.week.label,
        sections: digest.sections,
      });
      return await this.saveDraft(digest);
    } catch (e) {
      this.sx.ui.notice("Couldn't generate the digest: " + e);
    }
  }

  async saveDraft(digest) {
    try {
      const created = await this.sx.drafts.create({
        name: `team-digest-${digest.week.label.toLowerCase()}`,
        files: [{ path: "SKILL.md", content: toMarkdown(digest.week, digest.sections) }],
      });
      this.sx.ui.notice("Digest saved as a draft — review and publish to share it.");
      return created;
    } catch (e) {
      this.sx.ui.notice("Couldn't save the digest draft: " + e);
    }
  }

  /** Builds last week's digest as structured sections — the widget
   *  renders them and toMarkdown serializes them for the draft. */
  async build() {
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

    const sections = [
      {
        title: "TL;DR",
        items: [
          {
            text: `${[...thisWeek.values()].reduce((a, b) => a + b, 0)} asset uses by ${actors.size} people (prev week: ${[...prevWeek.values()].reduce((a, b) => a + b, 0)})`,
          },
          { text: `${changes.size} assets changed by ${authors.size} contributors` },
          movers[0]
            ? {
                asset: movers[0].name,
                text: `— biggest mover (${movers[0].delta > 0 ? "+" : ""}${movers[0].delta} uses)`,
              }
            : { text: "No significant usage movement" },
        ],
      },
    ];
    if (changes.size > 0) {
      sections.push({
        title: "Published & changed",
        items: [...changes.entries()].slice(0, 10).map(([target, list]) => ({
          asset: target,
          text: `— ${list.length} change${list.length > 1 ? "s" : ""} by ${[...new Set(list.map((e) => e.actor.split("@")[0]))].join(", ")}`,
        })),
      });
    }
    if (movers.length > 0) {
      sections.push({
        title: "Usage movers",
        items: movers.map((m) => ({
          asset: m.name,
          text: `— ${m.before} → ${m.now} (${m.delta > 0 ? "+" : ""}${m.delta})`,
        })),
      });
    }
    if (staleUsed.length > 0) {
      sections.push({
        title: "Needs attention — used weekly, unedited 90+ days",
        items: staleUsed.map((a) => ({ asset: a.name })),
      });
    }
    if (authors.size > 0) {
      sections.push({
        title: "Contributors",
        items: [...authors.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([actor, n]) => ({
            text: `${actor.split("@")[0]}: ${n} change${n > 1 ? "s" : ""}`,
          })),
      });
    }
    return { week, sections };
  }
}
