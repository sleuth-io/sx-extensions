import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEvals, writeEvalsDraft } from "../src/generate.js";
import { EVALS_PATH } from "../src/evals.js";

function stubDraftsSx({ drafts = [], targetOnCreate = true, confirm = true } = {}) {
  const state = {
    drafts: drafts.map((d) => ({ ...d })),
    created: [],
    updated: [],
    confirms: [],
  };
  return {
    state,
    ui: {
      async confirm(msg, action) {
        state.confirms.push({ msg, action });
        return confirm;
      },
    },
    drafts: {
      async list() {
        return state.drafts;
      },
      async create({ name, files }) {
        // Mirror the app: uniquify against existing drafts.
        let id = name;
        for (let i = 2; state.drafts.some((d) => d.id === id); i++) id = `${name}-${i}`;
        const draft = {
          id,
          name: id,
          type: "skill",
          targetAsset: targetOnCreate && id === name ? name : "",
        };
        state.drafts.push(draft);
        state.created.push({ id, files });
        return { id };
      },
      async updateFiles(id, files) {
        state.updated.push({ id, files });
        const d = state.drafts.find((x) => x.id === id);
        // Mirror UpdateDraft: recompute targetAsset from the vault (the
        // stub pretends every skill name exists in the vault).
        if (d && d.targetAsset !== d.name) d.targetAsset = d.name;
      },
    },
  };
}

const FILES = [
  { path: "SKILL.md", content: "body" },
  { path: EVALS_PATH, content: '{"evals": []}' },
];
const EVALS = [
  { eval_key: "a", prompt: "p", expected_output: "o", expectations: ["x"], category: "basic", is_active: true },
];

test("creates a draft targeting the skill and includes every prior file", async () => {
  const sx = stubDraftsSx();
  const res = await writeEvalsDraft(sx, "my-skill", FILES, EVALS);
  assert.equal(res.ok, true);
  const files = sx.state.created[0].files;
  assert.ok(files.find((f) => f.path === "SKILL.md"));
  const evalsFile = files.find((f) => f.path === EVALS_PATH);
  assert.ok(evalsFile.content.includes('"eval_key": "a"'));
  // belt-and-braces update always follows create
  assert.equal(sx.state.updated.length, 1);
});

test("older app (no targetAsset on create) is healed by the update", async () => {
  const sx = stubDraftsSx({ targetOnCreate: false });
  const res = await writeEvalsDraft(sx, "my-skill", FILES, EVALS);
  assert.equal(res.ok, true);
  assert.equal(sx.state.drafts[0].targetAsset, "my-skill");
});

test("reuses an existing draft for the skill after confirmation", async () => {
  const sx = stubDraftsSx({
    drafts: [{ id: "my-skill", name: "my-skill", type: "skill", targetAsset: "my-skill" }],
  });
  const res = await writeEvalsDraft(sx, "my-skill", FILES, EVALS);
  assert.equal(res.ok, true);
  assert.equal(sx.state.created.length, 0);
  assert.equal(sx.state.updated.length, 1);
  assert.equal(sx.state.confirms.length, 1);
});

test("declining the confirm leaves the draft alone", async () => {
  const sx = stubDraftsSx({
    drafts: [{ id: "my-skill", name: "my-skill", type: "skill", targetAsset: "my-skill" }],
    confirm: false,
  });
  const res = await writeEvalsDraft(sx, "my-skill", FILES, EVALS);
  assert.equal(res.ok, false);
  assert.equal(sx.state.updated.length, 0);
});

test("refuses a same-name draft that targets something else", async () => {
  const sx = stubDraftsSx({
    drafts: [{ id: "my-skill", name: "my-skill", type: "skill", targetAsset: "" }],
  });
  const res = await writeEvalsDraft(sx, "my-skill", FILES, EVALS);
  assert.equal(res.ok, false);
  assert.match(res.message, /doesn't target/);
});

test("improveEvals feeds benchmark results and grade feedback to the provider", async () => {
  const { improveEvals } = await import("../src/generate.js");
  let seen = "";
  const sx = {
    llm: {
      async complete(req) {
        seen = req.messages[1].content;
        return {
          json: {
            evals: [
              { eval_key: "sharper-case", prompt: "p", expected_output: "o", expectations: ["a"], category: "basic" },
            ],
          },
          text: "{}",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    },
  };
  const out = await improveEvals(sx, {
    name: "s",
    description: "d",
    files: [{ path: "SKILL.md", content: "body" }],
    evals: [{ eval_key: "old-eval", prompt: "p", expected_output: "", expectations: ["x"], category: "basic", is_active: true }],
    latest: {
      perEval: [{ key: "old-eval", withPass: 0.5, withoutPass: 0.5, status: "non_discriminating" }],
    },
    detailCells: [
      {
        evalKey: "old-eval",
        config: "with",
        grades: [{ text: "mentions X", pass: false, reason: "reply never mentions X" }],
      },
    ],
  });
  assert.equal(out[0].eval_key, "sharper-case");
  assert.equal(out[0].is_active, true);
  assert.ok(seen.includes("old-eval: non discriminating"), "per-eval results in prompt");
  assert.ok(seen.includes("reply never mentions X"), "grade feedback in prompt");
  assert.ok(seen.includes("Current evals:"), "existing evals in prompt");
});

test("generateEvals dedupes keys against existing evals", async () => {
  const sx = {
    llm: {
      async complete() {
        return {
          json: {
            evals: [
              { eval_key: "existing-key", prompt: "p1", expected_output: "o", expectations: ["a"], category: "basic" },
              { eval_key: "fresh", prompt: "p2", expected_output: "o", expectations: ["b"], category: "edge-case" },
            ],
          },
          text: "{}",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    },
  };
  const out = await generateEvals(sx, {
    name: "s",
    description: "d",
    files: [{ path: "SKILL.md", content: "body" }],
    existing: [{ eval_key: "existing-key" }],
    count: 2,
  });
  assert.deepEqual(out.map((e) => e.eval_key), ["existing-key-2", "fresh"]);
  assert.equal(out[0].is_active, true);
});
