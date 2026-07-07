// Draft Refactor — an sx analogue of Obsidian's Note Refactor. Skills
// bloat; the canonical fix is progressive disclosure: extract a section
// into its own asset and reference it. The new asset's name comes from
// the selection's first heading or line (the original's
// first-line-as-filename mode), and heading levels normalize so the
// extracted subtree starts at h1.

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/** Promote headings so the shallowest becomes h1. Lines inside code
 * fences are ignored in both passes — they're code, not headings. */
function normalizeHeadings(text) {
  const lines = text.split("\n");
  let min = Infinity;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6})\s/);
    if (m) min = Math.min(min, m[1].length);
  }
  if (!isFinite(min) || min === 1) return text;
  inFence = false;
  return lines
    .map((line) => {
      if (/^```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = line.match(/^(#{1,6})(\s.*)$/);
      return m ? "#".repeat(Math.max(1, m[1].length - min + 1)) + m[2] : line;
    })
    .join("\n");
}

export default class DraftRefactor {
  onload(sx) {
    this.sx = sx;
    sx.registerCommand({
      id: "extract-selection",
      title: "Extract selection to new draft",
      context: "editor",
      run: () => void this.extract(),
    });
  }

  onunload() {}

  async extract() {
    try {
      const sel = this.sx.editor.getSelection();
      if (!sel.text.trim()) {
        this.sx.ui.notice("Select the section to extract first.");
        return;
      }
      // Pin down the selection range now — the confirm and create below
      // await, and the cursor may move (or the editor close) meanwhile.
      const { from, to } = sel;
      const firstLine =
        sel.text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "extracted";
      const title = firstLine.replace(/^#{1,6}\s*/, "");
      const name = slugify(title) || "extracted-section";
      const ok = await this.sx.ui.confirm(
        `Extract ${sel.text.split("\n").length} lines into a new draft named "${name}"?`,
        "Extract",
      );
      if (!ok) return;
      const body = normalizeHeadings(sel.text.trim());
      // YAML-quote the title: it's user text and may contain ':' or '"'.
      const desc = `Use when ${title.toLowerCase()}. Extracted from a larger skill — refine this trigger.`;
      const yamlDesc = `"${desc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      const content = `---\nname: ${name}\ndescription: ${yamlDesc}\n---\n\n${body}\n`;
      await this.sx.drafts.create({
        name,
        files: [{ path: "SKILL.md", content }],
      });
      if (!this.sx.editor.active()) {
        this.sx.ui.notice(`Draft "${name}" created, but the editor closed — original text left as-is.`);
        return;
      }
      this.sx.editor.replaceRange(
        from,
        to,
        `See the \`${name}\` skill for: ${title}\n`,
      );
      this.sx.ui.notice(`Draft "${name}" created — the selection now points to it.`);
    } catch (e) {
      this.sx.ui.notice("Couldn't extract: " + e);
    }
  }
}
