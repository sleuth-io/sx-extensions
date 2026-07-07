// Related Assets — an sx analogue of Obsidian's Smart Connections
// (~1.1M downloads). Smart Connections embeds notes with a local model
// and shows a ranked sidebar of similar notes. At sx scale (hundreds of
// keyword-dense technical documents, not 100k prose notes) classical
// TF-IDF cosine similarity is exact, deterministic, and explainable: we
// can show WHICH shared terms drove each match, something embeddings
// can't do.

const STOPWORDS = new Set(
  (
    "a,an,the,and,or,but,if,then,else,for,of,in,on,at,to,from,by,with,as," +
    "is,are,was,were,be,been,being,do,does,did,done,doing,have,has,had," +
    "having,it,its,this,that,these,those,you,your,we,our,they,their,i,me," +
    "my,not,no,can,could,should,would,will,may,might,must,about,into,over," +
    "under,than,too,very,just,also,when,where,why,how,what,which,who,all," +
    "any,both,each,few,more,most,other,some,such,only,own,same,so,up,down," +
    "out,off,use,using,used,file,files,run,new,get,set,make,sure,like,need"
  ).split(","),
);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/^---[\s\S]*?\n---\n?/, " ") // frontmatter keys aren't prose
    .replace(/```[\s\S]*?```/g, " ") // fenced code is noise for prose similarity
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 2 && w.length < 40 && /^[a-z]/.test(w) && !STOPWORDS.has(w),
    );
}

/** term -> tf map, normalized by document length. */
function termFrequencies(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, n] of tf) tf.set(t, n / tokens.length);
  return tf;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const other = large.get(t);
    if (other) dot += w * other;
  }
  for (const w of a.values()) na += w * w;
  for (const w of b.values()) nb += w * w;
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";

export default class RelatedAssets {
  onload(sx) {
    this.sx = sx;
    this.corpus = null; // {builtAt, vectors: Map name -> {tf, summary}}
    sx.registerAssetTab({
      id: "related",
      title: "Related",
      mount: (view, ctx) => void this.mount(view, ctx.assetName),
    });
  }

  onunload() {
    this.corpus = null;
  }

  /** Vectorize every asset once per minute at most; markdown only. */
  async buildCorpus() {
    if (this.corpus && Date.now() - this.corpus.builtAt < 60_000) {
      return this.corpus;
    }
    const assets = await this.sx.assets.list();
    const vectors = new Map();
    for (const summary of assets) {
      try {
        const files = await this.sx.assets.readFiles(summary.name);
        const text = files
          .filter((f) => /\.(md|markdown)$/i.test(f.path))
          .map((f) => tokenize(f.content).join(" "))
          .join("\n");
        const tokens = (
          tokenize(summary.name + " " + summary.description).join(" ") +
          " " +
          text
        ).split(/\s+/).filter(Boolean);
        if (tokens.length > 0) {
          vectors.set(summary.name, { tf: termFrequencies(tokens), summary });
        }
      } catch {
        // unreadable asset — skip, never break the tab
      }
    }
    // Inverse document frequency turns raw tf into tf-idf weights.
    const df = new Map();
    for (const { tf } of vectors.values()) {
      for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    }
    const n = vectors.size;
    for (const entry of vectors.values()) {
      const weighted = new Map();
      for (const [term, tf] of entry.tf) {
        weighted.set(term, tf * Math.log(1 + n / df.get(term)));
      }
      entry.tf = weighted;
    }
    this.corpus = { builtAt: Date.now(), vectors };
    return this.corpus;
  }

  async mount(view, assetName) {
    view.el.replaceChildren(el("div", FAINT + "padding: 8px 0;", "Comparing assets…"));
    try {
      const { vectors } = await this.buildCorpus();
      const me = vectors.get(assetName);
      if (!me) {
        view.el.replaceChildren(
          el("div", FAINT + "padding: 8px 0;", "Nothing to compare yet."),
        );
        return;
      }
      const scored = [];
      for (const [name, other] of vectors) {
        if (name === assetName) continue;
        const score = cosine(me.tf, other.tf);
        if (score > 0.02) scored.push({ name, other, score });
      }
      scored.sort((a, b) => b.score - a.score);
      this.render(view.el, me, scored.slice(0, 8));
    } catch (e) {
      view.el.replaceChildren(
        el("div", FAINT + "padding: 8px 0;", "Couldn't compute related assets: " + e),
      );
    }
  }

  /** Top terms two tf-idf vectors share, by combined weight. */
  sharedTerms(a, b) {
    const shared = [];
    for (const [term, w] of a) {
      const other = b.get(term);
      if (other) shared.push({ term, weight: w * other });
    }
    shared.sort((x, y) => y.weight - x.weight);
    return shared.slice(0, 3).map((s) => s.term);
  }

  render(root, me, rows) {
    root.replaceChildren();
    if (rows.length === 0) {
      root.append(
        el("div", FAINT + "padding: 8px 0;", "No clearly related assets found."),
      );
      return;
    }
    const max = rows[0].score;
    for (const row of rows) {
      const item = el(
        "button",
        "display: block; width: 100%; text-align: left; padding: 10px 12px;" +
          "margin-bottom: 8px; border: 1px solid var(--color-line);" +
          "border-radius: 10px; background: transparent; cursor: pointer;" +
          "color: var(--color-ink); font: inherit;",
      );
      item.addEventListener("click", () => this.sx.ui.openAsset(row.name));

      const head = el("div", "display: flex; align-items: center; gap: 8px;");
      head.append(el("span", "font-weight: 600; font-size: 13px;", row.name));
      head.append(
        el("span", FAINT + "font-size: 11px;", row.other.summary.type),
      );
      const pct = el(
        "span",
        "margin-left: auto; font-size: 11px; color: var(--color-accent);",
        (row.score / max >= 0.999 ? "best match" : Math.round((row.score / max) * 100) + "%"),
      );
      head.append(pct);
      item.append(head);

      const bar = el(
        "div",
        "height: 3px; border-radius: 2px; background: var(--color-line); margin: 6px 0;",
      );
      const fill = el(
        "div",
        "height: 100%; border-radius: 2px; background: var(--color-accent);" +
          `width: ${Math.max(4, Math.round((row.score / max) * 100))}%;`,
      );
      bar.append(fill);
      item.append(bar);

      if (row.other.summary.description) {
        item.append(
          el(
            "div",
            FAINT + "font-size: 12px; margin-bottom: 4px;",
            row.other.summary.description,
          ),
        );
      }
      const terms = this.sharedTerms(me.tf, row.other.tf);
      if (terms.length > 0) {
        item.append(
          el("div", FAINT + "font-size: 11px;", "shared: " + terms.join(", ")),
        );
      }
      root.append(item);
    }
  }
}
