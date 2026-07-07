// Asset Query — an sx analogue of Obsidian's Dataview (~4.5M downloads).
// Dataview turns notes + frontmatter into a queryable database rendered
// as live tables. Here the database is the asset catalog: implicit
// fields (name/type/updatedAt/files), each asset's frontmatter, and
// usage-derived fields Dataview never had (uses30d, lastUsed, users).
//
// Query shape (a deliberately tiny DQL):
//   TABLE type, uses30d, lastUsed
//   WHERE type = skill and uses30d < 3
//   SORT updatedAt desc
//   LIMIT 10
// LIST instead of TABLE gives names only. The widget stores its query,
// so a team can pin e.g. "stale, unused assets" permanently.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const DEFAULT_QUERY = "TABLE type, uses30d, lastUsed\nSORT uses30d desc\nLIMIT 10";

/** key: value lines between --- fences at the top of the first markdown file. */
function parseFrontmatter(content) {
  const lines = content.split("\n");
  if ((lines[0] || "").trim() !== "---") return {};
  const out = {};
  for (let i = 1; i < Math.min(lines.length, 60); i++) {
    if (lines[i].trim() === "---") break;
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function parseQuery(raw) {
  const q = { mode: "TABLE", columns: [], where: [], sort: null, limit: 50 };
  const text = raw.replace(/\s+/g, " ").trim();
  const m = text.match(
    /^(TABLE|LIST)\s*([^]*?)(?:\s+WHERE\s+([^]*?))?(?:\s+SORT\s+(\S+)(?:\s+(asc|desc))?)?(?:\s+LIMIT\s+(\d+))?$/i,
  );
  if (!m) throw new Error('Query must start with TABLE or LIST');
  q.mode = m[1].toUpperCase();
  if (m[2] && m[2].trim()) {
    q.columns = m[2].split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
  }
  if (m[3]) {
    for (const clause of m[3].split(/\s+and\s+/i)) {
      const cm = clause.trim().match(/^([a-z0-9_-]+)\s*(=|!=|<|>|contains)\s*(.+)$/i);
      if (!cm) throw new Error(`Can't parse condition "${clause.trim()}"`);
      q.where.push({
        field: cm[1].toLowerCase(),
        op: cm[2].toLowerCase(),
        value: cm[3].trim().replace(/^["']|["']$/g, ""),
      });
    }
  }
  if (m[4]) q.sort = { field: m[4].toLowerCase(), dir: (m[5] || "asc").toLowerCase() };
  if (m[6]) q.limit = Math.max(1, parseInt(m[6], 10));
  return q;
}

function compare(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== "" && b !== "") return na - nb;
  return String(a).localeCompare(String(b));
}

function matches(row, cond) {
  const val = row[cond.field];
  const have = val === undefined || val === null ? "" : val;
  switch (cond.op) {
    case "=":
      return String(have).toLowerCase() === cond.value.toLowerCase();
    case "!=":
      return String(have).toLowerCase() !== cond.value.toLowerCase();
    case "<":
      return compare(have, cond.value) < 0;
    case ">":
      return compare(have, cond.value) > 0;
    case "contains":
      return String(have).toLowerCase().includes(cond.value.toLowerCase());
    default:
      return false;
  }
}

export default class AssetQuery {
  onload(sx) {
    this.sx = sx;
    sx.registerDashboardWidget({
      id: "asset-query",
      title: "Asset query",
      mount: (view) => void this.mount(view),
    });
  }

  onunload() {}

  async loadRows() {
    const [assets, events] = await Promise.all([
      this.sx.assets.list(),
      this.sx.usage.events(30).catch(() => []),
    ]);
    const usage = new Map();
    for (const e of events) {
      const u = usage.get(e.assetName) || { count: 0, last: "", actors: new Set() };
      u.count++;
      u.actors.add(e.actor);
      if (e.timestamp > u.last) u.last = e.timestamp;
      usage.set(e.assetName, u);
    }
    const rows = [];
    for (const summary of assets) {
      let frontmatter = {};
      let files = 0;
      try {
        const contents = await this.sx.assets.readFiles(summary.name);
        files = contents.length;
        const first = contents.find((f) => /\.(md|markdown)$/i.test(f.path));
        if (first) frontmatter = parseFrontmatter(first.content);
      } catch {
        // asset unreadable — keep implicit fields
      }
      const u = usage.get(summary.name);
      rows.push({
        ...frontmatter,
        name: summary.name,
        type: summary.type,
        description: summary.description,
        updatedat: summary.updatedAt || "",
        files,
        uses30d: u ? u.count : 0,
        lastused: u ? u.last.slice(0, 10) : "",
        users: u ? u.actors.size : 0,
      });
    }
    return rows;
  }

  async mount(view) {
    const saved = (await this.sx.storage.loadData()) || {};
    const editor = el(
      "textarea",
      "width: 100%; box-sizing: border-box; min-height: 56px; padding: 8px 10px;" +
        "font-family: var(--font-mono); font-size: 11px; line-height: 1.5;" +
        "border: none; border-bottom: 1px solid var(--color-line);" +
        "background: var(--color-canvas); color: var(--color-ink);" +
        "outline: none; resize: vertical;",
    );
    editor.value = saved.query || DEFAULT_QUERY;
    editor.spellcheck = false;
    const out = el("div", "padding: 4px 12px 10px;");
    view.el.append(editor, out);

    const run = async () => {
      out.replaceChildren(el("div", FAINT + "font-size: 12px; padding: 6px 0;", "Running…"));
      try {
        const q = parseQuery(editor.value);
        const rows = await this.loadRows();
        let result = rows.filter((r) => q.where.every((c) => matches(r, c)));
        if (q.sort) {
          const dir = q.sort.dir === "desc" ? -1 : 1;
          result.sort((a, b) => dir * compare(a[q.sort.field] ?? "", b[q.sort.field] ?? ""));
        }
        result = result.slice(0, q.limit);
        await this.sx.storage.saveData({ query: editor.value });
        this.renderTable(out, q, result);
      } catch (e) {
        out.replaceChildren(
          el("div", "font-size: 12px; padding: 6px 0; color: var(--color-danger);", String(e && e.message ? e.message : e)),
        );
      }
    };

    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void run();
      }
    });
    let debounce = 0;
    editor.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void run(), 600);
    });
    view.onDispose(() => clearTimeout(debounce));
    await run();
  }

  renderTable(root, q, rows) {
    root.replaceChildren();
    const count = el(
      "div",
      FAINT + "font-size: 10px; padding: 6px 0 4px; text-transform: uppercase; letter-spacing: 0.05em;",
      `Assets (${rows.length}) — ⌘↵ runs`,
    );
    root.append(count);
    if (rows.length === 0) {
      root.append(el("div", FAINT + "font-size: 12px;", "No assets match."));
      return;
    }
    if (q.mode === "LIST") {
      for (const row of rows) root.append(this.nameCell(row.name, "display: block; padding: 2px 0;"));
      return;
    }
    const table = el("table", "width: 100%; border-collapse: collapse; font-size: 12px;");
    const head = el("tr");
    for (const col of ["name", ...q.columns]) {
      head.append(
        el(
          "th",
          FAINT + "text-align: left; font-weight: 500; font-size: 10px; padding: 3px 8px 3px 0; border-bottom: 1px solid var(--color-line);",
          col,
        ),
      );
    }
    table.append(head);
    for (const row of rows) {
      const tr = el("tr");
      const nameTd = el("td", "padding: 4px 8px 4px 0; border-bottom: 1px solid var(--color-line);");
      nameTd.append(this.nameCell(row.name, ""));
      tr.append(nameTd);
      for (const col of q.columns) {
        const val = row[col];
        tr.append(
          el(
            "td",
            "padding: 4px 8px 4px 0; border-bottom: 1px solid var(--color-line); color: var(--color-ink-soft);",
            val === undefined || val === null || val === "" ? "—" : String(val),
          ),
        );
      }
      table.append(tr);
    }
    root.append(table);
  }

  nameCell(name, extra) {
    const link = el(
      "button",
      "background: none; border: none; padding: 0; font: inherit; font-size: 12px;" +
        "color: var(--color-accent); cursor: pointer; text-align: left;" +
        extra,
      name,
    );
    link.addEventListener("click", () => this.sx.ui.openAsset(name));
    return link;
  }
}
