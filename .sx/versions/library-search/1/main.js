// Library Search — an sx analogue of Obsidian's Omnisearch (~1.6M
// downloads). Omnisearch runs MiniSearch/BM25 with per-field boosts
// (filename 10, headings 6/5/4, body 1). At sx scale a weighted
// scan-and-score per keystroke needs no inverted index; we keep the
// field-boost model, prefix matching at half weight, quoted phrases,
// -term exclusion, and usage-weighted ranking Omnisearch can only
// approximate.

const BOOSTS = { name: 10, description: 6, headings: 4, body: 1 };

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

/** Parse a query into include terms, quoted phrases, and exclusions. */
function parseQuery(raw) {
  const phrases = [];
  const rest = raw.replace(/"([^"]+)"/g, (_, phrase) => {
    phrases.push(phrase.toLowerCase());
    return " ";
  });
  const terms = [];
  const excluded = [];
  for (const word of rest.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (word.startsWith("-") && word.length > 1) excluded.push(word.slice(1));
    else terms.push(word);
  }
  return { terms, phrases, excluded };
}

function fieldScore(text, terms) {
  if (!text) return 0;
  let score = 0;
  const lower = text.toLowerCase();
  const tokens = lower.split(/[^a-z0-9_-]+/).filter(Boolean);
  // Normalize by log length so a huge body doesn't win on volume alone.
  const norm = 1 / Math.log2(4 + tokens.length);
  for (const term of terms) {
    let exact = 0;
    let prefix = 0;
    for (const tok of tokens) {
      if (tok === term) exact++;
      else if (tok.startsWith(term)) prefix++;
    }
    score += (exact + prefix * 0.5) * norm;
  }
  return score;
}

/** ±60 chars of context around the first body hit, with the hit marked. */
function excerpt(body, terms, phrases) {
  const lower = body.toLowerCase();
  let hit = -1;
  let hitLen = 0;
  for (const needle of [...phrases, ...terms]) {
    const idx = lower.indexOf(needle);
    if (idx >= 0 && (hit < 0 || idx < hit)) {
      hit = idx;
      hitLen = needle.length;
    }
  }
  if (hit < 0) return null;
  const start = Math.max(0, hit - 60);
  const end = Math.min(body.length, hit + hitLen + 60);
  return {
    before: (start > 0 ? "…" : "") + body.slice(start, hit),
    match: body.slice(hit, hit + hitLen),
    after: body.slice(hit + hitLen, end) + (end < body.length ? "…" : ""),
  };
}

export default class LibrarySearch {
  onload(sx) {
    this.sx = sx;
    this.index = null;
    sx.registerSidebarPanel({
      id: "search",
      title: "Search",
      mount: (view) => this.mount(view),
    });
  }

  onunload() {
    this.index = null;
  }

  async buildIndex() {
    if (this.index && Date.now() - this.index.builtAt < 60_000) {
      return this.index;
    }
    const [assets, events] = await Promise.all([
      this.sx.assets.list(),
      this.sx.usage.events(30).catch(() => []),
    ]);
    const useCount = new Map();
    for (const e of events) {
      useCount.set(e.assetName, (useCount.get(e.assetName) || 0) + 1);
    }
    const docs = [];
    for (const summary of assets) {
      try {
        const files = await this.sx.assets.readFiles(summary.name);
        const markdown = files
          .filter((f) => /\.(md|markdown)$/i.test(f.path))
          .map((f) => f.content)
          .join("\n");
        const headings = markdown
          .split("\n")
          .filter((l) => /^#{1,6}\s/.test(l))
          .join("\n");
        docs.push({
          summary,
          headings,
          body: markdown,
          uses: useCount.get(summary.name) || 0,
        });
      } catch {
        docs.push({ summary, headings: "", body: "", uses: 0 });
      }
    }
    this.index = { builtAt: Date.now(), docs };
    return this.index;
  }

  score(doc, q) {
    const haystack = (
      doc.summary.name +
      " " +
      doc.summary.description +
      " " +
      doc.body
    ).toLowerCase();
    for (const ex of q.excluded) {
      if (haystack.includes(ex)) return 0;
    }
    for (const phrase of q.phrases) {
      if (!haystack.includes(phrase)) return 0;
    }
    let score = q.phrases.length > 0 ? 1 : 0;
    if (q.terms.length > 0) {
      score +=
        BOOSTS.name * fieldScore(doc.summary.name, q.terms) +
        BOOSTS.description * fieldScore(doc.summary.description, q.terms) +
        BOOSTS.headings * fieldScore(doc.headings, q.terms) +
        BOOSTS.body * fieldScore(doc.body, q.terms);
    }
    if (score <= 0) return 0;
    // Popular assets float up: log-scaled 30-day usage boost.
    return score * (1 + Math.log1p(doc.uses) * 0.15);
  }

  mount(view) {
    const input = el(
      "input",
      "width: 100%; padding: 6px 10px; font: inherit; font-size: 12px;" +
        "border: 1px solid var(--color-line); border-radius: 8px;" +
        "background: var(--color-canvas); color: var(--color-ink);" +
        "outline: none; box-sizing: border-box;",
    );
    input.placeholder = 'Search assets…  ("phrase", -not)';
    const results = el("div", "margin-top: 8px;");
    view.el.append(input, results);

    let seq = 0;
    const run = async () => {
      const raw = input.value.trim();
      const mySeq = ++seq;
      if (!raw) {
        results.replaceChildren();
        return;
      }
      results.replaceChildren(el("div", FAINT + "font-size: 12px;", "Searching…"));
      try {
        const { docs } = await this.buildIndex();
        if (mySeq !== seq) return;
        const q = parseQuery(raw);
        const ranked = docs
          .map((doc) => ({ doc, score: this.score(doc, q) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 12);
        this.renderResults(results, ranked, q);
      } catch (e) {
        if (mySeq === seq) {
          results.replaceChildren(
            el("div", FAINT + "font-size: 12px;", "Search failed: " + e),
          );
        }
      }
    };
    input.addEventListener("input", () => void run());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = results.querySelector("button");
        if (first) first.click();
      }
    });
    view.onDispose(() => {
      seq++; // cancel any in-flight render
    });
  }

  renderResults(root, ranked, q) {
    root.replaceChildren();
    if (ranked.length === 0) {
      root.append(el("div", FAINT + "font-size: 12px;", "No matches."));
      return;
    }
    for (const { doc } of ranked) {
      const row = el(
        "button",
        "display: block; width: 100%; text-align: left; padding: 8px 10px;" +
          "margin-bottom: 6px; border: 1px solid var(--color-line);" +
          "border-radius: 8px; background: transparent; cursor: pointer;" +
          "color: var(--color-ink); font: inherit;",
      );
      row.addEventListener("click", () =>
        this.sx.ui.openAsset(doc.summary.name),
      );
      const head = el("div", "display: flex; gap: 6px; align-items: baseline;");
      head.append(
        el("span", "font-weight: 600; font-size: 12px;", doc.summary.name),
      );
      head.append(el("span", FAINT + "font-size: 10px;", doc.summary.type));
      if (doc.uses > 0) {
        head.append(
          el(
            "span",
            FAINT + "font-size: 10px; margin-left: auto;",
            "×" + doc.uses + " this month",
          ),
        );
      }
      row.append(head);
      const ex = excerpt(doc.body, q.terms, q.phrases);
      if (ex) {
        const line = el(
          "div",
          FAINT + "font-size: 11px; margin-top: 3px; line-height: 1.4;",
        );
        const mark = el("mark", "background: var(--color-accent-soft); color: var(--color-accent); border-radius: 2px;");
        mark.textContent = ex.match;
        line.append(document.createTextNode(ex.before), mark, document.createTextNode(ex.after));
        row.append(line);
      } else if (doc.summary.description) {
        row.append(
          el(
            "div",
            FAINT + "font-size: 11px; margin-top: 3px;",
            doc.summary.description,
          ),
        );
      }
      root.append(row);
    }
  }
}
