// Table Tidy — an sx analogue of Obsidian's Advanced Tables (3.0M
// downloads). Like the original's md-advanced-tables core, all table
// logic is pure text-in/text-out; the editor API only supplies and
// receives the document.

function isRow(line) {
  return /^\s*\|/.test(line);
}

function splitRow(line) {
  // Only unescaped pipes delimit cells — `\|` is literal cell content
  // and survives the round trip untouched.
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim());
}

function isDelimiter(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c) || /^:?-+:?$/.test(c));
}

function width(s) {
  // East-Asian-wide chars count double so CJK tables still line up.
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s, target, align) {
  const gap = target - width(s);
  if (gap <= 0) return s;
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

/** Format one table block (array of lines) → formatted lines, or null. */
export function formatTable(lines) {
  const rows = lines.map(splitRow);
  if (rows.length < 2 || !isDelimiter(rows[1])) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  const aligns = [];
  for (let i = 0; i < cols; i++) {
    const d = rows[1][i] || "---";
    aligns.push(
      d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : "left",
    );
  }
  const widths = [];
  for (let i = 0; i < cols; i++) {
    // Floor keeps the delimiter's colons + 3 dashes inside the column:
    // :---: needs 5, ---: needs 4.
    const floor = aligns[i] === "center" ? 5 : aligns[i] === "right" ? 4 : 3;
    widths.push(
      Math.max(floor, ...rows.filter((_, ri) => ri !== 1).map((r) => width(r[i] || ""))),
    );
  }
  return rows.map((r, ri) => {
    if (ri === 1) {
      return "| " + aligns.map((a, i) => {
        const dashes = "-".repeat(widths[i] - (a === "center" ? 2 : a === "right" ? 1 : 0));
        return a === "center" ? ":" + dashes + ":" : a === "right" ? dashes + ":" : dashes;
      }).join(" | ") + " |";
    }
    return "| " + aligns.map((a, i) => pad(r[i] || "", widths[i], a)).join(" | ") + " |";
  });
}

/** All table blocks in a document: [{start, end}] line ranges. Skips
 * fenced code regions — a ``` example of a table is not a table. */
function tableBlocks(lines) {
  const blocks = [];
  let start = -1;
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (start >= 0) {
        blocks.push({ start, end: i });
        start = -1;
      }
      return;
    }
    if (fenced) return;
    if (isRow(line)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      blocks.push({ start, end: i });
      start = -1;
    }
  });
  if (start >= 0) blocks.push({ start, end: lines.length });
  return blocks;
}

export default class TableTidy {
  onload(sx) {
    this.sx = sx;
    sx.registerCommand({
      id: "format-tables",
      title: "Format all tables in draft",
      context: "editor",
      run: () => this.formatAll(),
    });
    sx.onBeforePublish((ctx) => this.check(ctx));
  }

  onunload() {}

  formatAll() {
    try {
      const doc = this.sx.editor.getValue();
      const lines = doc.split("\n");
      let changed = 0;
      for (const b of tableBlocks(lines).reverse()) {
        const formatted = formatTable(lines.slice(b.start, b.end));
        if (formatted) {
          lines.splice(b.start, b.end - b.start, ...formatted);
          changed++;
        }
      }
      if (changed === 0) {
        this.sx.ui.notice("No tables found in this draft.");
        return;
      }
      this.sx.editor.replaceRange(0, doc.length, lines.join("\n"));
      this.sx.ui.notice(`Formatted ${changed} table${changed > 1 ? "s" : ""}.`);
    } catch (e) {
      this.sx.ui.notice("Couldn't format tables: " + e);
    }
  }

  check(ctx) {
    const warnings = [];
    for (const f of ctx.files) {
      if (!/\.(md|markdown)$/i.test(f.path)) continue;
      const lines = f.content.split("\n");
      for (const b of tableBlocks(lines)) {
        const rows = lines.slice(b.start, b.end).map(splitRow);
        if (rows.length < 2 || !isDelimiter(rows[1])) continue;
        const counts = new Set(rows.map((r) => r.length));
        if (counts.size > 1) {
          warnings.push({
            message: "Ragged table — rows have differing column counts",
            detail: `${f.path}:${b.start + 1} — run "Format all tables in draft"`,
          });
        }
      }
    }
    return warnings.slice(0, 4);
  }
}
