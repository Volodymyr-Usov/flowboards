// What shows in the top bar and in the page bar: every block can be switched off in
// Settings > Menu & bars (yours, kept in your own storage). Everything shows by default. The Settings gear never hides.
// A block is any element marked with `blk(id, el)`; a hidden one gets `data-off` (see 10-shell.css).
// The view tabs are handled by the top bar itself (see `tabOff`): the open page's tab always stays.
import { prefs } from "../core/settings.ts";

export const BLOCKS_KEY = "blocks.off";

export interface BlockInfo { id: string; label: string; title: string; icon?: string; desc?: string }
export interface BlockGroup { name: string; blocks: BlockInfo[] }

/** The blocks with a fixed place (the view tabs are listed by the top bar: one `tab:<view id>` per view). */
export const BLOCK_GROUPS: BlockGroup[] = [
  { name: "Top bar", blocks: [
    { id: "team", label: "Team", title: "The project and team picker", icon: "people",
      desc: "The project and team picker at the very left of the top line. Hide it if you only ever work with one team." },
    { id: "style", label: "Style", title: "The team's working style (Scrum, Kanban, Scrumban)", icon: "flow",
      desc: "The team's working style: Scrum, Kanban or Scrumban. It sets which layout the Board opens with and the order of the tabs." },
    { id: "warn", label: "⚠ switch", title: "The button that switches the ⚠ marks on and off", icon: "warn",
      desc: "The button left of the colour theme that switches the ⚠ marks, and the colouring by what is missing, off and on. They are on by default." },
    { id: "theme", label: "Colour theme", title: "The light / dark / auto menu", icon: "contrast",
      desc: "The menu to choose a light, a dark or an automatic colour theme (automatic follows Azure DevOps)." },
    { id: "excel", label: "Excel", title: "Download this page as Excel", icon: "external",
      desc: "Downloads what the page shows as an Excel file: the Board's cards, or every table of the page, with the filters and sorting applied." },
    { id: "copy", label: "Copy", title: "Copy this page as a table", icon: "copy",
      desc: "Copies what the page shows as a table you can paste into Excel, an e-mail or a chat." },
    { id: "reset", label: "Reset layout", title: "The button that puts the layout back to the default", icon: "undo",
      desc: "The button next to Settings that puts your layout back to the default: bars, tabs, crosses, the Board's switches and columns. Filters, theme and the team's settings stay." },
    { id: "about", label: "About", title: "Version, author, privacy", icon: "info",
      desc: "The page with the version, the author, the code on GitHub and what happens to your data." },
  ] },
  { name: "Page bar", blocks: [
    { id: "people", label: "People", title: "The person chips (first in the bar)", icon: "people",
      desc: "The person chips at the start of the bar: click one to see only that person's work, right-click to hide it." },
    { id: "filters", label: "Filter", title: "The filter button and its chips (next)", icon: "filter",
      desc: "The Filter button and its chips: narrow the page by any property (type, state, owner, tags, sprint, dates, any field). Each page keeps its own filters." },
    { id: "layout", label: "Board / Taskboard / Story map", title: "The Board's layout switch", icon: "board",
      desc: "The Board's layout switch: columns, the sprint's taskboard, or the story map with a row per sprint." },
    { id: "search", label: "Search", title: "The search box", icon: "search",
      desc: "The search box: it filters the page as you type (on the Board it lifts matching cards; Enter shows only the matches)." },
    { id: "new", label: "New", title: "Create a work item", icon: "plus",
      desc: "Create a work item (story, bug, task…) in the team's area, with the form of this page." },
    { id: "pick", label: "Pick my next", title: "Open the story to pick up next", icon: "sparkle",
      desc: "Opens the story to pick up next, chosen among the cards the filters show." },
    { id: "colour", label: "Colouring (Colour, ⚠, with…)", title: "How cards are coloured, the mark for what is missing and the colouring rules: one setting for the three", icon: "contrast",
      desc: "The Board's Colour menu (by age, by what is missing, or both), the ⚠ choice and \"with…\" for the rules: one setting, all shown or all hidden." },
    { id: "sprint", label: "Sprint", title: "The taskboard's sprint choice", icon: "sprint",
      desc: "The sprint picker of the taskboard (the current sprint until you pick another)." },
    { id: "columns", label: "Hidden columns (story map)", title: "The note on the story map that columns are hidden", icon: "eye",
      desc: "The note on the story map that some board columns are hidden, with a button to see them." },
  ] },
];

const listeners = new Set<() => void>();

let tabBlocks: BlockInfo[] = [];
/** The top bar lists its view tabs here, so Settings can offer each one. */
export function setTabBlocks(list: BlockInfo[]): void { tabBlocks = list; }
export const getTabBlocks = (): BlockInfo[] => tabBlocks;

/** The ids switched off (none by default). */
export function blocksOff(): Set<string> {
  const v = prefs.get<unknown>(BLOCKS_KEY, []);
  const off = new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // Colour, ⚠ and "with…" used to be three blocks; they are one now: any of the old ones switched off switches the whole off
  for (const old of ["missing", "rules"]) if (off.delete(old)) off.add("colour");
  return off;
}

export const blockOff = (id: string): boolean => blocksOff().has(id);

/** Switch one block on or off; the page's bars follow at once. */
export function setBlockShown(id: string, shown: boolean): void {
  const off = blocksOff();
  if (shown) off.delete(id); else off.add(id);
  prefs.set(BLOCKS_KEY, [...off]);
  applyBlocks();
  for (const f of listeners) f();
}

/** Show everything again. */
export function resetBlocks(): void {
  prefs.set(BLOCKS_KEY, []);
  applyBlocks();
  for (const f of listeners) f();
}

/** Called after a change (the top bar redraws its tabs). Returns the way to stop. */
export function onBlocksChange(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** Mark an element as a block; it starts hidden when the choice says so. */
export function blk<T extends HTMLElement>(id: string, el: T): T {
  el.dataset.blk = id;
  if (blockOff(id)) el.dataset.off = ""; else delete el.dataset.off;
  return el;
}

/** Apply the choices to every block now on the page. */
export function applyBlocks(root: ParentNode = document): void {
  const off = blocksOff();
  for (const el of root.querySelectorAll<HTMLElement>("[data-blk]")) {
    if (off.has(el.dataset.blk!)) el.dataset.off = ""; else delete el.dataset.off;
  }
}

// ---- the tiny crosses: one on every tab and block, shown while the pointer is on it, to hide it with a click (Settings can hide the crosses) ----
export const CROSSES_KEY = "blocks.noCrosses";
export const crossesHidden = (): boolean => prefs.get<boolean>(CROSSES_KEY, false) === true;

/** Show or hide the crosses themselves (Settings). */
export function setCrossesHidden(hidden: boolean): void {
  prefs.set(CROSSES_KEY, hidden);
  document.body.classList.toggle("no-xs", hidden);
}

/**
 * The cross is drawn by CSS in the top right corner of a block (a tab: inside it); the click on that
 * corner hides the block instead of using it. Call once, at the start of the app.
 */
export function installCrosses(): void {
  document.body.classList.toggle("no-xs", crossesHidden());
  document.addEventListener("click", (e) => {
    if (crossesHidden() || !(e.target instanceof Element)) return;
    const el = e.target.closest<HTMLElement>("[data-blk], .tab");
    if (!el || el.matches(".tab.active")) return;
    const r = el.getBoundingClientRect();
    const tab = el.classList.contains("tab");
    // the zone of the drawn cross: inside the corner of a tab, centred on the corner of other blocks
    const hit = tab
      ? e.clientX >= r.right - 15 && e.clientX <= r.right - 1 && e.clientY >= r.top && e.clientY <= r.top + 14
      : Math.abs(e.clientX - r.right) <= 7 && Math.abs(e.clientY - r.top) <= 7;
    if (!hit) return;
    const id = tab ? `tab:${el.dataset.view}` : el.dataset.blk!;
    e.preventDefault();
    e.stopImmediatePropagation();
    setBlockShown(id, false);
  }, true);
}

/** Is this view's tab switched off? (The open page's tab stays whatever the choice.) */
export const tabOff = (viewId: string): boolean => blockOff(`tab:${viewId}`);
