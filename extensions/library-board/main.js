// Library Grid & Board — an sx analogue of Obsidian's Projects/DB Folder
// (the editable metadata grid) and Kanban (the one honest board: the
// draft→publish pipeline). View config stays in plugin storage — the
// Projects "leave no trace" rule — and metadata edits publish revisions
// through assets:write-metadata; drafts re-lane in KV.

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FAINT = "color: var(--color-ink-faint);";
const INPUT =
  "width: 100%; box-sizing: border-box; padding: 3px 6px; font: inherit;" +
  "font-size: 12px; border: 1px solid var(--color-line); border-radius: 6px;" +
  "background: var(--color-canvas); color: var(--color-ink); outline: none;";
const STAGES = ["Incoming", "Drafting", "In review", "Ready"];

export default class LibraryBoard {
  onload(sx) {
    this.sx = sx;
    this.renderSeq = 0;
    sx.registerMainView({
      id: "board",
      title: "Grid & Board",
      mount: (view) => void this.mount(view),
    });
    sx.onBeforePublish((ctx) => this.gate(ctx));
  }

  onunload() {}

  async state() {
    return (await this.sx.storage.loadData().catch(() => null)) || { stages: {} };
  }

  async mount(view) {
    view.el.replaceChildren(el("div", FAINT + "font-size: 12px;", "Loading…"));
    const tabs = el("div", "display: flex; gap: 6px; margin-bottom: 12px;");
    const body = el("div", "");
    const mk = (label, render) => {
      const b = el(
        "button",
        "border: 1px solid var(--color-line); border-radius: 8px; background: none;" +
          "padding: 4px 14px; font: inherit; font-size: 12px; cursor: pointer;" +
          "color: var(--color-ink-soft);",
        label,
      );
      b.addEventListener("click", () => void render(body));
      return b;
    };
    tabs.append(mk("Grid", (b) => this.renderGrid(b)), mk("Board", (b) => this.renderBoard(b)));
    view.el.replaceChildren(tabs, body);
    await this.renderGrid(body);
  }

  // ---- Grid: editable metadata across the library ----

  async renderGrid(root) {
    // Tab clicks can race — only the latest render may write into root.
    const seq = ++this.renderSeq;
    root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Loading assets…"));
    try {
      const [assets, events] = await Promise.all([
        this.sx.assets.list(),
        this.sx.usage.events(30).catch(() => []),
      ]);
      if (seq !== this.renderSeq) return;
      const uses = new Map();
      for (const e of events) uses.set(e.assetName, (uses.get(e.assetName) || 0) + 1);
      const table = el("table", "width: 100%; border-collapse: collapse; font-size: 12px;");
      const head = el("tr");
      for (const h of ["Asset", "Description", "Owner", "Status", "Uses 30d", ""]) {
        head.append(
          el("th", FAINT + "text-align: left; font-weight: 500; font-size: 10px; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--color-line); text-transform: uppercase;", h),
        );
      }
      table.append(head);
      for (const a of assets) {
        const tr = el("tr");
        const td = (child) => {
          const cell = el("td", "padding: 5px 8px 5px 0; border-bottom: 1px solid var(--color-line); vertical-align: top;");
          cell.append(child);
          return cell;
        };
        const name = el("button", "background: none; border: none; padding: 0; font: inherit; font-size: 12px; color: var(--color-accent); cursor: pointer;", a.name);
        name.addEventListener("click", () => this.sx.ui.openAsset(a.name));
        tr.append(td(name));
        // Owner/status aren't in assets.list, so untouched inputs are
        // blank — not the current values. Track what the user actually
        // edited and patch only those fields; omitted means no-change.
        const dirty = { description: false, owner: false, status: false };
        const desc = el("input", INPUT);
        desc.value = a.description || "";
        desc.addEventListener("input", () => (dirty.description = true));
        tr.append(td(desc));
        const owner = el("input", INPUT + "max-width: 110px;");
        owner.placeholder = "owner";
        owner.addEventListener("input", () => (dirty.owner = true));
        tr.append(td(owner));
        const status = el("select", INPUT + "max-width: 110px;");
        for (const o of ["", "active", "needs-review", "deprecated"]) {
          const opt = el("option", "", o || "—");
          opt.value = o;
          status.append(opt);
        }
        status.addEventListener("change", () => (dirty.status = true));
        tr.append(td(status));
        tr.append(td(el("span", FAINT + "font-size: 11px;", String(uses.get(a.name) || 0))));
        const save = el("button", "border: 1px solid var(--color-line); border-radius: 6px; background: none; padding: 2px 10px; font: inherit; font-size: 11px; cursor: pointer; color: var(--color-ink-soft);", "Save");
        save.addEventListener("click", async () => {
          const patch = {};
          if (dirty.description) patch.description = desc.value;
          if (dirty.owner) patch.owner = owner.value;
          if (dirty.status) patch.status = status.value;
          if (Object.keys(patch).length === 0) {
            save.textContent = "Saved ✓";
            return;
          }
          save.disabled = true;
          save.textContent = "Saving…";
          try {
            await this.sx.writeAssetMetadata(a.name, patch);
            save.textContent = "Saved ✓";
          } catch (e) {
            save.textContent = "Save";
            this.sx.ui.notice("Couldn't save " + a.name + ": " + e);
          } finally {
            save.disabled = false;
          }
        });
        tr.append(td(save));
        table.append(tr);
      }
      root.replaceChildren(
        el("div", FAINT + "font-size: 11px; margin-bottom: 8px;", "Edits publish a metadata-only revision of the asset — content untouched, sharing inherited."),
        table,
      );
    } catch (e) {
      if (seq !== this.renderSeq) return;
      root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Couldn't load: " + e));
    }
  }

  // ---- Board: the draft pipeline ----

  async renderBoard(root) {
    const seq = ++this.renderSeq;
    root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Loading drafts…"));
    try {
      const [drafts, state] = await Promise.all([this.sx.drafts.list(), this.state()]);
      if (seq !== this.renderSeq) return;
      const lanes = el("div", "display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;");
      for (const stage of STAGES) {
        const lane = el("div", "border: 1px solid var(--color-line); border-radius: 10px; min-height: 160px; padding: 8px;");
        lane.dataset.stage = stage;
        lane.append(el("div", FAINT + "font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding-bottom: 6px;", stage));
        for (const d of drafts.filter((x) => (state.stages[x.id] || "Incoming") === stage)) {
          const card = el(
            "div",
            "border: 1px solid var(--color-line); border-radius: 8px; padding: 6px 8px;" +
              "margin-bottom: 6px; cursor: grab; background: var(--color-surface); font-size: 12px;" +
              // Pointer-drag, not HTML5 DnD: dragstart never fires in
              // the app's webview, and without it the browser falls
              // back to text selection mid-drag.
              "user-select: none; -webkit-user-select: none; touch-action: none;",
          );
          card.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            this.startCardDrag(e, card, d.id, root);
          });
          card.append(
            el("div", "font-weight: 600;", d.name),
            el("div", FAINT + "font-size: 10px;", d.type + (d.targetAsset ? " · updates " + d.targetAsset : " · new")),
          );
          lane.append(card);
        }
        lanes.append(lane);
      }
      root.replaceChildren(
        el("div", FAINT + "font-size: 11px; margin-bottom: 8px;", "Drag drafts between stages. Publishing from a stage other than Ready warns in the publish sheet."),
        lanes,
      );
    } catch (e) {
      if (seq !== this.renderSeq) return;
      root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Couldn't load drafts: " + e));
    }
  }

  /** Pointer-based card drag: capture the pointer, float the card
   * under it, highlight the lane it's over, and drop on release. All
   * listeners live on the card via setPointerCapture, so there's
   * nothing to leak — release ends everything. */
  startCardDrag(down, card, draftId, root) {
    card.setPointerCapture(down.pointerId);
    const rect = card.getBoundingClientRect();
    let moved = false;
    let hoverLane = null;
    const laneUnder = (e) => {
      card.style.pointerEvents = "none";
      const under = document.elementFromPoint(e.clientX, e.clientY);
      card.style.pointerEvents = "";
      return under ? under.closest("[data-stage]") : null;
    };
    const onMove = (e) => {
      if (!moved && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
      if (!moved) {
        moved = true;
        card.style.position = "fixed";
        card.style.width = rect.width + "px";
        card.style.zIndex = "40";
        card.style.opacity = "0.85";
        card.style.cursor = "grabbing";
      }
      card.style.left = rect.left + (e.clientX - down.clientX) + "px";
      card.style.top = rect.top + (e.clientY - down.clientY) + "px";
      const lane = laneUnder(e);
      if (lane !== hoverLane) {
        if (hoverLane) hoverLane.style.borderColor = "var(--color-line)";
        if (lane) lane.style.borderColor = "var(--color-accent)";
        hoverLane = lane;
      }
    };
    const onUp = async (e) => {
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      if (hoverLane) hoverLane.style.borderColor = "var(--color-line)";
      const lane = moved && e.type === "pointerup" ? laneUnder(e) : null;
      if (!lane) {
        void this.renderBoard(root); // snap back
        return;
      }
      try {
        // Re-read state at drop time — the copy from render is stale
        // the moment another surface (or a second window) saves.
        const state = await this.state();
        state.stages[draftId] = lane.dataset.stage;
        await this.sx.storage.saveData(state);
      } catch (err) {
        this.sx.ui.notice("Couldn't move the draft: " + err);
      }
      void this.renderBoard(root);
    };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  }

  async gate(ctx) {
    try {
      const [drafts, state] = await Promise.all([this.sx.drafts.list(), this.state()]);
      const draft = drafts.find((d) => d.name === ctx.name);
      if (!draft) return [];
      const stage = state.stages[draft.id] || "Incoming";
      if (stage !== "Ready") {
        return [{
          message: `This draft is in "${stage}" on the pipeline board`,
          detail: "Move it to Ready when it has been reviewed — or publish anyway.",
        }];
      }
    } catch {
      // board state unavailable — no gate
    }
    return [];
  }
}
