import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEval,
  aggregate,
  annotate,
  statusCode,
  skillStatus,
  attentionScore,
  retireRank,
  mean,
  stddev,
} from "../src/health.js";

test("classifyEval at the 0.8 boundary", () => {
  assert.equal(classifyEval(0.8, 0.8), "non_discriminating");
  assert.equal(classifyEval(0.8, 0.79), "passing");
  assert.equal(classifyEval(0.79, 0.0), "failing");
  assert.equal(classifyEval(1.0, 1.0), "non_discriminating");
});

test("statusCode thresholds: 0.8 pass bar, 0.05 retire delta, 0.15 marginal", () => {
  assert.equal(statusCode(0.79, 0.2, 0.59), "F");
  assert.equal(statusCode(0.85, 0.85, 0.0), "R"); // baseline passes, no delta
  assert.equal(statusCode(0.85, 0.8, 0.05), "R"); // delta exactly at the line
  assert.equal(statusCode(0.9, 0.79, 0.11), "M"); // baseline fails → not retire
  assert.equal(statusCode(0.95, 0.5, 0.45), "H");
  assert.equal(statusCode(0.9, 0.76, 0.14), "M");
  assert.equal(statusCode(0.9, 0.75, 0.15), "H");
});

test("aggregate computes per-config stats, delta, and per-eval statuses", () => {
  const cells = [
    { evalKey: "a", config: "with", passRate: 1.0, durMs: 1000, tokens: 100 },
    { evalKey: "a", config: "without", passRate: 0.5, durMs: 900, tokens: 80 },
    { evalKey: "b", config: "with", passRate: 0.9, durMs: 1100, tokens: 120 },
    { evalKey: "b", config: "without", passRate: 0.9, durMs: 1000, tokens: 90 },
    { evalKey: "c", config: "with", passRate: 0.5, durMs: 0, tokens: 0, error: "judge failed" },
  ];
  const { perEval, agg, errors } = aggregate(cells);
  assert.equal(errors, 1);
  assert.equal(agg.with.passMean, 0.95);
  assert.equal(agg.without.passMean, 0.7);
  assert.equal(agg.delta, 0.25);
  const a = perEval.find((e) => e.key === "a");
  const b = perEval.find((e) => e.key === "b");
  assert.equal(a.status, "passing");
  assert.equal(b.status, "non_discriminating");
});

test("annotate bands", () => {
  const s = (m, sd = 0) => ({ passMean: m, passStddev: sd });
  assert.equal(annotate(s(0.8), s(0.78), 0.02), "no improvement over baseline");
  assert.equal(annotate(s(0.8), s(0.7), 0.1), "marginal improvement");
  assert.equal(annotate(s(0.9), s(0.5), 0.4), "strong skill impact");
  assert.equal(annotate(s(0.9), s(0.7), 0.2), "");
  assert.equal(annotate(s(0.9, 0.25), s(0.5), 0.4), "high variance — results may be unreliable");
});

test("skillStatus precedence: structure, staleness, then verdict", () => {
  assert.equal(skillStatus({ hasEvals: false }), "no-evals");
  assert.equal(skillStatus({ hasEvals: true, row: null }), "not-benchmarked");
  const row = { s: "R", sh: "aaaa1111", pm: "claude" };
  assert.equal(
    skillStatus({ hasEvals: true, row, currentHash: "bbbb2222", provider: "claude" }),
    "stale",
  );
  assert.equal(
    skillStatus({ hasEvals: true, row, currentHash: "aaaa1111", provider: "ollama" }),
    "stale",
  );
  assert.equal(
    skillStatus({ hasEvals: true, row, currentHash: "aaaa1111", provider: "claude" }),
    "retire-candidate",
  );
});

test("attentionScore ordering: popular uncovered beats abandoned uncovered beats covered", () => {
  const uncoveredPopular = attentionScore({ hasEvals: false, events30: 100 });
  const uncoveredQuiet = attentionScore({ hasEvals: false, events30: 0 });
  const healthy = attentionScore({
    hasEvals: true,
    row: { sh: "h", pm: "claude", at: Date.now() / 1000 },
    currentHash: "h",
    provider: "claude",
  });
  assert.ok(uncoveredPopular.score > uncoveredQuiet.score);
  assert.ok(uncoveredQuiet.score > healthy.score);
  assert.ok(uncoveredPopular.reasons.includes("no evals"));
  assert.ok(uncoveredPopular.reasons.includes("high usage"));
});

test("attentionScore flags stale hash and provider change; dismissal dampens", () => {
  const base = {
    hasEvals: true,
    row: { sh: "old", pm: "codex", at: 0 },
    currentHash: "new",
    provider: "claude",
    nowMs: 100 * 86400000,
  };
  const scored = attentionScore(base);
  assert.ok(scored.reasons.includes("benchmark stale"));
  assert.ok(scored.reasons.includes("benchmarked on codex"));
  assert.ok(scored.reasons.includes("benchmark aging"));
  const dismissed = attentionScore({ ...base, dismissed: true });
  assert.equal(dismissed.score, Math.round(scored.score * 0.5 * 10) / 10);
});

test("retireRank grows with baseline pass rate and usage", () => {
  assert.ok(retireRank({ bp: 0.9 }, 100) > retireRank({ bp: 0.9 }, 1));
  assert.ok(retireRank({ bp: 0.95 }, 10) > retireRank({ bp: 0.8 }, 10));
});

test("mean/stddev basics", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(stddev([5]), 0);
  assert.ok(Math.abs(stddev([0, 1]) - 0.5) < 1e-9);
});
