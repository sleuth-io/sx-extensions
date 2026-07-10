// Claude Assist — three library-shaped AI interactions, nothing
// generic: ask the library a question (answers cite assets, citations
// open them), critique the open draft as a prompt, and turn a
// description into a new skill draft. Completions go through sx.llm
// (API 1.9.0): the user picks ONE provider in Settings → AI provider —
// an installed CLI, a local Ollama model, or their own API key — and
// this extension never sees a vendor, an endpoint, or a key. Never
// publishes anything.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const INPUT =
  "box-sizing: border-box; padding: 6px 8px; font: inherit; font-size: 13px;" +
  "border: 1px solid var(--color-line); border-radius: 8px;" +
  "background: var(--color-canvas); color: var(--color-ink); outline: none;";
const BUTTON =
  "padding: 6px 12px; font: inherit; font-size: 12px; font-weight: 500;" +
  "border: 1px solid var(--color-line); border-radius: 8px; cursor: pointer;" +
  "background: var(--color-surface); color: var(--color-ink);";
const PRIMARY =
  BUTTON + "background: var(--color-accent); border-color: var(--color-accent); color: white;";

const MAX_CONTEXT_ASSETS = 12;
const MAX_ASSET_CHARS = 8000;
const MAX_HISTORY_MESSAGES = 16; // sent to the API; the transcript keeps everything

// ---- Retrieval: cheap, exact, explainable ----

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || []).filter(
    (t) => t.length > 2,
  );
}

/** Score every asset against the question by term overlap on name and
 * description; return the top candidates (whose files then get read). */
function rankAssets(assets, question) {
  const terms = new Set(tokenize(question));
  if (terms.size === 0) return [];
  return assets
    .map((a) => {
      let score = 0;
      for (const t of tokenize(a.name)) if (terms.has(t)) score += 4;
      for (const t of tokenize(a.description || "")) if (terms.has(t)) score += 2;
      return { asset: a, score };
    })
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, MAX_CONTEXT_ASSETS);
}

/** Run fn over items with at most n in flight — context reads are a
 * full round-trip each on cloud vaults; don't chain them serially. */
async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, worker),
  );
}

function assetMarkdown(files) {
  const md = files
    .filter((f) => f.path.toLowerCase().endsWith(".md"))
    .sort((a, b) =>
      // SKILL.md first — it's the asset's front door.
      (b.path.toUpperCase().endsWith("SKILL.MD") ? 1 : 0) -
      (a.path.toUpperCase().endsWith("SKILL.MD") ? 1 : 0),
    )
    .map((f) => f.content)
    .join("\n\n");
  if (md.length <= MAX_ASSET_CHARS) return md;
  // Cut on a code-point boundary — never split a surrogate pair.
  let cut = MAX_ASSET_CHARS;
  const last = md.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return md.slice(0, cut) + "\n…";
}

export default class ClaudeAssist {
  onload(sx) {
    this.sx = sx;
    this.messages = []; // {role, content} — the running chat
    this.transcript = []; // {who: "you"|"claude"|"note", text} — what renders
    this.busy = false;
    this.rerender = null;
    this.contextCache = new Map(); // name -> {stamp, md}, this session only

    sx.registerMainView({
      id: "assist",
      title: "Claude Assist",
      mount: (view) => void this.mount(view),
    });
    sx.registerCommand({
      id: "ask",
      title: "Claude: Ask the library",
      run: () => sx.ui.openView("assist"),
    });
    sx.registerCommand({
      id: "critique",
      title: "Claude: Critique draft as a prompt",
      context: "editor",
      run: () => this.critiqueOpenDraft(),
    });
    sx.registerCommand({
      id: "new-skill",
      title: "New skill from a description…",
      menu: "new",
      hint: "Describe it; Claude drafts the SKILL.md",
      run: () => {
        // If the view is already mounted, flip the composer directly —
        // openView won't re-mount an open view.
        this.pendingMode = "new-skill";
        sx.ui.openView("assist");
        this.applyPendingMode();
      },
    });
  }

  onunload() {}

  // ---- The one view: provider row, transcript, composer ----

  async mount(view) {
    // Register disposal FIRST — the awaits below can outlive the view
    // (dev-mode double mounts), and a dead mount must not claim
    // this.rerender/this.composerState or append to a discarded DOM.
    let disposed = false;
    let composer = null;
    let rerender = null;
    view.onDispose(() => {
      disposed = true;
      if (rerender && this.rerender === rerender) this.rerender = null;
      if (composer && this.composerState === composer) this.composerState = null;
    });
    const root = view.el;
    // The root fills its container; readability comes from a centered
    // inner column (settings row + thread + composer share it) rather
    // than pinning everything left with a void on the right.
    root.style.cssText = "display: flex; flex-direction: column; height: 100%;";
    const provider = await this.sx.llm.provider().catch(() => "");
    if (disposed) return;

    root.replaceChildren();
    const inner = el(
      "div",
      "display: flex; flex-direction: column; height: 100%; min-height: 0;" +
        "max-width: 900px; width: 100%; margin: 0 auto; gap: 10px;",
    );
    root.appendChild(inner);
    inner.appendChild(this.providerRow(provider));

    const scroller = el("div", "flex: 1; overflow-y: auto; min-height: 0;");
    const thread = el("div", "display: flex; flex-direction: column; gap: 10px; padding: 2px;");
    scroller.appendChild(thread);
    inner.appendChild(scroller);

    composer = this.composer(provider);
    inner.appendChild(composer.row);
    this.composerState = composer;

    rerender = () => {
      thread.replaceChildren();
      if (this.transcript.length === 0) {
        const hello = el(
          "div",
          FAINT + "font-size: 13px; line-height: 1.5; padding: 12px;",
        );
        hello.append(
          el("div", "font-weight: 600; color: var(--color-ink);", "Ask your library anything."),
          el(
            "div",
            "margin-top: 6px;",
            "Answers come from the assets in this library and cite them — click a citation to open the asset. " +
              "Or use “New skill from a description” in + New, and “Critique draft as a prompt” while editing.",
          ),
        );
        thread.appendChild(hello);
      }
      for (const m of this.transcript) thread.appendChild(this.bubble(m));
      scroller.scrollTop = scroller.scrollHeight;
    };
    this.rerender = rerender;
    this.rerender();
    this.applyPendingMode();
    composer.input.focus();
  }

  /** Reflect a queued "new-skill" mode onto the live composer — called
   * after every mount and directly by the command (an already-open view
   * never re-mounts). Deliberately does NOT clear pendingMode: dev-mode
   * React double-mounts views, so anything consumed on first mount is
   * lost with its discarded DOM. The flag clears when the user submits. */
  applyPendingMode() {
    const c = this.composerState;
    if (this.pendingMode !== "new-skill" || !c) return;
    c.mode = "new-skill";
    c.input.value = "";
    c.input.placeholder =
      "Describe the skill you want (what it does, when to use it) — Claude drafts it";
    c.input.focus();
  }

  /** One informational line: which provider answers, or how to set one
   * up. Provider configuration lives in Settings → AI provider, shared
   * by every extension — no per-extension key or model UI anymore. */
  providerRow(provider) {
    const row = el(
      "div",
      "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;" +
        "padding: 8px 10px; border: 1px solid var(--color-line); border-radius: 10px;" +
        "background: var(--color-surface); font-size: 12px;",
    );
    if (provider) {
      row.append(
        el("span", FAINT, "Answers come from your configured AI provider:"),
        el("span", "font-weight: 600; color: var(--color-ink);", provider),
        el("span", FAINT, "— change it in Settings → AI provider."),
      );
    } else {
      row.append(
        el(
          "span",
          "color: var(--color-ink);",
          "No AI provider configured yet — open Settings → AI provider and pick one " +
            "(an installed CLI, a local Ollama model, or your own API key).",
        ),
      );
    }
    return row;
  }

  composer(provider) {
    const row = el("div", "display: flex; gap: 8px; align-items: flex-end;");
    const input = el("textarea", INPUT + "flex: 1; resize: none; min-height: 40px; max-height: 140px;");
    input.rows = 2;
    input.placeholder = provider
      ? "Ask about your library…"
      : "Configure an AI provider in Settings, then ask about your library…";
    const send = el("button", PRIMARY, "Ask");
    const state = { row, input, mode: "ask" };
    const submit = () => {
      const q = input.value.trim();
      if (!q) return;
      if (this.busy) {
        this.sx.ui.notice("Claude is still responding — wait for this turn to finish");
        return;
      }
      input.value = "";
      if (state.mode === "new-skill") {
        state.mode = "ask";
        this.pendingMode = null;
        input.placeholder = "Ask about your library…";
        void this.newSkillFrom(q);
      } else {
        void this.askLibrary(q);
      }
    };
    send.onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    row.append(input, send);
    return state;
  }

  bubble(m) {
    if (m.who === "note") {
      return el("div", FAINT + "font-size: 12px; text-align: center;", m.text);
    }
    const mine = m.who === "you";
    const b = el(
      "div",
      "max-width: 85%; padding: 8px 12px; border-radius: 12px; font-size: 13px;" +
        "line-height: 1.55; white-space: pre-wrap; word-break: break-word;" +
        (mine
          ? "align-self: flex-end; background: var(--color-accent-soft); color: var(--color-ink);"
          : "align-self: flex-start; border: 1px solid var(--color-line); background: var(--color-surface); color: var(--color-ink);"),
    );
    this.renderRich(b, m.text);
    if (m.streaming) b.appendChild(el("span", FAINT, " ▍"));
    return b;
  }

  /** Minimal rich rendering: fenced code blocks and [[asset]] citations
   * that open the asset. Everything else stays literal text. */
  renderRich(container, text) {
    const parts = String(text).split(/```(?:\w+\n)?/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        container.appendChild(
          el(
            "pre",
            "margin: 6px 0; padding: 8px 10px; overflow-x: auto; font-size: 12px;" +
              "font-family: var(--font-mono); border-radius: 8px;" +
              "background: var(--color-canvas); border: 1px solid var(--color-line);",
            part.replace(/\n$/, ""),
          ),
        );
        return;
      }
      const rx = /\[\[([^\]\n]{1,120})\]\]/g;
      let last = 0;
      let match;
      while ((match = rx.exec(part)) !== null) {
        if (match.index > last) container.append(part.slice(last, match.index));
        const name = match[1].trim();
        const link = el(
          "a",
          "color: var(--color-accent); cursor: pointer; text-decoration: underline;",
          name,
        );
        link.onclick = (e) => {
          e.preventDefault();
          this.sx.ui.openAsset(name);
        };
        container.appendChild(link);
        last = match.index + match[0].length;
      }
      if (last < part.length) container.append(part.slice(last));
    });
  }

  // ---- Interactions ----

  async askLibrary(question) {
    this.transcript.push({ who: "you", text: question });
    this.messages.push({ role: "user", content: question });
    await this.completeTurn(await this.librarySystemPrompt(question), this.messages);
  }

  async critiqueOpenDraft() {
    if (this.busy) {
      this.sx.ui.notice("Claude is still responding — wait for this turn to finish");
      return;
    }
    let draft;
    try {
      draft = this.sx.editor.getValue();
    } catch {
      this.sx.ui.notice("Open a draft in the editor first");
      return;
    }
    if (!draft.trim()) {
      this.sx.ui.notice("The open draft is empty");
      return;
    }
    this.sx.ui.openView("assist");
    this.messages = [];
    this.transcript.push({ who: "note", text: "Critiquing the open draft as a prompt" });
    const system =
      "You are a prompt engineer reviewing an AI asset (a skill, rule, or command " +
      "prompt) a teammate has open in their editor. Critique it AS A PROMPT: " +
      "ambiguity, missing trigger conditions, conflicting instructions, untestable " +
      "claims, scope creep, and what an LLM will actually do with it. Be specific — " +
      "quote the lines you mean. End with the three highest-leverage edits. Keep it tight.";
    this.messages.push({
      role: "user",
      content: "Critique this draft:\n\n```\n" + draft + "\n```",
    });
    await this.completeTurn(system, this.messages);
  }

  async newSkillFrom(description) {
    this.transcript.push({ who: "you", text: "New skill: " + description });
    this.messages = [];
    const system =
      "You write SKILL.md files for a team AI-asset library. Given a description, " +
      "produce ONE complete SKILL.md: YAML frontmatter with `name` (kebab-case) and " +
      "`description` (one sentence, starts with when to use it), then focused " +
      "markdown instructions. No preamble — output the file content only.";
    this.messages.push({ role: "user", content: description });
    const text = await this.completeTurn(system, this.messages);
    if (!text) return;
    const name =
      (text.match(/^name:\s*([a-z0-9-]+)/m) || [])[1] ||
      tokenize(description).slice(0, 4).join("-") ||
      "new-skill";
    const content = text.replace(/^```[a-z]*\n?/, "").replace(/\n?```\s*$/, "");
    const ok = await this.sx.ui.confirm(
      `Create draft “${name}” from Claude's SKILL.md?`,
      "Create draft",
    );
    if (!ok) return;
    await this.sx.drafts.create({ name, files: [{ path: "SKILL.md", content }] });
    this.sx.ui.notice(`Draft “${name}” created — review and publish when ready`);
  }

  async librarySystemPrompt(question) {
    const assets = await this.sx.assets.list();
    const catalog = assets
      .slice(0, 300)
      .map((a) => `- ${a.name} (${a.type}): ${a.description || "no description"}`)
      .join("\n");
    // Rank on names/descriptions first; read only the winners' files —
    // 8 at a time, keeping rank order, and reusing this session's
    // markdown for any asset unchanged since a previous ask.
    const ranked = rankAssets(assets, question);
    const slots = new Array(ranked.length);
    await pool(
      ranked.map(({ asset }, i) => ({ asset, i })),
      8,
      async ({ asset, i }) => {
        const stamp = asset.updatedAt || asset.version || asset.name;
        const hit = this.contextCache.get(asset.name);
        let md;
        if (hit && hit.stamp === stamp) {
          md = hit.md;
        } else {
          try {
            md = assetMarkdown(await this.sx.assets.readFiles(asset.name));
            this.contextCache.set(asset.name, { stamp, md });
          } catch {
            // unreadable asset: the catalog line still represents it;
            // nothing cached, so the next ask retries
            return;
          }
        }
        if (md) slots[i] = `<asset name="${asset.name}">\n${md}\n</asset>`;
      },
    );
    const blocks = slots.filter(Boolean);
    return (
      "You answer questions about a team's AI-asset library (skills, rules, " +
      "commands, MCP configs). Ground every answer in the catalog and asset " +
      "contents below — if the library doesn't cover it, say so plainly. " +
      "Whenever you reference an asset, cite it as [[asset-name]] (double " +
      "brackets, exact name); citations are clickable. Be concise.\n\n" +
      "## Catalog\n" + catalog + "\n\n" +
      "## Relevant asset contents\n" + (blocks.join("\n\n") || "(none matched)")
    );
  }

  // ---- The completion: one sx.llm call, provider-agnostic ----

  /** Drop the just-pushed user turn so the history keeps alternating
   * roles after a failed request. */
  popFailedTurn(messages) {
    if (messages.length > 0 && messages[messages.length - 1].role === "user") {
      messages.pop();
    }
  }

  /** One turn through sx.llm.complete. Not streamed — the bridge is
   * one-shot (CLI providers can't stream), so the bubble shows a
   * thinking indicator until the whole reply lands. CLI and local
   * providers can take a while on big prompts; that's normal. */
  async completeTurn(system, messages) {
    const entry = { who: "claude", text: "", streaming: true };
    this.transcript.push(entry);
    this.busy = true;
    this.rerender?.();

    // Cap what goes over the wire; the transcript keeps the full chat.
    // The window must still start on a user turn.
    let history = messages.slice(-MAX_HISTORY_MESSAGES);
    if (history[0]?.role === "assistant") history = history.slice(1);

    try {
      const result = await this.sx.llm.complete({
        messages: [{ role: "system", content: system }, ...history],
        maxTokens: 8192,
      });
      entry.text = result.text;
      entry.streaming = false;
      messages.push({ role: "assistant", content: entry.text });
      this.rerender?.();
      return entry.text;
    } catch (e) {
      entry.streaming = false;
      // The turn failed — pop its user message so roles keep alternating,
      // and drop the empty bubble in favor of the error note.
      this.popFailedTurn(messages);
      const idx = this.transcript.indexOf(entry);
      if (idx >= 0) this.transcript.splice(idx, 1);
      this.transcript.push({ who: "note", text: String(e?.message || e) });
      this.rerender?.();
      return "";
    } finally {
      this.busy = false;
    }
  }
}
