// Team Doctor — the Collection Doctor's health-score frame pointed at a
// team, folding in Obsidian's Vault Changelog idea as a this-week digest.
// A team's library rots differently from a collection's: shares go stale,
// assets sit unused by the very people they were shared with, and members
// quietly stop engaging. One score, findings you can click straight into,
// and a recent-activity feed for standups.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

// Every read here is vault-wide (all assets, all teams, the usage and
// audit windows) — none is team-specific; the report filters to the team
// client-side. Cache them on the instance for a short window so
// re-opening the tab or switching between teams doesn't re-hit the vault.
// Sub-TTL staleness is invisible for a health view; failures aren't
// cached, so a blip doesn't stick.
const CACHE_TTL = 60_000;

const DAY = 86400000;
const THIN_DESCRIPTION = 40; // chars — below this, agents can't route to it
const STALE_DAYS = 180;
const UNUSED_DAYS = 90; // matches the single events(90) call
const INACTIVE_DAYS = 30;
const DIGEST_DAYS = 7;

// Score = 100 minus weighted deductions, capped per check so one systemic
// problem reads as "fix this class of thing", not an automatic zero.
const CHECKS = [
  {
    id: "unused",
    title: "Shared, but the team doesn't use it",
    weight: 6,
    cap: 24,
    hint: `No usage by any team member in ${UNUSED_DAYS} days — unshare it, or show the team what it's for.`,
  },
  {
    id: "stale",
    title: "Stale shares",
    weight: 6,
    cap: 24,
    hint: `Not updated in over ${STALE_DAYS} days — still accurate for this team?`,
  },
  {
    id: "description",
    title: "Missing or thin descriptions",
    weight: 8,
    cap: 30,
    hint: "Descriptions under 40 characters give teammates and agents nothing to route on.",
  },
  {
    id: "inactive",
    title: "Inactive members",
    weight: 4,
    cap: 16,
    hint: `No activity in ${INACTIVE_DAYS} days — maybe onboarding stalled, maybe the roster is stale.`,
  },
];

function scoreColor(score) {
  if (score >= 85) return "#0e9f6e";
  if (score >= 60) return "#d97706";
  return "var(--color-danger)";
}

function scoreLabel(score) {
  if (score >= 85) return "Healthy";
  if (score >= 60) return "Needs attention";
  return "Unhealthy";
}

function timeAgo(iso) {
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / DAY));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export default class TeamDoctor {
  onload(sx) {
    this.sx = sx;
    this.cache = new Map();
    sx.registerTeamView({
      id: "doctor",
      title: "Team Health",
      mount: (view, ctx) => void this.mount(view, ctx.team),
    });
  }

  onunload() {}

  /** Memoize a bulk read on the instance for CACHE_TTL. Concurrent
   *  callers share one in-flight promise; a rejection is evicted so the
   *  next call retries instead of serving a cached failure. */
  cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.promise;
    const promise = Promise.resolve()
      .then(fn)
      .catch((e) => {
        if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
        throw e;
      });
    this.cache.set(key, { at: Date.now(), promise });
    return promise;
  }

  buildReport(team, shared, events) {
    const now = Date.now();
    const members = new Set(team.members.map((m) => m.toLowerCase()));
    // Usage by team members only — a stranger using the asset doesn't
    // make it useful to THIS team.
    const teamUse = new Map();
    const lastActive = new Map();
    for (const ev of events) {
      const actor = (ev.actor || "").toLowerCase();
      if (!members.has(actor)) continue;
      teamUse.set(ev.assetName, (teamUse.get(ev.assetName) || 0) + 1);
      const t = new Date(ev.timestamp).getTime();
      if (t > (lastActive.get(actor) || 0)) lastActive.set(actor, t);
    }

    const findings = { unused: [], stale: [], description: [], inactive: [] };
    for (const m of shared) {
      if ((teamUse.get(m.name) || 0) === 0) {
        findings.unused.push({
          name: m.name,
          detail: `no team usage in ${UNUSED_DAYS} days`,
          asset: true,
        });
      }
      if (m.updatedAt) {
        const age = (now - new Date(m.updatedAt).getTime()) / DAY;
        if (age > STALE_DAYS) {
          findings.stale.push({
            name: m.name,
            detail: `last updated ${Math.round(age)}d ago`,
            asset: true,
          });
        }
      }
      const desc = (m.description || "").trim();
      if (desc.length < THIN_DESCRIPTION) {
        findings.description.push({
          name: m.name,
          detail: desc ? `description is only ${desc.length} chars` : "no description",
          asset: true,
        });
      }
    }
    for (const member of team.members) {
      const last = lastActive.get(member.toLowerCase());
      if (!last) {
        findings.inactive.push({
          name: member,
          detail: `no activity in the last ${UNUSED_DAYS} days`,
        });
      } else if ((now - last) / DAY > INACTIVE_DAYS) {
        findings.inactive.push({
          name: member,
          detail: `last active ${Math.round((now - last) / DAY)}d ago`,
        });
      }
    }

    let score = 100;
    const sections = [];
    for (const check of CHECKS) {
      const rows = findings[check.id];
      const applied = Math.min(check.cap, check.weight * rows.length);
      score -= applied;
      for (const row of rows) row.impact = rows.length ? applied / rows.length : 0;
      sections.push({ check, rows, applied });
    }
    const fixFirst = sections
      .flatMap((s) => s.rows.map((r) => ({ ...r, title: s.check.title })))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 3);
    return { score: Math.max(0, Math.round(score)), sections, fixFirst };
  }

  /** This-week digest: what changed for the team's assets, straight from
   *  the audit stream — the standup answer to "anything new?". */
  digestRows(audit, sharedNames, teamName) {
    const interesting = new Set([
      "asset.created",
      "asset.updated",
      "install.set",
      "install.removed",
      "team.member_added",
      "team.member_removed",
    ]);
    return audit
      .filter((ev) => {
        if (!interesting.has(ev.event)) return false;
        if (ev.event.startsWith("team.")) return ev.target === teamName;
        return sharedNames.has(ev.target);
      })
      .slice(0, 8);
  }

  async mount(view, teamName) {
    const root = view.el;
    root.style.cssText = "max-width: 760px;";
    root.replaceChildren(
      el("div", FAINT + "font-size: 12px; padding: 8px 0;", "Checking team health…"),
    );
    let disposed = false;
    view.onDispose(() => {
      disposed = true;
    });
    try {
      const [assets, teams, events, audit] = await Promise.all([
        this.cached("assets", () => this.sx.assets.list()),
        this.cached("teams", () => this.sx.teams.list()),
        // Usage and audit degrade to empty rather than failing the view —
        // the metadata checks still render a partial report.
        this.cached(`events:${UNUSED_DAYS}`, () => this.sx.usage.events(UNUSED_DAYS)).catch(() => []),
        this.cached(`audit:${DIGEST_DAYS}`, () => this.sx.usage.auditEvents(DIGEST_DAYS)).catch(() => []),
      ]);
      if (disposed) return;
      const team = teams.find((t) => t.name === teamName);
      if (!team) {
        this.empty(root, "This team no longer exists.");
        return;
      }
      const byName = new Map(assets.map((a) => [a.name, a]));
      const shared = (team.assets || []).map((n) => byName.get(n)).filter(Boolean);
      if (shared.length === 0 && team.members.length === 0) {
        this.empty(root, "No members and nothing shared yet — the health report appears once the team has either.");
        return;
      }
      const report = this.buildReport(team, shared, events);
      const digest = this.digestRows(audit, new Set(shared.map((s) => s.name)), teamName);
      this.render(root, report, team, shared.length, digest);
    } catch (e) {
      if (disposed) return;
      root.replaceChildren(
        el(
          "div",
          FAINT + "font-size: 12px; padding: 8px 0;",
          "Couldn't compute team health: " + (e?.message || e),
        ),
      );
    }
  }

  empty(root, message) {
    root.replaceChildren(el("div", FAINT + "font-size: 13px; padding: 16px 0;", message));
  }

  render(root, report, team, sharedCount, digest) {
    root.replaceChildren();

    // Score header.
    const head = el(
      "div",
      "display: flex; align-items: baseline; gap: 14px; padding: 10px 0 14px;",
    );
    head.append(
      el(
        "div",
        `font-size: 40px; font-weight: 700; color: ${scoreColor(report.score)};`,
        String(report.score),
      ),
      el("div", "font-size: 15px; font-weight: 600;", scoreLabel(report.score)),
      el(
        "div",
        FAINT + "font-size: 12px;",
        `${team.members.length} member${team.members.length === 1 ? "" : "s"} · ${sharedCount} shared asset${sharedCount === 1 ? "" : "s"}`,
      ),
    );
    root.append(head);

    // Fix-first strip.
    if (report.fixFirst.length > 0 && report.score < 100) {
      const strip = el(
        "div",
        "display: flex; flex-direction: column; gap: 4px; padding: 0 0 12px;",
      );
      strip.append(el("div", FAINT + "font-size: 11px; font-weight: 600;", "FIX FIRST"));
      for (const f of report.fixFirst) {
        strip.append(el("div", "font-size: 12px;", `${f.name} — ${f.detail}`));
      }
      root.append(strip);
    }

    // Findings per check.
    for (const { check, rows, applied } of report.sections) {
      const section = el("div", "padding: 10px 0; border-top: 1px solid var(--color-line);");
      const title = el("div", "display: flex; align-items: baseline; gap: 8px;");
      title.append(
        el("div", "font-size: 13px; font-weight: 600;", check.title),
        el(
          "div",
          FAINT + "font-size: 11px;",
          rows.length === 0 ? "all clear" : `${rows.length} · −${applied} pts`,
        ),
      );
      section.append(title, el("div", FAINT + "font-size: 11px; padding: 2px 0 6px;", check.hint));
      for (const row of rows.slice(0, 12)) {
        if (row.asset) {
          const btn = el(
            "button",
            "display: flex; gap: 8px; width: 100%; text-align: left; padding: 4px 6px;" +
              "font: inherit; font-size: 12px; border: 0; border-radius: 6px; cursor: pointer;" +
              "background: transparent; color: var(--color-ink);",
          );
          btn.append(
            el("span", "font-weight: 500;", row.name),
            el("span", FAINT, row.detail),
          );
          btn.addEventListener("mouseenter", () => (btn.style.background = "var(--color-accent-soft)"));
          btn.addEventListener("mouseleave", () => (btn.style.background = "transparent"));
          btn.addEventListener("click", () => this.sx.ui.openAsset(row.name));
          section.append(btn);
        } else {
          const line = el("div", "display: flex; gap: 8px; padding: 4px 6px; font-size: 12px;");
          line.append(el("span", "font-weight: 500;", row.name), el("span", FAINT, row.detail));
          section.append(line);
        }
      }
      if (rows.length > 12) {
        section.append(el("div", FAINT + "font-size: 11px; padding: 2px 6px;", `+${rows.length - 12} more`));
      }
      root.append(section);
    }

    // This-week digest.
    const dig = el("div", "padding: 10px 0; border-top: 1px solid var(--color-line);");
    dig.append(el("div", "font-size: 13px; font-weight: 600;", "This week"));
    if (digest.length === 0) {
      dig.append(el("div", FAINT + "font-size: 12px; padding: 4px 0;", "No changes touching this team in the last 7 days."));
    }
    for (const ev of digest) {
      const line = el("div", "display: flex; gap: 8px; padding: 3px 0; font-size: 12px;");
      line.append(
        el("span", FAINT + "min-width: 72px;", timeAgo(ev.timestamp)),
        el("span", "font-weight: 500;", ev.target),
        el("span", FAINT, `${ev.event} · ${ev.actor}`),
      );
      dig.append(line);
    }
    root.append(dig);
  }
}
