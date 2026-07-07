// Smart Templates — an sx analogue of Obsidian's Templater (~4.8M
// downloads) and QuickAdd (~1.9M). Templater's escape hatch to real JS is
// exactly wrong for shared team artifacts (its own docs warn about
// untrusted template code), so this keeps QuickAdd's safer model:
// declarative placeholders, prompted once by name, substituted
// everywhere. A template is any asset whose frontmatter has
// `template: true`; teams author and version templates like any asset.
//
// Placeholders:
//   {{date}} {{date:YYYY-MM-DD}}  today, optionally formatted
//   {{name}}                      the new asset's name
//   {{prompt:label}}              text input, asked once per label
//   {{choose:label|a,b,c}}        pick list

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const INPUT_STYLE =
  "width: 100%; box-sizing: border-box; padding: 5px 8px; font: inherit;" +
  "font-size: 12px; border: 1px solid var(--color-line); border-radius: 6px;" +
  "background: var(--color-canvas); color: var(--color-ink); outline: none;";

function formatDate(fmt) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const map = {
    YYYY: String(now.getFullYear()),
    MM: pad(now.getMonth() + 1),
    DD: pad(now.getDate()),
    HH: pad(now.getHours()),
    mm: pad(now.getMinutes()),
  };
  return (fmt || "YYYY-MM-DD").replace(/YYYY|MM|DD|HH|mm/g, (t) => map[t]);
}

const PLACEHOLDER = /\{\{\s*(date|name|prompt|choose)(?::([^}|]*))?(?:\|([^}]*))?\s*\}\}/g;

/** Distinct prompt/choose variables in template order. */
function scanVariables(text) {
  const vars = [];
  const seen = new Set();
  for (const m of text.matchAll(PLACEHOLDER)) {
    const [, kind, label, options] = m;
    if ((kind === "prompt" || kind === "choose") && label && !seen.has(label)) {
      seen.add(label);
      vars.push({
        kind,
        label: label.trim(),
        options: kind === "choose" ? (options || "").split(",").map((o) => o.trim()).filter(Boolean) : [],
      });
    }
  }
  return vars;
}

function substitute(text, name, values) {
  return text.replace(PLACEHOLDER, (whole, kind, label) => {
    if (kind === "date") return formatDate(label);
    if (kind === "name") return name;
    const value = values[(label || "").trim()];
    return value !== undefined && value !== "" ? value : whole;
  });
}

export default class SmartTemplates {
  onload(sx) {
    this.sx = sx;
    sx.registerSidebarPanel({
      id: "templates",
      title: "Templates",
      mount: (view) => void this.mount(view),
    });
  }

  onunload() {}

  async mount(view) {
    view.el.replaceChildren(el("div", FAINT + "font-size: 12px;", "Loading templates…"));
    try {
      const assets = await this.sx.assets.list();
      const templates = [];
      for (const summary of assets) {
        try {
          const files = await this.sx.assets.readFiles(summary.name);
          const first = files.find((f) => /\.(md|markdown)$/i.test(f.path));
          if (first && /^template:\s*true$/m.test(first.content.slice(0, 500))) {
            templates.push({ summary, files });
          }
        } catch {
          // unreadable asset — not a template
        }
      }
      this.renderPicker(view.el, templates);
    } catch (e) {
      view.el.replaceChildren(
        el("div", FAINT + "font-size: 12px;", "Couldn't scan templates: " + e),
      );
    }
  }

  renderPicker(root, templates) {
    root.replaceChildren();
    if (templates.length === 0) {
      const empty = el("div", "padding: 2px 8px;");
      empty.append(
        el(
          "div",
          FAINT + "font-size: 11px; line-height: 1.5; margin-bottom: 6px;",
          "No templates yet.",
        ),
        el(
          "div",
          FAINT + "font-size: 11px; line-height: 1.5;",
          "Mark any asset as a template by adding this to its frontmatter:",
        ),
        el(
          "pre",
          "margin: 6px 0; padding: 6px 8px; border: 1px solid var(--color-line);" +
            "border-radius: 8px; background: var(--color-canvas);" +
            "font-family: var(--font-mono); font-size: 10px; line-height: 1.6;" +
            "color: var(--color-ink-soft); overflow-x: auto;",
          "template: true",
        ),
        el(
          "div",
          FAINT + "font-size: 11px; line-height: 1.5;",
          "It then appears here as a form: placeholders like {{date}}, " +
            "{{prompt:audience}} and {{choose:tier|core,extra}} become " +
            "fields you fill in, and Create makes a new draft with " +
            "everything substituted.",
        ),
      );
      root.append(empty);
      return;
    }
    for (const t of templates) {
      const row = el(
        "button",
        "display: block; width: 100%; text-align: left; padding: 7px 10px;" +
          "margin-bottom: 6px; border: 1px solid var(--color-line);" +
          "border-radius: 8px; background: transparent; cursor: pointer;" +
          "color: var(--color-ink); font: inherit;",
      );
      row.append(el("div", "font-size: 12px; font-weight: 600;", t.summary.name));
      if (t.summary.description) {
        row.append(el("div", FAINT + "font-size: 11px; margin-top: 2px;", t.summary.description));
      }
      row.addEventListener("click", () => void this.renderForm(root, templates, t));
      root.append(row);
    }
  }

  async renderForm(root, templates, t) {
    const allText = t.files.map((f) => f.content).join("\n");
    const vars = scanVariables(allText);
    const saved = (await this.sx.storage.loadData().catch(() => null)) || {};
    const remembered = saved[t.summary.name] || {};

    root.replaceChildren();
    const back = el(
      "button",
      "background: none; border: none; padding: 0; cursor: pointer;" +
        FAINT + "font-size: 11px; font: inherit;",
      "← templates",
    );
    back.addEventListener("click", () => this.renderPicker(root, templates));
    root.append(back, el("div", "font-size: 12px; font-weight: 600; margin: 6px 0 8px;", "New from " + t.summary.name));

    const nameInput = el("input", INPUT_STYLE);
    nameInput.placeholder = "new asset name";
    root.append(this.field("Name", nameInput));

    const inputs = new Map();
    for (const v of vars) {
      let input;
      if (v.kind === "choose" && v.options.length > 0) {
        input = el("select", INPUT_STYLE);
        for (const opt of v.options) {
          const o = el("option", "", opt);
          o.value = opt;
          input.append(o);
        }
      } else {
        input = el("input", INPUT_STYLE);
      }
      if (remembered[v.label] !== undefined) input.value = remembered[v.label];
      inputs.set(v.label, input);
      root.append(this.field(v.label, input));
    }

    const create = el(
      "button",
      "margin-top: 8px; width: 100%; padding: 6px 0; border: none;" +
        "border-radius: 8px; background: var(--color-accent); color: white;" +
        "font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;",
      "Create draft",
    );
    create.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        this.sx.ui.notice("Give the new asset a name first");
        return;
      }
      const values = {};
      for (const [label, input] of inputs) values[label] = input.value.trim();
      create.disabled = true;
      create.textContent = "Creating…";
      try {
        const files = t.files.map((f) => ({
          path: f.path,
          content: substitute(
            // The template flag must not travel into the scaffolded
            // asset, and its frontmatter name becomes the new asset's.
            f.content
              .replace(/^template:\s*true\s*$/m, "")
              .replace(/^name:\s*.+$/m, "name: " + name),
            name,
            values,
          ),
        }));
        await this.sx.drafts.create({ name, files });
        saved[t.summary.name] = values;
        void this.sx.storage.saveData(saved);
        this.sx.ui.notice(`Draft "${name}" created from ${t.summary.name}`);
        this.renderPicker(root, templates);
      } catch (e) {
        this.sx.ui.notice("Couldn't create the draft: " + e);
        create.disabled = false;
        create.textContent = "Create draft";
      }
    });
    root.append(create);
  }

  field(label, input) {
    const wrap = el("div", "margin-bottom: 6px;");
    wrap.append(
      el("div", FAINT + "font-size: 10px; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.05em;", label),
      input,
    );
    return wrap;
  }
}
