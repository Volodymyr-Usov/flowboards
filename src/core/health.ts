// Health checks over a team's loaded work, and the tag look-alike test used by Audits.
// Pure functions: no page, no network. Process-agnostic: levels by kind, states by category.
import { REL, relId } from "../api/api.ts";
import type { Iteration, Level, ProcessInfo, WorkItem } from "../api/types.ts";
import { DAY, daysSince, hasText, isDone, isOpen, isRemoved, levelOf, orderedStates } from "./model.ts";
import { planKey, todayKey } from "./timeaxis.ts";
import type { Filter, Prop } from "./filters.ts";
import { passesAll } from "./filters.ts";

export type Severity = "high" | "medium" | "low";

export type CheckId =
  | "noParent" | "noPortfolioParent" | "noOwner" | "noDescription" | "noAcceptance" | "noEstimate" | "stale"
  | "pastSprint" | "doneWithOpenChildren" | "canClose" | "childAhead" | "remainingOnDone" | "pastTarget";

/** What a quick fix button does for a finding of this check. */
export type FixKind = "owner" | "parent" | "sprint" | "close" | "start" | "open";

export interface CheckInfo { id: CheckId; title: string; about: string; severity: Severity; fix: FixKind }

/** A built-in check's id, or "c:<id>" for a check the team added. */
export interface Finding { checkId: CheckId | `c:${string}`; itemId: number; message: string; severity: Severity }

/** What a team-made check offers on each finding: open it, assign it, move it to a state, or set a field. */
export type CustomFix = { kind: "open" } | { kind: "assign" } | { kind: "state"; state: string } | { kind: "field"; field: string; value: string };

/** A check the team added on the Health page: the items that match every condition are findings. */
export interface CustomCheck {
  id: string;
  title: string;
  /** what the finding says, shown on each one */
  message: string;
  severity: Severity;
  when: Filter[];
  fix: CustomFix;
}

/** Findings of the team's own checks: every item that passes all of a check's conditions (a check with none finds nothing). */
export function runCustomChecks(items: Iterable<WorkItem>, checks: CustomCheck[], props: Map<string, Prop>): Finding[] {
  const out: Finding[] = [];
  const list = [...items];
  for (const c of checks) {
    if (!c.when.length) continue;
    for (const w of list) if (passesAll(w, c.when, props)) out.push({ checkId: `c:${c.id}`, itemId: w.id, message: c.message || c.title, severity: c.severity });
  }
  return out;
}

export interface HealthInput {
  items: Iterable<WorkItem>;
  process: ProcessInfo;
  /** in-progress items unchanged for more days than this are stale */
  staleDays: number;
  iterations: Iteration[];
  /** the team's backlog iteration (items there are not in a sprint) */
  backlogRoot?: string;
  /** "now" in milliseconds */
  today: number;
  /**
   * Linked children that are not among the items (another team's area, closed long ago), as read:
   * done, open, or gone (removed). A child missing here was not read: it may be open.
   */
  outside?: Map<number, ChildState>;
}

/** A linked child as read for "Could be closed": done, open (or could not be read), or gone (removed: does not count). */
export type ChildState = "done" | "open" | "gone";

/** The state of a child for "Could be closed"; a child that could not be read may be open. */
export const childState = (w: WorkItem | undefined): ChildState => (!w ? "open" : isRemoved(w) ? "gone" : isDone(w) ? "done" : "open");

export const AC_FIELD = "Microsoft.VSTS.Common.AcceptanceCriteria";

export const CHECKS: CheckInfo[] = [
  { id: "noOwner", title: "In progress, no owner", about: "Work that has started but nobody owns it.", severity: "high", fix: "owner" },
  { id: "pastSprint", title: "Left in a past sprint", about: "Open work whose sprint has ended.", severity: "high", fix: "sprint" },
  { id: "pastTarget", title: "Target date passed", about: "Open work whose target date is in the past.", severity: "high", fix: "open" },
  { id: "doneWithOpenChildren", title: "Done, children open", about: "Done work that still has open child items.", severity: "high", fix: "open" },
  { id: "stale", title: "Stale", about: "In progress but not changed for longer than the team's stale limit.", severity: "medium", fix: "open" },
  { id: "noParent", title: "No parent", about: "Backlog items that do not belong to any item on the level above.", severity: "medium", fix: "parent" },
  { id: "noEstimate", title: "In progress, no estimate", about: "Backlog items in progress without an estimate.", severity: "medium", fix: "open" },
  { id: "childAhead", title: "Child started first", about: "A child is in progress while its parent has not started.", severity: "medium", fix: "start" },
  { id: "remainingOnDone", title: "Remaining work on done item", about: "Tasks with remaining work under a done item.", severity: "medium", fix: "open" },
  { id: "noPortfolioParent", title: "Portfolio item, no parent", about: "Portfolio items (below the top level) without a parent.", severity: "low", fix: "parent" },
  { id: "noDescription", title: "No description", about: "Open backlog and portfolio items with an empty description.", severity: "low", fix: "open" },
  { id: "noAcceptance", title: "No acceptance criteria", about: "Open backlog items with empty acceptance criteria.", severity: "low", fix: "open" },
  { id: "canClose", title: "Could be closed", about: "Open items whose children are all done, also those in other teams' areas (an item shows once its links are read; a child that cannot be read counts as open).", severity: "low", fix: "close" },
];

export const CHECK_BY_ID: Record<CheckId, CheckInfo> = Object.fromEntries(CHECKS.map((c) => [c.id, c])) as Record<CheckId, CheckInfo>;

export function findingKey(f: { checkId: string; itemId: number }): string {
  return `${f.checkId}:${f.itemId}`;
}

/** Does the type have this field? Unknown field lists count as yes. */
export function typeHasField(p: ProcessInfo, type: string, field: string): boolean {
  const fields = p.types[type]?.fields;
  return !fields || !fields.length || fields.includes(field);
}

/** First state of these types in a category (workflow order), e.g. the "close" state. */
export function firstStateIn(p: ProcessInfo, type: string, category: "InProgress" | "Completed"): string | undefined {
  return orderedStates(p, [type]).find((s) => s.category === category)?.name;
}

/** Iteration paths whose sprint has ended. */
export function pastIterationPaths(iterations: Iteration[], today: number): Set<string> {
  const out = new Set<string>();
  for (const i of iterations) {
    const ended = i.finish ? Date.parse(i.finish) + DAY <= today : false;
    if (i.timeFrame === "past" || (i.timeFrame !== "current" && ended)) out.add(i.path);
  }
  return out;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Child ids from an item's links (empty when its links are not read). */
export function linkedChildren(it: WorkItem): number[] {
  return [...new Set((it.relations ?? []).filter((r) => r.rel === REL.child).map(relId).filter((id) => id > 0))];
}

/**
 * Open items whose loaded children are all done: "Could be closed" when their links show no other open child.
 * The page reads their links (and the children that are not loaded) before they are listed.
 */
export function closeCandidates(items: Iterable<WorkItem>): WorkItem[] {
  const list = [...items];
  const kids = new Map<number, WorkItem[]>();
  for (const it of list) if (it.parent) kids.set(it.parent, [...(kids.get(it.parent) ?? []), it]);
  return list.filter((it) => {
    const children = kids.get(it.id) ?? [];
    return isOpen(it) && !isDone(it) && children.length > 0 && children.every(isDone);
  });
}

/**
 * Can this item be closed now: every linked child (read just before) is done or removed, and at least one is done.
 * A child missing from `kids` could not be read and counts as open.
 */
export function closableNow(it: WorkItem, kids: Map<number, WorkItem>): boolean {
  if (!isOpen(it) || isDone(it) || !it.relations) return false;
  const states = linkedChildren(it).map((id) => childState(kids.get(id)));
  return states.includes("done") && !states.includes("open");
}

export function runChecks(input: HealthInput): Finding[] {
  const { process: p, today } = input;
  const items = [...input.items];
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map<number, WorkItem[]>();
  for (const it of items) {
    if (!it.parent) continue;
    let l = kids.get(it.parent);
    if (!l) kids.set(it.parent, (l = []));
    l.push(it);
  }
  const topRank = Math.min(...p.levels.map((l) => l.rank));
  const past = pastIterationPaths(input.iterations, today);
  const todayDay = todayKey(new Date(today));
  const out: Finding[] = [];
  const add = (checkId: CheckId, it: WorkItem, message: string): void => {
    out.push({ checkId, itemId: it.id, message, severity: CHECK_BY_ID[checkId].severity });
  };

  for (const it of items) {
    const level: Level | undefined = levelOf(p, it.type);
    if (!level) continue;
    const open = isOpen(it);
    const inProgress = it.category === "InProgress";
    const children = kids.get(it.id) ?? [];
    const parent = it.parent ? byId.get(it.parent) : undefined;

    if (open && !it.parent) {
      if (level.kind === "requirement") add("noParent", it, "Not linked to a parent.");
      else if (level.kind === "portfolio" && level.rank !== topRank) add("noPortfolioParent", it, "Not linked to a parent.");
    }
    if (inProgress && !it.assignedTo) add("noOwner", it, `${it.state}, but nobody owns it.`);
    if (open && level.kind !== "task" && !hasText(it.description)) add("noDescription", it, "The description is empty.");
    if (open && level.kind === "requirement" && typeHasField(p, it.type, AC_FIELD) && !hasText(it.acceptance)) {
      add("noAcceptance", it, "The acceptance criteria are empty.");
    }
    if (inProgress && level.kind === "requirement" && !(it.effort && it.effort > 0) && typeHasField(p, it.type, p.fields.effort)) {
      add("noEstimate", it, `${it.state}, but has no estimate.`);
    }
    if (inProgress) {
      const days = daysSince(it.changed, today);
      if (days > input.staleDays) add("stale", it, `Not changed for ${plural(days, "day")}.`);
    }
    if (open && it.iteration !== input.backlogRoot && past.has(it.iteration)) {
      add("pastSprint", it, `Still ${it.state} in a sprint that has ended (${it.iteration.split("\\").pop()}).`);
    }
    if (isDone(it) && children.length) {
      const openKids = children.filter((c) => !isDone(c) && isOpen(c));
      if (openKids.length) add("doneWithOpenChildren", it, `${it.state}, but ${plural(openKids.length, "child item")} still open.`);
    }
    // only once its links are read: a child that is not loaded (another team's area, closed long ago) may be open
    if (open && !isDone(it) && children.length && children.every(isDone) && it.relations) {
      const states = linkedChildren(it).filter((id) => !byId.has(id)).map((id) => input.outside?.get(id) ?? "open");
      const doneKids = children.length + states.filter((s) => s === "done").length;
      if (!states.includes("open")) add("canClose", it, doneKids === 1 ? "Its only child item is done." : `All ${plural(doneKids, "child item")} are done.`);
    }
    if (it.category === "Proposed" && open) {
      const started = children.filter((c) => c.category === "InProgress");
      if (started.length) add("childAhead", it, `Still ${it.state}, but ${plural(started.length, "child item")} in progress (#${started[0].id}${started.length > 1 ? "…" : ""}).`);
    }
    if (level.kind === "task" && (it.remaining ?? 0) > 0 && parent && isDone(parent)) {
      add("remainingOnDone", it, `${it.remaining} remaining, but #${parent.id} is ${parent.state}.`);
    }
    // a planning date is a day without a time (saved as local midnight): read it as that day
    const target = planKey(it.targetDate ?? it.dueDate);
    if (open && !isDone(it) && target && target < todayDay) {
      add("pastTarget", it, `Target date ${target} has passed.`);
    }
  }
  const order: string[] = CHECKS.map((c) => c.id);
  return out.sort((a, b) => order.indexOf(a.checkId) - order.indexOf(b.checkId) || a.itemId - b.itemId);
}

// ---------- tags (Audits) ----------

/** Tag text without case, spaces, hyphens or underscores: "Tech-debt" and "tech debt" are the same. */
export function tagKey(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]+/g, "");
}

/** Edit distance, but only answers "0, 1 or more" (returns 2 for anything above 1). */
export function editDistanceUpTo1(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) ? 1 : 2;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1) ? 1 : 2;
}

/** The word and the singular forms it may have ("boxes" → box, boxe; "stories" → story). */
function singulars(k: string): string[] {
  const out = [k];
  if (k.length > 4 && k.endsWith("ies")) out.push(k.slice(0, -3) + "y");
  if (k.length > 3 && k.endsWith("es")) out.push(k.slice(0, -2));
  if (k.length > 2 && k.endsWith("s") && !k.endsWith("ss")) out.push(k.slice(0, -1));
  return out;
}

/** The digit runs of a tag key ("sprint12" gives "12", "q12026" gives "12026"). */
const numbersIn = (k: string): string => (k.match(/\d+/g) ?? []).join("|");

/**
 * Are two tags likely the same thing? (case, spaces, hyphens, one typo in 5+ letters, singular/plural)
 * Tags with different numbers are different things (Q1-2026 and Q2-2026, sprint-12 and sprint-13),
 * and a plural needs 3+ letters before its "s" ("io" and "ios" are different).
 */
export function tagsAlike(a: string, b: string): boolean {
  const x = tagKey(a);
  const y = tagKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (numbersIn(x) !== numbersIn(y)) return false;
  const sx = singulars(x).filter((s) => s.length >= 3);
  if (singulars(y).some((s) => s.length >= 3 && sx.includes(s))) return true;
  return x.length >= 5 && y.length >= 5 && editDistanceUpTo1(x, y) <= 1;
}

/**
 * Groups (2 or more) of tag names that look alike, each sorted by name. A group is a tag (the most used
 * first, by `uses`) and the tags that each look like that one: no chains, so "abcde" ~ "abcdf" ~ "abcgf"
 * does not put "abcde" and "abcgf" together.
 */
export function duplicateTagGroups(names: string[], uses: (name: string) => number = () => 0): string[][] {
  const order = names.map((n, i) => ({ n, i, u: uses(n), k: tagKey(n) }))
    .sort((a, b) => b.u - a.u || a.n.localeCompare(b.n) || a.i - b.i);
  const taken = new Set<number>();
  const groups: string[][] = [];
  for (const lead of order) {
    if (taken.has(lead.i)) continue;
    taken.add(lead.i);
    const g = [lead.n];
    for (const o of order) {
      if (taken.has(o.i) || Math.abs(lead.k.length - o.k.length) > 3) continue;
      if (tagsAlike(lead.n, o.n)) { taken.add(o.i); g.push(o.n); }
    }
    if (g.length > 1) groups.push(g);
  }
  return groups.map((g) => g.sort((a, b) => a.localeCompare(b))).sort((a, b) => a[0].localeCompare(b[0]));
}

/** Replace one tag with another in a tag list (case-insensitive), without making a double. */
export function replaceTag(tags: string[], from: string, into: string): string[] {
  const f = from.toLowerCase();
  const out = tags.filter((t) => t.toLowerCase() !== f);
  if (!out.some((t) => t.toLowerCase() === into.toLowerCase())) out.push(into);
  return out;
}
