import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEval,
  aggregate,
  annotate,
  statusCode,
  skillStatus,
  rowIsStale,
  toInterchange,
  fromInterchange,
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

test("interchange round-trip: extension aggregate → record → verdict row", () => {
  const agg = {
    with: { passMean: 0.9, passStddev: 0.05, durMs: 2500, tokens: 1200 },
    without: { passMean: 0.5, passStddev: 0.1, durMs: 2000, tokens: 900 },
    delta: 0.4,
    annotation: "strong skill impact",
  };
  const record = toInterchange({
    agg,
    perEval: [{ key: "a", withPass: 1, withoutPass: 0.5, status: "passing" }],
    provider: "claude-cli",
    model: "claude-sonnet-4-6",
    reps: 3,
    skillHash: "a1b2c3d4",
    by: "detkin@sleuth.io",
    at: 1760000000000,
  });
  assert.equal(record.source, "app");
  assert.equal(record.summary.with_skill.pass_rate.mean, 0.9);
  assert.equal(record.summary.delta.pass_rate, 0.4);
  assert.equal(record.summary.with_skill.time_seconds.mean, 2.5);
  assert.equal(record.summary.delta.tokens, 300);
  assert.deepEqual(record.notes, ["strong skill impact"]);
  assert.equal(record.per_eval[0].eval_key, "a");

  const row = fromInterchange(record);
  assert.equal(row.s, "H");
  assert.equal(row.wp, 0.9);
  assert.equal(row.bp, 0.5);
  assert.equal(row.d, 0.4);
  assert.equal(row.sh, "a1b2c3d4");
  assert.equal(row.pm, "claude-cli");
  assert.equal(row.src, "app");
  assert.equal(row.reps, 3);
  assert.equal(row.at, 1760000000);
  assert.equal(row.perEval[0].key, "a");
});

test("fromInterchange handles server records and junk", () => {
  const server = fromInterchange({
    at: "2026-03-31T11:08:00Z",
    source: "server",
    executor: { provider: "server", model: "claude-sonnet-4-6" },
    runs_per_config: 1,
    summary: {
      with_skill: { pass_rate: { mean: 0.83 } },
      without_skill: { pass_rate: { mean: 0.42 } },
      delta: { pass_rate: 0.42 },
    },
    skill_version: "4",
    is_current_version: false,
  });
  assert.equal(server.src, "server");
  assert.equal(server.icv, false);
  assert.equal(server.s, "H");
  assert.equal(server.perEval, null);

  assert.equal(fromInterchange(null), null);
  assert.equal(fromInterchange({ nope: 1 }), null);
});

test("rowIsStale: hash for app rows, is_current_version for server rows", () => {
  const app = { src: "app", sh: "aaaa", pm: "claude-cli", icv: null };
  assert.equal(rowIsStale(app, "aaaa", "claude-cli"), false);
  assert.equal(rowIsStale(app, "bbbb", "claude-cli"), true);
  assert.equal(rowIsStale(app, "aaaa", "ollama"), true); // provider changed

  const server = { src: "server", sh: null, pm: "server", icv: true };
  assert.equal(rowIsStale(server, "whatever", "claude-cli"), false); // provider-agnostic
  assert.equal(rowIsStale({ ...server, icv: false }, "whatever", "claude-cli"), true);

  // Legacy sharedStorage rows (no src/icv) behave as before.
  const legacy = { s: "H", sh: "aaaa", pm: "codex" };
  assert.equal(rowIsStale(legacy, "aaaa", "codex"), false);
  assert.equal(rowIsStale(legacy, "bbbb", "codex"), true);
  assert.equal(rowIsStale(legacy, "aaaa", "claude"), true);
});

test("mean/stddev basics", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(stddev([5]), 0);
  assert.ok(Math.abs(stddev([0, 1]) - 0.5) < 1e-9);
});
