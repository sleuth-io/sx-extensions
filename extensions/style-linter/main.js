// Style Linter — an sx analogue of Obsidian's Linter (~1.0M downloads).
// The original auto-rewrites files on save; shared team assets deserve
// report-not-rewrite, so findings surface as publish-sheet warnings (the
// lint-on-save analogue), a per-asset "Style" tab with the full report,
// and an on-demand whole-library lint. Rules are small pure functions
// over lines, individually toggleable — the original's key design. sx's
// built-in Publish Doctor covers publish CORRECTNESS (frontmatter,
// description, broken links); this is the opt-in style layer.

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
    label: "Lines under 160 characters",
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
      mount: (view) => void this.mountPanel(view),
    });
    sx.registerAssetTab({
      id: "style",
      title: "Style",
      mount: (view, ctx) => void this.mountAssetTab(view, ctx.assetName),
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

  async lintAsset(name, enabled) {
    const files = await this.sx.assets.readFiles(name);
    const findings = [];
    for (const file of files) {
      if (!/\.(md|markdown)$/i.test(file.path)) continue;
      for (const f of this.lintText(file.content, enabled)) {
        findings.push({ path: file.path, ...f });
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

  // ---- The per-asset "Style" tab: the actual findings, in full ----

  async mountAssetTab(view, assetName) {
    view.el.replaceChildren(el("div", FAINT + "font-size: 12px;", "Linting…"));
    try {
      const enabled = await this.ruleConfig();
      const findings = await this.lintAsset(assetName, enabled);
      view.el.replaceChildren();
      if (findings.length === 0) {
        view.el.append(
          el(
            "div",
            "font-size: 13px; color: var(--color-ink-soft); padding: 8px 0;",
            "✓ No style findings — this asset is clean.",
          ),
        );
        return;
      }
      view.el.append(
        el(
          "div",
          "font-size: 13px; font-weight: 600; padding-bottom: 8px;",
          findings.length + (findings.length === 1 ? " finding" : " findings"),
        ),
      );
      // Group by rule so one noisy rule reads as one block.
      const byRule = new Map();
      for (const f of findings) {
        const list = byRule.get(f.rule.id) || [];
        list.push(f);
        byRule.set(f.rule.id, list);
      }
      for (const [, list] of byRule) {
        const box = el(
          "div",
          "border: 1px solid var(--color-line); border-radius: 10px;" +
            "padding: 10px 12px; margin-bottom: 8px;",
        );
        box.append(
          el("div", "font-size: 12px; font-weight: 600;", list[0].rule.label),
        );
        for (const f of list) {
          box.append(
            el(
              "div",
              FAINT + "font-size: 12px; font-family: var(--font-mono); margin-top: 3px;",
              `${f.path}:${f.line} — ${f.message}`,
            ),
          );
        }
        view.el.append(box);
      }
    } catch (e) {
      view.el.replaceChildren(
        el("div", FAINT + "font-size: 12px;", "Couldn't lint: " + e),
      );
    }
  }

  // ---- The sidebar panel: rules link + library lint ----

  async mountPanel(view) {
    const enabled = await this.ruleConfig();
    view.el.replaceChildren();

    const row = el("div", "display: flex; gap: 6px; padding: 0 2px;");
    const rulesLink = el(
      "button",
      "flex: 1; background: none; border: 1px solid var(--color-line);" +
        "border-radius: 8px; padding: 4px 0; font: inherit; font-size: 11px;" +
        "color: var(--color-ink-soft); cursor: pointer;",
      "Rules…",
    );
    rulesLink.addEventListener("click", () => this.openRulesPopup(enabled));
    const lint = el(
      "button",
      "flex: 1.6; background: none; border: 1px solid var(--color-line);" +
        "border-radius: 8px; padding: 4px 0; font: inherit; font-size: 11px;" +
        "color: var(--color-ink-soft); cursor: pointer;",
      "Lint library",
    );
    row.append(rulesLink, lint);
    view.el.append(row);

    const report = el("div", "margin-top: 8px; padding: 0 2px;");
    view.el.append(report);
    lint.addEventListener("click", () => void this.lintLibrary(lint, report, enabled));
    view.el.append(
      el(
        "div",
        FAINT + "font-size: 10px; padding: 6px 2px 0; line-height: 1.5;",
        "Each asset also gets a Style tab with its full report.",
      ),
    );
  }

  openRulesPopup(enabled) {
    const backdrop = el(
      "div",
      "position: fixed; inset: 0; z-index: 120; background: rgba(0,0,0,0.4);" +
        "display: flex; align-items: center; justify-content: center;",
    );
    const sheet = el(
      "div",
      "width: 380px; max-height: calc(100vh - 48px); overflow-y: auto;" +
        "background: var(--color-surface); border: 1px solid var(--color-line);" +
        "border-radius: 16px; padding: 18px 20px; box-shadow: 0 24px 48px rgba(0,0,0,0.3);",
    );
    sheet.append(
      el("div", "font-size: 14px; font-weight: 600; margin-bottom: 2px;", "Style rules"),
      el(
        "div",
        FAINT + "font-size: 11px; margin-bottom: 10px;",
        "Applied at publish time, in each asset's Style tab, and by the library lint.",
      ),
    );
    for (const rule of RULES) {
      const row = el(
        "label",
        "display: flex; gap: 8px; align-items: center; padding: 5px 0;" +
          "font-size: 13px; color: var(--color-ink); cursor: pointer;",
      );
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!enabled[rule.id];
      box.addEventListener("change", () => {
        enabled[rule.id] = box.checked;
        void this.sx.storage.saveData(enabled);
      });
      row.append(box, document.createTextNode(rule.label));
      if (rule.defaultOff) {
        row.append(el("span", FAINT + "font-size: 10px;", "(off by default)"));
      }
      sheet.append(row);
    }
    const done = el(
      "button",
      "margin-top: 12px; width: 100%; padding: 7px 0; border: none;" +
        "border-radius: 8px; background: var(--color-accent); color: white;" +
        "font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;",
      "Done",
    );
    const close = () => backdrop.remove();
    done.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });
    sheet.append(done);
    backdrop.append(sheet);
    document.body.append(backdrop);
  }

  async lintLibrary(button, report, enabled) {
    button.disabled = true;
    button.textContent = "Linting…";
    report.replaceChildren();
    try {
      const assets = await this.sx.assets.list();
      let clean = 0;
      const dirty = [];
      for (const summary of assets) {
        try {
          const count = (await this.lintAsset(summary.name, enabled)).length;
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
      if (dirty.length > 0) {
        report.append(
          el(
            "div",
            FAINT + "font-size: 10px; padding-bottom: 4px;",
            "Open one and check its Style tab for the details.",
          ),
        );
      }
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
      button.disabled = false;
      button.textContent = "Lint library";
    }
  }
}
