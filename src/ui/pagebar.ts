// The one line under the top bar that every page shares, so every page looks the same:
//   the field (a two-sided switch, Search | Ask AI, joined to one text box), then the page's
//   filters and buttons, then the person chips and the page's switches and choices; counts and
//   status at the right end. What does not fit the width moves into the "⋯" menu at the end of the
//   line (a panel holding the very same controls) and comes back when there is room.
// Search filters the page as you type. Ask AI sends the same text to the Ask AI dialog on Enter.
// A page whose search only highlights (the Board) can pin it: Enter then shows only what matches,
// until the text is cleared (the × in the field, or Esc).
// Which side is on is kept in this browser; a page with nothing to search asks AI and highlights neither side.
// While filters or person chips filter the page, a "Filtered: 2 · Clear" chip stays in the line: it cannot be
// switched off and never moves under "⋯", so a filter whose own control is hidden still shows that it filters.
import type { App } from "../app/context.ts";
import { searchWords } from "../core/filters.ts";
import { prefs } from "../core/settings.ts";
import { AI_FEATURES } from "../core/ai.ts";
import { openAskAi } from "./askai.ts";
import { blk, onBlocksChange } from "./blocks.ts";
import { debounce, h, icon } from "./dom.ts";
import type { FilterSource, SearchBox } from "./filterbar.ts";
import { FILTERS_CHANGED, filterSourceOf } from "./filterbar.ts";

export type FieldMode = "search" | "ask";
export const FIELD_MODE_KEY = "field.mode";

/** The side the field starts on: the saved one, or Ask AI when the page has nothing to search. */
export function startMode(saved: unknown, canSearch: boolean): FieldMode {
  if (!canSearch) return "ask";
  return saved === "ask" ? "ask" : "search";
}

/** A filter part of the line: what it filters, and whether its control is switched off (it still filters). */
export interface FilterPart { what: FilterSource["what"]; count: number; says: string[]; off: boolean }

/** The "Filtered" chip: its text and its tooltip, or null when nothing filters. */
export function filteredSummary(parts: FilterPart[]): { text: string; title: string } | null {
  const n = parts.reduce((a, p) => a + p.count, 0);
  if (!n) return null;
  const hidden = parts.filter((p) => p.off && p.count);
  const off = hidden.reduce((a, p) => a + p.count, 0);
  const says = parts.flatMap((p) => (p.count ? p.says : []));
  const names = [...new Set(hidden.map((p) => (p.what === "people" ? "the person chips" : "the Filter button")))];
  const many = names.length > 1 || names[0] === "the person chips"; // "the person chips are", "the Filter button is"
  const offText = names.length
    ? ` ${names.join(" and ").replace(/^t/, "T")} ${many ? "are" : "is"} switched off in Settings > Menu & bars, but still filter${many ? "" : "s"} this page.`
    : "";
  return {
    text: `Filtered: ${n}${off ? ` (${off} hidden)` : ""}`,
    title: `This page is filtered: ${says.join("; ")}.${offText} Clear shows everything again.`,
  };
}

/** The details panel's width as a CSS variable on the page (--panel-w), so the page makes room for it (10-shell.css). */
let panelFollowed = false;
function followPanelWidth(): void {
  if (panelFollowed) return;
  const panel = document.querySelector<HTMLElement>("aside.panel");
  if (!panel) return;
  panelFollowed = true;
  const set = (): void => { document.body.style.setProperty("--panel-w", panel.style.width || `${panel.offsetWidth || 520}px`); };
  set();
  new MutationObserver(set).observe(panel, { attributes: true, attributeFilter: ["style"] });
}

export interface PageBarOpts {
  /** the page can be searched: what to show, and what to redraw when the words change */
  search?: { placeholder: string; title: string; label?: string; onChange: () => void;
    /** typing highlights; Enter pins the search: only what matches shows, until the text is cleared */
    pin?: boolean };
}

export interface PageBar {
  /** both lines: put it first in the page */
  el: HTMLElement;
  /** after the field: the page's filters and buttons */
  line2: HTMLElement;
  /** the right end: counts and status */
  end: HTMLElement;
  /** person chips, then switches and choices (the page bar is one line: People and Filter come first by CSS order) */
  line3: HTMLElement;
  /** the search side of the field (no words while Ask AI is on) */
  search: SearchBox & {
    /** the text typed, trimmed and lower case; "" while Ask AI is on */
    query: () => string;
    /** Enter was pressed (pages with `pin`): show only what matches, not just highlight it */
    pinned: () => boolean;
  };
}

/**
 * One line that never wraps: the controls that do not fit move into a panel opened by the "⋯" button
 * at the end (the controls themselves move, so they keep working there), and come back with room.
 * A placeholder keeps each one's place; a page that redraws a block drops the old copy from the panel.
 */
function fitLine(row: HTMLElement, more: HTMLButtonElement, panel: HTMLElement, fixed: HTMLElement, after: () => void): void {
  const moved: { el: HTMLElement; ph: Comment; at: number }[] = [];
  let queued = false;
  let open = false;
  const items = (parent: Element, out: HTMLElement[] = []): HTMLElement[] => {
    for (const c of parent.children) {
      // the "Filtered" chip always stays in the line
      if (c === more || c === panel || c === fixed || !(c instanceof HTMLElement)) continue;
      const d = getComputedStyle(c).display;
      if (d === "none") continue;
      if (d === "contents") items(c, out);
      else if (c.offsetWidth || c.offsetHeight) out.push(c); // an empty element takes no room: it never needs the menu
    }
    return out;
  };
  /** the controls in the line, drawn or not (an empty bar is told by these, not by what has a size) */
  const present = (parent: Element, out: HTMLElement[] = []): HTMLElement[] => {
    for (const c of parent.children) {
      if (c === more || c === panel || c === fixed || !(c instanceof HTMLElement) || c.hasAttribute("hidden") || "off" in c.dataset) continue;
      if (getComputedStyle(c).display === "contents") present(c, out); else out.push(c);
    }
    return out;
  };
  const restore = (): void => {
    for (const m of moved) { if (m.ph.isConnected) m.ph.replaceWith(m.el); else m.el.remove(); }
    moved.length = 0;
  };
  const setOpen = (v: boolean): void => {
    open = v && moved.length > 0;
    panel.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    if (open) { document.addEventListener("mousedown", onDown, true); document.addEventListener("keydown", onKey, true); }
  };
  // a click inside a popup the controls opened (the filter's, a menu) does not close the panel
  const onDown = (e: Event): void => { if (!row.isConnected) { setOpen(false); return; } const t = e.target as Element; if (!panel.contains(t) && !more.contains(t) && !t.closest?.(".popup")) setOpen(false); };
  const onKey = (e: KeyboardEvent): void => { if (!row.isConnected) { setOpen(false); return; } if (e.key === "Escape" && !document.querySelector(".popup")) { setOpen(false); more.focus(); } };
  const layout = (): void => {
    // moving a control takes its focus (and the caret) away: a box being typed in gets both back
    const active = document.activeElement as HTMLElement | null;
    const keep = active && row.contains(active) ? active : null;
    const caret = keep instanceof HTMLInputElement ? [keep.selectionStart, keep.selectionEnd] as const : null;
    mo.disconnect();
    try { after(); arrange(); } finally { mo.takeRecords(); observe(); }
    if (keep && keep.isConnected && document.activeElement !== keep) {
      keep.focus({ preventScroll: true });
      if (caret && keep instanceof HTMLInputElement && caret[0] != null) { try { keep.setSelectionRange(caret[0], caret[1]); } catch { /* not a text box */ } }
    }
  };
  const arrange = (): void => {
    restore();
    more.hidden = true;
    // the order shown: People and Filter first (CSS order), so what is last in line is what goes under ⋯ first
    const ord = (e: HTMLElement): number => Number(getComputedStyle(e).order) || 0;
    const all = items(row).sort((a, b) => ord(a) - ord(b));
    if (all.length > 1) {
      // a control is on a later line when its middle sits lower than the first one's (items of different heights share a line's middle)
      const mid = (e: HTMLElement): number => e.offsetTop + e.offsetHeight / 2;
      const top = mid(all[0]);
      const wraps = (e: HTMLElement): boolean => mid(e) > top + 10;
      const over = all.filter(wraps);
      if (over.length) {
        more.hidden = false;
        const out = (e: HTMLElement): void => { const ph = document.createComment("pb"); e.replaceWith(ph); moved.push({ el: e, ph, at: all.indexOf(e) }); };
        for (const e of over) out(e);
        // the button itself must sit on the line: give up controls from the end until it does
        const left = all.filter((e) => !over.includes(e));
        while (left.length > 1 && mid(more) > top + 10) out(left.pop()!);
      }
    }
    // a bar with nothing in it (a page without controls) takes no room
    const filled = (e: Element): boolean => e.children.length > 0 || (e.textContent ?? "").trim() !== "";
    row.parentElement?.classList.toggle("pb-empty", !moved.length && !present(row).some(filled));
    moved.sort((a, b) => a.at - b.at);
    panel.replaceChildren(...moved.map((m) => m.el));
    more.hidden = !moved.length;
    more.setAttribute("aria-label", `More controls (${moved.length})`);
    more.title = `${moved.length} ${moved.length === 1 ? "control does" : "controls do"} not fit the line: open them here`;
    if (open && !moved.length) setOpen(false);
  };
  const schedule = (): void => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; if (row.isConnected) layout(); }); };
  const mo = new MutationObserver((recs) => { if (recs.some((r) => r.target !== more && !panel.contains(r.target))) schedule(); });
  const observe = (): void => mo.observe(row, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "data-off"] });
  observe();
  new ResizeObserver(schedule).observe(row);
  // web fonts change the widths once they arrive
  void document.fonts?.ready.then(schedule);
  more.addEventListener("click", () => setOpen(!open));
}

const ASK_HINT = "Ask a question about the team's work, then press Enter";

export function pageBar(app: App, opts: PageBarOpts = {}): PageBar {
  const canSearch = Boolean(opts.search);
  // without AI help the field only searches (and a page with nothing to search shows no field)
  let mode: FieldMode = AI_FEATURES ? startMode(prefs.get<unknown>(FIELD_MODE_KEY, "search"), canSearch) : "search";
  let text = "";
  let pinned = false;
  const input = h("input.input.qf-input", { type: "text", spellcheck: false }) as HTMLInputElement;
  const clearBtn = h("button.icon-btn.qf-clear", { type: "button", title: "Clear the text (Esc)", "aria-label": "Clear the text", hidden: true }, icon("close", 14));
  const sendBtn = h("button.icon-btn.qf-send", { type: "button", title: "Ask AI this question", "aria-label": "Ask AI this question" }, icon("sparkle", 15));
  const searchSide = h("button.qf-side", {
    type: "button", "aria-pressed": "false",
    title: canSearch ? "Search: show only what contains every word you type" : "Nothing to search on this page: the field asks AI",
    "aria-disabled": String(!canSearch),
  }, icon("search", 14), h("span", null, "Search"));
  const askSide = h("button.qf-side", { type: "button", "aria-pressed": "false", title: "Ask AI: press Enter to ask the AI about the team's work (needs an AI key in Settings)" },
    icon("sparkle", 14), h("span", null, "Ask AI"));

  const changed = (): void => opts.search?.onChange();
  const run = debounce(() => { if (mode === "search") { text = input.value; changed(); } }, 150);
  const pin = (on: boolean): void => {
    pinned = on;
    field.classList.toggle("pinned", on);
    clearBtn.title = on ? "Clear the search and show everything again (Esc)" : "Clear the text (Esc)";
    input.title = mode === "ask" ? ASK_HINT : on ? "Showing only what matches. Clear the text (× or Esc) to show everything again." : `${opts.search?.title ?? ""}${opts.search?.pin ? ". Enter shows only what matches" : ""}. Esc clears.`;
  };
  const set = (v: string): void => {
    input.value = v;
    if (!v.trim()) pin(false);
    paintButtons();
    const before = text;
    text = mode === "search" ? v : "";
    if (text !== before || mode === "search") changed();
  };
  function paintButtons(): void {
    clearBtn.hidden = !input.value;
    sendBtn.hidden = mode !== "ask";
  }
  function paint(): void {
    searchSide.setAttribute("aria-pressed", String(mode === "search"));
    // on a page with nothing to search the field can only ask, so that side is not shown as a choice made
    askSide.setAttribute("aria-pressed", String(mode === "ask" && canSearch));
    input.placeholder = mode === "ask" ? "Ask AI about the team's work…" : opts.search?.placeholder ?? "";
    input.title = mode === "ask" ? ASK_HINT : `${opts.search?.title ?? ""}${opts.search?.pin ? ". Enter shows only what matches" : ""}. Esc clears.`;
    input.setAttribute("aria-label", mode === "ask" ? "Question for AI" : opts.search?.label ?? opts.search?.placeholder ?? "Search");
    paintButtons();
  }
  function setMode(m: FieldMode): void {
    if (m === mode || (m === "search" && !canSearch)) return;
    mode = m;
    pin(false);
    if (canSearch) prefs.set(FIELD_MODE_KEY, m);
    paint();
    // the same text: it filters the page in Search, and filters nothing while it is a question
    const next = m === "search" ? input.value : "";
    if (next !== text) { text = next; changed(); }
    input.focus();
  }
  const ask = (): void => {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    openAskAi(app, q);
  };
  searchSide.addEventListener("click", () => setMode("search"));
  askSide.addEventListener("click", () => setMode("ask"));
  input.addEventListener("input", () => {
    paintButtons();
    // emptying the field ends a pinned search at once
    if (!input.value.trim() && pinned) { pin(false); text = ""; changed(); return; }
    run();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) { e.stopPropagation(); set(""); }
    else if (e.key === "Enter" && mode === "ask") { e.preventDefault(); ask(); }
    else if (e.key === "Enter" && mode === "search" && opts.search?.pin && input.value.trim()) {
      e.preventDefault();
      pin(true);
      text = input.value;
      changed();
    }
  });
  clearBtn.addEventListener("click", () => { set(""); input.focus(); });
  sendBtn.addEventListener("click", () => ask());
  paint();

  const field = blk("search", h("div.qf", { role: "group", "aria-label": AI_FEATURES ? "Search or ask AI" : "Search", hidden: !canSearch && !AI_FEATURES },
    h("div.qf-box", null, input, clearBtn, AI_FEATURES ? sendBtn : null),
    h("div.qf-sides", null, searchSide, AI_FEATURES ? askSide : null)));
  const line2 = h("div.pb-items");
  const end = h("div.pb-end");
  const line3 = h("div.pb-3");
  const moreBtn = h("button.btn.small.pb-more", { type: "button", hidden: true, "aria-haspopup": "true", "aria-expanded": "false" }, icon("more", 15)) as HTMLButtonElement;
  const panel = h("div.pb-more-panel", { hidden: true, role: "group", "aria-label": "More controls" });

  // ---- the "Filtered: 2 · Clear" chip: the page's filter parts tell what they filter (src/ui/filterbar.ts) ----
  const parts = (): { src: FilterSource; off: boolean }[] => [...row.querySelectorAll<HTMLElement>("[data-blk]")].flatMap((b) => {
    const src = filterSourceOf(b);
    return src ? [{ src, off: b.closest("[data-off], [hidden]") != null }] : [];
  });
  const clearAll = (): void => { for (const p of parts()) p.src.clear(); };
  const fText = h("span.pb-filtered-text");
  const filtered = h("span.chip.pb-filtered", { hidden: true },
    icon("filter", 12), fText, h("span.muted", { "aria-hidden": "true" }, "·"),
    h("button.btn.link.small", { type: "button", title: "Remove every filter and person choice of this page", onclick: clearAll }, "Clear"));
  const paintFiltered = (): void => {
    const s = filteredSummary(parts().map(({ src, off }) => ({ what: src.what, count: src.count(), says: src.says(), off })));
    // written only when it changes: the line watches its own changes
    if (filtered.hidden !== !s) filtered.hidden = !s;
    if (!s) return;
    if (fText.textContent !== s.text) fText.textContent = s.text;
    if (filtered.title !== s.title) filtered.title = s.title;
  };

  const row = h("div.pb-line.pb-2", null, field, line2, line3, filtered, end, moreBtn, panel);
  const el = h("div.page-bar", null, row);
  row.addEventListener(FILTERS_CHANGED, paintFiltered);
  // a block switched off or on (Settings, a ×) changes the "(1 hidden)"; the listener goes once the page bar left the page
  let shown = false;
  const stop = onBlocksChange(() => { if (row.isConnected) { shown = true; paintFiltered(); } else if (shown) stop(); });
  fitLine(row, moreBtn, panel, filtered, () => { shown ||= row.isConnected; paintFiltered(); });
  followPanelWidth();
  return {
    el, line2, end, line3,
    search: {
      el: field, input,
      words: () => (mode === "search" ? searchWords(text) : []),
      query: () => (mode === "search" ? text.trim().toLowerCase() : ""),
      pinned: () => mode === "search" && pinned && Boolean(text.trim()),
      set,
    },
  };
}
