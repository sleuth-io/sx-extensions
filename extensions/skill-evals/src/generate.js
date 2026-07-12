// Eval generation via the user's configured provider, and the write-back
// that puts evals/evals.json into the skill as a draft the human publishes.

import {
  EVALS_PATH,
  serializeEvals,
  normalizeEval,
  dedupeKeys,
  skillContent,
} from "./evals.js";

export const GENERATION_CONTEXT_CHARS = 8000; // pulse parity
export const DEFAULT_COUNT = 8; // 6 basic + 2 edge-case

const GENERATION_SCHEMA = {
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
          category: { type: "string", enum: ["basic", "edge-case"] },
        },
      },
    },
  },
};

const SYSTEM = `You generate functional test cases (evals) for AI assistant skills.
Rules:
- Each prompt must be a realistic, specific user ask — something a person
  would actually type — answerable from the reply text alone.
- Each eval needs 2-4 expectations: short, independently verifiable
  assertions about the reply. Objective checks only; no style opinions.
- eval_key is a unique kebab-case identifier.
- category is "basic" for core behavior, "edge-case" for tricky inputs.`;

/** Ask the provider for `count` evals that don't duplicate existing keys.
 * Returns normalized, key-deduped evals ready to append. */
export async function generateEvals(sx, { name, description, files, existing, count }) {
  const n = count || DEFAULT_COUNT;
  const edge = Math.max(1, Math.round(n / 4));
  const { content, truncated } = skillContent(files, GENERATION_CONTEXT_CHARS);
  const existingKeys = existing.map((e) => e.eval_key);
  const user = [
    `Generate ${n} evals for this skill (${n - edge} "basic", ${edge} "edge-case").`,
    ``,
    `Skill name: ${name}`,
    `Skill description: ${description || "No description"}`,
    existingKeys.length
      ? `Existing eval keys (do NOT duplicate or rephrase these): ${existingKeys.join(", ")}`
      : ``,
    ``,
    `Skill content${truncated ? " (truncated)" : ""}:`,
    content,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const result = await sx.llm.complete({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    schema: GENERATION_SCHEMA,
    maxTokens: 8192,
  });
  const raw = result.json && Array.isArray(result.json.evals) ? result.json.evals : [];
  const normalized = raw.map(normalizeEval).filter(Boolean);
  return dedupeKeys(normalized, existingKeys);
}

/** Write evals into the skill as a draft targeting the existing asset.
 *
 * The dance matters: publishing a draft whose targetAsset is unset takes
 * the app's new-asset branch and resets the skill's sharing to everyone.
 * Current sx sets targetAsset on create; older builds only recompute it
 * in updateFiles — so we always update after create, then verify, and
 * refuse to leave a booby-trapped draft either way.
 *
 * Returns {ok, message}. */
export async function writeEvalsDraft(sx, skillName, files, evals) {
  const evalsFile = { path: EVALS_PATH, content: serializeEvals(evals) };
  const nextFiles = [
    // Every other file byte-identical: publish re-zips the draft as the
    // complete next revision, so a dropped file would be a deletion.
    ...files.filter((f) => f.path !== EVALS_PATH),
    evalsFile,
  ];

  const drafts = await sx.drafts.list();
  const existing = drafts.find((d) => d.targetAsset === skillName || d.name === skillName);
  if (existing) {
    if (existing.targetAsset !== skillName) {
      return {
        ok: false,
        message:
          `A draft named "${existing.name}" exists but doesn't target ${skillName} — ` +
          `publish or discard it first, then regenerate.`,
      };
    }
    const overwrite = await sx.ui.confirm(
      `A draft for ${skillName} already exists. Replace its files with the current skill plus the updated evals?`,
      "Update draft",
    );
    if (!overwrite) return { ok: false, message: "Kept the existing draft untouched." };
    await sx.drafts.updateFiles(existing.id, nextFiles);
    return { ok: true, message: `Updated the ${skillName} draft — review and publish it.` };
  }

  const { id } = await sx.drafts.create({ name: skillName, files: nextFiles });
  // Belt and braces for apps that don't set targetAsset on create: an
  // update recomputes it from the vault.
  await sx.drafts.updateFiles(id, nextFiles);
  const created = (await sx.drafts.list()).find((d) => d.id === id);
  if (!created || created.targetAsset !== skillName) {
    return {
      ok: false,
      message:
        `Draft "${id}" was created but does not target ${skillName} — publishing it would ` +
        `create a new asset or reset sharing. Discard it and retry on a newer app build.`,
    };
  }
  return { ok: true, message: `Draft with ${evals.length} evals created — review and publish it.` };
}
