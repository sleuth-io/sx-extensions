// src/evals.js
var EVALS_PATH = "evals/evals.json";
function normalizeEval(raw) {
  if (!raw || typeof raw !== "object") return null;
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return null;
  const expectations = Array.isArray(raw.expectations) ? raw.expectations.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
  return {
    ...raw,
    eval_key: kebab(String(raw.eval_key || "").trim()) || kebab(prompt.slice(0, 40)),
    prompt,
    expected_output: typeof raw.expected_output === "string" ? raw.expected_output.trim() : "",
    expectations,
    category: raw.category === "edge-case" ? "edge-case" : "basic",
    is_active: raw.is_active !== false
  };
}
function parseEvals(content) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    return { evals: [], invalid: true };
  }
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.evals) ? doc.evals : null;
  if (!list) return { evals: [], invalid: true };
  return { evals: list.map(normalizeEval).filter(Boolean), invalid: false };
}
function serializeEvals(evals) {
  return JSON.stringify({ evals }, null, 2) + "\n";
}
function findEvalsFile(files) {
  return files.find((f) => f.path === EVALS_PATH) || null;
}
function activeEvals(evals) {
  return evals.filter((e) => e.is_active);
}
function kebab(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function dedupeKeys(evals, existingKeys) {
  const taken = new Set(existingKeys);
  return evals.map((e) => {
    let key = e.eval_key || "eval";
    for (let i = 2; taken.has(key); i++) key = `${e.eval_key}-${i}`;
    taken.add(key);
    return { ...e, eval_key: key };
  });
}
function skillSourceFiles(files) {
  return files.filter((f) => f.path !== "metadata.toml" && !f.path.startsWith("evals/")).sort(
    (a, b) => a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)
  );
}
function skillContent(files, maxChars) {
  const joined = skillSourceFiles(files).map((f) => `--- ${f.path} ---
${f.content}`).join("\n\n");
  if (joined.length <= maxChars) return { content: joined, truncated: false };
  return { content: joined.slice(0, maxChars) + "\n\u2026(truncated)", truncated: true };
}
async function skillHash(files) {
  const basis = skillSourceFiles(files).map((f) => JSON.stringify([f.path, f.content])).join("\n");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return [...new Uint8Array(buf).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/store.js
var KEEP_SUMMARIES = 3;
var KEEP_DETAILS = 8;
var SHARED_BUDGET = 240 * 1024;
var USAGE_DAYS = 30;
var FACTS_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_USAGE_ROWS = 3e4;
var EMPTY = { v: 1, usage: {}, hashes: {}, runs: {}, detail: {}, inProgress: null, board: null };
async function loadLocal(sx) {
  const doc = await sx.storage.loadData().catch(() => null);
  return doc && doc.v === 1 ? { ...EMPTY, ...doc } : { ...EMPTY };
}
async function saveLocal(sx, doc) {
  enforceRetention(doc);
  await sx.storage.saveData(doc).catch(() => {
  });
}
function enforceRetention(doc) {
  for (const name of Object.keys(doc.runs)) {
    const runs = doc.runs[name];
    if (runs.length > KEEP_SUMMARIES) doc.runs[name] = runs.slice(-KEEP_SUMMARIES);
  }
  const names = Object.keys(doc.detail);
  if (names.length > KEEP_DETAILS) {
    names.sort((a, b) => (doc.detail[b].at || 0) - (doc.detail[a].at || 0)).slice(KEEP_DETAILS).forEach((name) => delete doc.detail[name]);
  }
  return doc;
}
var EMPTY_SHARED = { v: 1, skills: {}, dismissed: {} };
async function loadShared(sx) {
  const doc = await sx.sharedStorage.load().catch(() => null);
  return doc && doc.v === 1 ? { ...EMPTY_SHARED, ...doc } : { ...EMPTY_SHARED };
}
async function mergeSaveShared(sx, existingSkillNames, mutate) {
  const doc = await loadShared(sx);
  mutate(doc);
  pruneShared(doc, existingSkillNames);
  await sx.sharedStorage.save(doc);
  return doc;
}
function pruneShared(doc, existingSkillNames) {
  if (existingSkillNames) {
    const live = new Set(existingSkillNames);
    for (const name of Object.keys(doc.skills)) if (!live.has(name)) delete doc.skills[name];
    for (const name of Object.keys(doc.dismissed)) if (!live.has(name)) delete doc.dismissed[name];
  }
  let names = Object.keys(doc.skills).sort((a, b) => (doc.skills[a].at || 0) - (doc.skills[b].at || 0));
  while (names.length && JSON.stringify(doc).length > SHARED_BUDGET) {
    delete doc.skills[names.shift()];
  }
  return doc;
}
function mergeDedup(existing, incoming) {
  const keyOf = (e) => `${e.timestamp}|${e.actor}|${e.assetName}|${e.assetVersion}`;
  const seen = new Set(existing.map(keyOf));
  const out = existing.slice();
  for (const e of incoming) {
    const k = keyOf(e);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}
async function loadUsage(sx, doc) {
  const cutoffMs = Date.now() - USAGE_DAYS * 864e5;
  const prior = doc.usage[`usage:${USAGE_DAYS}`];
  const canIncrement = typeof sx.usage.eventsSince === "function";
  let events;
  if (prior && prior.newest && canIncrement) {
    const delta = await sx.usage.eventsSince(prior.newest).catch(() => null);
    events = delta ? mergeDedup(prior.events || [], delta) : await sx.usage.events(USAGE_DAYS);
  } else {
    events = await sx.usage.events(USAGE_DAYS).catch(() => []);
  }
  events = events.filter((e) => new Date(e.timestamp).getTime() >= cutoffMs);
  const newest = events.reduce((m, e) => e.timestamp > m ? e.timestamp : m, "");
  if (canIncrement && events.length <= MAX_USAGE_ROWS) {
    doc.usage[`usage:${USAGE_DAYS}`] = { events, newest };
  } else {
    delete doc.usage[`usage:${USAGE_DAYS}`];
  }
  return events;
}
function usageBySkill(events) {
  const counts = {};
  for (const e of events) counts[e.assetName] = (counts[e.assetName] || 0) + 1;
  return counts;
}

// src/health.js
var PASS_BAR = 0.8;
var DELTA_NONE = 0.05;
var DELTA_MARGINAL = 0.15;
var DELTA_STRONG = 0.3;
var HIGH_VARIANCE = 0.2;
var STALE_BENCH_DAYS = 90;
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}
function classifyEval(withPass, withoutPass) {
  if (withPass >= PASS_BAR) {
    return withoutPass >= PASS_BAR ? "non_discriminating" : "passing";
  }
  return "failing";
}
function aggregate(cells) {
  const ok = cells.filter((c) => !c.error);
  const byConfig = (config) => ok.filter((c) => c.config === config);
  const stats = (rows) => ({
    passMean: round2(mean(rows.map((r) => r.passRate))),
    passStddev: round2(stddev(rows.map((r) => r.passRate))),
    durMs: Math.round(mean(rows.map((r) => r.durMs || 0))),
    tokens: Math.round(mean(rows.map((r) => r.tokens || 0)))
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
    errors: cells.length - ok.length
  };
}
function annotate(w, wo, delta) {
  if (w.passStddev > HIGH_VARIANCE || wo.passStddev > HIGH_VARIANCE) {
    return "high variance \u2014 results may be unreliable";
  }
  if (delta <= DELTA_NONE) return "no improvement over baseline";
  if (delta < DELTA_MARGINAL) return "marginal improvement";
  if (delta >= DELTA_STRONG) return "strong skill impact";
  return "";
}
function statusCode(withPass, withoutPass, delta) {
  if (withPass < PASS_BAR) return "F";
  if (withoutPass >= PASS_BAR && delta <= DELTA_NONE) return "R";
  if (delta < DELTA_MARGINAL) return "M";
  return "H";
}
function skillStatus({ hasEvals, row, currentHash, provider }) {
  if (!hasEvals) return "no-evals";
  if (!row) return "not-benchmarked";
  if (row.sh !== currentHash || provider && row.pm && row.pm !== provider) return "stale";
  if (row.s === "F") return "failing";
  if (row.s === "R") return "retire-candidate";
  if (row.s === "M") return "marginal";
  return "healthy";
}
function attentionScore({
  hasEvals,
  row,
  currentHash,
  provider,
  events30 = 0,
  installRows = null,
  // null = unknown (not yet refined), {everyone, count} otherwise
  updatedAtMs = 0,
  dismissed = false,
  nowMs = Date.now()
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
    if (row.sh !== currentHash) {
      score += 22;
      reasons.push("benchmark stale");
    }
    if (provider && row.pm && row.pm !== provider) {
      score += 12;
      reasons.push(`benchmarked on ${row.pm}`);
    }
    if (nowMs - row.at * 1e3 > STALE_BENCH_DAYS * 864e5) {
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
  if (updatedAtMs && nowMs - updatedAtMs < 14 * 864e5) {
    score += 5;
    reasons.push("recently updated");
  }
  if (dismissed) score *= 0.5;
  return { score: Math.round(score * 10) / 10, reasons };
}
function retireRank(row, events30 = 0) {
  return round2((row.bp || 0) * (1 + Math.log2(1 + events30)));
}
function round2(x) {
  return Math.round(x * 100) / 100;
}

// src/benchmark.js
var BENCH_CONTEXT_CHARS = 16e3;
var JUDGE_OUTPUT_CHARS = 6e3;
var STORED_OUTPUT_CHARS = 1200;
var ANSWER_MAX_TOKENS = 4096;
var JUDGE_MAX_TOKENS = 1024;
function isCliProvider(provider) {
  const p = (provider || "").toLowerCase();
  return p.includes("cli") || ["claude", "codex", "gemini"].includes(p);
}
function concurrencyFor(provider) {
  return isCliProvider(provider) ? 1 : 3;
}
function estimateCalls(activeEvalCount, reps) {
  return activeEvalCount * 2 * reps * 2;
}
function planJobs(evals, reps) {
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
      prompt += `

Input file ${f.name || "attachment"}:
\`\`\`
${f.content}
\`\`\``;
    }
  }
  return prompt;
}
var JUDGE_SCHEMA = {
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
          reason: { type: "string" }
        }
      }
    }
  }
};
var JUDGE_SYSTEM = `You are a strict grader evaluating an AI reply against numbered expectations.
For each expectation decide PASS (the reply clearly satisfies it, with evidence in the text) or FAIL.
Grade only what is in the reply; do not give credit for intent.`;
async function judge(sx, evalSpec, output) {
  const user = [
    `Task given to the assistant:
${evalSpec.prompt}`,
    `Expected outcome:
${evalSpec.expected_output || "(not specified)"}`,
    `Expectations:
${evalSpec.expectations.map((x, i) => `${i + 1}. ${x}`).join("\n")}`,
    `Assistant reply to grade:
${output.slice(0, JUDGE_OUTPUT_CHARS)}`
  ].join("\n\n");
  const req = {
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: user }
    ],
    schema: JUDGE_SCHEMA,
    maxTokens: JUDGE_MAX_TOKENS
  };
  let result = await sx.llm.complete(req);
  let grades = result.json && Array.isArray(result.json.grades) ? result.json.grades : null;
  if (!grades) {
    result = await sx.llm.complete(req);
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
        { role: "user", content: userPrompt(evalSpec) }
      ],
      maxTokens: ANSWER_MAX_TOKENS
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
      tokens: (answer.usage?.inputTokens || 0) + (answer.usage?.outputTokens || 0)
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
      error: String(err?.message || err).slice(0, 300)
    };
  }
}
async function runBenchmark({
  sx,
  files,
  evals,
  reps,
  provider,
  priorCells = [],
  onCell,
  shouldCancel
}) {
  const { content, truncated } = skillContent(files, BENCH_CONTEXT_CHARS);
  const prompts = {
    with: `You are a helpful assistant.

${content}`,
    without: "You are a helpful assistant."
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
function buildSummary({ cells, evals, reps, provider, model, skillHash: skillHash2, evalsHash, by, at }) {
  const { perEval, agg, errors } = aggregate(cells);
  const summary = {
    at,
    provider,
    model,
    runs: reps,
    skillHash: skillHash2,
    evalsHash,
    perEval,
    agg,
    errors
  };
  const sharedRow = {
    s: statusCode(agg.with.passMean, agg.without.passMean, agg.delta),
    wp: agg.with.passMean,
    bp: agg.without.passMean,
    d: agg.delta,
    ev: evals.total,
    ac: evals.active,
    at: Math.round(at / 1e3),
    sh: skillHash2,
    pm: provider,
    by
  };
  return { summary, sharedRow };
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
function sectionLabel(text) {
  return el(
    "div",
    FAINT + "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;",
    text
  );
}
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
function rateBar(label, rate) {
  const wrap = el("div", "display: flex; align-items: center; gap: 6px; font-size: 11px;");
  const track = el(
    "div",
    "width: 72px; height: 6px; border-radius: 999px; background: var(--color-canvas);border: 1px solid var(--color-line); overflow: hidden;"
  );
  const fill = el(
    "div",
    `height: 100%; width: ${Math.round(rate * 100)}%; background: ${rate >= 0.8 ? "var(--color-accent)" : "var(--color-danger)"};`
  );
  track.append(fill);
  wrap.append(el("span", FAINT + "min-width: 46px;", label), track, el("span", SOFT, fmtPct(rate)));
  return wrap;
}
function fmtPct(x) {
  return `${Math.round(x * 100)}%`;
}
function fmtAgo(epochMs) {
  const days = Math.floor((Date.now() - epochMs) / 864e5);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

// src/generate.js
var GENERATION_CONTEXT_CHARS = 8e3;
var DEFAULT_COUNT = 8;
var GENERATION_SCHEMA = {
  type: "object",
  required: ["evals"],
  properties: {
    evals: {
      type: "array",
      items: {
        type: "object",
        required: ["eval_key", "prompt", "expected_output", "expectations", "category"],
        properties: {
          eval_key: { type: "string" },
          prompt: { type: "string" },
          expected_output: { type: "string" },
          expectations: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: ["basic", "edge-case"] }
        }
      }
    }
  }
};
var SYSTEM = `You generate functional test cases (evals) for AI assistant skills.
Rules:
- Each prompt must be a realistic, specific user ask \u2014 something a person
  would actually type \u2014 answerable from the reply text alone.
- Each eval needs 2-4 expectations: short, independently verifiable
  assertions about the reply. Objective checks only; no style opinions.
- eval_key is a unique kebab-case identifier.
- category is "basic" for core behavior, "edge-case" for tricky inputs.`;
async function generateEvals(sx, { name, description, files, existing, count }) {
  const n = count || DEFAULT_COUNT;
  const edge = Math.max(1, Math.round(n / 4));
  const { content, truncated } = skillContent(files, GENERATION_CONTEXT_CHARS);
  const existingKeys = existing.map((e) => e.eval_key);
  const user = [
    `Generate ${n} evals for this skill (${n - edge} "basic", ${edge} "edge-case").`,
    ``,
    `Skill name: ${name}`,
    `Skill description: ${description || "No description"}`,
    existingKeys.length ? `Existing eval keys (do NOT duplicate or rephrase these): ${existingKeys.join(", ")}` : ``,
    ``,
    `Skill content${truncated ? " (truncated)" : ""}:`,
    content
  ].filter((line) => line !== null).join("\n");
  const result = await sx.llm.complete({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user }
    ],
    schema: GENERATION_SCHEMA,
    maxTokens: 8192
  });
  const raw = result.json && Array.isArray(result.json.evals) ? result.json.evals : [];
  const normalized = raw.map(normalizeEval).filter(Boolean);
  return dedupeKeys(normalized, existingKeys);
}
async function writeEvalsDraft(sx, skillName, files, evals) {
  const evalsFile = { path: EVALS_PATH, content: serializeEvals(evals) };
  const nextFiles = [
    // Every other file byte-identical: publish re-zips the draft as the
    // complete next revision, so a dropped file would be a deletion.
    ...files.filter((f) => f.path !== EVALS_PATH),
    evalsFile
  ];
  const drafts = await sx.drafts.list();
  const existing = drafts.find((d) => d.targetAsset === skillName || d.name === skillName);
  if (existing) {
    if (existing.targetAsset !== skillName) {
      return {
        ok: false,
        message: `A draft named "${existing.name}" exists but doesn't target ${skillName} \u2014 publish or discard it first, then regenerate.`
      };
    }
    const overwrite = await sx.ui.confirm(
      `A draft for ${skillName} already exists. Replace its files with the current skill plus the updated evals?`,
      "Update draft"
    );
    if (!overwrite) return { ok: false, message: "Kept the existing draft untouched." };
    await sx.drafts.updateFiles(existing.id, nextFiles);
    return { ok: true, message: `Updated the ${skillName} draft \u2014 review and publish it.` };
  }
  const { id } = await sx.drafts.create({ name: skillName, files: nextFiles });
  await sx.drafts.updateFiles(id, nextFiles);
  const created = (await sx.drafts.list()).find((d) => d.id === id);
  if (!created || created.targetAsset !== skillName) {
    return {
      ok: false,
      message: `Draft "${id}" was created but does not target ${skillName} \u2014 publishing it would create a new asset or reset sharing. Discard it and retry on a newer app build.`
    };
  }
  return { ok: true, message: `Draft with ${evals.length} evals created \u2014 review and publish it.` };
}

// src/ui-tab.js
async function mountTab(plugin, view, ctx) {
  const sx = plugin.sx;
  const name = ctx.assetName;
  const state = {
    disposed: false,
    loading: true,
    isSkill: true,
    files: [],
    evals: [],
    invalid: false,
    provider: "",
    latest: null,
    // newest local RunSummary
    detail: null,
    // local RunDetail for this skill
    sharedRow: null,
    inProgress: null,
    busy: "",
    expanded: /* @__PURE__ */ new Set(),
    reps: 1
  };
  const rerender = () => {
    if (state.disposed) return;
    view.el.style.cssText = "display: flex; flex-direction: column; gap: 10px;";
    view.el.replaceChildren(...render());
  };
  plugin.rerenders.add(rerender);
  const providerWatch = window.setInterval(() => {
    void sx.llm.provider().then((p) => {
      if ((p || "") !== state.provider) {
        state.provider = p || "";
        rerender();
      }
    }).catch(() => {
    });
  }, 2e3);
  view.onDispose(() => {
    state.disposed = true;
    plugin.rerenders.delete(rerender);
    window.clearInterval(providerWatch);
  });
  async function refresh() {
    state.loading = true;
    rerender();
    const [assets, provider, local, shared] = await Promise.all([
      sx.assets.list().catch(() => []),
      sx.llm.provider().catch(() => ""),
      plugin.loadLocal(),
      plugin.loadShared()
    ]);
    const summary = assets.find((a) => a.name === name);
    state.isSkill = !summary || summary.type === "skill";
    state.provider = provider || "";
    if (state.isSkill) {
      state.files = await sx.assets.readFiles(name).catch(() => []);
      const evalsFile = findEvalsFile(state.files);
      const parsed = evalsFile ? parseEvals(evalsFile.content) : { evals: [], invalid: false };
      state.evals = parsed.evals;
      state.invalid = parsed.invalid;
    }
    state.latest = (local.runs[name] || []).at(-1) || null;
    state.detail = local.detail[name] || null;
    state.inProgress = local.inProgress?.skill === name ? local.inProgress : null;
    state.sharedRow = shared.skills[name] || null;
    state.loading = false;
    rerender();
  }
  async function onGenerate(replaceAll) {
    if (!state.provider) {
      sx.ui.openSettings("ai");
      return;
    }
    if (replaceAll) {
      const ok = await sx.ui.confirm(
        `Replace all ${state.evals.length} evals for ${name} with freshly generated ones?`,
        "Regenerate all"
      );
      if (!ok) return;
    }
    state.busy = "Generating evals with your AI provider\u2026";
    rerender();
    try {
      const assets = await sx.assets.list().catch(() => []);
      const description = assets.find((a) => a.name === name)?.description || "";
      const generated = await generateEvals(sx, {
        name,
        description,
        files: state.files,
        existing: replaceAll ? [] : state.evals,
        count: DEFAULT_COUNT
      });
      if (!generated.length) {
        sx.ui.notice("The provider returned no usable evals \u2014 try again.");
        return;
      }
      const next = replaceAll ? generated : [...state.evals, ...generated];
      const res = await writeEvalsDraft(sx, name, state.files, next);
      sx.ui.notice(res.message);
    } catch (err) {
      sx.ui.notice(`Eval generation failed: ${err?.message || err}`);
    } finally {
      state.busy = "";
      await refresh();
    }
  }
  function providerPrompt() {
    const row = el("div", NOTE + "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    const link = el(
      "a",
      "color: var(--color-accent); cursor: pointer; text-decoration: underline;",
      "Open AI settings"
    );
    link.onclick = (e) => {
      e.preventDefault();
      sx.ui.openSettings("ai");
    };
    row.append(
      el(
        "span",
        "",
        "No AI provider configured \u2014 pick one (an installed CLI, a local Ollama model, or your own API key) to generate evals and run benchmarks."
      ),
      link
    );
    return row;
  }
  function verdictStrip() {
    const wrap = el("div", CARD);
    const counts = `${state.evals.length} evals \xB7 ${activeEvals(state.evals).length} active`;
    const head = el("div", "display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;");
    head.append(el("div", "font-weight: 600; font-size: 13px;", counts));
    const s = state.latest;
    if (s) {
      head.append(
        el(
          "span",
          FAINT + "font-size: 12px;",
          `Last benchmark ${fmtAgo(s.at)} on ${s.provider}${s.errors ? ` \xB7 ${s.errors} cells failed to grade` : ""}`
        )
      );
      wrap.append(head);
      const bars = el("div", "display: flex; gap: 18px; flex-wrap: wrap; align-items: center;");
      bars.append(rateBar("with", s.agg.with.passMean), rateBar("without", s.agg.without.passMean));
      const deltaTone = s.agg.delta > 0.05 ? "accent" : "danger";
      bars.append(chip(`delta ${s.agg.delta >= 0 ? "+" : ""}${s.agg.delta}`, deltaTone));
      if (s.agg.annotation) bars.append(el("span", SOFT + "font-size: 12px;", s.agg.annotation));
      wrap.append(bars);
    } else if (state.sharedRow) {
      const r = state.sharedRow;
      head.append(
        el(
          "span",
          FAINT + "font-size: 12px;",
          `Benchmarked by ${r.by || "a teammate"} ${fmtAgo(r.at * 1e3)} on ${r.pm}: with ${fmtPct(
            r.wp
          )} vs baseline ${fmtPct(r.bp)} (delta ${r.d >= 0 ? "+" : ""}${r.d}).`
        )
      );
      wrap.append(head);
    } else {
      head.append(el("span", FAINT + "font-size: 12px;", "Never benchmarked."));
      wrap.append(head);
    }
    return wrap;
  }
  function actionsRow() {
    const row = el("div", "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    const gen = el("button", state.evals.length ? BUTTON : PRIMARY, `Generate ${DEFAULT_COUNT} evals`);
    gen.onclick = () => void onGenerate(false);
    row.append(gen);
    if (state.evals.length) {
      const regen = el("button", BUTTON, "Regenerate all\u2026");
      regen.onclick = () => void onGenerate(true);
      row.append(regen);
      const reps = el("select", BUTTON + "padding: 4px 6px;");
      for (const n of [1, 3]) {
        const opt = el("option", "", `${n} run${n > 1 ? "s" : ""}/config`);
        opt.value = String(n);
        reps.append(opt);
      }
      reps.value = String(state.reps);
      reps.onchange = () => state.reps = Number(reps.value);
      const run = el("button", PRIMARY, "Run benchmark");
      run.onclick = () => void plugin.startBenchmark(name, state.reps).then(refresh);
      row.append(reps, run);
    }
    return row;
  }
  function runStrip() {
    const r = plugin.activeRun;
    if (!r) return null;
    const strip = el(
      "div",
      NOTE + "display: flex; gap: 10px; align-items: center;",
      `Benchmarking ${r.skill}\u2026 ${r.done}/${r.total} cells`
    );
    if (r.skill === name) {
      const cancel = el("button", BUTTON, "Cancel");
      cancel.onclick = () => plugin.cancelBenchmark();
      strip.append(cancel);
    }
    return strip;
  }
  function resumeBanner() {
    if (!state.inProgress || plugin.activeRun) return null;
    const row = el(
      "div",
      NOTE + "display: flex; gap: 10px; align-items: center;",
      `An interrupted benchmark for ${name} has ${state.inProgress.cells?.length || 0} finished cells.`
    );
    const resume = el("button", PRIMARY, "Resume");
    resume.onclick = () => void plugin.resumeBenchmark().then(refresh);
    const discard = el("button", BUTTON, "Discard");
    discard.onclick = () => void plugin.discardInProgress().then(refresh);
    row.append(resume, discard);
    return row;
  }
  function evalCard(spec) {
    const card = el("div", CARD + (spec.is_active ? "" : "opacity: 0.55;"));
    const head = el("div", "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    head.append(
      el("code", "font-family: var(--font-mono); font-size: 12px;", spec.eval_key),
      chip(spec.category, spec.category === "edge-case" ? "accent" : "faint")
    );
    if (!spec.is_active) head.append(chip("inactive", "faint"));
    const per = state.latest?.perEval.find((p) => p.key === spec.eval_key);
    if (per) {
      head.append(
        chip(
          per.status.replace(/_/g, " "),
          per.status === "passing" ? "accent" : per.status === "failing" ? "danger" : "faint"
        )
      );
    }
    card.append(head, el("div", "font-size: 13px; line-height: 1.45;", spec.prompt));
    const exp = el("ul", "margin: 0; padding-left: 18px; font-size: 12px;" + SOFT);
    for (const x of spec.expectations) exp.append(el("li", "", x));
    card.append(exp);
    if (per) {
      const bars = el("div", "display: flex; gap: 18px; flex-wrap: wrap;");
      bars.append(rateBar("with", per.withPass), rateBar("without", per.withoutPass));
      card.append(bars);
    }
    const cells = (state.detail?.cells || []).filter((c) => c.evalKey === spec.eval_key);
    if (cells.length) {
      const toggle = el(
        "a",
        FAINT + "font-size: 12px; cursor: pointer; text-decoration: underline;",
        state.expanded.has(spec.eval_key) ? "Hide last run detail" : "Show last run detail"
      );
      toggle.onclick = () => {
        state.expanded.has(spec.eval_key) ? state.expanded.delete(spec.eval_key) : state.expanded.add(spec.eval_key);
        rerender();
      };
      card.append(toggle);
      if (state.expanded.has(spec.eval_key)) {
        for (const c of cells) {
          const box = el("div", NOTE);
          const title = c.error ? `${c.config} \xB7 run ${c.rep} \xB7 errored: ${c.error}` : `${c.config} \xB7 run ${c.rep} \xB7 ${fmtPct(c.passRate)}`;
          box.append(el("div", "font-weight: 600; font-size: 12px;", title));
          for (const g of c.grades || []) {
            box.append(el("div", (g.pass ? SOFT : "color: var(--color-danger);") + "font-size: 12px;", `${g.pass ? "\u2713" : "\u2717"} ${g.text} \u2014 ${g.reason}`));
          }
          if (c.output) {
            box.append(el("div", FAINT + "font-size: 11px; white-space: pre-wrap; font-family: var(--font-mono);", c.output));
          }
          card.append(box);
        }
      }
    }
    return card;
  }
  function render() {
    if (!state.isSkill) {
      return [el("div", FAINT + "font-size: 13px; padding: 8px;", "Evals apply to skills \u2014 this asset type has none.")];
    }
    if (state.loading) {
      return [el("div", FAINT + "font-size: 13px; padding: 8px;", "Loading evals\u2026")];
    }
    const out = [];
    if (!state.provider) out.push(providerPrompt());
    const strip = runStrip();
    if (strip) out.push(strip);
    const banner = resumeBanner();
    if (banner) out.push(banner);
    if (state.busy) out.push(el("div", NOTE, state.busy));
    out.push(verdictStrip(), actionsRow());
    if (state.invalid) {
      out.push(el("div", NOTE + "color: var(--color-danger);", "evals/evals.json exists but couldn't be parsed \u2014 regenerate or fix it by hand."));
    }
    if (!state.evals.length) {
      out.push(
        el(
          "div",
          FAINT + "font-size: 13px;",
          "No evals yet. Generate a starter set \u2014 they land in a draft you review and publish, as evals/evals.json inside the skill (the same format skills.new ships)."
        )
      );
    } else {
      out.push(...state.evals.map(evalCard));
    }
    return out;
  }
  rerender();
  await refresh();
}

// src/ui-main.js
var STATUS_LABEL = {
  "no-evals": "No evals",
  "not-benchmarked": "Not benchmarked",
  stale: "Stale",
  failing: "Failing",
  "retire-candidate": "Retire candidate",
  marginal: "Marginal",
  healthy: "Healthy"
};
var STATUS_ORDER = [
  "retire-candidate",
  "failing",
  "no-evals",
  "not-benchmarked",
  "stale",
  "marginal",
  "healthy"
];
async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
async function mountMain(plugin, view) {
  const sx = plugin.sx;
  const state = {
    disposed: false,
    status: "Loading library\u2026",
    refreshing: false,
    provider: "",
    rows: [],
    dismissed: {},
    filter: "",
    collectedAt: 0
  };
  const rerender = () => {
    if (state.disposed) return;
    view.el.style.cssText = "display: flex; flex-direction: column; gap: 12px;";
    view.el.replaceChildren(...render());
  };
  plugin.rerenders.add(rerender);
  const providerWatch = window.setInterval(() => {
    void sx.llm.provider().then((p) => {
      if ((p || "") !== state.provider) {
        state.provider = p || "";
        rerender();
      }
    }).catch(() => {
    });
  }, 2e3);
  view.onDispose(() => {
    state.disposed = true;
    plugin.rerenders.delete(rerender);
    window.clearInterval(providerWatch);
  });
  async function collect(force = false) {
    if (state.refreshing) return;
    state.refreshing = true;
    state.status = state.rows.length ? "" : "Loading library\u2026";
    rerender();
    const [local, shared, provider, assets] = await Promise.all([
      plugin.loadLocal(),
      plugin.loadShared(),
      sx.llm.provider().catch(() => ""),
      sx.assets.list().catch(() => [])
    ]);
    state.provider = provider || "";
    state.dismissed = shared.dismissed || {};
    const skills = assets.filter((a) => a.type === "skill");
    const events = await loadUsage(sx, local);
    const usage = usageBySkill(events);
    let done = 0;
    const rows = [];
    await pool(skills, 8, async (summary) => {
      if (state.disposed) return;
      const facts = await plugin.skillFacts(local, summary, force).catch(() => ({ hash: "", evalCount: 0, activeCount: 0 }));
      done++;
      if (done % 10 === 0 && !state.rows.length) {
        state.status = `Reading skills\u2026 ${done}/${skills.length}`;
        rerender();
      }
      const row = shared.skills[summary.name] || null;
      const hasEvals = facts.activeCount > 0;
      const dismissed = !!state.dismissed[summary.name];
      const events30 = usage[summary.name] || 0;
      const status = skillStatus({
        hasEvals,
        row,
        currentHash: facts.hash,
        provider: state.provider
      });
      const attn = attentionScore({
        hasEvals,
        row,
        currentHash: facts.hash,
        provider: state.provider,
        events30,
        updatedAtMs: summary.updatedAt ? new Date(summary.updatedAt).getTime() : 0,
        dismissed
      });
      rows.push({
        name: summary.name,
        description: summary.description,
        facts,
        row,
        status,
        score: attn.score,
        reasons: attn.reasons,
        events30,
        dismissed
      });
    });
    await saveLocal(sx, local);
    const head = rows.slice().sort((a, b) => b.score - a.score).slice(0, 10);
    await pool(head, 4, async (r) => {
      const inst = await sx.assets.installations(r.name).catch(() => null);
      if (!inst) return;
      const attn = attentionScore({
        hasEvals: r.facts.activeCount > 0,
        row: r.row,
        currentHash: r.facts.hash,
        provider: state.provider,
        events30: r.events30,
        installRows: { everyone: inst.everyone, count: inst.installations.length },
        updatedAtMs: 0,
        dismissed: r.dismissed
      });
      r.score = attn.score;
      r.reasons = attn.reasons;
      r.everyone = inst.everyone;
    });
    state.rows = rows;
    state.status = "";
    state.refreshing = false;
    state.collectedAt = Date.now();
    const snapshot = await plugin.loadLocal();
    snapshot.board = { rows, dismissed: state.dismissed, provider: state.provider, collectedAt: state.collectedAt };
    await saveLocal(sx, snapshot);
    rerender();
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
  async function dismiss(name, undo) {
    const by = await sx.app.currentUser().catch(() => "");
    const names = state.rows.map((r) => r.name);
    await plugin.mergeSaveShared(names, (doc) => {
      if (undo) delete doc.dismissed[name];
      else doc.dismissed[name] = { by, at: (/* @__PURE__ */ new Date()).toISOString() };
    });
    await collect();
  }
  function header() {
    const wrap = el("div", "display: flex; gap: 10px; align-items: center; flex-wrap: wrap;");
    const title = el("div", "");
    const skills = state.rows.length;
    const withEvals = state.rows.filter((r) => r.facts.activeCount > 0).length;
    const benched = state.rows.filter((r) => r.row).length;
    const retire = state.rows.filter((r) => r.status === "retire-candidate" && !r.dismissed).length;
    const failing = state.rows.filter((r) => r.status === "failing").length;
    const rollup = skills ? `${skills} skills \xB7 ${withEvals} with evals (${Math.round(withEvals / skills * 100)}%) \xB7 ${benched} benchmarked \xB7 ${retire} retire candidate${retire === 1 ? "" : "s"} \xB7 ${failing} failing` : "No skills in this library yet.";
    title.append(el("div", SOFT + "font-size: 13px;", rollup));
    const spacer = el("div", "flex: 1;");
    if (state.refreshing && state.rows.length) {
      wrap.append(title, spacer, el("span", FAINT + "font-size: 12px;", "Refreshing\u2026"));
      return wrap;
    }
    const refresh = el("button", SMALL_BUTTON, "Refresh");
    refresh.title = "Re-read every skill's files (evals can change without a version bump)";
    refresh.onclick = () => void collect(true);
    wrap.append(title, spacer, refresh);
    return wrap;
  }
  function providerPrompt() {
    const row = el("div", NOTE + "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;");
    const link = el(
      "a",
      "color: var(--color-accent); cursor: pointer; text-decoration: underline;",
      "Open AI settings"
    );
    link.onclick = (e) => {
      e.preventDefault();
      sx.ui.openSettings("ai");
    };
    row.append(
      el("span", "", "No AI provider configured \u2014 benchmarks and eval generation need one."),
      link
    );
    return row;
  }
  function runStrip() {
    const r = plugin.activeRun;
    if (!r) return null;
    return el(
      "div",
      NOTE,
      `Benchmarking ${r.skill}\u2026 ${r.done}/${r.total} cells. Progress and cancel live on the skill's Evals tab.`
    );
  }
  function queueRow(r) {
    const row = el(
      "div",
      "display: flex; gap: 8px; align-items: center; padding: 6px 10px;border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;background: var(--color-surface);"
    );
    const nameLink = el(
      "a",
      "font-weight: 600; cursor: pointer; color: var(--color-ink); white-space: nowrap;",
      r.name
    );
    nameLink.onclick = () => sx.ui.openAsset(r.name);
    row.append(nameLink);
    for (const reason of r.reasons.slice(0, 2)) row.append(chip(reason, "faint"));
    const action = el(
      "button",
      SMALL_BUTTON + "margin-left: auto;",
      r.facts.activeCount > 0 ? "Benchmark" : "Add evals"
    );
    action.onclick = () => {
      if (r.facts.activeCount > 0) void plugin.startBenchmark(r.name, 1).then(collect);
      else sx.ui.openAsset(r.name);
    };
    row.append(action);
    return row;
  }
  function retireRow(r) {
    const row = el(
      "div",
      "display: flex; flex-direction: column; gap: 3px; padding: 6px 10px;border: 1px solid var(--color-line); border-radius: 8px;background: var(--color-surface);"
    );
    const head = el("div", "display: flex; gap: 8px; align-items: center;");
    const nameLink = el(
      "a",
      "font-weight: 600; font-size: 12px; cursor: pointer; color: var(--color-ink); white-space: nowrap;",
      r.name
    );
    nameLink.onclick = () => sx.ui.openAsset(r.name);
    head.append(
      nameLink,
      chip("retire candidate", "danger"),
      menuButton([
        { label: "Re-benchmark", run: () => void plugin.startBenchmark(r.name, 1).then(collect) },
        { label: "Mark deprecated\u2026", run: () => void markDeprecated(r.name) },
        { label: "Dismiss", run: () => void dismiss(r.name, false), danger: true }
      ])
    );
    const evidence = `Baseline passes ${fmtPct(r.row.bp)} without it \xB7 \u0394 ${r.row.d >= 0 ? "+" : ""}${r.row.d} \xB7 ${r.events30} uses/30d${r.everyone ? " \xB7 installed everywhere" : ""} \xB7 by ${r.row.by || "a teammate"} ${fmtAgo(r.row.at * 1e3)} on ${r.row.pm}`;
    row.append(head, el("div", FAINT + "font-size: 11px;", evidence));
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
      (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.score - a.score
    );
    for (const r of rows) {
      const line = el(
        "div",
        "display: flex; gap: 10px; align-items: center; padding: 6px 10px;border: 1px solid var(--color-line); border-radius: 8px; font-size: 12px;background: var(--color-surface); cursor: pointer;"
      );
      line.onclick = () => sx.ui.openAsset(r.name);
      const tone = r.status === "healthy" ? "accent" : r.status === "retire-candidate" || r.status === "failing" ? "danger" : "faint";
      const detail = r.row ? `with ${fmtPct(r.row.wp)} \xB7 baseline ${fmtPct(r.row.bp)} \xB7 \u0394 ${r.row.d >= 0 ? "+" : ""}${r.row.d}` : r.facts.activeCount > 0 ? `${r.facts.activeCount} active eval${r.facts.activeCount === 1 ? "" : "s"}` : "";
      line.append(
        el("span", "font-weight: 600; min-width: 160px;", r.name),
        chip(STATUS_LABEL[r.status] + (r.dismissed ? " \xB7 dismissed" : ""), tone)
      );
      if (detail) line.append(el("span", SOFT, detail));
      if (r.events30 > 0) {
        line.append(el("span", FAINT + "margin-left: auto; white-space: nowrap;", `${r.events30} uses/30d`));
      }
      wrap.append(line);
    }
    return wrap;
  }
  function render() {
    const out = [];
    if (!state.provider) out.push(providerPrompt());
    const strip = runStrip();
    if (strip) out.push(strip);
    out.push(header());
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
    const retire = state.rows.filter((r) => r.status === "retire-candidate" && !r.dismissed).sort((a, b) => retireRank(b.row, b.events30) - retireRank(a.row, a.events30));
    if (retire.length) {
      const label = sectionLabel(`Retire candidates (${retire.length})`);
      label.title = "The baseline model already passes these skills' own evals \u2014 they may not be earning their keep.";
      out.push(label);
      const list = el("div", "display: flex; flex-direction: column; gap: 4px;");
      list.append(...retire.map(retireRow));
      out.push(list);
    }
    out.push(sectionLabel("All skills"), table());
    return out;
  }
  rerender();
  const cachedBoard = (await plugin.loadLocal()).board;
  if (cachedBoard?.rows?.length && !state.disposed) {
    state.rows = cachedBoard.rows;
    state.dismissed = cachedBoard.dismissed || {};
    state.provider = cachedBoard.provider || "";
    state.collectedAt = cachedBoard.collectedAt || 0;
    state.status = "";
    rerender();
  }
  await collect();
}

// src/index.js
var SkillEvals = class {
  onload(sx) {
    this.sx = sx;
    this.activeRun = null;
    this.rerenders = /* @__PURE__ */ new Set();
    sx.registerMainView({
      id: "skill-evals",
      title: "Skill Evals",
      section: "tools",
      mount: (view) => void mountMain(this, view)
    });
    sx.registerAssetTab({
      id: "evals",
      title: "Evals",
      mount: (view, ctx) => void mountTab(this, view, ctx)
    });
    sx.registerCommand({
      id: "open-health",
      title: "Skill Evals: open dashboard",
      run: () => sx.ui.openView("skill-evals")
    });
    sx.on("asset-published", ({ name }) => this.dropHash(name));
  }
  notify() {
    for (const fn of this.rerenders) fn();
  }
  async dropHash(name) {
    const local = await loadLocal(this.sx);
    if (local.hashes[name]) {
      delete local.hashes[name];
      await saveLocal(this.sx, local);
    }
  }
  /** Cached per-skill facts: content hash + eval counts. Re-read when the
   * asset's updatedAt moved, when the entry ages past the TTL (evals can
   * change server-side without a version bump), or when forced by the
   * Refresh button. Callers pass the local doc and save it after their
   * batch. */
  async skillFacts(local, summary, force = false) {
    const cached = local.hashes[summary.name];
    const fresh = cached && cached.updatedAt === (summary.updatedAt || "") && Date.now() - (cached.checkedAt || 0) < FACTS_TTL_MS;
    if (fresh && !force) return cached;
    const files = await this.sx.assets.readFiles(summary.name);
    const evalsFile = findEvalsFile(files);
    const evals = evalsFile ? parseEvals(evalsFile.content).evals : [];
    const facts = {
      updatedAt: summary.updatedAt || "",
      checkedAt: Date.now(),
      hash: await skillHash(files),
      evalCount: evals.length,
      activeCount: activeEvals(evals).length
    };
    local.hashes[summary.name] = facts;
    return facts;
  }
  /** Kick off (or refuse) a benchmark for one skill. Entry point for
   * both views. */
  async startBenchmark(skillName, reps) {
    const sx = this.sx;
    if (this.activeRun) {
      sx.ui.notice(`Already benchmarking ${this.activeRun.skill} \u2014 one run at a time.`);
      return;
    }
    const provider = await sx.llm.provider().catch(() => "");
    if (!provider) {
      sx.ui.notice("No AI provider configured \u2014 set one in Settings \u2192 AI provider.");
      sx.ui.openSettings("ai");
      return;
    }
    const files = await sx.assets.readFiles(skillName);
    const evalsFile = findEvalsFile(files);
    const evals = evalsFile ? parseEvals(evalsFile.content).evals : [];
    const active = activeEvals(evals);
    if (!active.length) {
      sx.ui.notice(`${skillName} has no active evals \u2014 generate some first.`);
      return;
    }
    const calls = estimateCalls(active.length, reps);
    const slow = isCliProvider(provider) ? " CLI providers can take minutes per call, one at a time." : "";
    const ok = await sx.ui.confirm(
      `Run ${calls} AI calls against "${provider}" (${active.length} evals \xD7 with/without \xD7 ${reps} run${reps > 1 ? "s" : ""}, plus grading)?${slow}`,
      "Run benchmark"
    );
    if (!ok) return;
    await this.execute({ skillName, reps, provider, files, evals, active, priorCells: [] });
  }
  /** Resume the persisted in-progress run, discarding it if the skill's
   * content changed since it started. */
  async resumeBenchmark() {
    const sx = this.sx;
    if (this.activeRun) return;
    const local = await loadLocal(sx);
    const saved = local.inProgress;
    if (!saved) return;
    const files = await sx.assets.readFiles(saved.skill);
    const hash = await skillHash(files);
    if (hash !== saved.skillHash) {
      local.inProgress = null;
      await saveLocal(sx, local);
      sx.ui.notice(`${saved.skill} changed since the interrupted run \u2014 start a fresh benchmark.`);
      this.notify();
      return;
    }
    const evalsFile = findEvalsFile(files);
    const evals = evalsFile ? parseEvals(evalsFile.content).evals : [];
    await this.execute({
      skillName: saved.skill,
      reps: saved.reps,
      provider: saved.provider,
      files,
      evals,
      active: activeEvals(evals),
      priorCells: saved.cells || []
    });
  }
  async discardInProgress() {
    const local = await loadLocal(this.sx);
    local.inProgress = null;
    await saveLocal(this.sx, local);
    this.notify();
  }
  async execute({ skillName, reps, provider, files, evals, active, priorCells }) {
    const sx = this.sx;
    const hash = await skillHash(files);
    const evalsHash = await skillHash([
      { path: "evals", content: JSON.stringify(active.map((e) => e.eval_key)) }
    ]);
    this.activeRun = {
      skill: skillName,
      reps,
      provider,
      done: priorCells.length,
      total: active.length * 2 * reps,
      cancel: false
    };
    this.notify();
    let lastModel = "";
    const progressCells = priorCells.slice();
    const { cells, cancelled } = await runBenchmark({
      sx: {
        llm: {
          complete: async (req) => {
            const res = await sx.llm.complete(req);
            if (!req.schema) lastModel = res.model || lastModel;
            return res;
          }
        }
      },
      files,
      evals: active,
      reps,
      provider,
      priorCells,
      onCell: async (cell, done, total) => {
        progressCells.push(cell);
        if (this.activeRun) {
          this.activeRun.done = done;
          this.activeRun.total = total;
        }
        const local2 = await loadLocal(sx);
        local2.inProgress = { skill: skillName, reps, provider, skillHash: hash, cells: progressCells };
        await saveLocal(sx, local2);
        this.notify();
      },
      shouldCancel: () => this.activeRun?.cancel
    });
    this.activeRun = null;
    if (cancelled) {
      sx.ui.notice(`Benchmark paused with ${cells.length} cells done \u2014 resume from the skill's Evals tab.`);
      this.notify();
      return;
    }
    const at = Date.now();
    const by = await sx.app.currentUser().catch(() => "");
    const { summary, sharedRow } = buildSummary({
      cells,
      evals: { total: evals.length, active: active.length },
      reps,
      provider,
      model: lastModel,
      skillHash: hash,
      evalsHash,
      by,
      at
    });
    const local = await loadLocal(sx);
    local.runs[skillName] = [...local.runs[skillName] || [], summary];
    local.detail[skillName] = { at, cells };
    local.inProgress = null;
    await saveLocal(sx, local);
    const names = (await sx.assets.list().catch(() => [])).map((a) => a.name);
    await mergeSaveShared(sx, names, (doc) => {
      doc.skills[skillName] = sharedRow;
    }).catch(() => sx.ui.notice("Benchmark saved locally; sharing the summary row failed."));
    sx.ui.notice(
      `Benchmark done: with ${Math.round(summary.agg.with.passMean * 100)}% vs baseline ${Math.round(
        summary.agg.without.passMean * 100
      )}% (${summary.agg.delta >= 0 ? "+" : ""}${summary.agg.delta}).`
    );
    this.notify();
  }
  cancelBenchmark() {
    if (this.activeRun) this.activeRun.cancel = true;
  }
  // Small shared reads the views use.
  loadLocal() {
    return loadLocal(this.sx);
  }
  loadShared() {
    return loadShared(this.sx);
  }
  mergeSaveShared(names, mutate) {
    return mergeSaveShared(this.sx, names, mutate);
  }
};
export {
  SkillEvals as default
};
