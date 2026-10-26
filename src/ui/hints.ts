// Pointing at anything explains it: a control that was given no tooltip by its page gets one when the pointer reaches it,
// from what the page itself says about it (its accessible name, its label, its placeholder, its words). Controls that
// have a tooltip (or sit inside something that has) keep theirs. A made tooltip is marked (data-hint-auto) and made
// again on every hover, so it follows the control's words. Installed once, by the app.

const INTERACTIVE = "button, a[href], input, select, textarea, summary, label, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=radio]";

const tidy = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

/** What a control with no tooltip of its own can say about itself, or "". */
export function hintFor(el: Element): string {
  const aria = tidy(el.getAttribute("aria-label"));
  if (aria) return aria;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const label = tidy(el.labels?.[0]?.textContent);
    const placeholder = "placeholder" in el ? tidy(el.placeholder) : "";
    const base = label || placeholder;
    if (!base) return "";
    return el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? `${base} (click to ${el.checked ? "untick" : "tick"})` : base;
  }
  const text = tidy(el.textContent);
  if (!text) return "";
  const short = text.length > 90 ? `${text.slice(0, 88)}…` : text;
  if (el instanceof HTMLAnchorElement && el.target === "_blank") return `${short} (opens in a new tab)`;
  return short;
}

/** The attribute that marks a tooltip made here (its value is the text made), so it is made again on each hover. */
export const AUTO = "data-hint-auto";

/**
 * Give a control its tooltip now (on hover). A tooltip made here before is made again (the control's words may have
 * changed: a count, a state); one the page set itself, also later over a made one, is kept.
 */
export function refreshHint(el: Element): void {
  const made = el.getAttribute(AUTO);
  // the page wrote its own tooltip over the made one: it is the page's now
  if (made != null && el.getAttribute("title") !== made) el.removeAttribute(AUTO);
  // a tooltip of its own stays; so does one of something it sits in (then a made one would hide it: it goes)
  if (el.hasAttribute("title") && !el.hasAttribute(AUTO)) return;
  const hint = el.parentElement?.closest(`[title]:not([${AUTO}])`) ? "" : hintFor(el);
  if (hint) { el.setAttribute("title", hint); el.setAttribute(AUTO, hint); }
  else if (el.hasAttribute(AUTO)) { el.removeAttribute("title"); el.removeAttribute(AUTO); }
}

export function installHints(root: Document = document): void {
  root.addEventListener("mouseover", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const el = t.closest(INTERACTIVE);
    if (el) refreshHint(el);
  }, true);
}
