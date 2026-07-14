// The local quality evaluator — a JS port of pulse's AssetEvaluationTool
// (sleuth/apps/issues/skills/asset_evaluation_tool.py) used on file
// vaults, where there is no server to evaluate. Two structure factors
// are scored algorithmically; the six content factors come from one
// schema-constrained call to the user's AI provider. Weights, category
// groupings, and tier cuts are pulse's verbatim, so local records read
// on the same scale as skills.new's — comparable in shape, though the
// two rubrics evolve independently (see docs/quality-spec.md).

import { analyzeFiles, skillHash } from "./files.js";

export const FACTOR_WEIGHTS = {
  file_organization: 0.12,
  length_appropriateness: 0.12,
  specificity: 0.18,
  workflow_clarity: 0.18,
  concrete_examples: 0.15,
  coverage_breadth: 0.12,
  trigger_clarity: 0.1,
  common_mistakes: 0.03,
};

export const CATEGORY_FACTORS = {
  structure: ["file_organization", "length_appropriateness"],
  actionability: ["specificity", "workflow_clarity"],
  content: ["concrete_examples", "coverage_breadth"],
  completeness: ["trigger_clarity", "common_mistakes"],
};

const LLM_FACTORS = [
  "specificity",
  "workflow_clarity",
  "concrete_examples",
  "coverage_breadth",
  "trigger_clarity",
  "common_mistakes",
];

export function getTier(score) {
  if (score >= 90) return "Exceptional";
  if (score >= 75) return "Good";
  if (score >= 50) return "Needs Work";
  if (score >= 25) return "Poor";
  return "Inadequate";
}

// ---- Algorithmic structure factors ----

export function scoreFileOrganization(stats) {
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

export function scoreLength(stats) {
  const { wordCount, totalWordCount } = stats;
  const hasRefContent = totalWordCount > wordCount;
  let score;
  let reason;
  if (wordCount < 100) {
    if (hasRefContent && totalWordCount >= 200) {
      score = 85;
      reason = `Brief primary file (${wordCount} words) with reference files (${totalWordCount} total) — well-organized delegation`;
    } else {
      score = 30;
      reason = `Too short (${wordCount} words) — may lack substantive content`;
    }
  } else if (wordCount <= 1500) {
    score = 100;
    reason = `Good length (${wordCount} words)`;
  } else if (wordCount <= 2000) {
    score = 85;
    reason = `Acceptable (${wordCount} words) — consider moving details to references/`;
  } else if (wordCount <= 3000) {
    score = hasRefContent ? 70 : 60;
    reason = hasRefContent
      ? `Verbose (${wordCount} words) despite having reference files`
      : `Getting verbose (${wordCount} words) — should split to references/`;
  } else {
    score = hasRefContent ? 50 : 40;
    reason = hasRefContent
      ? `Very verbose (${wordCount} words) despite reference files`
      : `Too verbose (${wordCount} words) — must split to references/`;
  }
  return { score, tier: getTier(score), justification: reason };
}

// ---- Weighted aggregation (pulse's math verbatim) ----

export function weightedOverall(factors) {
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

export function categoryScores(factors) {
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

// ---- The LLM assessment ----

const RESPONSE_SCHEMA = {
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
              justification: { type: "string" },
            },
          },
        ]),
      ),
    },
    reasoning: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
  },
};

const RUBRICS = `## EVALUATION RUBRICS

### 1. SPECIFICITY (Weight: 18%)
Does the skill provide concrete, specific guidance rather than vague advice?
Content in reference files counts equally — check ALL provided content.
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
Documents gotchas/anti-patterns? (OPTIONAL — score 60 if absent but the domain has no obvious pitfalls)
- Exceptional 90-100: 3+ pitfalls with prevention strategies
- Good 75-89: 1-2 documented mistakes with fixes
- Needs Work 50-74: warnings mentioned but lacking detail
- Poor 25-49: vague warnings without substance`;

export function buildPrompt({ name, description, stats }) {
  const structure = [
    stats.hasPrimary ? "- Contains primary definition file" : null,
    stats.hasReferences ? "- Has references/ directory" : null,
    stats.hasScripts ? "- Has scripts/ directory" : null,
    stats.hasAssets ? "- Has assets/ directory" : null,
  ].filter(Boolean);

  let refSection = "";
  if (stats.references.length) {
    const parts = [];
    let budget = 40000;
    for (const ref of stats.references) {
      if (budget <= 0) {
        parts.push("\n(Additional reference files truncated due to size)");
        break;
      }
      const content = ref.content || "";
      const truncated = content.slice(0, budget);
      parts.push(`**Reference File: ${ref.path}**\n${truncated}${content.length > budget ? "..." : ""}`);
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
- Concise skills are GOOD — don't penalize brevity if actionable.
- Skills should NOT explain standard frameworks — focus on project-specific usage.
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
${primary.slice(0, 30000)}${primary.length > 30000 ? "..." : ""}${refSection}

**NOTE:** Evaluate the ENTIRE skill including all files shown above.

---

${RUBRICS}

---

Score each of the six factors, then summarize: reasoning (one paragraph), strengths, weaknesses, and recommendations (specific, actionable bullets).`;
}

/** Run one local evaluation and return the interchange record. */
export async function evaluateLocally(sx, { name, description, files }) {
  const stats = analyzeFiles(files);
  const res = await sx.llm.complete({
    messages: [{ role: "user", content: buildPrompt({ name, description, stats }) }],
    schema: RESPONSE_SCHEMA,
  });
  const assessment = res.json;
  if (!assessment || typeof assessment !== "object" || !assessment.factors) {
    throw new Error("The provider returned no usable assessment — try again.");
  }

  const factors = {
    file_organization: scoreFileOrganization(stats),
    length_appropriateness: scoreLength(stats),
  };
  for (const name of LLM_FACTORS) {
    const f = assessment.factors[name];
    if (!f) continue;
    const score = Math.max(0, Math.min(100, Number(f.score) || 0));
    factors[name] = { score, tier: getTier(score), justification: f.justification || "" };
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
    hash: await skillHash(files),
  });
}

/** Assemble the interchange record (docs/quality-spec.md). Pure — the
 * testable core of the evaluator. */
export function buildRecord({
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
  hash,
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
      recommendations,
    },
    stats: { file_count: stats.fileCount, word_count: stats.totalWordCount },
    skill_hash: hash,
  };
  if (by) record.by = by;
  return record;
}
