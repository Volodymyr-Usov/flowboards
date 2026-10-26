// The Board's rules without the page: which columns, which card goes where, in what order, which
// Features show on the left and how they group under Epics, what a card is missing.
// Also the pull requests of a story and the sprint rows of the story map layout.
// Pure; covered by test/boardmodel.test.ts.
import { prFromArtifact } from "../api/api.ts";
import type { BoardInfo, Iteration, Level, ProcessInfo, WorkItem } from "../api/types.ts";
import { textMatch } from "../core/filters.ts";
import { byOrder, daysInState, hasText, isDone, orderedStates } from "../core/model.ts";
import type { Facts, MissingPart, Rule } from "../core/rules.ts";
import { inheritedRules as coreInherited, missingParts } from "../core/rules.ts";
import { runLimited as runAll } from "./prlogic.ts";

export interface Column {
  name: string;
  /** state for each type (board mode) or the state itself (state mode) */
  states: Record<string, string>;
  limit: number;
  kind: "incoming" | "inProgress" | "outgoing";
  color: string;
  /** split in Doing and Done on the team's board: the board's done field says which half a card is in */
  split?: boolean;
}

/** Columns from the team's board, or one per state of the requirement types. */
export function boardColumns(p: ProcessInfo, req: Level, board: BoardInfo | null, mode: "columns" | "states"): Column[] {
  const states = orderedStates(p, req.types);
  const colorOf = (state: string | undefined) => states.find((s) => s.name === state)?.color ?? "#888888";
  if (mode === "columns" && board?.columns.length && board.columnField) {
    return board.columns.map((c) => ({
      name: c.name, states: c.stateMappings, limit: c.itemLimit, kind: c.columnType,
      color: colorOf(Object.values(c.stateMappings)[0]),
      // a split column needs the field that holds the half; without it the column is drawn whole
      ...(c.isSplit && board.doneField ? { split: true } : {}),
    }));
  }
  return states.map((s, i) => ({
    name: s.name,
    states: Object.fromEntries(req.types.map((t) => [t, s.name])),
    limit: 0,
    kind: s.category === "Proposed" && i === 0 ? "incoming" : s.category === "Completed" ? "outgoing" : "inProgress",
    color: s.color,
  }));
}

/** The column a card stands in: its board column when it has one we know, else the first column of its state. */
export function columnOf(cols: Column[], w: WorkItem, mode: "columns" | "states"): Column | undefined {
  if (mode === "columns" && w.boardColumn) {
    const c = cols.find((x) => x.name === w.boardColumn);
    if (c && (c.states[w.type] === undefined || c.states[w.type] === w.state)) return c;
  }
  return cols.find((c) => (c.states[w.type] ?? c.states[Object.keys(c.states)[0]]) === w.state)
    ?? cols.find((c) => Object.values(c.states).includes(w.state));
}

/** Is this column one of several that share the card's state (days in column then need the history)? */
export function sharesState(cols: Column[], col: Column, type: string): boolean {
  const s = col.states[type];
  return cols.filter((c) => c.states[type] === s).length > 1;
}

/** "rules": the ⚠ follows the rules of the card's column (Settings > Rules); the others are the older fixed checks */
export type MissingMode = "off" | "rules" | "desc" | "descAc" | "all";

/** The board's colouring rules: when a card turns yellow or red, and what else counts as missing. */
export interface ColorRules {
  /** days in the column: yellow from, red from */
  ageWarn: number; ageBad: number;
  /** things missing: yellow from, red from */
  missWarn: number; missBad: number;
  /** also mark a card without an owner, or without an effort */
  owner: boolean; effort: boolean;
}
export const DEFAULT_RULES: ColorRules = { ageWarn: 30, ageBad: 90, missWarn: 1, missBad: 2, owner: false, effort: false };

/** What a card lacks, in words. */
export function missing(w: WorkItem, mode: MissingMode, taskCount: number, prCount: number, hasAcField: boolean, also: { owner?: boolean; effort?: boolean } = {}): string[] {
  if (mode === "off" || w.category === "Completed") return [];
  // "rules" is judged by the card's column (see ruleGaps); where there is no column to ask, a description is what counts
  const out: string[] = [];
  if (also.owner && !w.assignedTo) out.push("owner");
  if (also.effort && w.effort == null) out.push("effort");
  if (!hasText(w.description, 10)) out.push("description");
  if ((mode === "descAc" || mode === "all") && hasAcField && !hasText(w.acceptance, 5)) out.push("acceptance criteria");
  if (mode === "all" && w.category === "InProgress" && taskCount === 0 && prCount === 0) out.push("tasks");
  return out;
}

/** What one rule asks for that a card still lacks. */
export interface RuleGap { rule: Rule; labels: string[]; parts: MissingPart[] }

/** The column (position) a rule guards: its board column, else the first column that holds its state. -1: none we know. */
export function ruleColumn(rule: Rule, cols: Column[], type: string): number {
  const byName = cols.findIndex((c) => c.name === rule.target);
  return byName >= 0 ? byName : cols.findIndex((c) => c.states[type] === rule.target);
}

/**
 * The rules that hold for a card standing in column `at`: those of its own column and of every column to its left
 * (what Ready asks, Active and Review ask too). One-way rules ("from X to Y") guard that move only and are left out.
 */
export function inheritedRules(rules: Rule[], kind: Rule["level"], cols: Column[], at: number, type: string): Rule[] {
  return coreInherited(rules, kind, at, (r) => ruleColumn(r, cols, type));
}

/**
 * What a card lacks of the rules that hold in its column, rule by rule. Who may make a move is not a gap, and a
 * field rule is judged only for fields the card was read with (an unread field is not "empty").
 */
export function ruleGaps(rules: Rule[], kind: Rule["level"], cols: Column[], at: number, type: string, facts: Facts): RuleGap[] {
  const out: RuleGap[] = [];
  for (const r of inheritedRules(rules, kind, cols, at, type)) {
    const judged: Rule = { ...r, onlyBy: [], fields: (r.fields ?? []).filter((ref) => facts.values && ref in facts.values) };
    const parts = missingParts(judged, facts);
    if (parts.length) out.push({ rule: r, labels: parts.map((p) => p.label), parts });
  }
  return out;
}

export interface Group {
  /** the Epic (top portfolio item) or null for Features without one */
  epic: WorkItem | null;
  features: WorkItem[];
}

/**
 * Features for the left list: those with a shown card, plus (with `empty`) open ones without stories.
 * Grouped by their Epic when `byEpic`; the Epics in backlog order, Features without an Epic last.
 */
export function featureGroups(features: WorkItem[], parentOf: (id: number | undefined) => WorkItem | undefined, withCards: Set<number>, opts: { empty: boolean; byEpic: boolean; showClosed: boolean }): Group[] {
  const shown = features.filter((f) => withCards.has(f.id) || (opts.empty && (opts.showClosed || !isDone(f)))).sort(byOrder);
  if (!opts.byEpic) return shown.map((f) => ({ epic: null, features: [f] }));
  const groups = new Map<number, Group>();
  const loose: WorkItem[] = [];
  for (const f of shown) {
    const e = parentOf(f.parent);
    if (!e) { loose.push(f); continue; }
    let g = groups.get(e.id);
    if (!g) groups.set(e.id, (g = { epic: e, features: [] }));
    g.features.push(f);
  }
  const ordered = [...groups.values()].sort((a, b) => byOrder(a.epic!, b.epic!));
  return [...ordered, ...loose.map((f) => ({ epic: null, features: [f] }))];
}

/** Clock colour for days in a column: grey when waiting or done, then green, yellow, red. */
export function clockClass(days: number, kind: Column["kind"], category: WorkItem["category"]): "neutral" | "green" | "yellow" | "red" {
  if (kind !== "inProgress" || category === "Proposed" || category === "Completed") return "neutral";
  return days < 7 ? "green" : days < 14 ? "yellow" : "red";
}

export type ColorMode = "none" | "age" | "missing" | "both";

/** Card tint: 0 none, 1 yellow, 2 red. */
export function tint(mode: ColorMode, daysInColumn: number, missingCount: number, category: WorkItem["category"], r: ColorRules = DEFAULT_RULES): 0 | 1 | 2 {
  if (mode === "none" || category === "Completed") return 0;
  const age: 0 | 1 | 2 = daysInColumn >= r.ageBad ? 2 : daysInColumn >= r.ageWarn ? 1 : 0;
  const miss: 0 | 1 | 2 = missingCount && missingCount >= r.missBad ? 2 : missingCount && missingCount >= r.missWarn ? 1 : 0;
  if (mode === "age") return age;
  if (mode === "missing") return miss;
  return Math.max(age, miss) as 0 | 1 | 2;
}

/** Search: every word must appear somewhere in the item's text. */
export function matches(words: string[], w: WorkItem, extra: string): boolean {
  return textMatch(words, w, extra);
}

/** Days a card has been in its column: from the column history when known, else since its state changed. */
export function daysInColumn(w: WorkItem, columnSince: Map<number, string>, now = Date.now()): number {
  const s = columnSince.get(w.id);
  return s ? Math.max(0, Math.floor((now - Date.parse(s)) / 86_400_000)) : daysInState(w, now);
}

/** When the item entered its current board column, from its updates (newest change of the column field). */
export function columnEnteredAt(updates: { date: string; changes: { field: string; newValue?: unknown }[] }[], columnField: string, column: string): string | undefined {
  for (let i = updates.length - 1; i >= 0; i--) {
    const c = updates[i].changes.find((x) => x.field === columnField || x.field === "System.BoardColumn");
    if (c && c.newValue === column) return updates[i].date;
  }
  return undefined;
}

// ---------- board columns over time (cumulative flow by column) ----------

/** A step in an item's way across the board: from this time on it stood in this column (null: off the board). */
export interface ColumnStep { at: string; column: string | null }

/**
 * The board columns an item stood in over time, from its updates: each change of its state or of the
 * board's column field is a step, read the way the Board places a card (the column field when it fits
 * the state, else the first column of the state). Without a readable history (null), the item's own
 * dates stand in: created in the first column, started in the first column of work, closed in the last.
 * The last step is always the column the item stands in now.
 */
export function columnPath(w: WorkItem, updates: { date: string; changes: { field: string; newValue?: unknown }[] }[] | null, cols: Column[], columnField: string | undefined): ColumnStep[] {
  const out: ColumnStep[] = [];
  const push = (at: string | undefined, column: string | null): void => {
    if (!at) return;
    const last = out[out.length - 1];
    if (last && Date.parse(at) < Date.parse(last.at)) at = last.at; // dates out of order: never back in time
    if (last?.column === column) return;
    if (last && last.at === at) { last.column = column; if (out.length > 1 && out[out.length - 2].column === column) out.pop(); return; }
    out.push({ at, column });
  };
  const place = (state: string, boardColumn: string | undefined): string | null =>
    columnOf(cols, { ...w, state, boardColumn }, "columns")?.name ?? null;
  let state: string | undefined;
  let col: string | undefined;
  let read = false;
  for (const u of updates ?? []) {
    let touched = false;
    for (const c of u.changes) {
      if (c.field === "System.State") { state = c.newValue == null ? undefined : String(c.newValue); touched = true; }
      else if (c.field === columnField || (c.field === "System.BoardColumn" && !u.changes.some((x) => x.field === columnField))) { col = c.newValue == null ? undefined : String(c.newValue); touched = true; }
    }
    if (touched && state) { read = true; push(u.date, place(state, col)); }
  }
  if (!read) {
    const firstWork = cols.find((c) => c.kind === "inProgress");
    push(w.created, cols[0]?.name ?? null);
    if (w.category !== "Proposed") push(w.activated ?? (w.category === "InProgress" ? w.stateChanged : undefined), firstWork?.name ?? null);
    if (w.category === "Completed") push(w.closed ?? w.stateChanged, cols[cols.length - 1]?.name ?? null);
  }
  // where it stands now (the history may be older than the copy we hold)
  const now = w.category === "Removed" ? null : columnOf(cols, w, "columns")?.name ?? null;
  if (out[out.length - 1]?.column !== now) push(out.length ? w.changed : w.created, now);
  return out;
}

/** The column an item stood in at the end of a day (dayIndex), or null when not on the board yet. */
export function columnOnDay(path: ColumnStep[], day: number): string | null {
  let at: string | null = null;
  for (const s of path) if (Math.floor(Date.parse(s.at) / 86_400_000) <= day) at = s.column;
  return at;
}

/** Cumulative flow by column: for each day from startDay, how many items stood in each column at its end. */
export function cfdByColumn(paths: ColumnStep[][], columns: string[], startDay: number, length: number): Record<string, number[]> {
  const diff: Record<string, number[]> = {};
  for (const c of columns) diff[c] = new Array<number>(length + 1).fill(0);
  for (const p of paths) {
    for (let i = 0; i < p.length; i++) {
      const c = p[i].column;
      if (c === null || !diff[c]) continue;
      const fromDay = Math.floor(Date.parse(p[i].at) / 86_400_000);
      const toDay = i + 1 < p.length ? Math.floor(Date.parse(p[i + 1].at) / 86_400_000) : startDay + length;
      const from = Math.max(fromDay, startDay) - startDay;
      const to = Math.min(toDay, startDay + length) - startDay; // exclusive
      if (to <= from) continue;
      diff[c][from]++;
      diff[c][to]--;
    }
  }
  const out: Record<string, number[]> = {};
  for (const c of columns) {
    let run = 0;
    out[c] = [];
    for (let i = 0; i < length; i++) { run += diff[c][i]; out[c].push(run); }
  }
  return out;
}

// ---------- pull requests of a story ----------

export interface PrLink {
  /** repository and id: the same pull request linked twice counts once */
  key: string;
  repoId: string;
  prId: number;
  /** 0 when the story itself links it, else the id of the task (or other child) that does */
  from: number;
}

/** Pull requests linked to a story or to any of its children, each once; the story's own link wins. */
export function prLinks(story: WorkItem, children: WorkItem[]): PrLink[] {
  const out = new Map<string, PrLink>();
  for (const x of [story, ...children]) {
    for (const r of x.relations ?? []) {
      const p = prFromArtifact(r.url);
      if (!p) continue;
      const key = `${p.repoId.toLowerCase()}/${p.prId}`;
      if (!out.has(key)) out.set(key, { key, repoId: p.repoId, prId: p.prId, from: x === story ? 0 : x.id });
    }
  }
  return [...out.values()];
}

/** Which pull requests count on cards: open ones (drafts too), completed ones, or both. */
export type PrShow = "all" | "open" | "completed";

export interface PrCount {
  /** the links that count under the choice (abandoned ones never do) */
  counted: PrLink[];
  /** completed among them */
  done: number;
  /** links whose status is not read yet */
  unknown: number;
  /** what the card shows, e.g. "2/3", "1 open", "2 done"; "" when nothing counts */
  label: string;
}

/** Count a story's pull requests under the choice. Until a status is read, "all" counts the link and the others show "…". */
export function prCount(links: PrLink[], statusOf: (l: PrLink) => string | undefined, show: PrShow): PrCount {
  const isOpen = (s: string): boolean => s === "active" || s === "draft";
  const unknown = links.filter((l) => !statusOf(l)).length;
  const counted = links.filter((l) => {
    const s = statusOf(l);
    if (!s) return show === "all";
    if (s === "abandoned") return false;
    if (show === "open") return isOpen(s);
    if (show === "completed") return s === "completed";
    return true; // "all": also one that cannot be read (deleted, no access)
  });
  const done = counted.filter((l) => statusOf(l) === "completed").length;
  const wait = unknown > 0 && show !== "all" ? "…" : "";
  const label = show === "all"
    ? (counted.length ? `${done}/${counted.length}` : "")
    : counted.length || wait ? `${counted.length}${wait} ${show === "open" ? "open" : "done"}` : "";
  return { counted, done, unknown, label };
}

/** Run jobs with at most `max` at a time; a job that throws does not stop the others. */
export async function runLimited<T>(list: T[], max: number, job: (x: T) => Promise<void>): Promise<void> {
  await runAll(list, max, job);
}

// ---------- story map: one row per sprint ----------

export interface SprintRow {
  key: string;
  name: string;
  /** where a card dropped on this row goes; null: no drop (earlier sprints) */
  path: string | null;
  /** iteration paths that fall in this row */
  paths: string[];
  kind: "past" | "current" | "future" | "backlog";
  start?: string;
  finish?: string;
}

const DAY = 86_400_000;

/** Rows of the story map: earlier sprints (one row), the current sprint, the coming ones by start, then the backlog. */
export function sprintRows(iterations: Iteration[], backlogPath: string, today = Date.now()): SprintRow[] {
  const frame = (i: Iteration): "past" | "current" | "future" => {
    if (i.timeFrame) return i.timeFrame;
    if (i.finish && Date.parse(i.finish) + DAY <= today) return "past";
    if (i.start && Date.parse(i.start) <= today) return "current";
    return "future";
  };
  const start = (i: Iteration): number => (i.start ? Date.parse(i.start) : Number.MAX_SAFE_INTEGER);
  const sorted = [...iterations].filter((i) => i.path !== backlogPath).sort((a, b) => start(a) - start(b) || a.name.localeCompare(b.name));
  const past = sorted.filter((i) => frame(i) === "past");
  const rows: SprintRow[] = [{ key: "past", name: "Earlier sprints", path: null, paths: past.map((i) => i.path), kind: "past" }];
  for (const i of sorted) {
    const f = frame(i);
    if (f !== "past") rows.push({ key: i.path, name: i.name, path: i.path, paths: [i.path], kind: f, start: i.start, finish: i.finish });
  }
  rows.push({ key: "backlog", name: "Backlog / no sprint", path: backlogPath, paths: [], kind: "backlog" });
  return rows;
}

/** The row a card stands in: the sprint of its iteration (or of a sprint above it), else the backlog row. */
export function rowOf(rows: SprintRow[], iteration: string): SprintRow {
  const it = iteration.toLowerCase();
  let best: SprintRow | undefined;
  let bestLen = -1;
  for (const r of rows) {
    for (const p of r.paths) {
      const q = p.toLowerCase();
      if ((it === q || it.startsWith(q + "\\")) && q.length > bestLen) { best = r; bestLen = q.length; }
    }
  }
  return best ?? rows[rows.length - 1];
}

/** "1 story", "0 stories", "3 backlog items": a count with a level's plural name, made singular for one. */
export function countOf(n: number, plural: string): string {
  const p = plural.toLowerCase();
  return `${n} ${n === 1 ? p.replace(/ies$/, "y").replace(/([^s])s$/, "$1") : p}`;
}

/** Cards drawn at first in a board column, and in a story map cell; "Show more" adds as many again. */
export const COLUMN_CAP = 50;
export const CELL_CAP = 20;
/** Feature columns drawn at first on the story map */
export const FEATURE_CAP = 30;

/** The first `limit` of a list, and how many are left out. */
export function capCards<T>(list: T[], limit: number): { shown: T[]; hidden: number } {
  return list.length <= limit ? { shown: list, hidden: 0 } : { shown: list.slice(0, limit), hidden: list.length - limit };
}

/** The limit to draw so that the card at `index` shows: the limit itself, or the next whole step past it. */
export function limitShowing(index: number, limit: number, step: number): number {
  return index < limit ? limit : Math.ceil((index + 1) / step) * step;
}

/** A list split by a key, in one pass, keeping the order. */
export function groupBy<T, K>(list: T[], key: (x: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of list) {
    const k = key(x);
    const l = out.get(k);
    if (l) l.push(x); else out.set(k, [x]);
  }
  return out;
}

/** Card order in a column or cell: search matches first, then the team's backlog order (the lines show each card's Feature). */
export function cardOrder(a: { hit: boolean; w: WorkItem }, b: { hit: boolean; w: WorkItem }): number {
  return Number(b.hit) - Number(a.hit) || byOrder(a.w, b.w);
}

/**
 * The result of a step whose Undo reads the item again once it ran. A reorder leaves the copy of the
 * item as a guess (Azure DevOps does not say the new revision), and the Undo of the step before it,
 * run right after, would be refused as changed meanwhile.
 */
export function readAfterUndo<R extends { undo?: () => Promise<unknown> }>(r: R, read: () => Promise<unknown>): R {
  const undo = r.undo;
  if (!undo) return r;
  return { ...r, undo: async () => { const out = await undo(); await read(); return out; } };
}

/**
 * Where a card dropped at height `y` goes in a column, as the cards before and after it (0 = none).
 * While a search lifts matching cards to the top, the screen order is not the backlog order: the
 * neighbours are taken only among cards of the dragged card's kind (matches with matches, the others
 * with the others), which keep their backlog order among themselves.
 */
export function placeAmong(cards: { id: number; hit: boolean; mid: number }[], hit: boolean, y: number): { before: number; after: number } {
  let before = 0;
  for (const c of cards) {
    if (c.hit !== hit) continue;
    if (y < c.mid) return { before, after: c.id };
    before = c.id;
  }
  return { before, after: 0 };
}

export type PriorityMove = "top" | "up" | "down" | "bottom";

/** A card moved by the menu in its column's order (`peers` in backlog order): the cards to go between, or null when it stays. */
export function priorityMove(peers: number[], id: number, where: PriorityMove): { prev: number; next: number } | null {
  const i = peers.indexOf(id);
  if (i < 0) return null;
  const rest = peers.filter((x) => x !== id);
  const to = where === "top" ? 0 : where === "up" ? i - 1 : where === "down" ? i + 1 : rest.length;
  if (to < 0 || to > rest.length || to === i) return null;
  return { prev: rest[to - 1] ?? 0, next: rest[to] ?? 0 };
}

/**
 * Does a drop on this story map row move the story? Into a sprint row: when it is in another row now.
 * Into the backlog row: when it is not in the team's backlog iteration itself (a story in a sprint the
 * team does not use shows in the backlog row, and goes to the backlog iteration).
 */
export function movesToRow(rows: SprintRow[], row: SprintRow, iteration: string): boolean {
  if (!row.path) return false;
  if (row.kind === "backlog") return iteration.toLowerCase() !== row.path.toLowerCase();
  return rowOf(rows, iteration).key !== row.key;
}

/** A card dropped between two others (none = start or end): true when its backlog order already puts it there. */
export function alreadyBetween(w: WorkItem, before: WorkItem | undefined, after: WorkItem | undefined): boolean {
  return (!before || byOrder(before, w) < 0) && (!after || byOrder(w, after) < 0);
}

export interface Box { left: number; top: number; right: number; bottom: number }
export type Dir = "up" | "down" | "left" | "right";

/**
 * Arrow keys between cards: the box nearest to `from` in a direction, or -1. Up and down stay in the
 * same column (boxes that overlap it sideways); left and right go to the nearest column that way, to
 * the box at the closest height.
 */
export function nearestBox(from: Box, boxes: Box[], dir: Dir): number {
  const cx = (b: Box): number => (b.left + b.right) / 2;
  const cy = (b: Box): number => (b.top + b.bottom) / 2;
  let best = -1;
  let score = Infinity;
  if (dir === "up" || dir === "down") {
    boxes.forEach((b, i) => {
      if (!(b.left < from.right && b.right > from.left)) return;
      const d = dir === "down" ? cy(b) - cy(from) : cy(from) - cy(b);
      if (d > 1 && d < score) { score = d; best = i; }
    });
    return best;
  }
  const gap = (b: Box): number => (dir === "right" ? b.left - from.right : from.left - b.right);
  const ahead = boxes.map((b, i) => ({ b, i })).filter(({ b }) => (dir === "right" ? cx(b) > from.right : cx(b) < from.left));
  if (!ahead.length) return -1;
  const near = Math.min(...ahead.map(({ b }) => gap(b)));
  for (const { b, i } of ahead) {
    if (gap(b) > near + 24) continue;
    const d = Math.abs(cy(b) - cy(from));
    if (d < score) { score = d; best = i; }
  }
  return best;
}
