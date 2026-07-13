import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceRetention,
  pruneShared,
  usageBySkill,
  KEEP_SUMMARIES,
  KEEP_DETAILS,
  SHARED_BUDGET,
} from "../src/store.js";

test("enforceRetention caps summaries and evicts detail LRU by run time", () => {
  const doc = { runs: {}, detail: {} };
  doc.runs.a = [1, 2, 3, 4, 5].map((i) => ({ at: i }));
  for (let i = 0; i < KEEP_DETAILS + 3; i++) {
    doc.detail[`skill-${i}`] = { at: i };
  }
  enforceRetention(doc);
  assert.equal(doc.runs.a.length, KEEP_SUMMARIES);
  assert.deepEqual(doc.runs.a.map((r) => r.at), [3, 4, 5]); // newest kept
  assert.equal(Object.keys(doc.detail).length, KEEP_DETAILS);
  assert.ok(!doc.detail["skill-0"]); // oldest evicted
  assert.ok(doc.detail[`skill-${KEEP_DETAILS + 2}`]); // newest kept
});

test("pruneShared drops deleted skills and oldest rows past the budget", () => {
  const doc = { v: 1, skills: {}, dismissed: { ghost: { by: "x", at: 1 } } };
  doc.skills.ghost = { at: 1 };
  doc.skills.alive = { at: 2 };
  pruneShared(doc, ["alive"]);
  assert.ok(!doc.skills.ghost);
  assert.ok(!doc.dismissed.ghost);
  assert.ok(doc.skills.alive);

  // Fill way past the budget with fat rows; oldest must go first.
  const names = [];
  for (let i = 0; i < 3000; i++) {
    const name = `s${i}`;
    names.push(name);
    doc.skills[name] = { at: i, pad: "x".repeat(100) };
  }
  pruneShared(doc, [...names, "alive"]);
  assert.ok(JSON.stringify(doc).length <= SHARED_BUDGET);
  assert.ok(doc.skills.s2999); // newest survives
});

test("usageBySkill counts events per asset", () => {
  const counts = usageBySkill([
    { assetName: "a" },
    { assetName: "a" },
    { assetName: "b" },
  ]);
  assert.deepEqual(counts, { a: 2, b: 1 });
});
