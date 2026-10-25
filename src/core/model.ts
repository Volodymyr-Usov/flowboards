// Pure helpers over the process and work items. No page, no network: covered by unit tests.
import type { Category, Level, Person, ProcessInfo, WorkItem } from "../api/types.ts";

export const DAY = 86_400_000;

export function levelOf(p: ProcessInfo, type: string): Level | undefined {
  return p.levels.find((l) => l.types.includes(type));
}

export function requirementLevel(p: ProcessInfo): Level {
  return p.levels.find((l) => l.kind === "requirement")!;
}

export function taskLevel(p: ProcessInfo): Level | undefined {
  return p.levels.find((l) => l.kind === "task");
}

/** The level directly above a level (Feature above Story), or undefined at the top. */
export function parentLevel(p: ProcessInfo, level: Level): Level | undefined {
  return p.levels.find((l) => l.rank === level.rank - 1);
}

export function childLevel(p: ProcessInfo, level: Level): Level | undefined {
  return p.levels.find((l) => l.rank === level.rank + 1);
}

/** State names of the given types that are in the given categories. */
export function statesOf(p: ProcessInfo, types: string[], categories: Category[]): string[] {
  const out = new Set<string>();
  for (const t of types) for (const s of p.types[t]?.states ?? []) if (categories.includes(s.category)) out.add(s.name);
  return [...out];
}

/** All state names of these types in workflow order (by category, then the process's own order). */
export function orderedStates(p: ProcessInfo, types: string[]): { name: string; category: Category; color: string }[] {
  const order: Category[] = ["Proposed", "InProgress", "Resolved", "Completed"];
  const seen = new Map<string, { name: string; category: Category; color: string; idx: number }>();
  let idx = 0;
  for (const t of types) for (const s of p.types[t]?.states ?? []) {
    if (s.category === "Removed" || seen.has(s.name)) continue;
    seen.set(s.name, { ...s, idx: idx++ });
  }
  return [...seen.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.idx - b.idx)
    .map(({ name, category, color }) => ({ name, category, color }));
}

export function stateColor(p: ProcessInfo, type: string, state: string): string {
  return p.types[type]?.states.find((s) => s.name === state)?.color ?? "#888888";
}

export function typeColor(p: ProcessInfo, type: string): string {
  return p.types[type]?.color ?? "#888888";
}

export const isDone = (w: WorkItem): boolean => w.category === "Completed" || w.category === "Resolved";
export const isClosed = (w: WorkItem): boolean => w.category === "Completed";
export const isRemoved = (w: WorkItem): boolean => w.category === "Removed";
export const isOpen = (w: WorkItem): boolean => !isClosed(w) && !isRemoved(w);

/** Whole days between an ISO date and now (0 for today). */
export function daysSince(iso: string | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const days = Math.floor((now - Date.parse(iso)) / DAY);
  return Number.isNaN(days) ? 0 : Math.max(0, days);
}

/** Days since the item entered its current state. */
export function daysInState(w: WorkItem, now = Date.now()): number {
  return daysSince(w.stateChanged ?? w.changed ?? w.created, now);
}

export function samePerson(a?: Person, b?: Person): boolean {
  if (!a || !b) return false;
  return (a.uniqueName && b.uniqueName && a.uniqueName.toLowerCase() === b.uniqueName.toLowerCase()) || (!!a.id && a.id === b.id);
}

export function personKey(p?: Person): string {
  return p ? (p.uniqueName || p.displayName).toLowerCase() : "";
}

export function initials(name: string): string {
  const parts = name.replace(/[<(].*$/, "").replace(/@.*$/, "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Text of an HTML field without tags; empty for "" or "<div></div>". */
export function plainText(html: string | undefined): string {
  if (!html) return "";
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function hasText(html: string | undefined, min = 1): boolean {
  return plainText(html).length >= min;
}

/** Sort by the backlog order field, then id. Items without an order go last. */
export function byOrder(a: WorkItem, b: WorkItem): number {
  const x = a.order ?? Number.MAX_SAFE_INTEGER;
  const y = b.order ?? Number.MAX_SAFE_INTEGER;
  return x - y || a.id - b.id;
}

export function fmtDate(iso: string | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, opts);
}

export function fmtDays(days: number): string {
  if (days < 1) return "0d";
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.round(days / 30.4)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** Is this area one of the team's? (No areas known: everything counts.) */
export function inTeamAreas(area: string, areas: { path: string; includeChildren: boolean }[]): boolean {
  return !areas.length || areas.some((a) => area === a.path || (a.includeChildren && area.startsWith(a.path + "\\")));
}

/** The last segment of an area or iteration path. */
export function leaf(path: string): string {
  const i = path.lastIndexOf("\\");
  return i < 0 ? path : path.slice(i + 1);
}

export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "\\");
}

/** Working days (Mon–Fri or the team's days) between two dates, both included, minus days off. */
export function workingDays(startIso: string, endIso: string, workDays: number[], daysOff: { start: string; end: string }[] = []): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  let n = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    const d = new Date(t);
    if (!workDays.includes(d.getUTCDay())) continue;
    if (daysOff.some((o) => t >= Date.parse(o.start.slice(0, 10)) && t <= Date.parse(o.end.slice(0, 10)))) continue;
    n++;
  }
  return n;
}
