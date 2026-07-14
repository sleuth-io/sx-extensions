// File analysis shared by the evaluator and the tab. Mirrors the shapes
// pulse's AssetEvaluationTool derives before scoring, so local and
// server evaluations look at the same facts.

/** Primary definition file per asset type, most specific first. */
const PRIMARY_NAMES = ["SKILL.md", "RULE.md", "AGENT.md", "COMMAND.md"];

/** The evaluation view of an asset: everything except metadata.toml and
 * evals/ (they aren't skill behavior), primary file first. */
export function sourceFiles(files) {
  return files
    .filter((f) => f.path !== "metadata.toml" && !f.path.startsWith("evals/"))
    .sort((a, b) =>
      isPrimary(a.path) ? -1 : isPrimary(b.path) ? 1 : a.path.localeCompare(b.path),
    );
}

function isPrimary(path) {
  return PRIMARY_NAMES.includes(path);
}

export function primaryFile(files) {
  const sources = sourceFiles(files);
  return sources.find((f) => isPrimary(f.path)) || sources.find((f) => f.path.endsWith(".md")) || null;
}

/** Word counts, reference content, and structural flags — the same
 * facts pulse's _analyze_files gathers. */
export function analyzeFiles(files) {
  const sources = sourceFiles(files);
  const primary = primaryFile(files);
  const primaryContent = primary?.content || "";
  const references = sources.filter((f) => f !== primary);

  const wordCount = countWords(primaryContent);
  let referenceWords = 0;
  let totalChars = 0;
  for (const f of sources) {
    totalChars += (f.content || "").length;
    if (f !== primary) referenceWords += countWords(f.content || "");
  }
  return {
    primary,
    primaryContent,
    references,
    wordCount,
    totalWordCount: wordCount + referenceWords,
    totalChars,
    fileCount: sources.length,
    hasPrimary: primary !== null && isPrimary(primary.path),
    hasReferences: sources.some((f) => f.path.startsWith("references/")),
    hasScripts: sources.some((f) => f.path.startsWith("scripts/")),
    hasAssets: sources.some((f) => f.path.startsWith("assets/")),
  };
}

export function countWords(text) {
  const trimmed = (text || "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** 8-hex content hash of skill behavior — the staleness key for quality
 * records. Same basis as skill-evals' benchmark hash so the two
 * extensions agree on "changed". */
export async function skillHash(files) {
  const basis = sourceFiles(files)
    .map((f) => JSON.stringify([f.path, f.content]))
    .join("\n");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis));
  return [...new Uint8Array(buf).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
