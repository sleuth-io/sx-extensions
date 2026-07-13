// Pure scoring and aggregation — no sx, no DOM, fully unit-tested.
// Thresholds mirror pulse's benchmark classification so verdicts match
// what skills.new would say about the same skill.

export const PASS_BAR = 0.8; // an eval "passes" a config at this rate
export const DELTA_NONE = 0.05; // at or below: skill adds nothing
export const DELTA_MARGINAL = 0.15; // below: marginal improvement
export const DELTA_STRONG = 0.3; // at or above: strong impact
export const HIGH_VARIANCE = 0.2; // stddev above: unreliable
export const STALE_BENCH_DAYS = 90;

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

/** Pulse's per-eval rule: both configs pass → the skill didn't matter. */
export function classifyEval(withPass, withoutPass) {
  if (withPass >= PASS_BAR) {
    return withoutPass >= PASS_BAR ? "non_discriminating" : "passing";
  }
  return "failing";
}

/** Aggregate graded cells into the run summary. Cells look like
 * {evalKey, config: "with"|"without", passRate, durMs, tokens, error?};
 * errored cells are excluded (counted for the caller to surface). */
export function aggregate(cells) {
  const ok = cells.filter((c) => !c.error);
  const byConfig = (config) => ok.filter((c) => c.config === config);
  const stats = (rows) => ({
    passMean: round2(mean(rows.map((r) => r.passRate))),
    passStddev: round2(stddev(rows.map((r) => r.passRate))),
    durMs: Math.round(mean(rows.map((r) => r.durMs || 0))),
    tokens: Math.round(mean(rows.map((r) => r.tokens || 0))),
  });
  const w = stats(byConfig("with"));
  const wo = stats(byConfig("without"));
  const delta = round2(w.passMean - wo.passMean);

  const perEval = [];
  const keys = [...new Set(ok.map((c) => c.evalKey))];
  for (const key of keys) {
    const withPass = round2(mean(byConfig("with").filter((c) => c.evalKey === key).map((c) => c.passRate)));
    const withoutPass = round2(mean(byConfig("without").filter((c) => c.evalKey === key).map((c) => c.passRate)));
    perEval.push({ key, withPass, withoutPass, status: classifyEval(withPass, withoutPass) });
  }

  return {
    perEval,
    agg: { with: w, without: wo, delta, annotation: annotate(w, wo, delta) },
    errors: cells.length - ok.length,
  };
}

export function annotate(w, wo, delta) {
  if (w.passStddev > HIGH_VARIANCE || wo.passStddev > HIGH_VARIANCE) {
    return "high variance — results may be unreliable";
  }
  if (delta <= DELTA_NONE) return "no improvement over baseline";
  if (delta < DELTA_MARGINAL) return "marginal improvement";
  if (delta >= DELTA_STRONG) return "strong skill impact";
  return "";
}

// ---- Interchange records (docs/benchmarks-spec.md in sx) ----
// The unified benchmark shape shared with skills.new: pulse's
// run_summary as the aggregate, plus per_eval and staleness carriers.

/** Build an interchange record from this extension's aggregate. */
export function toInterchange({ agg, perEval, provider, model, reps, skillHash, by, at }) {
  const stats = (side) => ({
    pass_rate: { mean: side.passMean, stddev: side.passStddev },
    time_seconds: { mean: round2((side.durMs || 0) / 1000) },
    tokens: { mean: side.tokens || 0 },
  });
  return {
    at: new Date(at).toISOString(),
    source: "app",
    executor: { provider, model: model || "" },
    runs_per_config: reps,
    by: by || "",
    summary: {
      with_skill: stats(agg.with),
      without_skill: stats(agg.without),
      delta: {
        pass_rate: agg.delta,
        time_seconds: round2(((agg.with.durMs || 0) - (agg.without.durMs || 0)) / 1000),
        tokens: (agg.with.tokens || 0) - (agg.without.tokens || 0),
      },
    },
    per_eval: perEval.map((p) => ({
      eval_key: p.key,
      with_pass: p.withPass,
      without_pass: p.withoutPass,
      status: p.status,
    })),
    notes: agg.annotation ? [agg.annotation] : [],
    skill_hash: skillHash,
  };
}

/** Normalize an interchange record (app- or server-run) into the row
 * shape the dashboard and tab consume — the same shape legacy
 * sharedStorage verdict rows used, so both sources feed one pipeline. */
export function fromInterchange(record) {
  if (!record || typeof record !== "object" || !record.summary) return null;
  const rate = (side) => record.summary?.[side]?.pass_rate?.mean;
  const wp = round2(Number(rate("with_skill") ?? 0));
  const bp = round2(Number(rate("without_skill") ?? 0));
  const d = round2(Number(record.summary?.delta?.pass_rate ?? wp - bp));
  const atMs = Date.parse(record.at || "") || 0;
  return {
    s: statusCode(wp, bp, d),
    wp,
    bp,
    d,
    at: Math.round(atMs / 1000),
    sh: record.skill_hash || null,
    icv: record.is_current_version ?? null,
    pm: record.executor?.provider || "",
    model: record.executor?.model || "",
    by: record.by || "",
    src: record.source === "server" ? "server" : "app",
    reps: record.runs_per_config || 1,
    perEval: Array.isArray(record.per_eval)
      ? record.per_eval.map((p) => ({
          key: p.eval_key,
          withPass: Number(p.with_pass ?? 0),
          withoutPass: Number(p.without_pass ?? 0),
          status: p.status || classifyEval(Number(p.with_pass ?? 0), Number(p.without_pass ?? 0)),
        }))
      : null,
    notes: Array.isArray(record.notes) ? record.notes : [],
  };
}

/** Status codes stored in verdict rows. */
export function statusCode(withPass, withoutPass, delta) {
  if (withPass < PASS_BAR) return "F"; // failing even with the skill
  if (withoutPass >= PASS_BAR && delta <= DELTA_NONE) return "R"; // retire candidate
  if (delta < DELTA_MARGINAL) return "M";
  return "H";
}

/** Render-time status for a skill given its shared row and live state.
 * Thresholds live here, not in stored data, so they can evolve. */
export function skillStatus({ hasEvals, row, currentHash, provider }) {
  if (!hasEvals) return "no-evals";
  if (!row) return "not-benchmarked";
  if (rowIsStale(row, currentHash, provider)) return "stale";
  if (row.s === "F") return "failing";
  if (row.s === "R") return "retire-candidate";
  if (row.s === "M") return "marginal";
  return "healthy";
}

/** App rows carry the content hash they ran against; server rows carry
 * the server-computed is_current_version flag instead. Server rows are
 * provider-agnostic — skills.new picked its own executor, so a local
 * provider change says nothing about them. */
export function rowIsStale(row, currentHash, provider) {
  if (row.icv === false) return true;
  if (row.sh && row.sh !== currentHash) return true;
  return !!(row.src !== "server" && provider && row.pm && row.pm !== provider);
}

/** The attention queue: what deserves a look right now. Structural need
 * dominates; usage and reach break ties so the popular uncovered skill
 * outranks the abandoned one. Returns {score, reasons}. */
export function attentionScore({
  hasEvals,
  row,
  currentHash,
  provider,
  events30 = 0,
  installRows = null, // null = unknown (not yet refined), {everyone, count} otherwise
  updatedAtMs = 0,
  dismissed = false,
  nowMs = Date.now(),
}) {
  let score = 0;
  const reasons = [];
  if (!hasEvals) {
    score += 40;
    reasons.push("no evals");
  } else if (!row) {
    score += 30;
    reasons.push("never benchmarked");
  } else {
    if (row.icv === false || (row.sh && row.sh !== currentHash)) {
      score += 22;
      reasons.push("benchmark stale");
    }
    if (row.src !== "server" && provider && row.pm && row.pm !== provider) {
      score += 12;
      reasons.push(`benchmarked on ${row.pm}`);
    }
    if (nowMs - row.at * 1000 > STALE_BENCH_DAYS * 86400000) {
      score += 8;
      reasons.push("benchmark aging");
    }
  }
  if (events30 > 0) {
    score += Math.min(20, 5 * Math.log2(1 + events30));
    if (events30 >= 10) reasons.push("high usage");
  }
  if (installRows) {
    score += installRows.everyone ? 10 : Math.min(10, installRows.count);
    if (installRows.everyone) reasons.push("installed everywhere");
  }
  if (updatedAtMs && nowMs - updatedAtMs < 14 * 86400000) {
    score += 5;
    reasons.push("recently updated");
  }
  if (dismissed) score *= 0.5;
  return { score: Math.round(score * 10) / 10, reasons };
}

/** Retire candidates ranked by how much keeping them costs: the most
 * used skill the baseline already passes is the most expensive to keep. */
export function retireRank(row, events30 = 0) {
  return round2((row.bp || 0) * (1 + Math.log2(1 + events30)));
}

export function round2(x) {
  return Math.round(x * 100) / 100;
}
