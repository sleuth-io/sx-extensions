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
    root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Loading assets…"));
    try {
      const [assets, events] = await Promise.all([
        this.sx.assets.list(),
        this.sx.usage.events(30).catch(() => []),
      ]);
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
        const desc = el("input", INPUT);
        desc.value = a.description || "";
        tr.append(td(desc));
        const owner = el("input", INPUT + "max-width: 110px;");
        owner.placeholder = "owner";
        tr.append(td(owner));
        const status = el("select", INPUT + "max-width: 110px;");
        for (const o of ["", "active", "needs-review", "deprecated"]) {
          const opt = el("option", "", o || "—");
          opt.value = o;
          status.append(opt);
        }
        tr.append(td(status));
        tr.append(td(el("span", FAINT + "font-size: 11px;", String(uses.get(a.name) || 0))));
        const save = el("button", "border: 1px solid var(--color-line); border-radius: 6px; background: none; padding: 2px 10px; font: inherit; font-size: 11px; cursor: pointer; color: var(--color-ink-soft);", "Save");
        save.addEventListener("click", async () => {
          save.disabled = true;
          save.textContent = "Saving…";
          try {
            await this.sx.writeAssetMetadata(a.name, {
              description: desc.value,
              owner: owner.value,
              status: status.value,
            });
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
      root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Couldn't load: " + e));
    }
  }

  // ---- Board: the draft pipeline ----

  async renderBoard(root) {
    root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Loading drafts…"));
    try {
      const [drafts, state] = await Promise.all([this.sx.drafts.list(), this.state()]);
      const lanes = el("div", "display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;");
      for (const stage of STAGES) {
        const lane = el("div", "border: 1px solid var(--color-line); border-radius: 10px; min-height: 160px; padding: 8px;");
        lane.dataset.stage = stage;
        lane.append(el("div", FAINT + "font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding-bottom: 6px;", stage));
        lane.addEventListener("dragover", (e) => e.preventDefault());
        lane.addEventListener("drop", async (e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData("text/plain");
          if (!id) return;
          state.stages[id] = stage;
          await this.sx.storage.saveData(state);
          void this.renderBoard(root);
        });
        for (const d of drafts.filter((x) => (state.stages[x.id] || "Incoming") === stage)) {
          const card = el(
            "div",
            "border: 1px solid var(--color-line); border-radius: 8px; padding: 6px 8px;" +
              "margin-bottom: 6px; cursor: grab; background: var(--color-surface); font-size: 12px;",
          );
          card.draggable = true;
          card.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", d.id));
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
      root.replaceChildren(el("div", FAINT + "font-size: 12px;", "Couldn't load drafts: " + e));
    }
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
