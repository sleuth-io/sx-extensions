// The evaluator's pure core: pulse-verbatim weights, algorithmic
// structure scoring, weighted aggregation, and the interchange record
// shape the sx quality store validates.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTOR_WEIGHTS,
  CATEGORY_FACTORS,
  getTier,
  scoreFileOrganization,
  scoreLength,
  weightedOverall,
  categoryScores,
  buildRecord,
  buildPrompt,
} from "../src/evaluate.js";
import { analyzeFiles, skillHash, countWords } from "../src/files.js";

const SKILL_MD =
  "---\nname: commit-msgs\ndescription: Use when writing commits.\n---\n\n" +
  "## Workflow\n1. Look at the diff.\n2. Write a 50-char subject.\n";

const FILES = [
  { path: "SKILL.md", content: SKILL_MD },
  { path: "references/details.md", content: "Deep dive. ".repeat(60) },
  { path: "metadata.toml", content: "[asset]\nname = 'commit-msgs'" },
];

test("factor weights sum to 1 and cover every category factor", () => {
  const sum = Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}`);
  for (const names of Object.values(CATEGORY_FACTORS)) {
    for (const name of names) assert.ok(FACTOR_WEIGHTS[name], `${name} has a weight`);
  }
});

test("tier cuts match pulse's", () => {
  assert.equal(getTier(90), "Exceptional");
  assert.equal(getTier(75), "Good");
  assert.equal(getTier(50), "Needs Work");
  assert.equal(getTier(25), "Poor");
  assert.equal(getTier(10), "Inadequate");
});

test("analyzeFiles derives pulse's facts, excluding metadata.toml", () => {
  const stats = analyzeFiles(FILES);
  assert.equal(stats.fileCount, 2);
  assert.equal(stats.hasPrimary, true);
  assert.equal(stats.hasReferences, true);
  assert.equal(stats.wordCount, countWords(SKILL_MD));
  assert.ok(stats.totalWordCount > stats.wordCount);
});

test("file organization scores primary + frontmatter + references", () => {
  const stats = analyzeFiles(FILES);
  const f = scoreFileOrganization(stats);
  assert.equal(f.score, 100); // 50 primary + 30 frontmatter + 20 references
  assert.equal(f.tier, "Exceptional");

  const bare = scoreFileOrganization(analyzeFiles([{ path: "notes.md", content: "hi" }]));
  assert.ok(bare.score <= 30, `score ${bare.score} for primary-less asset`);
});

test("length scoring follows pulse's brackets", () => {
  const mk = (wordCount, totalWordCount) =>
    scoreLength({ wordCount, totalWordCount });
  assert.equal(mk(800, 800).score, 100);
  assert.equal(mk(1800, 1800).score, 85);
  assert.equal(mk(40, 40).score, 30); // short, no references
  assert.equal(mk(40, 400).score, 85); // short but delegates
  assert.equal(mk(2500, 2500).score, 60);
  assert.equal(mk(2500, 3000).score, 70);
  assert.equal(mk(4000, 4000).score, 40);
});

test("weighted overall and category scores use pulse's math", () => {
  const factors = {};
  for (const name of Object.keys(FACTOR_WEIGHTS)) {
    factors[name] = { score: 80, tier: "Good", justification: "" };
  }
  assert.equal(Math.round(weightedOverall(factors)), 80);
  const cats = categoryScores(factors);
  assert.deepEqual(cats, { structure: 80, actionability: 80, content: 80, completeness: 80 });

  // A missing factor drops out of both aggregates (pulse renormalizes).
  delete factors.common_mistakes;
  assert.equal(Math.round(weightedOverall(factors)), 80);
  assert.equal(categoryScores(factors).completeness, 80); // trigger_clarity carries it
});

test("buildRecord emits a valid interchange record", async () => {
  const stats = analyzeFiles(FILES);
  const factors = {
    file_organization: scoreFileOrganization(stats),
    length_appropriateness: scoreLength(stats),
    specificity: { score: 70, tier: "Needs Work", justification: "few refs" },
    workflow_clarity: { score: 90, tier: "Exceptional", justification: "numbered" },
    concrete_examples: { score: 60, tier: "Needs Work", justification: "" },
    coverage_breadth: { score: 55, tier: "Needs Work", justification: "" },
    trigger_clarity: { score: 85, tier: "Good", justification: "" },
    common_mistakes: { score: 60, tier: "Needs Work", justification: "" },
  };
  const record = buildRecord({
    factors,
    reasoning: "Solid but thin on examples.",
    strengths: ["clear workflow"],
    weaknesses: ["few examples"],
    recommendations: ["add examples"],
    stats,
    provider: "ollama",
    model: "llama3:8b",
    by: "alice",
    at: Date.UTC(2026, 6, 14, 12, 0, 0),
    hash: await skillHash(FILES),
  });

  assert.equal(record.source, "app");
  assert.equal(record.at, "2026-07-14T12:00:00.000Z");
  assert.ok(record.overall >= 0 && record.overall <= 100);
  assert.equal(typeof record.categories.structure, "number");
  assert.equal(record.insights.improvements[0], "few examples");
  assert.equal(record.stats.file_count, 2);
  assert.equal(record.by, "alice");
  assert.match(record.skill_hash, /^[0-9a-f]{8}$/);
  // The sx store's validation gate: JSON object with overall + categories.
  const parsed = JSON.parse(JSON.stringify(record));
  assert.equal(typeof parsed.overall, "number");
  assert.equal(typeof parsed.categories, "object");
});

test("skillHash changes with content and ignores metadata.toml", async () => {
  const base = await skillHash(FILES);
  const touchedMeta = FILES.map((f) =>
    f.path === "metadata.toml" ? { ...f, content: "changed" } : f,
  );
  assert.equal(await skillHash(touchedMeta), base);
  const touchedSkill = FILES.map((f) =>
    f.path === "SKILL.md" ? { ...f, content: f.content + "\nMore." } : f,
  );
  assert.notEqual(await skillHash(touchedSkill), base);
});

test("prompt carries the skill facts and truncates giant references", () => {
  const stats = analyzeFiles([
    { path: "SKILL.md", content: SKILL_MD },
    { path: "references/huge.md", content: "x".repeat(50000) },
    { path: "references/late.md", content: "never reached" },
  ]);
  const prompt = buildPrompt({ name: "commit-msgs", description: "desc", stats });
  assert.match(prompt, /Name: commit-msgs/);
  assert.match(prompt, /EVALUATION RUBRICS/);
  assert.match(prompt, /references\/huge\.md/);
  assert.match(prompt, /truncated due to size/);
  assert.ok(!prompt.includes("never reached"));
});
