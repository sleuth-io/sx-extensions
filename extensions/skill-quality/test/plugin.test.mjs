// Wiring smoke test: drive the real plugin class through onload and both
// re-evaluate dispatch modes against a stubbed sx — registration,
// server-mode polling, and the local-mode evaluate + store sequence.
import { test } from "node:test";
import assert from "node:assert/strict";
import SkillQuality from "../src/index.js";

const SKILL_FILES = [
  {
    path: "SKILL.md",
    content:
      "---\nname: commit-msgs\ndescription: Use when writing commits.\n---\n\n## Workflow\n1. Diff.\n2. Subject.\n",
  },
];

const LLM_ASSESSMENT = {
  factors: Object.fromEntries(
    ["specificity", "workflow_clarity", "concrete_examples", "coverage_breadth", "trigger_clarity", "common_mistakes"].map(
      (name) => [name, { score: 75, justification: "solid" }],
    ),
  ),
  reasoning: "A solid skill.",
  strengths: ["clear"],
  weaknesses: ["thin"],
  recommendations: ["add examples"],
};

function stubSx({ mode = "local", confirm = true, evaluatingPolls = 0 } = {}) {
  const state = {
    tabs: [],
    notices: [],
    added: [],
    gets: 0,
    reevaluates: 0,
    llmCalls: 0,
    doc: { evaluating: false, records: [] },
  };
  let pollsLeft = evaluatingPolls;
  return {
    state,
    registerAssetTab: (spec) => state.tabs.push(spec),
    ui: {
      notice: (msg) => state.notices.push(msg),
      confirm: async () => confirm,
      openSettings: () => {},
    },
    app: { currentUser: async () => "alice" },
    llm: {
      provider: async () => "ollama",
      complete: async (req) => {
        state.llmCalls++;
        assert.ok(req.schema, "local evaluation must be schema-constrained");
        return { json: LLM_ASSESSMENT, text: "", provider: "ollama", model: "llama3:8b" };
      },
    },
    assets: {
      readFiles: async () => SKILL_FILES,
      list: async () => [{ name: "commit-msgs", description: "Use when writing commits." }],
    },
    quality: {
      reevaluate: async () => {
        state.reevaluates++;
        return { mode };
      },
      get: async () => {
        state.gets++;
        if (pollsLeft > 0) {
          pollsLeft--;
          return { evaluating: true, records: [] };
        }
        return state.doc;
      },
      add: async (name, record) => state.added.push({ name, record }),
    },
  };
}

test("onload registers the Quality asset tab", () => {
  const sx = stubSx();
  const plugin = new SkillQuality();
  plugin.onload(sx);
  assert.equal(sx.state.tabs.length, 1);
  assert.equal(sx.state.tabs[0].id, "quality");
  assert.equal(sx.state.tabs[0].title, "Quality");
});

test("local mode runs one LLM call and stores a valid record", async () => {
  const sx = stubSx({ mode: "local" });
  const plugin = new SkillQuality();
  plugin.onload(sx);

  await plugin.reevaluate("commit-msgs");

  assert.equal(sx.state.llmCalls, 1);
  assert.equal(sx.state.added.length, 1);
  const { name, record } = sx.state.added[0];
  assert.equal(name, "commit-msgs");
  assert.equal(record.source, "app");
  assert.ok(record.overall >= 0 && record.overall <= 100);
  for (const key of ["structure", "actionability", "content", "completeness"]) {
    assert.equal(typeof record.categories[key], "number", `categories.${key}`);
  }
  assert.equal(record.insights.improvements[0], "thin");
  assert.equal(record.executor.provider, "ollama");
  assert.equal(record.by, "alice");
  assert.ok(!plugin.busy.has("commit-msgs"), "busy state cleared");
  assert.match(sx.state.notices.at(-1), /evaluated: \d+\/100/);
});

test("local mode respects a declined confirm", async () => {
  const sx = stubSx({ mode: "local", confirm: false });
  const plugin = new SkillQuality();
  plugin.onload(sx);
  await plugin.reevaluate("commit-msgs");
  assert.equal(sx.state.llmCalls, 0);
  assert.equal(sx.state.added.length, 0);
});

test("server mode polls until evaluating settles and never stores locally", async () => {
  const sx = stubSx({ mode: "server", evaluatingPolls: 2 });
  const plugin = new SkillQuality();
  plugin.onload(sx);
  // Shrink the poll interval so the test doesn't sleep for real.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 1);
  try {
    await plugin.reevaluate("commit-msgs");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(sx.state.reevaluates, 1);
  assert.ok(sx.state.gets >= 3, `polled ${sx.state.gets} times`);
  assert.equal(sx.state.llmCalls, 0);
  assert.equal(sx.state.added.length, 0);
  assert.ok(!plugin.busy.has("commit-msgs"));
});

test("reevaluate errors surface as a notice, not a crash", async () => {
  const sx = stubSx();
  sx.quality.reevaluate = async () => {
    throw new Error("permission denied");
  };
  const plugin = new SkillQuality();
  plugin.onload(sx);
  await plugin.reevaluate("commit-msgs");
  assert.match(sx.state.notices.at(-1), /permission denied/);
  assert.ok(!plugin.busy.has("commit-msgs"));
});

test("concurrent reevaluate for the same skill is refused", async () => {
  const sx = stubSx({ mode: "server", evaluatingPolls: 1 });
  const plugin = new SkillQuality();
  plugin.onload(sx);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 5);
  try {
    const first = plugin.reevaluate("commit-msgs");
    await plugin.reevaluate("commit-msgs");
    assert.ok(sx.state.notices.some((n) => n.includes("Already evaluating")));
    await first;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(sx.state.reevaluates, 1);
});
