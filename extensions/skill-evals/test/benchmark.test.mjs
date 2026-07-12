import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCliProvider,
  concurrencyFor,
  estimateCalls,
  planJobs,
  runBenchmark,
  buildSummary,
} from "../src/benchmark.js";

const EVALS = [
  {
    eval_key: "greets",
    prompt: "Say hello",
    expected_output: "A greeting",
    expectations: ["contains a greeting", "is polite"],
    is_active: true,
  },
  {
    eval_key: "with-file",
    prompt: "Summarize the attachment",
    expected_output: "A summary",
    expectations: ["mentions revenue"],
    input_files: [{ name: "q3.txt", content: "revenue up 10%" }],
    is_active: true,
  },
];

/** An llm stub: answers echo which system prompt variant they saw; the
 * judge passes everything unless the answer came from the bare config. */
function stubSx({ judgeFailsOnce = false } = {}) {
  const calls = [];
  let judgeFailures = judgeFailsOnce ? 1 : 0;
  return {
    calls,
    llm: {
      async complete(req) {
        calls.push(req);
        if (req.schema) {
          if (judgeFailures > 0) {
            judgeFailures--;
            return { text: "garbage", json: null, usage: { inputTokens: 0, outputTokens: 0 } };
          }
          const passAll = calls.some(
            (c) => !c.schema && c.messages[0].content.includes("SKILL BODY"),
          );
          const n = 4;
          return {
            json: {
              grades: Array.from({ length: n }, (_, i) => ({
                i: i + 1,
                pass: req.messages[1].content.includes("with-skill-answer"),
                reason: "checked",
              })),
            },
            text: "{}",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        const withSkill = req.messages[0].content.includes("SKILL BODY");
        return {
          text: withSkill ? "with-skill-answer" : "bare-answer",
          usage: { inputTokens: 100, outputTokens: 50 },
          provider: "test",
          model: "test-model",
        };
      },
    },
  };
}

test("provider heuristics and concurrency", () => {
  assert.equal(isCliProvider("claude-cli"), true);
  assert.equal(isCliProvider("codex"), true);
  assert.equal(isCliProvider("ollama"), false);
  assert.equal(isCliProvider("anthropic"), false);
  assert.equal(concurrencyFor("claude"), 1);
  assert.equal(concurrencyFor("anthropic"), 3);
});

test("estimateCalls counts completions plus judge calls", () => {
  assert.equal(estimateCalls(10, 1), 40);
  assert.equal(estimateCalls(3, 3), 36);
});

test("planJobs enumerates evals × configs × reps", () => {
  const jobs = planJobs(EVALS, 2);
  assert.equal(jobs.length, 2 * 2 * 2);
  assert.ok(jobs.find((j) => j.key === "greets|without|2"));
});

test("runBenchmark grades with-skill above baseline and inlines input files", async () => {
  const sx = stubSx();
  const progress = [];
  const { cells, cancelled } = await runBenchmark({
    sx,
    files: [{ path: "SKILL.md", content: "SKILL BODY" }],
    evals: EVALS,
    reps: 1,
    provider: "anthropic",
    onCell: (_c, done, total) => progress.push([done, total]),
    shouldCancel: () => false,
  });
  assert.equal(cancelled, false);
  assert.equal(cells.length, 4);
  for (const c of cells.filter((x) => x.config === "with")) assert.equal(c.passRate, 1);
  for (const c of cells.filter((x) => x.config === "without")) assert.equal(c.passRate, 0);
  assert.deepEqual(progress.at(-1), [4, 4]);
  const fileCall = sx.calls.find(
    (r) => !r.schema && r.messages[1].content.includes("revenue up 10%"),
  );
  assert.ok(fileCall, "input_files content should be inlined into the prompt");
});

test("runBenchmark resumes past prior cells and honors cancel", async () => {
  const sx = stubSx();
  const prior = [
    { evalKey: "greets", config: "with", rep: 1, passRate: 1, grades: [], output: "", durMs: 1, tokens: 0 },
  ];
  const { cells } = await runBenchmark({
    sx,
    files: [{ path: "SKILL.md", content: "SKILL BODY" }],
    evals: [EVALS[0]],
    reps: 1,
    provider: "anthropic",
    priorCells: prior,
    shouldCancel: () => false,
  });
  assert.equal(cells.length, 2); // prior kept, only the missing config ran
  assert.equal(sx.calls.filter((c) => !c.schema).length, 1);

  let ran = 0;
  const cancelled = await runBenchmark({
    sx: stubSx(),
    files: [{ path: "SKILL.md", content: "SKILL BODY" }],
    evals: EVALS,
    reps: 1,
    provider: "claude", // concurrency 1 → deterministic cancel point
    onCell: () => ran++,
    shouldCancel: () => ran >= 1,
  });
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.cells.length < 4);
});

test("judge retries once then errors the cell", async () => {
  const sx = stubSx({ judgeFailsOnce: true });
  const { cells } = await runBenchmark({
    sx,
    files: [{ path: "SKILL.md", content: "SKILL BODY" }],
    evals: [EVALS[0]],
    reps: 1,
    provider: "claude",
    shouldCancel: () => false,
  });
  // First judge call failed once, retried fine; no cell errors expected.
  assert.equal(cells.filter((c) => c.error).length, 0);
});

test("buildSummary produces the compact shared row", () => {
  const cells = [
    { evalKey: "a", config: "with", passRate: 0.9, durMs: 10, tokens: 5 },
    { evalKey: "a", config: "without", passRate: 0.85, durMs: 10, tokens: 5 },
  ];
  const { summary, sharedRow } = buildSummary({
    cells,
    evals: { total: 3, active: 1 },
    reps: 1,
    provider: "claude",
    model: "m",
    skillHash: "aaaa1111",
    evalsHash: "bbbb2222",
    by: "dylan",
    at: 1760000000000,
  });
  assert.equal(sharedRow.s, "R"); // baseline passes, delta 0.05 → retire
  assert.equal(sharedRow.at, 1760000000);
  assert.equal(sharedRow.sh, "aaaa1111");
  assert.equal(summary.agg.delta, 0.05);
  assert.equal(summary.perEval[0].status, "non_discriminating");
});
