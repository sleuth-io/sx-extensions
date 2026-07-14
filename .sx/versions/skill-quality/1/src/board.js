// The quality board's pure logic: status classification, the attention
// queue's scoring, and the header rollup. Kept DOM-free so the
// recommendations are unit-testable.
//
// Score bands follow pulse's tier cuts (evaluate.js getTier): a skill
// scoring under 25 is "Inadequate — missing essential elements", which
// is the retire signal; 25-59 is low quality worth improving; 85+ is
// exemplary work worth pointing teammates at.

export const STATUS_ORDER = [
  "not-evaluated",
  "stale",
  "retire-candidate",
  "low",
  "needs-work",
  "good",
  "exemplary",
];

export const STATUS_LABEL = {
  "not-evaluated": "Not evaluated",
  stale: "Stale",
  "retire-candidate": "Retire candidate",
  low: "Low quality",
  "needs-work": "Needs work",
  good: "Good",
  exemplary: "High quality",
};

export const STATUS_HELP = [
  ["Not evaluated", "No quality score yet — evaluate it to get a baseline."],
  ["Stale", "The skill changed since its last evaluation — the score may no longer apply. Re-evaluate."],
  [
    "Retire candidate",
    "Scored Inadequate (<25): missing essential elements or placeholder content. Improve it substantially, or deprecate it.",
  ],
  ["Low quality", "Scored Poor (25–59) — the insights list concrete fixes."],
  ["Needs work", "Scored 60–74 — useful, but the recommendations are worth applying."],
  ["Good", "Scored 75–84 — solid work with minor gaps."],
  ["High quality", "Scored 85+ — exemplary; a template for new skills."],
];

// Allow a small clock skew between a server evaluation's `at` (derived
// from the asset's updatedAt) and the asset timestamp itself.
const STALE_SLACK_MS = 60 * 1000;

/** Classify one skill from its latest quality record (or null) and the
 * asset's updatedAt. Staleness outranks the score bands: a score for
 * content that no longer exists isn't evidence of anything. */
export function classifyStatus({ record, updatedAt }) {
  if (!record || typeof record.overall !== "number") return "not-evaluated";
  const evaluatedAt = record.at ? Date.parse(record.at) : NaN;
  const changedAt = updatedAt ? Date.parse(updatedAt) : NaN;
  if (
    Number.isFinite(evaluatedAt) &&
    Number.isFinite(changedAt) &&
    changedAt - evaluatedAt > STALE_SLACK_MS
  ) {
    return "stale";
  }
  const overall = record.overall;
  if (overall < 25) return "retire-candidate";
  if (overall < 60) return "low";
  if (overall < 75) return "needs-work";
  if (overall < 85) return "good";
  return "exemplary";
}

/** "What should I look at now" — bigger is more urgent. Popular skills
 * with missing or bad scores outrank dusty ones. */
export function attentionScore({ status, overall, uses30 = 0 }) {
  let score = 0;
  const reasons = [];
  switch (status) {
    case "not-evaluated":
      score = 50;
      reasons.push("never evaluated");
      break;
    case "stale":
      score = 40;
      reasons.push("changed since evaluation");
      break;
    case "retire-candidate":
      score = 35;
      reasons.push(`inadequate (${overall})`);
      break;
    case "low":
      score = 25 + Math.round((60 - overall) / 4);
      reasons.push(`low quality (${overall})`);
      break;
    case "needs-work":
      score = 8;
      reasons.push(`needs work (${overall})`);
      break;
    default:
      score = 0;
  }
  if (score > 0 && uses30 >= 20) {
    score += 10;
    reasons.push(`${uses30} uses/30d`);
  }
  return { score, reasons };
}

/** Rank retire candidates: least-used first (weakest case to keep),
 * then lowest score. */
export function retireRank(a, b) {
  return a.uses30 - b.uses30 || a.overall - b.overall;
}

/** The category the skill is weakest in — the "what to fix first" hint
 * shown on table rows. */
export function weakestCategory(record) {
  const labels = {
    structure: "structure",
    actionability: "actionability",
    content: "content",
    completeness: "completeness",
  };
  let worst = null;
  for (const [key, label] of Object.entries(labels)) {
    const score = record?.categories?.[key];
    if (typeof score !== "number") continue;
    if (!worst || score < worst.score) worst = { label, score };
  }
  return worst;
}

/** Header rollup numbers. */
export function rollup(rows) {
  const evaluated = rows.filter((r) => r.record);
  const scores = evaluated.map((r) => r.record.overall).filter((s) => typeof s === "number");
  return {
    skills: rows.length,
    evaluated: evaluated.length,
    avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    high: rows.filter((r) => r.status === "exemplary").length,
    low: rows.filter((r) => r.status === "low").length,
    retire: rows.filter((r) => r.status === "retire-candidate").length,
    stale: rows.filter((r) => r.status === "stale").length,
  };
}
