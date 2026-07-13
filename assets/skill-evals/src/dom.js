// DOM helpers and style constants shared by both views. Same shapes as
// skill-doctor/repo-doctor so the extension reads as native chrome.

export function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const FAINT = "color: var(--color-ink-faint);";
export const SOFT = "color: var(--color-ink-soft);";
export const CARD =
  "border: 1px solid var(--color-line); border-radius: 12px; padding: 12px;" +
  "background: var(--color-surface); display: flex; flex-direction: column; gap: 8px;";
export const BUTTON =
  "padding: 5px 10px; font: inherit; font-size: 12px; font-weight: 500;" +
  "border: 1px solid var(--color-line); border-radius: 8px; cursor: pointer;" +
  "background: var(--color-surface); color: var(--color-ink);";
export const PRIMARY =
  BUTTON +
  "background: var(--color-accent); border-color: var(--color-accent); color: white;";
export const NOTE =
  "border: 1px solid var(--color-line); border-radius: 8px; padding: 8px 10px;" +
  "background: var(--color-canvas); font-size: 12px; line-height: 1.5;";

export const SMALL_BUTTON = BUTTON + "padding: 3px 8px; font-size: 11px; white-space: nowrap;";

/** Uppercase faint section label — quieter hierarchy than bold headings. */
export function sectionLabel(text) {
  return el(
    "div",
    FAINT + "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;",
    text,
  );
}

/** A "⋯" button revealing a small popup of secondary actions. The popup
 * closes on any outside click; rerenders drop it wholesale, so nothing
 * leaks past the row's lifetime. */
export function menuButton(items) {
  const wrap = el("div", "position: relative; margin-left: auto;");
  const btn = el("button", SMALL_BUTTON + "line-height: 1;", "⋯");
  btn.title = "More actions";
  const menu = el(
    "div",
    "position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; display: none;" +
      "min-width: 150px; padding: 4px; border: 1px solid var(--color-line); border-radius: 8px;" +
      "background: var(--color-surface); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);" +
      "flex-direction: column; gap: 2px;",
  );
  for (const item of items) {
    const it = el(
      "button",
      "text-align: left; padding: 5px 8px; font: inherit; font-size: 12px; border: 0;" +
        "border-radius: 6px; background: transparent; cursor: pointer;" +
        (item.danger ? "color: var(--color-danger);" : "color: var(--color-ink);"),
      item.label,
    );
    it.onmouseenter = () => (it.style.background = "var(--color-canvas)");
    it.onmouseleave = () => (it.style.background = "transparent");
    it.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = "none";
      item.run();
    };
    menu.append(it);
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const opening = menu.style.display === "none" || !menu.style.display;
    menu.style.display = opening ? "flex" : "none";
    if (opening) {
      document.addEventListener("click", () => (menu.style.display = "none"), { once: true });
    }
  };
  wrap.append(btn, menu);
  return wrap;
}

export function chip(text, tone) {
  const colors = {
    danger: "border-color: var(--color-danger); color: var(--color-danger);",
    accent: "border-color: var(--color-accent); color: var(--color-accent);",
    faint: "color: var(--color-ink-faint);",
  };
  return el(
    "span",
    "display: inline-block; padding: 1px 7px; border: 1px solid var(--color-line);" +
      "border-radius: 999px; font-size: 11px; white-space: nowrap;" +
      (colors[tone] || colors.faint),
    text,
  );
}

/** Small horizontal pass-rate bar with a label, e.g. "with 93%". */
export function rateBar(label, rate) {
  const wrap = el("div", "display: flex; align-items: center; gap: 6px; font-size: 11px;");
  const track = el(
    "div",
    "width: 72px; height: 6px; border-radius: 999px; background: var(--color-canvas);" +
      "border: 1px solid var(--color-line); overflow: hidden;",
  );
  const fill = el(
    "div",
    `height: 100%; width: ${Math.round(rate * 100)}%; background: ${
      rate >= 0.8 ? "var(--color-accent)" : "var(--color-danger)"
    };`,
  );
  track.append(fill);
  wrap.append(el("span", FAINT + "min-width: 46px;", label), track, el("span", SOFT, fmtPct(rate)));
  return wrap;
}

export function fmtPct(x) {
  return `${Math.round(x * 100)}%`;
}

export function fmtAgo(epochMs) {
  const days = Math.floor((Date.now() - epochMs) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}
