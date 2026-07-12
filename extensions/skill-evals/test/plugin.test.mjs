// Wiring smoke test: drive the real plugin class through onload and a
// full benchmark against a stubbed sx — registration, persistence,
// shared-row publication, and restart-resume all covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import SkillEvals from "../src/index.js";
import { EVALS_PATH } from "../src/evals.js";

const EVALS_DOC = JSON.stringify({
  evals: [
    { eval_key: "a", prompt: "do a", expected_output: "a done", expectations: ["says a"], category: "basic", is_active: true },
    { eval_key: "b", prompt: "do b", expected_output: "b done", expectations: ["says b"], category: "basic", is_active: true },
    { eval_key: "off", prompt: "skip", expected_output: "", expectations: ["x"], category: "basic", is_active: false },
  ],
});

function stubSx({ confirm = true } = {}) {
  const state = {
    local: null,
    shared: { v: 1, skills: {}, dismissed: {} },
    notices: [],
    confirms: [],
    registered: { views: [], tabs: [], commands: [], events: {} },
    llmCalls: 0,
  };
  return {
    state,
    registerMainView: (spec) => state.registered.views.push(spec),
    registerAssetTab: (spec) => state.registered.tabs.push(spec),
    registerCommand: (spec) => state.registered.commands.push(spec),
    on: (event, handler) => (state.registered.events[event] = handler),
    ui: {
      notice: (msg) => state.notices.push(msg),
      confirm: async (msg, action) => {
        state.confirms.push({ msg, action });
        return confirm;
      },
      openSettings: () => {},
      openAsset: () => {},
      openView: () => {},
    },
    app: { currentUser: async () => "dylan" },
    storage: {
      loadData: async () => state.local,
      saveData: async (doc) => {
        state.local = JSON.parse(JSON.stringify(doc));
      },
    },
    sharedStorage: {
      load: async () => state.shared,
      save: async (doc) => {
        state.shared = JSON.parse(JSON.stringify(doc));
      },
    },
    assets: {
      list: async () => [{ name: "my-skill", type: "skill", description: "d", updatedAt: "2026-07-01" }],
      readFiles: async () => [
        { path: "SKILL.md", content: "SKILL BODY" },
        { path: EVALS_PATH, content: EVALS_DOC },
      ],
      installations: async () => ({ everyone: true, installations: [] }),
    },
    usage: { events: async () => [] },
    llm: {
      provider: async () => "anthropic",
      complete: async (req) => {
        state.llmCalls++;
        if (req.schema) {
          return {
            json: { grades: [{ i: 1, pass: req.messages[1].content.includes("with-skill"), reason: "r" }] },
            text: "{}",
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "judge-model",
          };
        }
        const withSkill = req.messages[0].content.includes("SKILL BODY");
        return {
          text: withSkill ? "with-skill answer" : "bare answer",
          usage: { inputTokens: 10, outputTokens: 10 },
          model: "answer-model",
        };
      },
    },
    drafts: { list: async () => [], create: async () => ({ id: "x" }), updateFiles: async () => {} },
  };
}

test("onload registers the main view, asset tab, command, and publish listener", () => {
  const sx = stubSx();
  new SkillEvals().onload(sx);
  assert.equal(sx.state.registered.views[0].id, "skill-evals");
  assert.equal(sx.state.registered.views[0].section, "tools");
  assert.equal(sx.state.registered.tabs[0].id, "evals");
  assert.equal(sx.state.registered.commands[0].id, "open-health");
  assert.ok(sx.state.registered.events["asset-published"]);
});

test("startBenchmark runs active evals only, persists results, shares the row", async () => {
  const sx = stubSx();
  const plugin = new SkillEvals();
  plugin.onload(sx);
  await plugin.startBenchmark("my-skill", 1);

  // 2 active evals × 2 configs × 1 rep = 4 completions + 4 judge calls.
  assert.equal(sx.state.llmCalls, 8);
  assert.match(sx.state.confirms[0].msg, /Run 8 AI calls/);

  const runs = sx.state.local.runs["my-skill"];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agg.with.passMean, 1);
  assert.equal(runs[0].agg.without.passMean, 0);
  assert.equal(runs[0].agg.delta, 1);
  assert.equal(runs[0].model, "answer-model");
  assert.equal(sx.state.local.inProgress, null);
  assert.equal(sx.state.local.detail["my-skill"].cells.length, 4);

  const row = sx.state.shared.skills["my-skill"];
  assert.equal(row.s, "H");
  assert.equal(row.by, "dylan");
  assert.equal(row.ev, 3);
  assert.equal(row.ac, 2);
  assert.match(row.sh, /^[0-9a-f]{8}$/);
  assert.equal(plugin.activeRun, null);
  assert.match(sx.state.notices.at(-1), /Benchmark done/);
});

test("declining the confirm runs nothing", async () => {
  const sx = stubSx({ confirm: false });
  const plugin = new SkillEvals();
  plugin.onload(sx);
  await plugin.startBenchmark("my-skill", 1);
  assert.equal(sx.state.llmCalls, 0);
  assert.equal(sx.state.local, null);
});

test("resumeBenchmark finishes an interrupted run without redoing done cells", async () => {
  const sx = stubSx();
  const plugin = new SkillEvals();
  plugin.onload(sx);
  // Seed a real interrupted state by running once, then transplanting two
  // cells into inProgress as if the app died mid-run.
  await plugin.startBenchmark("my-skill", 1);
  const cells = sx.state.local.detail["my-skill"].cells.slice(0, 2);
  const hash = sx.state.shared.skills["my-skill"].sh;
  sx.state.local.runs = {};
  sx.state.local.detail = {};
  sx.state.local.inProgress = { skill: "my-skill", reps: 1, provider: "anthropic", skillHash: hash, cells };
  sx.state.llmCalls = 0;

  await plugin.resumeBenchmark();
  assert.equal(sx.state.llmCalls, 4); // 2 remaining cells × (answer + judge)
  assert.equal(sx.state.local.inProgress, null);
  assert.equal(sx.state.local.runs["my-skill"].length, 1);
});

test("resumeBenchmark discards the run when the skill changed underneath it", async () => {
  const sx = stubSx();
  const plugin = new SkillEvals();
  plugin.onload(sx);
  sx.state.local = {
    v: 1,
    usage: {},
    hashes: {},
    runs: {},
    detail: {},
    inProgress: { skill: "my-skill", reps: 1, provider: "anthropic", skillHash: "deadbeef", cells: [] },
  };
  await plugin.resumeBenchmark();
  assert.equal(sx.state.local.inProgress, null);
  assert.equal(sx.state.llmCalls, 0);
  assert.match(sx.state.notices.at(-1), /changed since/);
});

test("asset-published drops the cached hash so facts re-read", async () => {
  const sx = stubSx();
  const plugin = new SkillEvals();
  plugin.onload(sx);
  sx.state.local = { v: 1, usage: {}, hashes: { "my-skill": { hash: "x" } }, runs: {}, detail: {}, inProgress: null };
  await sx.state.registered.events["asset-published"]({ name: "my-skill" });
  assert.ok(!sx.state.local.hashes["my-skill"]);
});
