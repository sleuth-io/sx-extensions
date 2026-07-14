// src/files.js
var PRIMARY_NAMES = ["SKILL.md", "RULE.md", "AGENT.md", "COMMAND.md"];
function sourceFiles(files) {
  return files.filter((f) => f.path !== "metadata.toml" && !f.path.startsWith("evals/")).sort(
    (a, b) => isPrimary(a.path) ? -1 : isPrimary(b.path) ? 1 : a.path.localeCompare(b.path)
  );
}
function isPrimary(path) {
  return PRIMARY_NAMES.includes(path);
}
function primaryFile(files) {
  const sources = sourceFiles(files);
  return sources.find((f) => isPrimary(f.path)) || sources.find((f) => f.path.endsWith(".md")) || null;
}
function analyzeFiles(files) {
  const sources = sourceFiles(files);
  const primary = primaryFile(files);
  const primaryContent = primary?.content || "";
  const references = sources.filter((f) => f !== primary);
  const wordCount = countWords(primaryContent);
  let referenceWords = 0;
  let totalChars = 0;
  for (const f of sources) {
    totalChars += (f.content || "").length;
    if (f !== primary) referenceWords += countWords(f.content || "");
  }
  return {
    primary,
    primaryContent,
    references,
    wordCount,
    totalWordCount: wordCount + referenceWords,
    totalChars,
    fileCount: sources.length,
    hasPrimary: primary !== null && isPrimary(primary.path),
    hasReferences: sources.some((f) => f.path.startsWith("references/")),
    hasScripts: sources.some((f) => f.path.startsWith("scripts/")),
    hasAssets: sources.some((f) => f.path.startsWith("assets/"))
  };
}
function countWords(text) {
  const trimmed = (text || "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
async function skillHash(files) {
  const basis = sourceFiles(files).map((f) => JSON.stringify([f.path, f.content])).join("\n");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return [...new Uint8Array(buf).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/evaluate.js
var FACTOR_WEIGHTS = {
  file_organization: 0.12,
  length_appropriateness: 0.12,
  specificity: 0.18,
  workflow_clarity: 0.18,
  concrete_examples: 0.15,
  coverage_breadth: 0.12,
  trigger_clarity: 0.1,
  common_mistakes: 0.03
};
var CATEGORY_FACTORS = {
  structure: ["file_organization", "length_appropriateness"],
  actionability: ["specificity", "workflow_clarity"],
  content: ["concrete_examples", "coverage_breadth"],
  completeness: ["trigger_clarity", "common_mistakes"]
};
var LLM_FACTORS = [
  "specificity",
  "workflow_clarity",
  "concrete_examples",
  "coverage_breadth",
  "trigger_clarity",
  "common_mistakes"
];
function getTier(score) {
  if (score >= 90) return "Exceptional";
  if (score >= 75) return "Good";
  if (score >= 50) return "Needs Work";
  if (score >= 25) return "Poor";
  return "Inadequate";
}
function scoreFileOrganization(stats) {
  let score = 0;
  const reasons = [];
  if (stats.hasPrimary) {
    score += 50;
    reasons.push("Has primary definition file");
  } else {
    reasons.push("Missing primary definition file");
  }
  const head = stats.primaryContent.slice(0, 500);
  if (stats.primaryContent.slice(0, 100).includes("---") && head.includes("description:")) {
    score += 30;
    reasons.push("proper YAML frontmatter with description");
  } else {
    reasons.push("missing or incomplete frontmatter");
  }
  if (stats.hasReferences) {
    score += 20;
    reasons.push("references/ directory for detailed docs");
  }
  return { score, tier: getTier(score), justification: reasons.join("; ") + "." };
}
function scoreLength(stats) {
  const { wordCount, totalWordCount } = stats;
  const hasRefContent = totalWordCount > wordCount;
  let score;
  let reason;
  if (wordCount < 100) {
    if (hasRefContent && totalWordCount >= 200) {
      score = 85;
      reason = `Brief primary file (${wordCount} words) with reference files (${totalWordCount} total) \u2014 well-organized delegation`;
    } else {
      score = 30;
      reason = `Too short (${wordCount} words) \u2014 may lack substantive content`;
    }
  } else if (wordCount <= 1500) {
    score = 100;
    reason = `Good length (${wordCount} words)`;
  } else if (wordCount <= 2e3) {
    score = 85;
    reason = `Acceptable (${wordCount} words) \u2014 consider moving details to references/`;
  } else if (wordCount <= 3e3) {
    score = hasRefContent ? 70 : 60;
    reason = hasRefContent ? `Verbose (${wordCount} words) despite having reference files` : `Getting verbose (${wordCount} words) \u2014 should split to references/`;
  } else {
    score = hasRefContent ? 50 : 40;
    reason = hasRefContent ? `Very verbose (${wordCount} words) despite reference files` : `Too verbose (${wordCount} words) \u2014 must split to references/`;
  }
  return { score, tier: getTier(score), justification: reason };
}
function weightedOverall(factors) {
  let total = 0;
  let weight = 0;
  for (const [name, w] of Object.entries(FACTOR_WEIGHTS)) {
    const f = factors[name];
    if (!f) continue;
    total += (f.score || 0) * w;
    weight += w;
  }
  return weight > 0 ? total / weight : 50;
}
function categoryScores(factors) {
  const out = {};
  for (const [category, names] of Object.entries(CATEGORY_FACTORS)) {
    let total = 0;
    let weight = 0;
    for (const name of names) {
      const f = factors[name];
      if (!f) continue;
      const w = FACTOR_WEIGHTS[name] || 0;
      total += (f.score || 0) * w;
      weight += w;
    }
    out[category] = Math.round(weight > 0 ? total / weight : 50);
  }
  return out;
}
var RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["factors", "reasoning", "strengths", "weaknesses", "recommendations"],
  properties: {
    factors: {
      type: "object",
      additionalProperties: false,
      required: LLM_FACTORS,
      properties: Object.fromEntries(
        LLM_FACTORS.map((name) => [
          name,
          {
            type: "object",
            additionalProperties: false,
            required: ["score", "justification"],
            properties: {
              score: { type: "number", minimum: 0, maximum: 100 },
              justification: { type: "string" }
            }
          }
        ])
      )
    },
    reasoning: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } }
  }
};
var RUBRICS = `## EVALUATION RUBRICS

### 1. SPECIFICITY (Weight: 18%)
Does the skill provide concrete, specific guidance rather than vague advice?
Content in reference files counts equally \u2014 check ALL provided content.
Code-based: references actual file paths. General: references specific tools, versions, URLs, or doc links.
- Exceptional 90-100: 10+ specific references, cross-references between areas
- Good 75-89: 5-9 specific references, covers key areas
- Needs Work 50-74: 2-4 references, some vague or generic
- Poor 25-49: 1 reference or only generic advice
- Inadequate 0-24: no specific references, entirely abstract

### 2. WORKFLOW CLARITY (Weight: 18%)
Clear step-by-step guidance with decision points? Workflows in reference files count equally.
- Exceptional 90-100: numbered steps, decision points, edge cases, verification
- Good 75-89: clear numbered steps, main flow covered
- Needs Work 50-74: steps present but vague or missing key decisions
- Poor 25-49: loose guidance without clear sequence
- Inadequate 0-24: no workflow, just reference information

### 3. CONCRETE EXAMPLES (Weight: 15%)
Real, concrete examples relevant to the context?
- Exceptional 90-100: real examples with WHY, shows variations
- Good 75-89: concrete examples with application context
- Needs Work 50-74: mix of concrete and generic
- Poor 25-49: mostly abstract without concrete application
- Inadequate 0-24: no concrete examples

### 4. COVERAGE BREADTH (Weight: 12%)
Different scenarios or areas covered?
- Exceptional 90-100: 4+ scenarios/areas, shows variations
- Good 75-89: 2-3 scenarios, reasonable coverage
- Needs Work 50-74: 1-2 scenarios, may miss important variations
- Poor 25-49: single narrow scenario
- Inadequate 0-24: no breadth, entirely theoretical

### 5. TRIGGER CLARITY (Weight: 10%)
Clearly explains WHEN to use this skill?
- Exceptional 90-100: multiple scenarios, "use when" AND "don't use when"
- Good 75-89: clear primary use case with context
- Needs Work 50-74: vague trigger without specifics
- Poor 25-49: reader must guess when to apply
- Inadequate 0-24: no trigger information

### 6. COMMON MISTAKES (Weight: 3%)
Documents gotchas/anti-patterns? (OPTIONAL \u2014 score 60 if absent but the domain has no obvious pitfalls)
- Exceptional 90-100: 3+ pitfalls with prevention strategies
- Good 75-89: 1-2 documented mistakes with fixes
- Needs Work 50-74: warnings mentioned but lacking detail
- Poor 25-49: vague warnings without substance`;
function buildPrompt({ name, description, stats }) {
  const structure = [
    stats.hasPrimary ? "- Contains primary definition file" : null,
    stats.hasReferences ? "- Has references/ directory" : null,
    stats.hasScripts ? "- Has scripts/ directory" : null,
    stats.hasAssets ? "- Has assets/ directory" : null
  ].filter(Boolean);
  let refSection = "";
  if (stats.references.length) {
    const parts = [];
    let budget = 4e4;
    for (const ref of stats.references) {
      if (budget <= 0) {
        parts.push("\n(Additional reference files truncated due to size)");
        break;
      }
      const content = ref.content || "";
      const truncated = content.slice(0, budget);
      parts.push(`**Reference File: ${ref.path}**
${truncated}${content.length > budget ? "..." : ""}`);
      budget -= truncated.length;
    }
    refSection = "\n\n**Reference Files:**\n" + parts.join("\n\n");
  }
  const primary = stats.primaryContent;
  return `You are evaluating a skill for quality. Your job is to assign CALIBRATED scores using the rubrics below. You MUST justify each score by citing specific evidence.

**CRITICAL SCORING GUIDELINES:**
- Be discriminating. 85+ should be RARE and require excellence across all dimensions.
- Most skills score 60-85. This is normal for solid, useful work.
- Under 50 means specific improvements needed.
- Concise skills are GOOD \u2014 don't penalize brevity if actionable.
- Skills should NOT explain standard frameworks \u2014 focus on project-specific usage.
- A brief primary file that delegates to well-organized reference files is GOOD.

**CALIBRATION ANCHORS:**
- 90-100: Exceptional - Would serve as an exemplary template for others
- 75-89: Good - Solid skill that effectively guides with minor gaps
- 50-74: Needs Work - Has value but missing important elements
- 25-49: Poor - Fundamental issues that significantly limit usefulness
- 0-24: Inadequate - Missing essential elements, placeholder content

---

**Skill Details:**
Name: ${name}
Description: ${description || "(none)"}
File Count: ${stats.fileCount} files
Primary Word Count: ${stats.wordCount} words
Total Word Count (including reference files): ${stats.totalWordCount} words

**Available Structure:**
${structure.join("\n") || "- Basic asset structure"}

**Primary File Content:**
${primary.slice(0, 3e4)}${primary.length > 3e4 ? "..." : ""}${refSection}

**NOTE:** Evaluate the ENTIRE skill including all files shown above.

---

${RUBRICS}

---

Score each of the six factors, then summarize: reasoning (one paragraph), strengths, weaknesses, and recommendations (specific, actionable bullets).`;
}
async function evaluateLocally(sx, { name, description, files }) {
  const stats = analyzeFiles(files);
  const res = await sx.llm.complete({
    messages: [{ role: "user", content: buildPrompt({ name, description, stats }) }],
    schema: RESPONSE_SCHEMA
  });
  const assessment = res.json;
  if (!assessment || typeof assessment !== "object" || !assessment.factors) {
    throw new Error("The provider returned no usable assessment \u2014 try again.");
  }
  const factors = {
    file_organization: scoreFileOrganization(stats),
    length_appropriateness: scoreLength(stats)
  };
  for (const name2 of LLM_FACTORS) {
    const f = assessment.factors[name2];
    if (!f) continue;
    const score = Math.max(0, Math.min(100, Number(f.score) || 0));
    factors[name2] = { score, tier: getTier(score), justification: f.justification || "" };
  }
  const by = await sx.app?.currentUser?.().catch(() => "") ?? "";
  return buildRecord({
    factors,
    reasoning: assessment.reasoning || "",
    strengths: assessment.strengths || [],
    weaknesses: assessment.weaknesses || [],
    recommendations: assessment.recommendations || [],
    stats,
    provider: res.provider,
    model: res.model,
    by,
    at: Date.now(),
    hash: await skillHash(files)
  });
}
function buildRecord({
  factors,
  reasoning,
  strengths,
  weaknesses,
  recommendations,
  stats,
  provider,
  model,
  by,
  at,
  hash
}) {
  const record = {
    at: new Date(at).toISOString(),
    source: "app",
    executor: { provider: provider || "", model: model || "" },
    overall: Math.round(weightedOverall(factors)),
    categories: categoryScores(factors),
    factors,
    summary: reasoning,
    insights: {
      strengths,
      improvements: weaknesses,
      recommendations
    },
    stats: { file_count: stats.fileCount, word_count: stats.totalWordCount },
    skill_hash: hash
  };
  if (by) record.by = by;
  return record;
}

// src/dom.js
function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== void 0) node.textContent = text;
  return node;
}
var FAINT = "color: var(--color-ink-faint);";
var SOFT = "color: var(--color-ink-soft);";
var CARD = "border: 1px solid var(--color-line); border-radius: 12px; padding: 12px;background: var(--color-surface); display: flex; flex-direction: column; gap: 8px;";
var BUTTON = "padding: 5px 10px; font: inherit; font-size: 12px; font-weight: 500;border: 1px solid var(--color-line); border-radius: 8px; cursor: pointer;background: var(--color-surface); color: var(--color-ink);";
var PRIMARY = BUTTON + "background: var(--color-accent); border-color: var(--color-accent); color: white;";
var NOTE = "border: 1px solid var(--color-line); border-radius: 8px; padding: 8px 10px;background: var(--color-canvas); font-size: 12px; line-height: 1.5;";
var SMALL_BUTTON = BUTTON + "padding: 3px 8px; font-size: 11px; white-space: nowrap;";
function menuButton(items) {
  const wrap = el("div", "position: relative; margin-left: auto;");
  const btn = el("button", SMALL_BUTTON + "line-height: 1;", "\u22EF");
  btn.title = "More actions";
  const menu = el(
    "div",
    "position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; display: none;min-width: 150px; padding: 4px; border: 1px solid var(--color-line); border-radius: 8px;background: var(--color-surface); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);flex-direction: column; gap: 2px;"
  );
  for (const item of items) {
    const it = el(
      "button",
      "text-align: left; padding: 5px 8px; font: inherit; font-size: 12px; border: 0;border-radius: 6px; background: transparent; cursor: pointer;" + (item.danger ? "color: var(--color-danger);" : "color: var(--color-ink);"),
      item.label
    );
    it.onmouseenter = () => it.style.background = "var(--color-canvas)";
    it.onmouseleave = () => it.style.background = "transparent";
    it.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = "none";
      item.run();
    };
    menu.append(it);
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const opening = menu.style.display === "none" || !menu.style.display;
    menu.style.display = opening ? "flex" : "none";
    if (opening) {
      document.addEventListener("click", () => menu.style.display = "none", { once: true });
    }
  };
  wrap.append(btn, menu);
  return wrap;
}
function sectionLabel(text) {
  return el(
    "div",
    FAINT + "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;",
    text
  );
}
function chip(text, tone) {
  const colors = {
    danger: "border-color: var(--color-danger); color: var(--color-danger);",
    accent: "border-color: var(--color-accent); color: var(--color-accent);",
    faint: "color: var(--color-ink-faint);"
  };
  return el(
    "span",
    "display: inline-block; padding: 1px 7px; border: 1px solid var(--color-line);border-radius: 999px; font-size: 11px; white-space: nowrap;" + (colors[tone] || colors.faint),
    text
  );
}
function scoreColor(score) {
  if (score >= 85) return "var(--color-accent)";
  if (score >= 60) return "#d97706";
  return "var(--color-danger)";
}
function scoreBadge(score) {
  const badge = el(
    "div",
    `width: 72px; height: 72px; border-radius: 16px; display: flex; align-items: center;justify-content: center; font-size: 26px; font-weight: 700; color: white;background: ${scoreColor(score)}; flex-shrink: 0;`,
    String(score)
  );
  return badge;
}
function progressBar(label, score) {
  const row = el("div", "display: flex; align-items: center; gap: 10px; font-size: 12px;");
  const track = el(
    "div",
    "flex: 1; height: 7px; border-radius: 999px; background: var(--color-canvas);border: 1px solid var(--color-line); overflow: hidden;"
  );
  const fill = el(
    "div",
    `height: 100%; width: ${Math.max(0, Math.min(100, score))}%; background: ${scoreColor(score)};`
  );
  track.append(fill);
  row.append(
    el("span", SOFT + "min-width: 100px;", label),
    track,
    el("span", SOFT + "min-width: 34px; text-align: right;", `${Math.round(score)}%`)
  );
  return row;
}
function fmtAgo(epochMs) {
  const days = Math.floor((Date.now() - epochMs) / 864e5);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

// src/ui-tab.js
var CATEGORY_LABELS = [
  ["structure", "Structure"],
  ["actionability", "Actionability"],
  ["content", "Content"],
  ["completeness", "Completeness"]
];
async function mountTab(plugin, view, ctx) {
  const sx = plugin.sx;
  const name = ctx.assetName;
  const state = {
    disposed: false,
    loading: true,
    unsupported: false,
    doc: { evaluating: false, records: [] },
    currentHash: "",
    insightsOpen: true
  };
  const rerender = () => {
    if (state.disposed) return;
    view.el.style.cssText = "display: flex; flex-direction: column; gap: 10px;";
    view.el.replaceChildren(...render());
  };
  plugin.rerenders.add(rerender);
  view.onDispose(() => {
    state.disposed = true;
    plugin.rerenders.delete(rerender);
  });
  async function refresh() {
    state.loading = true;
    rerender();
    try {
      const [doc, files] = await Promise.all([
        sx.quality.get(name),
        sx.assets.readFiles(name).catch(() => [])
      ]);
      state.doc = doc;
      state.currentHash = files.length ? await skillHash(files) : "";
    } catch (err) {
      state.unsupported = true;
      state.error = err?.message || String(err);
    }
    state.loading = false;
    rerender();
  }
  function render() {
    if (state.loading) return [el("div", FAINT + "padding: 8px;", "Loading quality\u2026")];
    if (state.unsupported) {
      return [
        el(
          "div",
          NOTE,
          "This library's backend doesn't support quality storage yet \u2014 update the vault's server (or the app) to use quality scores."
        )
      ];
    }
    const busy = plugin.busy.get(name);
    const evaluating = busy || state.doc.evaluating;
    const record = state.doc.records[0];
    const nodes = [];
    const header = el("div", "display: flex; align-items: center; gap: 8px;");
    header.append(el("div", "font-size: 14px; font-weight: 600;", "Quality"));
    const btn = el(
      "button",
      PRIMARY + "margin-left: auto;" + (evaluating ? "opacity: 0.6; pointer-events: none;" : ""),
      evaluating ? "Evaluating\u2026" : record ? "Re-evaluate" : "Evaluate"
    );
    btn.onclick = () => void plugin.reevaluate(name);
    header.append(btn);
    nodes.push(header);
    if (!record) {
      nodes.push(
        el(
          "div",
          NOTE,
          evaluating ? "Evaluating this skill \u2014 results will appear here shortly." : "This skill hasn't been evaluated yet. Evaluate scores its structure, actionability, content, and completeness with concrete improvement suggestions."
        )
      );
      return nodes;
    }
    const panel = el("div", CARD);
    const row = el("div", "display: flex; align-items: center; gap: 16px;");
    row.append(scoreBadge(record.overall));
    const bars = el("div", "flex: 1; display: flex; flex-direction: column; gap: 6px;");
    for (const [key, label] of CATEGORY_LABELS) {
      const score = record.categories?.[key];
      if (typeof score === "number") bars.append(progressBar(label, score));
    }
    row.append(bars);
    panel.append(row);
    const meta = el("div", "display: flex; align-items: center; gap: 6px; flex-wrap: wrap;");
    if (record.at) meta.append(el("span", FAINT + "font-size: 11px;", `Evaluated ${fmtAgo(Date.parse(record.at))}`));
    if (record.by) meta.append(el("span", FAINT + "font-size: 11px;", `by ${record.by}`));
    meta.append(chip(record.source === "server" ? "skills.new" : record.executor?.model || "local", "faint"));
    const prior = state.doc.records[1];
    if (prior && typeof prior.overall === "number") {
      const delta = record.overall - prior.overall;
      if (delta !== 0) meta.append(chip(`${delta > 0 ? "+" : ""}${delta} vs last`, delta > 0 ? "accent" : "danger"));
    }
    if (record.skill_hash && state.currentHash && record.skill_hash !== state.currentHash) {
      meta.append(chip("skill changed since evaluation", "danger"));
    }
    panel.append(meta);
    nodes.push(panel);
    if (record.summary) nodes.push(el("div", NOTE, record.summary));
    const insights = record.insights || {};
    const sections = [
      ["Strengths", insights.strengths],
      ["Areas for Improvement", insights.improvements],
      ["Recommendations", insights.recommendations]
    ].filter(([, items]) => items?.length);
    if (sections.length) {
      const details = el("details", "display: flex; flex-direction: column; gap: 4px;");
      details.open = state.insightsOpen;
      details.ontoggle = () => state.insightsOpen = details.open;
      const summary = el("summary", SOFT + "cursor: pointer; font-size: 12px; font-weight: 600;", "Insights");
      details.append(summary);
      for (const [label, items] of sections) {
        details.append(sectionLabel(label));
        const list = el("ul", "margin: 2px 0 6px; padding-left: 18px; display: flex; flex-direction: column; gap: 3px;");
        for (const item of items) {
          list.append(el("li", SOFT + "font-size: 12px; line-height: 1.45;", item));
        }
        details.append(list);
      }
      nodes.push(details);
    }
    if (record.stats) {
      const bits = [];
      if (record.stats.file_count != null) bits.push(`${record.stats.file_count} file${record.stats.file_count === 1 ? "" : "s"}`);
      if (record.stats.word_count != null) bits.push(`${record.stats.word_count} words`);
      if (bits.length) nodes.push(el("div", FAINT + "font-size: 11px;", bits.join(" \xB7 ")));
    }
    return nodes;
  }
  plugin.refreshers.set(name, refresh);
  view.onDispose(() => {
    if (plugin.refreshers.get(name) === refresh) plugin.refreshers.delete(name);
  });
  await refresh();
}

// src/board.js
var STATUS_ORDER = [
  "not-evaluated",
  "stale",
  "retire-candidate",
  "low",
  "needs-work",
  "good",
  "exemplary"
];
var STATUS_LABEL = {
  "not-evaluated": "Not evaluated",
  stale: "Stale",
  "retire-candidate": "Retire candidate",
  low: "Low quality",
  "needs-work": "Needs work",
  good: "Good",
  exemplary: "High quality"
};
var STATUS_HELP = [
  ["Not evaluated", "No quality score yet \u2014 evaluate it to get a baseline."],
  ["Stale", "The skill changed since its last evaluation \u2014 the score may no longer apply. Re-evaluate."],
  [
    "Retire candidate",
    "Scored Inadequate (<25): missing essential elements or placeholder content. Improve it substantially, or deprecate it."
  ],
  ["Low quality", "Scored Poor (25\u201359) \u2014 the insights list concrete fixes."],
  ["Needs work", "Scored 60\u201374 \u2014 useful, but the recommendations are worth applying."],
  ["Good", "Scored 75\u201384 \u2014 solid work with minor gaps."],
  ["High quality", "Scored 85+ \u2014 exemplary; a template for new skills."]
];
var STALE_SLACK_MS = 60 * 1e3;
function classifyStatus({ record, updatedAt }) {
  if (!record || typeof record.overall !== "number") return "not-evaluated";
  const evaluatedAt = record.at ? Date.parse(record.at) : NaN;
  const changedAt = updatedAt ? Date.parse(updatedAt) : NaN;
  if (Number.isFinite(evaluatedAt) && Number.isFinite(changedAt) && changedAt - evaluatedAt > STALE_SLACK_MS) {
    return "stale";
  }
  const overall = record.overall;
  if (overall < 25) return "retire-candidate";
  if (overall < 60) return "low";
  if (overall < 75) return "needs-work";
  if (overall < 85) return "good";
  return "exemplary";
}
function attentionScore({ status, overall, uses30 = 0 }) {
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
function retireRank(a, b) {
  return a.uses30 - b.uses30 || a.overall - b.overall;
}
function weakestCategory(record) {
  const labels = {
    structure: "structure",
    actionability: "actionability",
    content: "content",
    completeness: "completeness"
  };
  let worst = null;
  for (const [key, label] of Object.entries(labels)) {
    const score = record?.categories?.[key];
    if (typeof score !== "number") continue;
    if (!worst || score < worst.score) worst = { label, score };
  }
  return worst;
}
function rollup(rows) {
  const evaluated = rows.filter((r) => r.record);
  const scores = evaluated.map((r) => r.record.overall).filter((s) => typeof s === "number");
  return {
    skills: rows.length,
    evaluated: evaluated.length,
    avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    high: rows.filter((r) => r.status === "exemplary").length,
    low: rows.filter((r) => r.status === "low").length,
    retire: rows.filter((r) => r.status === "retire-candidate").length,
    stale: rows.filter((r) => r.status === "stale").length
  };
}

// src/ui-main.js
var NAME_COL = "font-weight: 600; width: 220px; flex: none; overflow: hidden;text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--color-ink);";
var SCORE_PILL = "display: inline-flex; align-items: center; justify-content: center; width: 34px;border-radius: 999px; font-size: 11px; font-weight: 700; color: white; padding: 1px 0;";
function scorePill(overall) {
  return el("span", SCORE_PILL + `background: ${scoreColor(overall)};`, String(overall));
}
async function mountMain(plugin, view) {
  const sx = plugin.sx;
  const state = {
    disposed: false,
    status: "Loading library\u2026",
    refreshing: false,
    rows: [],
    filter: "",
    showLegend: false
  };
  const openQuality = (name) => sx.ui.openAsset(name, { tab: "quality" });
  const rerender = () => {
    if (state.disposed) return;
    view.el.style.cssText = "display: flex; flex-direction: column; gap: 12px;";
    view.el.replaceChildren(...render());
  };
  plugin.rerenders.add(rerender);
  view.onDispose(() => {
    state.disposed = true;
    plugin.rerenders.delete(rerender);
  });
  async function collect() {
    if (state.refreshing) return;
    state.refreshing = true;
    state.status = state.rows.length ? "" : "Loading library\u2026";
    rerender();
    try {
      const [latest, assets, events] = await Promise.all([
        sx.quality.latest().catch(() => ({})),
        sx.assets.list().catch(() => []),
        sx.usage.events(30).catch(() => [])
      ]);
      const uses = {};
      for (const e of events) uses[e.assetName] = (uses[e.assetName] || 0) + 1;
      state.rows = assets.filter((a) => a.type === "skill").map((a) => {
        const record = latest[a.name] || null;
        const status = classifyStatus({ record, updatedAt: a.updatedAt });
        const attn = attentionScore({
          status,
          overall: record?.overall ?? 0,
          uses30: uses[a.name] || 0
        });
        return {
          name: a.name,
          description: a.description,
          record,
          status,
          overall: record?.overall ?? null,
          uses30: uses[a.name] || 0,
          score: attn.score,
          reasons: attn.reasons
        };
      });
    } finally {
      state.status = "";
      state.refreshing = false;
      rerender();
    }
  }
  plugin.boardRefresh = collect;
  view.onDispose(() => {
    if (plugin.boardRefresh === collect) plugin.boardRefresh = null;
  });
  async function evaluate(name) {
    await plugin.reevaluate(name);
    await collect();
  }
  async function markDeprecated(name) {
    const ok = await sx.ui.confirm(
      `Mark ${name} as deprecated? This publishes a metadata-only revision (content untouched) so teammates see the status.`,
      "Mark deprecated"
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
  function header() {
    const wrap = el("div", "display: flex; gap: 10px; align-items: center; flex-wrap: wrap;");
    const r = rollup(state.rows);
    const bits = r.skills ? [
      `${r.skills} skills`,
      `${r.evaluated} evaluated (${Math.round(r.evaluated / r.skills * 100)}%)`,
      r.avg !== null ? `avg ${r.avg}` : null,
      `${r.high} high quality`,
      `${r.low + r.retire} low`,
      r.retire ? `${r.retire} retire candidate${r.retire === 1 ? "" : "s"}` : null
    ].filter(Boolean) : ["No skills in this library yet."];
    wrap.append(el("div", SOFT + "font-size: 13px;", bits.join(" \xB7 ")));
    wrap.append(el("div", "flex: 1;"));
    const help = el("button", SMALL_BUTTON + "border-radius: 999px; line-height: 1;", "?");
    help.title = "What the statuses mean";
    help.onclick = () => {
      state.showLegend = !state.showLegend;
      rerender();
    };
    if (state.refreshing && state.rows.length) {
      wrap.append(el("span", FAINT + "font-size: 12px;", "Refreshing\u2026"), help);
      return wrap;
    }
    const refresh = el("button", SMALL_BUTTON, "Refresh");
    refresh.onclick = () => void collect();
    wrap.append(refresh, help);
    return wrap;
  }
  function legend() {
    const panel = el("div", NOTE + "display: flex; flex-direction: column; gap: 5px;");
    for (const [label, meaning] of STATUS_HELP) {
      const line = el("div", "display: flex; gap: 8px; align-items: baseline;");
      line.append(
        el("span", "font-weight: 600; font-size: 12px; width: 130px; flex: none;", label),
        el("span", SOFT + "font-size: 12px;", meaning)
      );
      panel.append(line);
    }
    return panel;
  }
  function busyStrip() {
    const names = [...plugin.busy.keys()];
    if (!names.length) return null;
    return el("div", NOTE, `Evaluating ${names.join(", ")}\u2026 results land on each skill's Quality tab.`);
  }
  function evaluateButton(r) {
    const btn = el("button", SMALL_BUTTON + "margin-left: auto;", r.record ? "Re-evaluate" : "Evaluate");
    if (plugin.busy.has(r.name)) {
      btn.textContent = "Evaluating\u2026";
      btn.style.opacity = "0.6";
      btn.style.pointerEvents = "none";
    } else {
      btn.onclick = (e) => {
        e.stopPropagation();
        void evaluate(r.name);
      };
    }
    return btn;
  }
  function queueRow(r) {
    const row = el(
      "div",
      "display: flex; gap: 8px; align-items: center; padding: 6px 10px;border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;background: var(--color-surface);"
    );
    const nameLink = el("a", NAME_COL, r.name);
    nameLink.title = r.name;
    nameLink.onclick = () => openQuality(r.name);
    row.append(nameLink);
    for (const reason of r.reasons.slice(0, 2)) row.append(chip(reason, "faint"));
    row.append(evaluateButton(r));
    return row;
  }
  function retireRow(r) {
    const row = el(
      "div",
      "display: flex; flex-direction: column; gap: 3px; padding: 6px 10px;border: 1px solid var(--color-line); border-radius: 8px;background: var(--color-surface);"
    );
    const head = el("div", "display: flex; gap: 8px; align-items: center;");
    const nameLink = el("a", NAME_COL + "font-size: 12px;", r.name);
    nameLink.title = r.name;
    nameLink.onclick = () => openQuality(r.name);
    head.append(
      nameLink,
      scorePill(r.overall),
      chip("retire candidate", "danger"),
      menuButton([
        { label: "Open quality", run: () => openQuality(r.name) },
        { label: "Re-evaluate", run: () => void evaluate(r.name) },
        { label: "Mark deprecated\u2026", run: () => void markDeprecated(r.name), danger: true }
      ])
    );
    const worst = weakestCategory(r.record);
    const improvement = r.record?.insights?.improvements?.[0];
    const evidence = [
      `scored ${r.overall} (Inadequate)`,
      worst ? `weakest: ${worst.label} ${worst.score}%` : null,
      r.uses30 ? `${r.uses30} uses/30d` : "unused in 30d",
      r.record?.at ? `evaluated ${fmtAgo(Date.parse(r.record.at))}` : null
    ].filter(Boolean).join(" \xB7 ");
    row.append(head, el("div", FAINT + "font-size: 11px;", evidence));
    if (improvement) row.append(el("div", FAINT + "font-size: 11px;", `top issue: ${improvement}`));
    return row;
  }
  function exemplaryRow(r) {
    const row = el(
      "div",
      "display: flex; gap: 8px; align-items: center; padding: 6px 10px;border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;background: var(--color-surface);"
    );
    const nameLink = el("a", NAME_COL, r.name);
    nameLink.title = r.name;
    nameLink.onclick = () => openQuality(r.name);
    row.append(nameLink, scorePill(r.overall), chip("template-worthy", "accent"));
    const strength = r.record?.insights?.strengths?.[0];
    if (strength) {
      row.append(el("span", FAINT + "font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", strength));
    }
    return row;
  }
  function table() {
    const wrap = el("div", "display: flex; flex-direction: column; gap: 6px;");
    const filters = el("div", "display: flex; gap: 6px; flex-wrap: wrap;");
    const counts = {};
    for (const r of state.rows) counts[r.status] = (counts[r.status] || 0) + 1;
    for (const status of ["", ...STATUS_ORDER.filter((s) => counts[s])]) {
      const label = status ? `${STATUS_LABEL[status]} (${counts[status]})` : `All (${state.rows.length})`;
      const active = state.filter === status;
      const b = el(
        "button",
        SMALL_BUTTON + "border-radius: 999px;" + (active ? "background: var(--color-accent); border-color: var(--color-accent); color: white;" : ""),
        label
      );
      b.onclick = () => {
        state.filter = status;
        rerender();
      };
      filters.append(b);
    }
    wrap.append(filters);
    const rows = state.rows.filter((r) => !state.filter || r.status === state.filter).sort(
      (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (a.overall ?? 101) - (b.overall ?? 101)
    );
    for (const r of rows) {
      const line = el(
        "div",
        "display: flex; gap: 10px; align-items: center; padding: 4px 10px;border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;background: var(--color-surface); cursor: pointer;"
      );
      line.onclick = () => openQuality(r.name);
      const tone = r.status === "exemplary" || r.status === "good" ? "accent" : r.status === "retire-candidate" || r.status === "low" ? "danger" : "faint";
      const name = el("span", NAME_COL, r.name);
      name.title = r.name;
      line.append(name);
      if (r.overall !== null) line.append(scorePill(r.overall));
      line.append(chip(STATUS_LABEL[r.status], tone));
      const worst = r.record && r.status !== "exemplary" ? weakestCategory(r.record) : null;
      if (worst) line.append(el("span", SOFT + "white-space: nowrap;", `weakest: ${worst.label} ${worst.score}%`));
      line.append(el("span", "flex: 1;"));
      if (r.uses30 > 0) line.append(el("span", FAINT + "white-space: nowrap;", `${r.uses30} uses/30d`));
      line.append(rowMenu(r));
      wrap.append(line);
    }
    return wrap;
  }
  function rowMenu(r) {
    const items = [
      { label: "Open quality", run: () => openQuality(r.name) },
      { label: r.record ? "Re-evaluate" : "Evaluate", run: () => void evaluate(r.name) }
    ];
    if (r.status === "retire-candidate") {
      items.push({ label: "Mark deprecated\u2026", run: () => void markDeprecated(r.name), danger: true });
    }
    const menu = menuButton(items);
    menu.style.marginLeft = "0";
    menu.onclick = (e) => e.stopPropagation();
    return menu;
  }
  function render() {
    const out = [];
    const strip = busyStrip();
    if (strip) out.push(strip);
    out.push(header());
    if (state.showLegend) out.push(legend());
    if (state.status) {
      out.push(el("div", FAINT + "font-size: 13px; padding: 8px;", state.status));
      return out;
    }
    if (!state.rows.length) return out;
    const queue = state.rows.filter((r) => r.score >= 10).sort((a, b) => b.score - a.score).slice(0, 5);
    if (queue.length) {
      out.push(sectionLabel("Up next"));
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...queue.map(queueRow));
      out.push(list);
    }
    const retire = state.rows.filter((r) => r.status === "retire-candidate").sort(retireRank);
    if (retire.length) {
      const label = sectionLabel(`Retire candidates (${retire.length})`);
      label.title = "Scored Inadequate \u2014 missing essential elements. Improve substantially or deprecate.";
      out.push(label);
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...retire.map(retireRow));
      out.push(list);
    }
    const exemplary = state.rows.filter((r) => r.status === "exemplary").sort((a, b) => b.overall - a.overall).slice(0, 5);
    if (exemplary.length) {
      const label = sectionLabel(`High quality (${exemplary.length})`);
      label.title = "Exemplary skills \u2014 point new authors at these as templates.";
      out.push(label);
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...exemplary.map(exemplaryRow));
      out.push(list);
    }
    out.push(sectionLabel("All skills"), table());
    return out;
  }
  rerender();
  await collect();
}

// src/index.js
var POLL_MS = 4e3;
var POLL_LIMIT_MS = 5 * 60 * 1e3;
var SkillQuality = class {
  onload(sx) {
    this.sx = sx;
    this.rerenders = /* @__PURE__ */ new Set();
    this.refreshers = /* @__PURE__ */ new Map();
    this.busy = /* @__PURE__ */ new Map();
    this.boardRefresh = null;
    sx.registerAssetTab({
      id: "quality",
      title: "Quality",
      mount: (view, ctx) => void mountTab(this, view, ctx)
    });
    sx.registerMainView({
      id: "skill-quality",
      title: "Skill Quality",
      section: "tools",
      mount: (view) => void mountMain(this, view)
    });
    sx.registerCommand({
      id: "open-quality-board",
      title: "Skill Quality: open board",
      run: () => sx.ui.openView("skill-quality")
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
    this.busy.delete(name);
    this.notify();
    const provider = await sx.llm.provider().catch(() => "");
    if (!provider) {
      sx.ui.notice("No AI provider configured \u2014 set one in Settings \u2192 AI provider.");
      sx.ui.openSettings("ai");
      return;
    }
    const ok = await sx.ui.confirm(
      `Evaluate "${name}" with "${provider}" (one AI call scoring structure, actionability, content, and completeness)?`,
      "Evaluate"
    );
    if (!ok) return;
    this.busy.set(name, "local");
    this.notify();
    try {
      const [files, assets] = await Promise.all([
        sx.assets.readFiles(name),
        sx.assets.list().catch(() => [])
      ]);
      const record = await evaluateLocally(sx, {
        name,
        description: assets.find((a) => a.name === name)?.description || "",
        files
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
    for (; ; ) {
      const doc = await this.sx.quality.get(name);
      if (!doc.evaluating) return doc;
      if (Date.now() > deadline) {
        throw new Error("the server is still evaluating \u2014 check back shortly");
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
};
export {
  SkillQuality as default
};
