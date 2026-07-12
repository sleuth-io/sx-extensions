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
