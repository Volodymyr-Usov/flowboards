// Backlog: Epics, Features, stories and tasks as a tree with progress; drag to re-parent or reorder.
// Works with any process: the levels come from ws.process.levels. Rows are built once per update
// (lazily, when first shown) and kept; expanding, collapsing and filtering only swap which rows show.
// A priority score column (weighted shortest job first) shows when the process has the fields for it;
// its title sorts the rows by the score.
// Keyboard: a tree grid with one row in the Tab order; arrows move and open, Alt+arrows reorder,
// Enter opens, Space picks, the menu key (or Shift+F10) opens the row menu. Ctrl/Shift+click pick rows.
import type { Level, WorkItem } from "../api/types.ts";
import type { View, ViewHandle } from "../app/context.ts";
import { textMatch } from "../core/filters.ts";
import { firstStateIn } from "../core/health.ts";
import { isClosed, isDone, leaf } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import type { WriteResult, Writer } from "../core/writes.ts";
import { wsjfScore, wsjfSetup } from "../core/wsjf.ts";
import type { WsjfScore } from "../core/wsjf.ts";
import { createItem, sprintChoices } from "../ui/create.ts";
import { debounce, h, icon } from "../ui/dom.ts";
import { filterBar, peopleStrip, processFieldNames } from "../ui/filterbar.ts";
import { pageBar } from "../ui/pagebar.ts";
import { avatar, empty, help, itemPicker, menu, select, stateMark, toast, toggle, typeMark } from "../ui/kit.ts";
import type { MenuItem } from "../ui/kit.ts";
import { tagChip } from "../ui/tagchip.ts";

interface TNode {
  /** work item id; group rows ("no parent") have negative ids */
  id: number;
  item?: WorkItem;
  level: Level;
  depth: number;
  kids: TNode[];
  parent?: TNode;
  /** label of a group row */
  group?: string;
  effort?: number;
  /** effort is the sum of the children's */
  rolled?: boolean;
  done: number;
  total: number;
}

type DropMode = "into" | "before" | "after";
interface Drop { target: TNode; mode: DropMode }

const INDENT = 18;
const PREF_OPEN = "tree.open"; // per team: PREF_OPEN:<project>/<team>
const PREF_CLOSED = "tree.showClosed";
const PREF_DEPTH = "tree.depth";
/** one level only, as a flat list without the hierarchy (its rank), or null for the tree */
const PREF_ONLY = "tree.only";
const PREF_FILTERS = "tree.filters";
const PREF_PEOPLE = "tree.people";
const PREF_SORT = "tree.sort";
const PREF_SORT_OLD = "tree.sortScore"; // the earlier choice: the priority score on or off

type SortKey = "title" | "state" | "owner" | "sprint" | "effort" | "score" | "progress" | "tags";
/** A column the backlog is sorted by, and the way: 1 up, -1 down. */
interface SortBy { key: SortKey; dir: 1 | -1 }

// ---------- pure parts (tested) ----------

/**
 * Moves that put items at the top or the bottom of their level, keeping their order among themselves:
 * [id, previousId, nextId] for each, done in turn (0 = start or end). `order` is the level in backlog
 * order; `ids` the items to move, in the order they should end up.
 */
export function endMoves(order: number[], ids: number[], where: "top" | "bottom"): [number, number, number][] {
  const moving = new Set(ids);
  const rest = order.filter((id) => !moving.has(id));
  const out: [number, number, number][] = [];
  ids.forEach((id, i) => {
    const prev = i ? ids[i - 1] : where === "top" ? 0 : rest[rest.length - 1] ?? 0;
    const next = where === "top" ? rest[0] ?? 0 : 0;
    out.push([id, prev, next]);
  });
  return out;
}

/**
 * One step up (-1) or down (1) past the neighbour that shows: [previousId, nextId] around the new place,
 * taken from all the siblings (hidden ones too, so the pair is side by side). Null at either end.
 */
export function stepPlace(all: number[], shown: number[], id: number, dir: -1 | 1): [number, number] | null {
  const j = shown.indexOf(id);
  const other = j < 0 ? undefined : shown[j + dir];
  if (other == null) return null;
  const rest = all.filter((x) => x !== id);
  const k = rest.indexOf(other);
  if (k < 0) return null;
  return dir < 0 ? [rest[k - 1] ?? 0, other] : [other, rest[k + 1] ?? 0];
}

/**
 * The items a "move to sprint" writes: each picked item not there yet, and the open tasks of a picked
 * story (`tasks`: its open tasks). Each id once, also when a story and its task are both picked;
 * `tasks` counts only those that came along.
 */
export function sprintMoveIds(list: { id: number; iteration: string; story: boolean; tasks: { id: number; iteration: string }[] }[], path: string): { ids: number[]; tasks: number } {
  const ids: number[] = [];
  const seen = new Set<number>();
  const picked = new Set(list.map((k) => k.id));
  const add = (id: number): boolean => { if (seen.has(id)) return false; seen.add(id); ids.push(id); return true; };
  let tasks = 0;
  for (const k of list) {
    if (k.iteration !== path) add(k.id);
    if (!k.story) continue;
    for (const t of k.tasks) if (t.iteration !== path && !picked.has(t.id) && add(t.id)) tasks++;
  }
  return { ids, tasks };
}

/** The ids from one row to another, both included, in the order shown. */
export function rangeOf(shown: number[], a: number, b: number): number[] {
  const i = shown.indexOf(a);
  const j = shown.indexOf(b);
  if (i < 0 || j < 0) return j < 0 ? [] : [b];
  return shown.slice(Math.min(i, j), Math.max(i, j) + 1);
}

export const treeView: View = {
  id: "tree",
  title: "Backlog",
  icon: "tree",
  group: "plan",
  about: "Epics, Features, stories and tasks as a tree with progress. Drag a row onto a row one level up to move it there, or between rows to change the order; the … on a row (or a right-click) has more. Ctrl or Shift+click picks several rows.",
  mount(el, app): ViewHandle {
    const ws = app.ws;
    const levels = [...ws.process.levels].sort((a, b) => a.rank - b.rank);
    const taskRank = ws.taskLevel()?.rank ?? Infinity;

    // ---- screen choices ----
    const openKey = `${PREF_OPEN}:${ws.project}/${ws.team}`;
    const savedOpen = prefs.get<number[] | null>(openKey, null);
    const open = new Set<number>(savedOpen ?? []);
    /** while searching or filtering every row opens; these were closed by hand since the search changed */
    const shut = new Set<number>();
    let firstDraw = savedOpen == null;
    let showClosed = prefs.get(PREF_CLOSED, false);
    let maxRank = Math.min(prefs.get(PREF_DEPTH, levels[levels.length - 1]?.rank ?? 0), levels[levels.length - 1]?.rank ?? 0);
    let onlyRank: number | null = prefs.get<number | null>(PREF_ONLY, null);
    if (onlyRank != null && !levels.some((l) => l.rank === onlyRank)) onlyRank = null;
    /** a row's level is shown: up to the depth in the tree, or exactly the one level in a list */
    const levelShown = (rank: number): boolean => (onlyRank != null ? rank === onlyRank : rank <= maxRank);
    /** the row of the open item (details panel) */
    let selected: number | null = app.openId();
    /** more rows picked with Ctrl/Shift+click or Space: the row menu acts on all of them */
    const picked = new Set<number>();
    /** where a Shift+click range starts */
    let anchorId: number | null = selected;
    /** the row in the Tab order (roving tabindex) */
    let focusId: number | null = selected;
    /** an item just created here: show it once it arrives */
    let reveal: number | null = null;
    // priority score: only when some type of the process has the fields for it
    const wsjf = wsjfSetup(ws.process);
    const hasScore = wsjf.types.size > 0;
    // the column the rows are sorted by (within each parent); none = the backlog order
    let sortBy: SortBy | null = prefs.get<SortBy | null>(PREF_SORT, null) ?? (hasScore && prefs.get<boolean>(PREF_SORT_OLD, false) ? { key: "score", dir: -1 } : null);
    if (sortBy?.key === "score" && !hasScore) sortBy = null;
    let scores = new Map<number, WsjfScore>();
    const cols = hasScore ? 8 : 7;
    const saveOpen = debounce(() => prefs.set(openKey, [...open]), 300);
    const changedFilter = (): void => { shut.clear(); render(); };

    // ---- page ----
    const bar = pageBar(app, { search: {
      placeholder: "Search title, tag, owner, id…", label: "Search the backlog", title: "Show only the items that contain every word, with their parents",
      onChange: changedFilter,
    } });
    const words = (): string[] => bar.search.words();
    // ---- filters: person chips and filters on any property (shared with the other pages) ----
    const fb = filterBar({ key: PREF_FILTERS, items: () => ws.items.values(), names: () => processFieldNames(ws.process), onChange: changedFilter });
    // people of the rows the tree can show: the levels shown, closed ones only with "Show closed", passing the filters
    const people = peopleStrip({
      api: ws.api, key: PREF_PEOPLE, onChange: changedFilter,
      items: () => [...ws.items.values()].filter((w) => levelShown(ws.levelOf(w)?.rank ?? Infinity) && (showClosed || !isClosed(w)) && fb.test(w)),
    });
    const filtering = (): boolean => words().length > 0 || fb.active() || people.active();

    // the tree down to a level, or one level alone as a flat list (no hierarchy)
    const depthSel = select([
      ...levels.map((l) => ({ value: `tree:${l.rank}`, label: `Tree down to ${l.name}` })),
      ...levels.map((l) => ({ value: `only:${l.rank}`, label: `Only ${l.name} (list)` })),
    ], onlyRank != null ? `only:${onlyRank}` : `tree:${maxRank}`, (v) => setLevels(v), { title: "The tree down to a level, or one level alone as a flat list without parents", "aria-label": "Levels shown" });
    function setLevels(v: string): void {
      const [kind, rank] = v.split(":");
      if (kind === "only") { onlyRank = Number(rank); prefs.set(PREF_ONLY, onlyRank); }
      else { onlyRank = null; prefs.set(PREF_ONLY, null); maxRank = Number(rank); prefs.set(PREF_DEPTH, maxRank); }
      depthSel.value = v;
      paintSort();
      render();
    }
    const top = levels[0];
    const scoreHelp = hasScore
      ? help(`Priority score, "weighted shortest job first": (${[...new Set([...wsjf.types.values()].flatMap((t) => t.value.map((v) => v.label.toLowerCase())))].join(" + ")}) / size, from each item's own fields. Click the column title to sort by it, highest first, within each parent; click again to reverse, a third time for the backlog order. "–" means a number is missing (point at it to see which).`)
      : help("No priority score column: this process has no business value, time criticality or risk reduction field together with a size or effort field on its backlog types.");
    bar.line2.append(fb.el,
      h("button.btn.small", { title: "Open every row", onclick: () => expandAll(true) }, "Expand all"),
      h("button.btn.small", { title: "Close every row", onclick: () => expandAll(false) }, "Collapse all"));
    if (top && !app.actions.readOnly) bar.line2.append(h("button.btn.small", { title: `Create a new ${top.defaultType}`, onclick: () => void addChild(null) }, icon("plus", 14), `New ${top.defaultType}`));
    bar.line3.append(people.el, depthSel,
      toggle("Show closed", showClosed, (v) => { showClosed = v; prefs.set(PREF_CLOSED, v); render(); }, "Also show items that are closed"),
      scoreHelp);
    // status at the right end of line 2: the rows picked, read-only or sorted, and how many rows show
    const pickedNote = h("span.tree-picked", { hidden: true });
    const count = h("span");
    const hint = h("span.tree-hint");
    bar.end.append(pickedNote, hint, count);
    const tbody = h("tbody");
    // every column title sorts: click for ascending (numbers: highest first), again to reverse, again for the backlog order
    const HEADS: { key: SortKey; label: string; tip?: string; num?: boolean }[] = [
      { key: "title", label: "Title" }, { key: "state", label: "State" }, { key: "owner", label: "Owner" }, { key: "sprint", label: "Sprint" },
      { key: "effort", label: "Effort", num: true, tip: "Effort; for a parent, the sum of its children's" },
      ...(hasScore ? [{ key: "score" as const, label: "Priority score", num: true }] : []),
      { key: "progress", label: "Progress", tip: "Children done out of all children" }, { key: "tags", label: "Tags" },
    ];
    const heads = new Map<SortKey, { th: HTMLElement; btn: HTMLElement }>();
    const setSort = (s: SortBy | null): void => { sortBy = s; prefs.set(PREF_SORT, sortBy); paintSort(); refresh(); };
    const clickSort = (key: SortKey, num: boolean): void => {
      if (!sortBy || sortBy.key !== key) setSort({ key, dir: num ? -1 : 1 });
      else setSort(sortBy.dir === (num ? -1 : 1) ? { key, dir: (num ? 1 : -1) as 1 | -1 } : null);
    };
    const paintSort = (): void => {
      for (const hd of HEADS) {
        const { th, btn } = heads.get(hd.key)!;
        const on = sortBy?.key === hd.key;
        btn.replaceChildren(hd.label, on ? icon(sortBy!.dir === 1 ? "up" : "down", 12) : "");
        btn.title = `${on ? (sortBy!.dir === 1 ? "Sorted ascending" : "Sorted descending") : "Sort by " + hd.label.toLowerCase()}. ${on ? "Click to change; the third click returns to the backlog order." : (hd.tip ?? "Within each parent")}`;
        th.setAttribute("aria-sort", on ? (sortBy!.dir === 1 ? "ascending" : "descending") : "none");
        th.classList.toggle("sorted", on);
      }
      // where dragging cannot work, say why and offer the way back
      const fix = (label: string, title: string, run: () => void): HTMLElement => h("button.btn.link.small", { type: "button", title, onclick: run }, label);
      hint.replaceChildren(...(app.actions.readOnly ? ["Read-only. "]
        : onlyRank != null ? ["A list: dragging is off. ", fix("Show the tree", "Show the tree again, so rows can be dragged", () => setLevels(`tree:${maxRank}`)), " "]
          : sortBy ? ["Sorted: dragging is off. ", fix("Backlog order", "Sort in the backlog order again, so rows can be dragged", () => setSort(null)), " "]
            : []));
    };
    const headCells = HEADS.map((hd) => {
      const btn = h("button.tree-sort", { type: "button", onclick: () => clickSort(hd.key, Boolean(hd.num)) });
      const th = h(`th.tree-sh${hd.num || hd.key === "score" ? ".num" : ""}`, { "aria-sort": "none", role: "columnheader" }, btn);
      heads.set(hd.key, { th, btn });
      return th;
    });
    const table = h("table.tree-table", { role: "treegrid", "aria-label": "Backlog", "aria-multiselectable": "true" },
      h("colgroup", null, h("col.tree-w-title"), h("col.tree-w-state"), h("col.tree-w-owner"), h("col.tree-w-sprint"), h("col.tree-w-effort"), hasScore ? h("col.tree-w-score") : null, h("col.tree-w-progress"), h("col.tree-w-tags")),
      h("thead", null, h("tr", { role: "row" }, headCells)),
      tbody);
    const indicator = h("div.tree-drop-line", { hidden: true });
    const wrap = h("div.tree-wrap", null, table, indicator);
    const none = h("div", { hidden: true });
    el.append(bar.el, wrap, none);

    // ---- the tree, rebuilt on every update ----
    let roots: TNode[] = [];
    let nodes = new Map<number, TNode>();
    let rows = new Map<number, HTMLTableRowElement>();
    let flat: TNode[] = [];
    let shown = new Set<number>();

    function build(): void {
      nodes = new Map();
      rows = new Map();
      scores = new Map();
      if (hasScore) for (const it of ws.items.values()) scores.set(it.id, wsjfScore(it, wsjf));
      const byId = new Map<number, TNode>();
      for (const it of ws.items.values()) {
        const level = ws.levelOf(it);
        if (!level) continue;
        byId.set(it.id, { id: it.id, item: it, level, depth: 0, kids: [], done: 0, total: 0 });
      }
      roots = [];
      const groups = new Map<number, TNode>();
      for (const n of byId.values()) {
        const p = byId.get(n.item!.parent ?? 0);
        if (p && p.level.rank < n.level.rank) { n.parent = p; p.kids.push(n); continue; }
        if (n.level.rank === levels[0].rank) { roots.push(n); continue; }
        let g = groups.get(n.level.rank);
        if (!g) {
          g = { id: -1 - n.level.rank, level: n.level, depth: 0, kids: [], group: `${n.level.name} with no parent`, done: 0, total: 0 };
          groups.set(n.level.rank, g);
        }
        n.parent = g;
        g.kids.push(n);
      }
      const groupNodes = [...groups.values()].sort((a, b) => a.level.rank - b.level.rank);
      // each parent sorts its children once their numbers (effort, progress) are known
      const walk = (n: TNode, depth: number): void => {
        n.depth = depth;
        nodes.set(n.id, n);
        for (const k of n.kids) walk(k, depth + 1);
        if (n.item) {
          // effort: own value, or the sum of the children's (tasks carry hours, not effort)
          const effKids = n.kids.filter((k) => k.level.rank < taskRank);
          if (effKids.length) { n.effort = effKids.reduce((a, k) => a + (k.effort ?? 0), 0); n.rolled = true; }
          else n.effort = n.level.rank < taskRank ? n.item.effort : undefined;
          // progress: requirement-level descendants for portfolio items, tasks for stories
          if (n.level.kind === "portfolio") {
            const stack = [...n.kids];
            while (stack.length) {
              const k = stack.pop()!;
              if (k.level.kind === "requirement") { n.total++; if (isDone(k.item!)) n.done++; } else if (k.level.kind === "portfolio") stack.push(...k.kids);
            }
          } else if (n.level.kind === "requirement") {
            for (const k of n.kids) { n.total++; if (isDone(k.item!)) n.done++; }
          }
        }
        n.kids.sort(cmp);
      };
      for (const r of [...roots, ...groupNodes]) walk(r, 0);
      roots.sort(cmp);
      roots.push(...groupNodes);
      if (firstDraw) {
        // first visit: portfolio levels open, stories closed
        for (const n of nodes.values()) if (n.level.kind === "portfolio" || n.group) open.add(n.id);
        firstDraw = false;
        saveOpen();
      }
      for (const id of [...picked]) if (!nodes.get(id)?.item) picked.delete(id);
    }

    /** What a column sorts by; undefined when the row has nothing there (those go last, whichever way). */
    function sortValue(n: TNode, key: SortKey): number | string | undefined {
      const it = n.item!;
      switch (key) {
        case "title": return it.title.toLowerCase();
        case "state": return it.state.toLowerCase();
        case "owner": return it.assignedTo?.displayName.toLowerCase() || undefined;
        case "sprint": return it.iteration ? leaf(it.iteration).toLowerCase() : undefined;
        case "effort": return n.effort;
        case "score": return scores.get(it.id)?.score ?? undefined;
        case "progress": return n.total ? n.done / n.total : undefined;
        case "tags": return it.tags.length ? it.tags.join("; ").toLowerCase() : undefined;
      }
    }
    function cmp(a: TNode, b: TNode): number {
      // by the chosen column first, then the backlog order
      if (sortBy && a.item && b.item) {
        const x = sortValue(a, sortBy.key);
        const y = sortValue(b, sortBy.key);
        if (x == null !== (y == null)) return x == null ? 1 : -1;
        if (x != null && y != null && x !== y) return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sortBy.dir;
      }
      const x = a.item?.order ?? Number.MAX_SAFE_INTEGER;
      const y = b.item?.order ?? Number.MAX_SAFE_INTEGER;
      return x - y || a.id - b.id;
    }

    // ---- filtering and flattening ----
    // the same search as the Sprint, Roadmap and Calendar: every word in the title, tags, owner, id, state…
    const matches = (it: WorkItem): boolean => fb.test(it) && people.test(it) && textMatch(words(), it);
    const isOpenRow = (n: TNode, filter: boolean): boolean => (filter ? !shut.has(n.id) : open.has(n.id));

    function render(): void {
      const filter = filtering();
      people.refresh();
      if (onlyRank != null) { renderList(filter); return; }
      const visible = new Map<number, boolean>();
      const hits = new Set<number>();
      const vis = (n: TNode): boolean => {
        if (n.level.rank > maxRank) { visible.set(n.id, false); return false; }
        let any = false;
        for (const k of n.kids) if (vis(k)) any = true;
        let self = false;
        if (n.item && (showClosed || !isClosed(n.item)) && matches(n.item)) { self = true; if (filter) hits.add(n.id); }
        const v = self || any;
        visible.set(n.id, v);
        return v;
      };
      for (const r of roots) vis(r);
      const list: TNode[] = [];
      const add = (n: TNode): void => {
        if (!visible.get(n.id)) return;
        list.push(n);
        const row = rowOf(n);
        row.classList.remove("flat");
        row.querySelector(".tree-parent")?.remove();
        const hasKids = n.kids.some((k) => visible.get(k.id));
        const isOpen = hasKids && isOpenRow(n, filter);
        row.classList.toggle("has-kids", hasKids);
        row.classList.toggle("open", isOpen);
        row.classList.toggle("ctx", filter && !hits.has(n.id) && !n.group);
        row.classList.toggle("closed", !!n.item && isClosed(n.item));
        row.setAttribute("aria-level", String(n.depth + 1));
        if (hasKids) row.setAttribute("aria-expanded", String(isOpen)); else row.removeAttribute("aria-expanded");
        row.querySelector(".tree-chev")?.setAttribute("aria-expanded", String(isOpen));
        if (isOpen) for (const k of n.kids) add(k);
      };
      for (const r of roots) add(r);
      show(list, filter && hits.size <= PAGE);
      const items = list.filter((n) => n.item).length;
      const drawn = flat.filter((n) => n.item).length;
      count.textContent = filter ? `${hits.size} found.` : drawn < items ? `${drawn} of ${items} rows shown.` : `${items} rows shown.`;
      const nothing = !list.length;
      wrap.hidden = nothing;
      none.hidden = !nothing;
      if (nothing) none.replaceChildren(ws.items.size
        ? empty("Nothing matches", "Change the search, the filters or the levels, or show closed items.", { label: "Clear the search and filters", onClick: clearFilters })
        : empty("No work yet", "This team has no Epics, Features or stories in its area yet."));
    }

    /** rows drawn at first, and added by each "Show more"; a search that finds fewer than this many items shows all of them */
    const PAGE = 150;
    let limit = PAGE;
    let limitFor = "";
    /**
     * Put the rows in the table (the first `limit`, with "Show more" under them, unless `everything`); the keyboard's row keeps its focus
     * across the swap.
     */
    function show(all: TNode[], everything = false): void {
      const hadFocus = tbody.contains(document.activeElement) && document.activeElement?.matches("tr.tree-row");
      // another search, filter, level or sort starts from the first rows again
      const sig = JSON.stringify([words(), fb.active(), people.active(), onlyRank, maxRank, showClosed, sortBy?.key, sortBy?.dir]);
      if (sig !== limitFor) { limitFor = sig; limit = PAGE; }
      const list = everything || all.length <= limit ? all : all.slice(0, limit);
      const left = all.length - list.length;
      flat = list;
      shown = new Set(list.map((n) => n.id));
      tbody.replaceChildren(...list.map((n) => rowOf(n)), ...(left > 0 ? [h("tr.tree-more", null, h("td", { colspan: cols },
        h("button.btn.small", { type: "button", title: `Show ${Math.min(PAGE, left)} more rows`, onclick: () => { limit += PAGE; refresh(); } }, `Show ${Math.min(PAGE, left)} more`),
        h("span.small.muted", null, ` ${list.length} of ${all.length} rows shown`)))] : []));
      if (focusId == null || !shown.has(focusId)) focusId = list[0]?.id ?? null;
      for (const n of list) rowOf(n).tabIndex = n.id === focusId ? 0 : -1;
      if (hadFocus && focusId != null) rows.get(focusId)?.focus({ preventScroll: true });
      paintPicked();
    }

    function clearFilters(): void {
      bar.search.set("");
      fb.clear();
      people.clear();
    }

    function expandAll(on: boolean): void {
      if (filtering()) {
        // while searching, open and close only for this search
        if (on) shut.clear(); else for (const n of nodes.values()) if (n.kids.length) shut.add(n.id);
        render();
        return;
      }
      if (on) for (const n of nodes.values()) { if (n.kids.length && n.level.rank < maxRank) open.add(n.id); }
      else open.clear();
      saveOpen();
      render();
    }

    function toggleOpen(id: number): void {
      if (filtering()) { if (shut.has(id)) shut.delete(id); else shut.add(id); render(); return; }
      if (open.has(id)) open.delete(id); else open.add(id);
      saveOpen();
      render();
    }

    // ---- rows ----
    /** One level alone, as a flat list: no parents, no indent; sorted by the chosen column, else in backlog order. */
    function renderList(filter: boolean): void {
      const list = [...nodes.values()].filter((n) => n.item && n.level.rank === onlyRank && (showClosed || !isClosed(n.item)) && matches(n.item)).sort(cmp);
      for (const n of list) {
        const row = rowOf(n);
        row.classList.remove("has-kids", "open", "ctx");
        row.classList.toggle("closed", isClosed(n.item!));
        row.classList.add("flat");
        row.setAttribute("aria-level", "1");
        row.removeAttribute("aria-expanded");
        // without the tree, the parent shows next to the title
        const cell = row.querySelector(".tree-cell");
        const p = n.item!.parent ? ws.get(n.item!.parent) : undefined;
        if (cell && p && !cell.querySelector(".tree-parent")) cell.querySelector(".tree-t")?.after(h("span.tree-parent.small.muted", { title: `Under ${p.type} #${p.id}: ${p.title}` }, `· ${p.title}`));
      }
      show(list, filter && list.length <= PAGE);
      const level = levels.find((l) => l.rank === onlyRank);
      count.textContent = `${list.length} ${level?.name.toLowerCase() ?? "items"}${filter ? " found" : ""}.`;
      const nothing = !list.length;
      wrap.hidden = nothing;
      none.hidden = !nothing;
      if (nothing) none.replaceChildren(empty("Nothing to list", `No ${level?.name.toLowerCase() ?? "items"} match. Change the search or the filters, or show closed items.`));
    }

    function rowOf(n: TNode): HTMLTableRowElement {
      let row = rows.get(n.id);
      if (!row) {
        row = makeRow(n);
        rows.set(n.id, row);
        if (n.id === selected) row.classList.add("selected");
      }
      return row;
    }

    function makeRow(n: TNode): HTMLTableRowElement {
      const chev = h("button.tree-chev", { title: "Open or close (→ ←)", "aria-label": "Open or close", "aria-expanded": "false", tabindex: -1 }, icon("chevron", 14));
      let row: HTMLTableRowElement;
      if (!n.item) {
        row = h("tr.tree-row.tree-group", { dataset: { id: n.id }, "data-xl-skip": "", role: "row", tabindex: -1, "aria-label": n.group },
          h("td", { colspan: cols }, h("div.tree-cell", { style: { "--d": n.depth } }, chev, h("span.tree-group-label", null, n.group), h("span.muted.small", null, ` ${n.kids.length}`))));
      } else {
        const it = n.item;
        const child = levels.find((l) => l.rank === n.level.rank + 1);
        const canAdd = child && n.level.kind !== "task" && !app.actions.readOnly;
        const effort = n.level.rank >= taskRank
          ? (it.remaining != null ? h("span.muted", { title: "Remaining hours" }, `${it.remaining} h`) : null)
          : n.effort != null && (n.effort || !n.rolled)
            ? h("span", { class: n.rolled ? "tree-rolled" : "", title: n.rolled ? `Sum of the children's effort${it.effort != null ? ` (own value: ${it.effort})` : ""}` : "Effort" }, fmtNum(n.effort))
            : null;
        const pct = n.total ? Math.round((n.done / n.total) * 100) : 0;
        const progress = n.total
          ? h("div.tree-prog", { title: `${n.done} of ${n.total} ${n.level.kind === "portfolio" ? ws.requirementLevel().name.toLowerCase() : "tasks"} done` },
            h("div.tree-bar", null, h("i", { style: { width: pct + "%" } })), h("span.small.muted", null, `${n.done}/${n.total}`))
          : null;
        row = h("tr.tree-row", { dataset: { id: it.id }, class: `tree-k-${n.level.kind}`, role: "row", tabindex: -1, "aria-label": `${it.type} ${it.id}: ${it.title}` },
          h("td.tree-c-title", null, h("div.tree-cell", { style: { "--d": n.depth } },
            chev,
            typeMark(ws, it.type),
            h("span.mono.muted.tree-id", null, it.id),
            h("span.tree-t", { title: it.title }, it.title),
            canAdd ? h("button.tree-add", { title: `Add a ${child.defaultType} under this ${it.type}`, "aria-label": `Add a ${child.defaultType}`, tabindex: -1 }, icon("plus", 14)) : null,
            h("button.tree-more", { type: "button", title: "More: open, move, change parent… (menu key or Shift+F10)", "aria-label": "More", tabindex: -1 }, icon("more", 14)))),
          h("td", null, stateMark(ws, it)),
          h("td", null, h("span.tree-owner", { title: it.assignedTo?.displayName ?? "Nobody" }, avatar(ws.api, it.assignedTo, 20), h("span", null, it.assignedTo?.displayName ?? ""))),
          h("td.tree-sprint", { title: it.iteration }, leaf(it.iteration)),
          h("td.num", null, effort),
          hasScore ? scoreCell(it) : null,
          h("td", null, progress),
          h("td.tree-tags", { title: it.tags.join("; ") }, it.tags.map((t) => tagChip(t))));
      }
      for (const td of row.cells) td.setAttribute("role", "gridcell");
      return row;
    }

    function scoreCell(it: WorkItem): HTMLElement {
      const sc = scores.get(it.id);
      if (!sc?.applies) return h("td.num.tree-score", { title: `${it.type} has no fields for a priority score` });
      if (sc.score == null) return h("td.num.tree-score.missing", { title: `No priority score: ${sc.missing.join(", ")} ${sc.missing.length === 1 ? "is" : "are"} missing.\n${sc.how}` }, "–");
      return h("td.num.tree-score", { title: `Priority score ${fmtNum(sc.score)} = ${sc.how}` }, fmtNum(sc.score));
    }

    async function addChild(n: TNode | null): Promise<void> {
      const level = n ? levels.find((l) => l.rank === n.level.rank + 1) : levels[0];
      if (!level || app.actions.readOnly) return;
      const types = [level.defaultType, ...level.types.filter((t) => t !== level.defaultType)];
      const created = await createItem(app, { types, parentId: n?.item?.id, iteration: n && level.kind === "task" ? n.item?.iteration : undefined });
      if (!created) return;
      if (n) { open.add(n.id); saveOpen(); }
      reveal = created.id;
      showNew();
    }

    /** Show the item just created: open its parents, select its row and scroll to it (a new Epic lands far down). */
    function showNew(): void {
      const id = reveal;
      const n = id != null ? nodes.get(id) : undefined;
      if (id == null || !n) return; // not read yet: the next update shows it
      reveal = null;
      for (let p = n.parent; p; p = p.parent) { open.add(p.id); shut.delete(p.id); }
      saveOpen();
      picked.clear();
      focusId = id;
      anchorId = id;
      select_(id);
      render();
      const row = rows.get(id);
      if (!row?.isConnected) {
        toast(`#${id} is not shown here: the search, the filters or the levels hide it.`, { action: { label: "Show it", run: () => {
          clearFilters();
          if (onlyRank != null ? n.level.rank !== onlyRank : n.level.rank > maxRank) setLevels(`tree:${Math.max(maxRank, n.level.rank)}`);
          if (n.item && isClosed(n.item) && !showClosed) { showClosed = true; prefs.set(PREF_CLOSED, true); }
          reveal = id;
          showNew();
        } } });
        return;
      }
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
      row.classList.remove("flash");
      void row.offsetWidth;
      row.classList.add("flash");
    }

    // ---- selection: Ctrl/Cmd+click and Space pick rows, Shift+click a range; Esc lets go ----
    function paintPicked(): void {
      for (const [id, row] of rows) {
        const on = picked.has(id);
        row.classList.toggle("picked", on);
        if (row.isConnected && id > 0) row.setAttribute("aria-selected", String(on || id === selected));
      }
      pickedNote.hidden = picked.size === 0;
      if (picked.size) {
        pickedNote.replaceChildren(`${picked.size} selected `,
          h("button.btn.link.small", { type: "button", title: "What to do with the selected rows", onclick: (e: Event) => { const first = flat.find((n) => picked.has(n.id)) ?? nodes.get([...picked][0]); if (first) rowMenu(first, e.currentTarget as Element); } }, "Actions…"),
          " ",
          h("button.btn.link.small", { type: "button", title: "Let go of the selected rows (Esc)", onclick: () => clearPicked() }, "Clear"),
          " ");
      }
    }
    function clearPicked(): void { if (!picked.size) return; picked.clear(); paintPicked(); }
    function togglePick(n: TNode): void {
      if (!n.item) return;
      if (picked.has(n.id)) picked.delete(n.id); else picked.add(n.id);
      anchorId = n.id;
      paintPicked();
    }
    function pickRange(to: TNode): void {
      const from = anchorId ?? selected ?? to.id;
      picked.clear();
      for (const id of rangeOf(flat.map((n) => n.id), from, to.id)) if (nodes.get(id)?.item) picked.add(id);
      paintPicked();
    }
    /** The rows a menu acts on: the picked ones when the row is one of them, else the row alone. */
    const targetsOf = (n: TNode): TNode[] => (picked.has(n.id) && picked.size > 1 ? flat.filter((k) => picked.has(k.id)) : [n]).filter((k) => !!k.item);

    function focusRow(n: TNode, scroll = true): void {
      const old = focusId != null ? rows.get(focusId) : undefined;
      if (old) old.tabIndex = -1;
      focusId = n.id;
      const row = rowOf(n);
      row.tabIndex = 0;
      row.focus({ preventScroll: true });
      if (scroll) row.scrollIntoView({ block: "nearest" });
    }

    // ---- the row menu ----
    const lbl = (w: WorkItem): string => `#${w.id} ${w.title.length > 50 ? w.title.slice(0, 48) + "…" : w.title}`;
    const many = (list: TNode[]): string => (list.length === 1 ? lbl(list[0].item!) : `${list.length} items`);
    const ro = (): boolean => app.actions.readOnly;
    const batch = (message: string, steps: { label: string; run: (w: Writer) => Promise<WriteResult> }[]): void => {
      backToRow();
      if (steps.length) void app.actions.batch(message, steps).then(() => clearPicked());
    };
    /** After a menu or a picker closes, the keyboard goes on from the row (unless another popup or dialog opened). */
    const backToRow = (): void => {
      setTimeout(() => {
        if (document.querySelector(".popup, .backdrop") || (document.activeElement && document.activeElement !== document.body)) return;
        if (focusId != null) rows.get(focusId)?.focus({ preventScroll: true });
      });
    };

    function rowMenu(n: TNode, anchor: Element): void {
      if (!n.item) return;
      const list = targetsOf(n);
      const one = list.length === 1;
      const child = levels.find((l) => l.rank === n.level.rank + 1);
      const sameLevel = list.every((k) => k.level.rank === list[0].level.rank);
      const up = levels.find((l) => l.rank === list[0].level.rank - 1);
      const items: (MenuItem | "-")[] = [];
      if (one) items.push({ label: "Open", icon: "external", onClick: () => app.openItem(n.id) });
      if (one && child && n.level.kind !== "task") items.push({ label: `Add ${child.defaultType}`, icon: "plus", disabled: ro(), onClick: () => void addChild(n) });
      if (!one) items.push({ label: `${list.length} items selected`, disabled: true, onClick: () => undefined });
      items.push("-",
        { label: "Move to top", icon: "up", disabled: ro(), hint: "First in the backlog order of its level", onClick: () => moveToEnd(list, "top") },
        { label: "Move to bottom", icon: "down", disabled: ro(), hint: "Last in the backlog order of its level", onClick: () => moveToEnd(list, "bottom") },
        { label: "Move to sprint…", icon: "sprint", disabled: ro(), onClick: () => sprintMenu(list, anchor) },
        { label: "Change parent…", icon: "tree", disabled: ro() || !sameLevel || !up, hint: !up ? `${list[0].level.name} is the top level` : !sameLevel ? "Pick rows of one level to change their parent" : undefined, onClick: () => pickParent(list, anchor, up!) });
      const closable = list.filter((k) => !isClosed(k.item!) && firstStateIn(ws.process, k.item!.type, "Completed"));
      if (closable.length) {
        const st = firstStateIn(ws.process, closable[0].item!.type, "Completed")!;
        items.push("-", { label: one ? `Close (move to ${st})` : `Close ${closable.length} (move to done)`, icon: "check", disabled: ro(), onClick: () => closeItems(closable) });
      }
      menu(anchor, items.map((it) => it === "-" ? it : { ...it, onClick: () => { it.onClick(); backToRow(); } }));
    }

    /** Several reorders as one: to the top or the bottom of each level, their order kept. */
    function moveToEnd(list: TNode[], where: "top" | "bottom"): void {
      const steps: { label: string; run: (w: Writer) => Promise<WriteResult> }[] = [];
      for (const rank of new Set(list.map((k) => k.level.rank))) {
        const level = levels.find((l) => l.rank === rank)!;
        const ids = list.filter((k) => k.level.rank === rank).map((k) => k.item!).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id).map((w) => w.id);
        for (const [id, prev, next] of endMoves(ws.ofLevel(level).map((w) => w.id), ids, where)) steps.push({ label: `#${id}`, run: (w) => w.reorder(id, prev, next) });
      }
      batch(`${many(list)} moved to the ${where}`, steps);
    }

    function sprintMenu(list: TNode[], anchor: Element): void {
      const cur = ws.currentIteration();
      const choices = sprintChoices(ws.settings.backlogIteration ?? ws.project, ws.iterations);
      menu(anchor, choices.map((c) => ({
        label: c.path === cur?.path && !c.label.endsWith("(current)") ? `${c.label} (current)` : c.label, icon: "sprint",
        disabled: list.every((k) => k.item!.iteration === c.path),
        onClick: () => moveToSprint(list, c.path, c.label),
      })));
    }

    /** Move items to a sprint; a story's open tasks go with it, as in Azure DevOps. */
    function moveToSprint(list: TNode[], path: string, label: string): void {
      const { ids, tasks } = sprintMoveIds(list.map((k) => ({
        id: k.id, iteration: k.item!.iteration, story: k.level.kind === "requirement",
        tasks: k.kids.filter((t) => t.item && t.level.kind === "task" && !isClosed(t.item)).map((t) => ({ id: t.id, iteration: t.item!.iteration })),
      })), path);
      batch(`${many(list)} moved to ${label}${tasks ? ` with ${tasks} open ${tasks === 1 ? "task" : "tasks"}` : ""}`,
        ids.map((id) => ({ label: `#${id}`, run: (w) => w.setFields(id, [{ field: "System.IterationPath", value: path }]) })));
    }

    function pickParent(list: TNode[], anchor: Element, up: Level): void {
      const mine = new Set(list.map((k) => k.id));
      itemPicker(ws, anchor, (w) => up.types.includes(w.type) && !isClosed(w) && !mine.has(w.id), (p) => {
        const to = p?.id ?? 0;
        if (list.every((k) => (k.item!.parent ?? 0) === to)) { backToRow(); return; }
        const steps = list.filter((k) => (k.item!.parent ?? 0) !== to).map((k) => ({ label: `#${k.id}`, run: (w: Writer) => w.reparent(k.id, to) }));
        batch(`${many(list)} ${list.length === 1 ? "is" : "are"} now under ${p ? lbl(p) : "no parent"}`, steps);
        if (p) { open.add(p.id); saveOpen(); }
      }, { placeholder: `Find a ${up.name.replace(/s$/, "")} by title or number`, allowNone: "No parent" });
    }

    function closeItems(list: TNode[]): void {
      if (list.length === 1) { const st = firstStateIn(ws.process, list[0].item!.type, "Completed")!; void app.actions.move(list[0].id, { state: st }).then(() => clearPicked()); return; }
      batch(`${list.length} items closed`, list.map((k) => ({ label: `#${k.id}`, run: (w: Writer) => w.move(k.id, { state: firstStateIn(ws.process, k.item!.type, "Completed")! }) })));
    }

    /** Alt+↑/↓: one place up or down among the siblings shown (the keyboard's way to drag). */
    async function nudge(n: TNode, dir: -1 | 1): Promise<void> {
      if (!n.item || ro()) return;
      if (sortBy) { toast("Sorted by a column, so the order cannot change here.", { action: { label: "Backlog order", run: () => setSort(null) } }); return; }
      const sibs = onlyRank != null
        ? [...nodes.values()].filter((k) => k.item && k.level.rank === onlyRank).sort(cmp)
        : (n.parent ? n.parent.kids : roots).filter((k) => k.item && k.level.rank === n.level.rank);
      const place = stepPlace(sibs.map((k) => k.id), sibs.filter((k) => shown.has(k.id)).map((k) => k.id), n.id, dir);
      if (!place) return;
      await app.actions.reorder(n.id, place[0], place[1]);
    }

    // ---- clicks ----
    let suppressClick = false;
    tbody.addEventListener("mousedown", (e) => { if (e.shiftKey && (e.target as Element).closest("tr.tree-row")) e.preventDefault(); }); // no text selection
    tbody.addEventListener("click", (e) => {
      if (suppressClick) { suppressClick = false; return; }
      const t = e.target as Element;
      const row = t.closest<HTMLElement>("tr.tree-row");
      if (!row) return;
      const n = nodes.get(Number(row.dataset.id));
      if (!n) return;
      if (t.closest(".tree-more")) { focusRow(n, false); rowMenu(n, t.closest(".tree-more")!); return; }
      if (t.closest(".tree-add")) { void addChild(n); return; }
      if (t.closest(".tree-chev") || !n.item) { focusRow(n, false); toggleOpen(n.id); return; }
      if (e.ctrlKey || e.metaKey) {
        // the first Ctrl+click keeps the open row in the selection
        if (!picked.size && selected != null && selected !== n.id && shown.has(selected) && nodes.get(selected)?.item) picked.add(selected);
        togglePick(n);
        focusRow(n, false);
        return;
      }
      if (e.shiftKey) { pickRange(n); focusRow(n, false); return; }
      clearPicked();
      anchorId = n.id;
      focusRow(n, false);
      app.openItem(n.id);
    });
    tbody.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>("tr.tree-row");
      const n = row && nodes.get(Number(row.dataset.id));
      if (!n?.item || drag) return;
      e.preventDefault();
      if (!picked.has(n.id)) clearPicked();
      focusRow(n, false);
      rowMenu(n, row!.querySelector(".tree-more") ?? row!);
    });
    // the buttons inside a row hand the keyboard back to the row (a menu closed with Esc focuses its button)
    tbody.addEventListener("focusin", (e) => {
      const t = e.target as Element;
      if (!t.matches(".tree-more, .tree-add, .tree-chev")) return;
      const row = t.closest<HTMLElement>("tr.tree-row");
      const n = row && nodes.get(Number(row.dataset.id));
      if (n && !t.closest(".popup")) focusRow(n, false);
    });

    // ---- keyboard: the tree grid ----
    tbody.addEventListener("keydown", (e) => {
      const row = e.target as HTMLElement;
      if (!row.matches?.("tr.tree-row")) return;
      const n = nodes.get(Number(row.dataset.id));
      if (!n) return;
      const i = flat.indexOf(n);
      const go = (m: TNode | undefined): void => {
        e.preventDefault();
        if (!m) return;
        if (e.shiftKey && m.item) { if (n.item) picked.add(n.id); picked.add(m.id); anchorId = anchorId ?? n.id; paintPicked(); }
        focusRow(m);
      };
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); void nudge(n, e.key === "ArrowUp" ? -1 : 1); return; }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const kids = row.classList.contains("has-kids");
      const isOpen = row.classList.contains("open");
      switch (e.key) {
        case "ArrowDown": go(flat[i + 1]); break;
        case "ArrowUp": go(flat[i - 1]); break;
        case "Home": go(flat[0]); break;
        case "End": go(flat[flat.length - 1]); break;
        case "PageDown": go(flat[Math.min(flat.length - 1, i + 10)]); break;
        case "PageUp": go(flat[Math.max(0, i - 10)]); break;
        case "ArrowRight":
          e.preventDefault();
          if (kids && !isOpen) toggleOpen(n.id); else if (kids) go(flat[i + 1]);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (kids && isOpen) toggleOpen(n.id); else if (n.parent && shown.has(n.parent.id)) go(n.parent);
          break;
        case "Enter":
          e.preventDefault();
          if (n.item) { anchorId = n.id; app.openItem(n.id); } else toggleOpen(n.id);
          break;
        case " ":
          e.preventDefault();
          togglePick(n);
          break;
        case "ContextMenu":
          e.preventDefault();
          rowMenu(n, row.querySelector(".tree-more") ?? row);
          break;
        case "F10":
          if (e.shiftKey) { e.preventDefault(); rowMenu(n, row.querySelector(".tree-more") ?? row); }
          break;
      }
    });
    // Esc lets go of the picked rows, once nothing else (panel, popup, dialog, search text) takes it
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !picked.size || drag || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.matches("input, textarea, select"))) return;
      if (app.openId() != null || document.querySelector(".backdrop, .popup")) return;
      e.preventDefault();
      clearPicked();
    };
    document.addEventListener("keydown", onEsc);

    // ---- drag and drop (pointer events) ----
    let drag: { node: TNode; x: number; y: number; started: boolean; ghost?: HTMLElement; drop: Drop | null; pointerId: number } | null = null;
    let intoRow: HTMLElement | null = null;

    // dragging works while searching or filtering too: the order is set against all the siblings, hidden ones included
    tbody.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || app.actions.readOnly || sortBy || onlyRank != null || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as Element;
      if (t.closest("button, a, input")) return;
      const row = t.closest<HTMLElement>("tr.tree-row");
      const n = row && nodes.get(Number(row.dataset.id));
      if (!n?.item) return;
      drag = { node: n, x: e.clientX, y: e.clientY, started: false, drop: null, pointerId: e.pointerId };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", cancelDrag);
      document.addEventListener("keydown", onKey, true);
    });

    function onMove(e: PointerEvent): void {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.started) {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
        drag.started = true;
        document.body.classList.add("tree-dragging");
        rows.get(drag.node.id)?.classList.add("dragged");
        drag.ghost = h("div.tree-ghost", null, typeMark(ws, drag.node.item!.type), `#${drag.node.id} ${drag.node.item!.title}`);
        document.body.append(drag.ghost);
      }
      e.preventDefault();
      drag.ghost!.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
      if (e.clientY < 70) window.scrollBy(0, -12); else if (e.clientY > window.innerHeight - 40) window.scrollBy(0, 12);
      showDrop(findDrop(e.clientX, e.clientY));
    }

    function findDrop(x: number, y: number): Drop | null {
      const d = drag!.node;
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("tr.tree-row");
      if (!row || !tbody.contains(row)) return null;
      const t = nodes.get(Number(row.dataset.id));
      if (!t || t === d) return null;
      for (let p: TNode | undefined = t; p; p = p.parent) if (p === d) return null; // not under itself
      if (!t.item) return t.level.rank === d.level.rank && d.parent !== t ? { target: t, mode: "into" } : null;
      if (t.level.rank === d.level.rank - 1) return d.parent === t ? null : { target: t, mode: "into" };
      if (t.level.rank !== d.level.rank) return null;
      const r = row.getBoundingClientRect();
      return { target: t, mode: y < r.top + r.height / 2 ? "before" : "after" };
    }

    function showDrop(drop: Drop | null): void {
      drag!.drop = drop;
      intoRow?.classList.remove("drop-into");
      intoRow = null;
      document.body.classList.toggle("tree-no-drop", !drop);
      if (!drop || drop.mode === "into") {
        indicator.hidden = true;
        if (drop) { intoRow = rows.get(drop.target.id) ?? null; intoRow?.classList.add("drop-into"); }
        return;
      }
      // "after" an open row: the line goes below its last shown descendant
      let ref = rows.get(drop.target.id)!;
      if (drop.mode === "after") {
        let i = flat.indexOf(drop.target);
        while (i + 1 < flat.length && flat[i + 1].depth > drop.target.depth) i++;
        ref = rows.get(flat[i].id)!;
      }
      const wr = wrap.getBoundingClientRect();
      const rr = ref.getBoundingClientRect();
      indicator.hidden = false;
      indicator.style.top = `${(drop.mode === "before" ? rr.top : rr.bottom) - wr.top - 1}px`;
      indicator.style.left = `${8 + drop.target.depth * INDENT}px`;
    }

    function onUp(e: PointerEvent): void {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const d = drag;
      if (d.started) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
      cancelDrag();
      if (d.started && d.drop) void doDrop(d.node, d.drop);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && drag) { e.stopPropagation(); e.preventDefault(); cancelDrag(); }
    }

    function cancelDrag(): void {
      if (drag?.started) suppressClick = true;
      drag?.ghost?.remove();
      if (drag) rows.get(drag.node.id)?.classList.remove("dragged");
      drag = null;
      intoRow?.classList.remove("drop-into");
      intoRow = null;
      indicator.hidden = true;
      document.body.classList.remove("tree-dragging", "tree-no-drop");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", cancelDrag);
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => { suppressClick = false; }, 0);
    }

    async function doDrop(d: TNode, drop: Drop): Promise<void> {
      const t = drop.target;
      if (drop.mode === "into") {
        await app.actions.reparent(d.id, t.item ? t.id : 0);
        if (t.item) { open.add(t.id); saveOpen(); }
        return;
      }
      // between siblings: same parent as the target (re-parent first when it differs)
      const parent = t.parent;
      const newParentId = parent?.item ? parent.id : 0;
      // all the siblings, also those a search hides, so the new place is between two neighbours
      const sibs = (parent ? parent.kids : roots).filter((k) => k.item && k.level.rank === d.level.rank && k !== d);
      const i = sibs.indexOf(t);
      const prev = drop.mode === "before" ? sibs[i - 1] : t;
      const next = drop.mode === "before" ? t : sibs[i + 1];
      const reorder = !(prev?.id === d.id || next?.id === d.id);
      if (d.parent === parent) { if (reorder) await app.actions.reorder(d.id, prev?.id ?? 0, next?.id ?? 0); return; }
      // a new parent and a place among its children: one message, one Undo for both
      let moved = false;
      await app.actions.batch(`${lbl(d.item!)} is now under ${parent?.item ? lbl(parent.item) : "no parent"}`, [
        { label: "Parent", run: async (w) => { const r = await w.reparent(d.id, newParentId); moved = true; return r; } },
        ...(reorder ? [{ label: "Order", run: (w: Writer) => { if (!moved) throw new Error("The parent did not change."); return w.reorder(d.id, prev?.id ?? 0, next?.id ?? 0); } }] : []),
      ]);
      if (parent?.item) { open.add(parent.id); saveOpen(); }
    }

    // ---- selection ----
    function select_(id: number | null): void {
      if (selected != null) { const r = rows.get(selected); r?.classList.remove("selected"); if (r && !picked.has(selected)) r.setAttribute("aria-selected", "false"); }
      selected = id;
      if (id != null) { const r = rows.get(id); r?.classList.add("selected"); r?.setAttribute("aria-selected", "true"); }
    }

    const refresh = (): void => {
      build();
      fb.refresh();
      render();
      select_(selected);
      if (reveal != null) showNew();
    };
    paintSort();
    refresh();

    return {
      update() { if (drag) cancelDrag(); refresh(); },
      select(id) {
        select_(id);
        // the keyboard goes on from the open item
        if (id == null || !shown.has(id)) return;
        if (focusId != null) { const old = rows.get(focusId); if (old) old.tabIndex = -1; }
        focusId = id;
        anchorId = id;
        const row = rows.get(id);
        if (row) row.tabIndex = 0;
      },
      unmount() { cancelDrag(); saveOpen(); document.removeEventListener("keydown", onEsc); },
    };
  },
};

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
