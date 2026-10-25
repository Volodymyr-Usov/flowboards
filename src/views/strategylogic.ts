// Pure helpers of the Strategy view: which pillar an Epic belongs to, pillars found in tags,
// work closed per month, and whether an Epic's state fits the work under it. No page, no network.
import type { Category } from "../api/types.ts";

export interface PillarLike { id: string; name: string; description?: string; color?: string }

/** The group key of Epics without a pillar. */
export const NO_PILLAR = "";
/** Value in epicPillars that says "this Epic has no pillar", even when it has a pillar tag. */
export const NONE_VALUE = "none";

/** The series color tokens a pillar may use, in their fixed order. */
export const SERIES_TOKENS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

/** A CSS color for a pillar: its saved token, or the token of its place in the list. */
export function pillarColor(color: string | undefined, index: number): string {
  const c = (color ?? "").trim();
  const token = SERIES_TOKENS.find((t) => t === c || t.slice(2) === c);
  return `var(${token ?? SERIES_TOKENS[((index % SERIES_TOKENS.length) + SERIES_TOKENS.length) % SERIES_TOKENS.length]})`;
}

/** Letters and digits of any script, lower case, joined by "-": "Рост" -> "рост", "Go Big" -> "go-big". */
export function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "pillar";
}

/** A short hash of a text (FNV-1a, base 36), the same every time. */
export function shortHash(s: string): string {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); }
  return (x >>> 0).toString(36);
}

/** Pillar names in an item's tags: "Pillar:Growth" -> "Growth" (prefix compared without case). */
export function pillarNamesFromTags(tags: string[], prefix: string): string[] {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (t.toLowerCase().startsWith(p)) {
      const name = t.slice(p.length).trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Pillars found in the tags of these Epics, by name, with stable ids and colors in order. */
export function derivePillars(tagLists: string[][], prefix: string): PillarLike[] {
  const names = new Map<string, string>();
  for (const tags of tagLists) for (const n of pillarNamesFromTags(tags, prefix)) if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), n);
  const sorted = [...names.values()].sort((a, b) => a.localeCompare(b));
  // same slug for different names ("C++", "C#"): the first keeps it, the others add a hash of the name
  const used = new Set<string>();
  return sorted.map((name, i) => {
    const base = "tag-" + slug(name);
    let id = used.has(base) ? `${base}-${shortHash(name.toLowerCase())}` : base;
    for (let n = 2; used.has(id); n++) id = `${base}-${shortHash(name.toLowerCase())}-${n}`;
    used.add(id);
    return { id, name, color: SERIES_TOKENS[i % SERIES_TOKENS.length] };
  });
}

/**
 * The pillar id of an Epic: the one set by hand (epicPillars), else the first pillar whose
 * tag "<prefix><name>" the Epic carries, else NO_PILLAR.
 */
export function pillarOfEpic(epicId: number, tags: string[], pillars: PillarLike[], manual: Record<string, string>, prefix: string): string {
  const m = manual[String(epicId)];
  if (m === NONE_VALUE) return NO_PILLAR;
  if (m && pillars.some((p) => p.id === m)) return m;
  const names = pillarNamesFromTags(tags, prefix).map((n) => n.toLowerCase());
  for (const n of names) {
    const p = pillars.find((x) => x.name.trim().toLowerCase() === n);
    if (p) return p.id;
  }
  return NO_PILLAR;
}

/**
 * Epics that would lose their pillar when pillars are renamed (or the tag prefix changes): they joined by
 * tag before and their pillar still exists, but their tag no longer names it. They get the pillar by id
 * in `manual`, so they stay. Gives the new manual choices and how many Epics were kept.
 */
export function keepRenamed(epics: { id: number; tags: string[] }[], before: PillarLike[], after: PillarLike[], manual: Record<string, string>,
  prefixBefore: string, prefixAfter: string): { epicPillars: Record<string, string>; kept: number[] } {
  const out = { ...manual };
  const kept: number[] = [];
  for (const e of epics) {
    if (manual[String(e.id)]) continue; // chosen by hand: stays as it is
    const was = pillarOfEpic(e.id, e.tags, before, {}, prefixBefore);
    if (was === NO_PILLAR || !after.some((p) => p.id === was)) continue;
    if (pillarOfEpic(e.id, e.tags, after, {}, prefixAfter) === was) continue;
    out[String(e.id)] = was;
    kept.push(e.id);
  }
  return { epicPillars: out, kept };
}

/** How the pillar was chosen, for the Epic card's select. */
export function pillarSource(epicId: number, manual: Record<string, string>, pillars: PillarLike[]): "manual" | "none" | "tag" {
  const m = manual[String(epicId)];
  if (m === NONE_VALUE) return "none";
  if (m && pillars.some((p) => p.id === m)) return "manual";
  return "tag";
}

/** "YYYY-MM" of the last n months (local time), oldest first, ending with the month of `now`. */
export function monthKeys(now: number, n = 12): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** The first day (local time) of the oldest month of monthKeys(now, n), as an ISO date "YYYY-MM-DD". */
export function monthsStart(now: number, n = 12): string {
  return monthKeys(now, n)[0] + "-01";
}

/** The same moment as a time: local midnight of that first day (the months are counted in local time). */
export function monthsStartTime(now: number, n = 12): number {
  const [y, m] = monthKeys(now, n)[0].split("-").map(Number);
  return new Date(y, m - 1, 1).getTime();
}

export function monthKeyOf(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Count records per group per month. Records outside the months are left out. */
export function countByMonth<K>(records: { closed?: string; group: K | undefined }[], months: string[]): Map<K, number[]> {
  const out = new Map<K, number[]>();
  const idx = new Map(months.map((m, i) => [m, i]));
  for (const r of records) {
    if (r.group === undefined) continue;
    const i = idx.get(monthKeyOf(r.closed));
    if (i === undefined) continue;
    let row = out.get(r.group);
    if (!row) out.set(r.group, (row = months.map(() => 0)));
    row[i]++;
  }
  return out;
}

/** Add month rows together (for a pillar: the rows of its Epics). */
export function sumRows(rows: (number[] | undefined)[], n: number): number[] {
  const out = new Array<number>(n).fill(0);
  for (const r of rows) if (r) for (let i = 0; i < n; i++) out[i] += r[i] ?? 0;
  return out;
}

/** The nearest ancestor (the item itself excluded) that passes `is`, walking at most `max` steps. */
export function findAncestor(start: number, parentOf: (id: number) => number | undefined, is: (id: number) => boolean, max = 12): number | undefined {
  const seen = new Set<number>([start]);
  let p = parentOf(start);
  for (let i = 0; p && i < max && !seen.has(p); i++) {
    if (is(p)) return p;
    seen.add(p);
    p = parentOf(p);
  }
  return undefined;
}

/** Done and total of a set of items, each id counted once (the last copy wins). Removed items are left out. */
export function progressOf(items: { id: number; category: Category }[]): { done: number; total: number } {
  const byId = new Map<number, Category>();
  for (const i of items) byId.set(i.id, i.category);
  let done = 0;
  let total = 0;
  for (const c of byId.values()) {
    if (c === "Removed") continue;
    total++;
    if (c === "Resolved" || c === "Completed") done++;
  }
  return { done, total };
}

/**
 * Does an Epic's state fit the work under it? A sentence when it does not:
 *  - not started (Proposed) while work under it has started or finished
 *  - done (Resolved or Completed) while work under it is still open
 *  - in progress while everything under it is done
 */
export function stateMismatch(category: Category, below: Category[]): string | null {
  const live = below.filter((c) => c !== "Removed");
  if (!live.length) return null;
  const open = live.filter((c) => c === "Proposed" || c === "InProgress").length;
  const started = live.filter((c) => c !== "Proposed").length;
  if (category === "Proposed" && started) return `Not started, but ${started} item${started === 1 ? "" : "s"} under it ${started === 1 ? "has" : "have"} started or finished.`;
  if ((category === "Resolved" || category === "Completed") && open) return `Done, but ${open} item${open === 1 ? " is" : "s are"} under it still open.`;
  if (category === "InProgress" && !open) return "In progress, but all work under it is done.";
  return null;
}
