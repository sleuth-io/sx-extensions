// Benchmark execution: every active eval runs with and without the skill
// through the user's provider, an LLM judge grades each expectation, and
// the aggregate says whether the skill earns its keep.

import { skillContent } from "./evals.js";
import { aggregate, statusCode, round2 } from "./health.js";

export const BENCH_CONTEXT_CHARS = 16000;
const JUDGE_OUTPUT_CHARS = 6000; // what the judge sees
const STORED_OUTPUT_CHARS = 1200; // what we persist per cell
const ANSWER_MAX_TOKENS = 4096;
const JUDGE_MAX_TOKENS = 1024;

/** CLI providers run one slow completion at a time; API/local providers
 * tolerate a little parallelism. */
export function isCliProvider(provider) {
  const p = (provider || "").toLowerCase();
  return p.includes("cli") || ["claude", "codex", "gemini"].includes(p);
}

export function concurrencyFor(provider) {
  return isCliProvider(provider) ? 1 : 3;
}

/** Completions + judge calls the run will make — for the confirm dialog. */
export function estimateCalls(activeEvalCount, reps) {
  return activeEvalCount * 2 * reps * 2;
}

export function planJobs(evals, reps) {
  const jobs = [];
  for (const e of evals) {
    for (const config of ["with", "without"]) {
      for (let rep = 1; rep <= reps; rep++) {
        jobs.push({ key: `${e.eval_key}|${config}|${rep}`, evalKey: e.eval_key, config, rep });
      }
    }
  }
  return jobs;
}

function userPrompt(evalSpec) {
  let prompt = evalSpec.prompt;
  for (const f of evalSpec.input_files || []) {
    if (f && typeof f.content === "string") {
      prompt += `\n\nInput file ${f.name || "attachment"}:\n\`\`\`\n${f.content}\n\`\`\``;
    }
  }
  return prompt;
}

const JUDGE_SCHEMA = {
  type: "object",
  required: ["grades"],
  properties: {
    grades: {
      type: "array",
      items: {
        type: "object",
        required: ["i", "pass", "reason"],
        properties: {
          i: { type: "integer" },
          pass: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
  },
};

const JUDGE_SYSTEM = `You are a strict grader evaluating an AI reply against numbered expectations.
For each expectation decide PASS (the reply clearly satisfies it, with evidence in the text) or FAIL.
Grade only what is in the reply; do not give credit for intent.`;

async function judge(sx, evalSpec, output) {
  const user = [
    `Task given to the assistant:\n${evalSpec.prompt}`,
    `Expected outcome:\n${evalSpec.expected_output || "(not specified)"}`,
    `Expectations:\n${evalSpec.expectations.map((x, i) => `${i + 1}. ${x}`).join("\n")}`,
    `Assistant reply to grade:\n${output.slice(0, JUDGE_OUTPUT_CHARS)}`,
  ].join("\n\n");
  const req = {
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: user },
    ],
    schema: JUDGE_SCHEMA,
    maxTokens: JUDGE_MAX_TOKENS,
  };
  let result = await sx.llm.complete(req);
  let grades = result.json && Array.isArray(result.json.grades) ? result.json.grades : null;
  if (!grades) {
    result = await sx.llm.complete(req); // one retry on malformed judge output
    grades = result.json && Array.isArray(result.json.grades) ? result.json.grades : null;
  }
  if (!grades) throw new Error("judge returned no grades");
  return evalSpec.expectations.map((text, idx) => {
    const g = grades.find((x) => x.i === idx + 1) || {};
    return { text, pass: g.pass === true, reason: String(g.reason || "").slice(0, 200) };
  });
}

async function runCell(sx, job, evalSpec, systemPrompt) {
  const started = Date.now();
  try {
    const answer = await sx.llm.complete({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt(evalSpec) },
      ],
      maxTokens: ANSWER_MAX_TOKENS,
    });
    const grades = await judge(sx, evalSpec, answer.text);
    const passed = grades.filter((g) => g.pass).length;
    return {
      evalKey: job.evalKey,
      config: job.config,
      rep: job.rep,
      passRate: round2(grades.length ? passed / grades.length : 0),
      grades,
      output: answer.text.slice(0, STORED_OUTPUT_CHARS),
      durMs: Date.now() - started,
      tokens: (answer.usage?.inputTokens || 0) + (answer.usage?.outputTokens || 0),
    };
  } catch (err) {
    return {
      evalKey: job.evalKey,
      config: job.config,
      rep: job.rep,
      passRate: 0,
      grades: [],
      output: "",
      durMs: Date.now() - started,
      tokens: 0,
      error: String(err?.message || err).slice(0, 300),
    };
  }
}

/** Run (or resume) a benchmark. `priorCells` are already-finished cells
 * from an interrupted run — their jobs are skipped. Calls onCell after
 * every finished cell so the caller can persist progress; checks
 * shouldCancel between jobs. Returns all cells (prior + new). */
export async function runBenchmark({
  sx,
  files,
  evals,
  reps,
  provider,
  priorCells = [],
  onCell,
  shouldCancel,
}) {
  const { content, truncated } = skillContent(files, BENCH_CONTEXT_CHARS);
  const prompts = {
    with: `You are a helpful assistant.\n\n${content}`,
    without: "You are a helpful assistant.",
  };
  const byKey = new Map(evals.map((e) => [e.eval_key, e]));
  const done = new Set(priorCells.map((c) => `${c.evalKey}|${c.config}|${c.rep}`));
  const jobs = planJobs(evals, reps).filter((j) => !done.has(j.key));
  const cells = priorCells.slice();

  let next = 0;
  let finished = priorCells.length;
  const total = finished + jobs.length;
  const worker = async () => {
    while (next < jobs.length) {
      if (shouldCancel?.()) return;
      const job = jobs[next++];
      const cell = await runCell(sx, job, byKey.get(job.evalKey), prompts[job.config]);
      cells.push(cell);
      finished++;
      await onCell?.(cell, finished, total);
    }
  };
  const n = Math.min(concurrencyFor(provider), jobs.length);
  await Promise.all(Array.from({ length: Math.max(n, 1) }, worker));
  return { cells, truncated, cancelled: !!shouldCancel?.(), total };
}

/** Fold finished cells into the persisted summary + the shared row. */
export function buildSummary({ cells, evals, reps, provider, model, skillHash, evalsHash, by, at }) {
  const { perEval, agg, errors } = aggregate(cells);
  const summary = {
    at,
    provider,
    model,
    runs: reps,
    skillHash,
    evalsHash,
    perEval,
    agg,
    errors,
  };
  const sharedRow = {
    s: statusCode(agg.with.passMean, agg.without.passMean, agg.delta),
    wp: agg.with.passMean,
    bp: agg.without.passMean,
    d: agg.delta,
    ev: evals.total,
    ac: evals.active,
    at: Math.round(at / 1000),
    sh: skillHash,
    pm: provider,
    by,
  };
  return { summary, sharedRow };
}
