// Style Linter — an sx analogue of Obsidian's Linter (~1.0M downloads).
// The original auto-rewrites files on save; shared team assets deserve
// report-not-rewrite, so findings surface as publish-sheet warnings (the
// lint-on-save analogue) and an on-demand whole-library lint. Rules are
// small pure functions over lines, individually toggleable — the
// original's key design. sx's built-in Publish Doctor covers publish
// CORRECTNESS (frontmatter, description, broken links); this is the
// opt-in style layer.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

const RULES = [
  {
    id: "heading-skip",
    label: "No skipped heading levels (h1 → h3)",
    check(lines) {
      const findings = [];
      let prev = 0;
      lines.forEach((line, i) => {
        const m = line.match(/^(#{1,6})\s/);
        if (!m) return;
        const level = m[1].length;
        if (prev > 0 && level > prev + 1) {
          findings.push({ line: i + 1, message: `h${prev} jumps to h${level}` });
        }
        prev = level;
      });
      return findings;
    },
  },
  {
    id: "single-h1",
    label: "At most one top-level heading",
    check(lines) {
      const h1s = [];
      lines.forEach((line, i) => {
        if (/^#\s/.test(line)) h1s.push(i + 1);
      });
      return h1s.length > 1
        ? h1s.slice(1).map((line) => ({ line, message: "second top-level heading" }))
        : [];
    },
  },
  {
    id: "trailing-whitespace",
    label: "No trailing whitespace",
    check(lines) {
      const findings = [];
      lines.forEach((line, i) => {
        if (/[ \t]+$/.test(line)) findings.push({ line: i + 1, message: "trailing whitespace" });
      });
      return findings.slice(0, 5); // one asset shouldn't drown the report
    },
  },
  {
    id: "blank-runs",
    label: "No runs of 3+ blank lines",
    check(lines) {
      const findings = [];
      let run = 0;
      lines.forEach((line, i) => {
        if (line.trim() === "") {
          run++;
          if (run === 3) findings.push({ line: i + 1, message: "3+ consecutive blank lines" });
        } else {
          run = 0;
        }
      });
      return findings;
    },
  },
  {
    id: "fence-language",
    label: "Code fences declare a language",
    check(lines) {
      const findings = [];
      let inFence = false;
      lines.forEach((line, i) => {
        const m = line.match(/^```(.*)$/);
        if (!m) return;
        if (!inFence && m[1].trim() === "") {
          findings.push({ line: i + 1, message: "code fence without a language" });
        }
        inFence = !inFence;
      });
      return findings;
    },
  },
  {
    id: "long-lines",
    label: "Lines under 160 characters (off by default)",
    defaultOff: true,
    check(lines) {
      const findings = [];
      let inFence = false;
      lines.forEach((line, i) => {
        if (/^```/.test(line)) inFence = !inFence;
        else if (!inFence && line.length > 160) {
          findings.push({ line: i + 1, message: line.length + " chars" });
        }
      });
      return findings.slice(0, 3);
    },
  },
];

export default class StyleLinter {
  onload(sx) {
    this.sx = sx;
    this.enabled = null; // rule id -> bool, lazily loaded
    sx.onBeforePublish((ctx) => this.lintPublish(ctx));
    sx.registerSidebarPanel({
      id: "style",
      title: "Style",
      mount: (view) => void this.mount(view),
    });
  }

  onunload() {}

  async ruleConfig() {
    if (!this.enabled) {
      const saved = (await this.sx.storage.loadData().catch(() => null)) || {};
      this.enabled = {};
      for (const rule of RULES) {
        this.enabled[rule.id] = saved[rule.id] !== undefined ? saved[rule.id] : !rule.defaultOff;
      }
    }
    return this.enabled;
  }

  lintText(content, enabled) {
    const lines = content.split("\n");
    const findings = [];
    for (const rule of RULES) {
      if (!enabled[rule.id]) continue;
      for (const f of rule.check(lines)) {
        findings.push({ rule, ...f });
      }
    }
    return findings;
  }

  async lintPublish(ctx) {
    const enabled = await this.ruleConfig();
    const warnings = [];
    for (const file of ctx.files) {
      if (!/\.(md|markdown)$/i.test(file.path)) continue;
      for (const f of this.lintText(file.content, enabled)) {
        warnings.push({
          message: `Style: ${f.rule.label.toLowerCase()}`,
          detail: `${file.path}:${f.line} — ${f.message}`,
        });
      }
    }
    return warnings.slice(0, 8);
  }

  async mount(view) {
    const enabled = await this.ruleConfig();
    view.el.replaceChildren();
    for (const rule of RULES) {
      const row = el(
        "label",
        "display: flex; gap: 6px; align-items: center; padding: 3px 0;" +
          "font-size: 11px; color: var(--color-ink-soft); cursor: pointer;",
      );
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!enabled[rule.id];
      box.addEventListener("change", () => {
        enabled[rule.id] = box.checked;
        void this.sx.storage.saveData(enabled);
      });
      row.append(box, document.createTextNode(rule.label));
      view.el.append(row);
    }

    const lint = el(
      "button",
      "margin-top: 8px; width: 100%; padding: 5px 0; border: 1px solid var(--color-line);" +
        "border-radius: 8px; background: transparent; color: var(--color-ink-soft);" +
        "font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;",
      "Lint the whole library",
    );
    const report = el("div", "margin-top: 8px;");
    lint.addEventListener("click", async () => {
      lint.disabled = true;
      lint.textContent = "Linting…";
      report.replaceChildren();
      try {
        const assets = await this.sx.assets.list();
        let clean = 0;
        const dirty = [];
        for (const summary of assets) {
          try {
            const files = await this.sx.assets.readFiles(summary.name);
            let count = 0;
            for (const file of files) {
              if (!/\.(md|markdown)$/i.test(file.path)) continue;
              count += this.lintText(file.content, enabled).length;
            }
            if (count === 0) clean++;
            else dirty.push({ name: summary.name, count });
          } catch {
            // unreadable asset — skip
          }
        }
        dirty.sort((a, b) => b.count - a.count);
        report.append(
          el(
            "div",
            "font-size: 11px; font-weight: 600; padding-bottom: 4px;",
            `${clean} clean · ${dirty.length} with findings`,
          ),
        );
        for (const d of dirty.slice(0, 10)) {
          const row = el(
            "button",
            "display: flex; width: 100%; background: none; border: none; padding: 2px 0;" +
              "font: inherit; font-size: 11px; cursor: pointer; gap: 6px; align-items: baseline;",
          );
          row.addEventListener("click", () => this.sx.ui.openAsset(d.name));
          row.append(
            el("span", "color: var(--color-accent); text-align: left;", d.name),
            el("span", FAINT + "margin-left: auto;", d.count + (d.count === 1 ? " finding" : " findings")),
          );
          report.append(row);
        }
      } catch (e) {
        report.append(el("div", FAINT + "font-size: 11px;", "Lint failed: " + e));
      } finally {
        lint.disabled = false;
        lint.textContent = "Lint the whole library";
      }
    });
    view.el.append(lint, report);
  }
}
