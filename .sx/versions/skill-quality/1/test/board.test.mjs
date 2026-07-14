// The board's recommendation logic: status bands, staleness, the
// attention queue's ordering, retire ranking, and the rollup.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStatus,
  attentionScore,
  retireRank,
  weakestCategory,
  rollup,
  STATUS_ORDER,
  STATUS_LABEL,
} from "../src/board.js";

const record = (overall, extra = {}) => ({
  overall,
  at: "2026-07-14T10:00:00Z",
  categories: { structure: 80, actionability: 70, content: 60, completeness: 90 },
  ...extra,
});

test("score bands follow the tier cuts", () => {
  const at = "2026-07-14T10:00:00Z";
  const updatedAt = "2026-07-14T09:00:00Z"; // evaluated after last change
  assert.equal(classifyStatus({ record: null, updatedAt }), "not-evaluated");
  assert.equal(classifyStatus({ record: record(10), updatedAt }), "retire-candidate");
  assert.equal(classifyStatus({ record: record(24), updatedAt }), "retire-candidate");
  assert.equal(classifyStatus({ record: record(25), updatedAt }), "low");
  assert.equal(classifyStatus({ record: record(59), updatedAt }), "low");
  assert.equal(classifyStatus({ record: record(60), updatedAt }), "needs-work");
  assert.equal(classifyStatus({ record: record(74), updatedAt }), "needs-work");
  assert.equal(classifyStatus({ record: record(75), updatedAt }), "good");
  assert.equal(classifyStatus({ record: record(84), updatedAt }), "good");
  assert.equal(classifyStatus({ record: record(85), updatedAt }), "exemplary");
  void at;
});

test("a skill changed after evaluation is stale, outranking its score", () => {
  const changedLater = "2026-07-14T12:00:00Z";
  assert.equal(classifyStatus({ record: record(90), updatedAt: changedLater }), "stale");
  // Within clock-skew slack (server records: at == updatedAt) is NOT stale.
  assert.equal(
    classifyStatus({ record: record(90), updatedAt: "2026-07-14T10:00:30Z" }),
    "exemplary",
  );
  // Missing timestamps never classify stale.
  assert.equal(
    classifyStatus({ record: record(90, { at: undefined }), updatedAt: changedLater }),
    "exemplary",
  );
});

test("attention queue: never-evaluated > stale > retire > low > needs-work", () => {
  const scores = ["not-evaluated", "stale", "retire-candidate", "low", "needs-work"].map(
    (status) => attentionScore({ status, overall: 40 }).score,
  );
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] > scores[i], `${scores[i - 1]} > ${scores[i]} at ${i}`);
  }
  assert.equal(attentionScore({ status: "good", overall: 80 }).score, 0);
  assert.equal(attentionScore({ status: "exemplary", overall: 90 }).score, 0);
});

test("popular skills get an attention boost with the usage reason", () => {
  const quiet = attentionScore({ status: "low", overall: 40, uses30: 3 });
  const popular = attentionScore({ status: "low", overall: 40, uses30: 34 });
  assert.ok(popular.score > quiet.score);
  assert.ok(popular.reasons.some((r) => r.includes("34 uses")));
  // Healthy skills never enter the queue, popular or not.
  assert.equal(attentionScore({ status: "good", overall: 80, uses30: 100 }).score, 0);
});

test("retire candidates rank least-used, lowest-scored first", () => {
  const rows = [
    { name: "used", uses30: 9, overall: 20 },
    { name: "unused-worst", uses30: 0, overall: 5 },
    { name: "unused", uses30: 0, overall: 15 },
  ];
  const ranked = rows.slice().sort(retireRank).map((r) => r.name);
  assert.deepEqual(ranked, ["unused-worst", "unused", "used"]);
});

test("weakestCategory finds the lowest category", () => {
  assert.deepEqual(weakestCategory(record(50)), { label: "content", score: 60 });
  assert.equal(weakestCategory({ overall: 50 }), null);
});

test("rollup counts the header numbers", () => {
  const rows = [
    { record: record(90), status: "exemplary" },
    { record: record(40), status: "low" },
    { record: record(10), status: "retire-candidate" },
    { record: null, status: "not-evaluated" },
  ];
  const r = rollup(rows);
  assert.equal(r.skills, 4);
  assert.equal(r.evaluated, 3);
  assert.equal(r.avg, Math.round((90 + 40 + 10) / 3));
  assert.equal(r.high, 1);
  assert.equal(r.low, 1);
  assert.equal(r.retire, 1);
});

test("every status has a label and an order slot", () => {
  for (const status of STATUS_ORDER) {
    assert.ok(STATUS_LABEL[status], `label for ${status}`);
  }
});
