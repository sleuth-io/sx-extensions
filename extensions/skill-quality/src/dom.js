// DOM helpers and style constants. Same shapes as skill-evals so the
// extension reads as native chrome.

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

/** Uppercase faint section label — quieter hierarchy than bold headings. */
export function sectionLabel(text) {
  return el(
    "div",
    FAINT + "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;",
    text,
  );
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

/** Score color thresholds shared by the badge and the bars — the same
 * cuts collection-doctor uses. */
export function scoreColor(score) {
  if (score >= 85) return "var(--color-accent)";
  if (score >= 60) return "#d97706"; // amber — no design token for warn yet
  return "var(--color-danger)";
}

/** The big score badge (shield-ish rounded square, like skills.new's). */
export function scoreBadge(score) {
  const badge = el(
    "div",
    "width: 72px; height: 72px; border-radius: 16px; display: flex; align-items: center;" +
      "justify-content: center; font-size: 26px; font-weight: 700; color: white;" +
      `background: ${scoreColor(score)}; flex-shrink: 0;`,
    String(score),
  );
  return badge;
}

/** Labeled 0-100 progress bar, skills.new Quality-tab style. */
export function progressBar(label, score) {
  const row = el("div", "display: flex; align-items: center; gap: 10px; font-size: 12px;");
  const track = el(
    "div",
    "flex: 1; height: 7px; border-radius: 999px; background: var(--color-canvas);" +
      "border: 1px solid var(--color-line); overflow: hidden;",
  );
  const fill = el(
    "div",
    `height: 100%; width: ${Math.max(0, Math.min(100, score))}%; background: ${scoreColor(score)};`,
  );
  track.append(fill);
  row.append(
    el("span", SOFT + "min-width: 100px;", label),
    track,
    el("span", SOFT + "min-width: 34px; text-align: right;", `${Math.round(score)}%`),
  );
  return row;
}

export function fmtAgo(epochMs) {
  const days = Math.floor((Date.now() - epochMs) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}
