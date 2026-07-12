// Storage layout and retention. Three tiers:
//   - eval content lives in the skill asset itself (evals/evals.json)
//   - verbose per-run detail stays per-user in sx.storage (10 MB)
//   - only compact verdict rows are team-shared in sx.sharedStorage (256 KB)

export const KEEP_SUMMARIES = 3; // benchmark summaries retained per skill
export const KEEP_DETAILS = 8; // skills with full run detail (LRU by run time)
export const SHARED_BUDGET = 240 * 1024; // stay under the 256 KB hard cap
export const USAGE_DAYS = 30;
const MAX_USAGE_ROWS = 30000;

const EMPTY = { v: 1, usage: {}, hashes: {}, runs: {}, detail: {}, inProgress: null };

export async function loadLocal(sx) {
  const doc = await sx.storage.loadData().catch(() => null);
  return doc && doc.v === 1 ? { ...EMPTY, ...doc } : { ...EMPTY };
}

export async function saveLocal(sx, doc) {
  enforceRetention(doc);
  await sx.storage.saveData(doc).catch(() => {});
}

/** Pure, tested: cap summaries per skill and evict detail beyond the
 * KEEP_DETAILS most recently benchmarked skills. Mutates doc. */
export function enforceRetention(doc) {
  for (const name of Object.keys(doc.runs)) {
    const runs = doc.runs[name];
    if (runs.length > KEEP_SUMMARIES) doc.runs[name] = runs.slice(-KEEP_SUMMARIES);
  }
  const names = Object.keys(doc.detail);
  if (names.length > KEEP_DETAILS) {
    names
      .sort((a, b) => (doc.detail[b].at || 0) - (doc.detail[a].at || 0))
      .slice(KEEP_DETAILS)
      .forEach((name) => delete doc.detail[name]);
  }
  return doc;
}

// ---- Shared summary rows ----

const EMPTY_SHARED = { v: 1, skills: {}, dismissed: {} };

export async function loadShared(sx) {
  const doc = await sx.sharedStorage.load().catch(() => null);
  return doc && doc.v === 1 ? { ...EMPTY_SHARED, ...doc } : { ...EMPTY_SHARED };
}

/** Read-merge-save: re-read immediately before writing to shrink the
 * last-writer-wins window, apply the mutation, prune, save. */
export async function mergeSaveShared(sx, existingSkillNames, mutate) {
  const doc = await loadShared(sx);
  mutate(doc);
  pruneShared(doc, existingSkillNames);
  await sx.sharedStorage.save(doc);
  return doc;
}

/** Pure, tested: drop rows for deleted skills, then oldest rows until
 * the document fits the budget. */
export function pruneShared(doc, existingSkillNames) {
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

// ---- Usage window (repo-doctor's incremental pattern) ----

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

/** Load the usage window, incrementally when the app supports it. Reads
 * and writes doc.usage in place; caller saves the doc. */
export async function loadUsage(sx, doc) {
  const cutoffMs = Date.now() - USAGE_DAYS * 86400000;
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
  const newest = events.reduce((m, e) => (e.timestamp > m ? e.timestamp : m), "");
  if (canIncrement && events.length <= MAX_USAGE_ROWS) {
    doc.usage[`usage:${USAGE_DAYS}`] = { events, newest };
  } else {
    delete doc.usage[`usage:${USAGE_DAYS}`];
  }
  return events;
}

/** Per-skill event counts from a usage window. */
export function usageBySkill(events) {
  const counts = {};
  for (const e of events) counts[e.assetName] = (counts[e.assetName] || 0) + 1;
  return counts;
}
