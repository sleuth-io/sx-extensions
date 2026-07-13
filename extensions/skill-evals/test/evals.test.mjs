import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEvals,
  serializeEvals,
  normalizeEval,
  dedupeKeys,
  kebab,
  skillContent,
  skillHash,
  findEvalsFile,
  EVALS_PATH,
} from "../src/evals.js";

const PULSE_DOC = JSON.stringify({
  evals: [
    {
      eval_key: "basic-pdf-fill",
      prompt: "Fill out the provided PDF form",
      expected_output: "A completed PDF",
      expectations: ["fields populated", "valid PDF"],
      input_files: [{ name: "form.pdf", content: "..." }],
      category: "basic",
      is_active: true,
    },
  ],
});

test("parses the canonical wrapper document", () => {
  const { evals, invalid } = parseEvals(PULSE_DOC);
  assert.equal(invalid, false);
  assert.equal(evals.length, 1);
  assert.equal(evals[0].eval_key, "basic-pdf-fill");
});

test("parses a bare array document", () => {
  const { evals, invalid } = parseEvals(
    JSON.stringify([{ eval_key: "a", prompt: "do a thing", expectations: ["done"] }]),
  );
  assert.equal(invalid, false);
  assert.equal(evals.length, 1);
});

test("defaults is_active and category, drops promptless entries", () => {
  const { evals } = parseEvals(
    JSON.stringify({
      evals: [
        { eval_key: "x", prompt: "p", expectations: ["e"] },
        { eval_key: "broken" },
        { eval_key: "off", prompt: "p2", expectations: [], is_active: false, category: "edge-case" },
      ],
    }),
  );
  assert.equal(evals.length, 2);
  assert.equal(evals[0].is_active, true);
  assert.equal(evals[0].category, "basic");
  assert.equal(evals[1].is_active, false);
  assert.equal(evals[1].category, "edge-case");
});

test("round-trip preserves unknown pulse fields", () => {
  const { evals } = parseEvals(PULSE_DOC);
  const roundTripped = parseEvals(serializeEvals(evals)).evals[0];
  assert.deepEqual(roundTripped.input_files, [{ name: "form.pdf", content: "..." }]);
});

test("invalid JSON and unknown shapes are flagged, not thrown", () => {
  assert.equal(parseEvals("not json").invalid, true);
  assert.equal(parseEvals(JSON.stringify({ nope: 1 })).invalid, true);
});

test("normalizeEval derives a key from the prompt when missing", () => {
  const e = normalizeEval({ prompt: "Summarize the Q3 report!", expectations: ["short"] });
  assert.equal(e.eval_key, "summarize-the-q3-report");
});

test("dedupeKeys suffixes collisions", () => {
  const out = dedupeKeys(
    [{ eval_key: "a" }, { eval_key: "a" }, { eval_key: "a" }],
    ["a"],
  );
  assert.deepEqual(out.map((e) => e.eval_key), ["a-2", "a-3", "a-4"]);
});

test("kebab normalizes arbitrary strings", () => {
  assert.equal(kebab("Basic PDF Fill!"), "basic-pdf-fill");
});

test("skillContent puts SKILL.md first, excludes metadata and evals, truncates", () => {
  const files = [
    { path: "metadata.toml", content: "meta" },
    { path: EVALS_PATH, content: "{}" },
    { path: "helpers.md", content: "helper" },
    { path: "SKILL.md", content: "skill body" },
  ];
  const { content, truncated } = skillContent(files, 10000);
  assert.equal(truncated, false);
  assert.ok(content.startsWith("--- SKILL.md ---"));
  assert.ok(!content.includes("metadata.toml"));
  assert.ok(!content.includes("evals/"));

  const small = skillContent(files, 20);
  assert.equal(small.truncated, true);
  assert.ok(small.content.endsWith("…(truncated)"));
});

test("skillHash ignores metadata.toml and evals changes", async () => {
  const base = [
    { path: "SKILL.md", content: "body" },
    { path: "metadata.toml", content: "v1" },
  ];
  const h1 = await skillHash(base);
  const h2 = await skillHash([
    { path: "SKILL.md", content: "body" },
    { path: "metadata.toml", content: "v2 — status: deprecated" },
    { path: EVALS_PATH, content: "{\"evals\":[]}" },
  ]);
  const h3 = await skillHash([{ path: "SKILL.md", content: "different body" }]);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{8}$/);
});

test("findEvalsFile locates only the canonical path", () => {
  assert.equal(findEvalsFile([{ path: "evals.json", content: "" }]), null);
  assert.ok(findEvalsFile([{ path: EVALS_PATH, content: "" }]));
});
