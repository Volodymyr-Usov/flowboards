// Filters shared by every page that lists work items: any property (type, state, owner, tags, sprint,
// dates, numbers, or any other field that was read), each as "is any of / is none of" a list of values,
// a number range, a date range, or yes/no; person filters (only these people, hide those); and the
// text search. Pure logic, no page: tested in test/filters.test.ts. The page parts: src/ui/filterbar.ts.
import type { Person, WorkItem } from "../api/types.ts";
import { dayKey, localDay, planKey } from "./timeaxis.ts";
import { personKey } from "./model.ts";

export type PropKind = "set" | "number" | "date" | "bool";

export interface Prop {
  id: string;
  label: string;
  kind: PropKind;
  /** set: the item's values ("" = empty); number/date: one value or undefined; bool: yes or no */
  get: (w: WorkItem) => string[] | number | string | boolean | undefined;
  /** set: the words shown for the item's values, in the same order (a person's name for their sign-in, a sprint's
   *  name for its path); without it the values themselves show. Filters saved with these words still match. */
  shown?: (w: WorkItem) => string[];
  /** set: values match whatever their case (tags) */
  fold?: boolean;
}

export interface Filter {
  prop: string;
  /** set: "any" (is any of) or "none" (is none of) */
  op?: "any" | "none";
  values?: string[];
  min?: number;
  max?: number;
  /** dates as YYYY-MM-DD, both ends included */
  from?: string;
  to?: string;
  is?: boolean;
}

const leafOf = (path: string): string => path.split("\\").pop() ?? path;
/** a person in property filters: the sign-in name (lower case; two people can share a display name), "" for nobody */
const who = (p: Person | undefined): string => (p ? personKey(p) : "");
const nameOf = (p: Person | undefined): string => p?.displayName ?? "";
/** a moment (created, changed, closed): its day in the local calendar */
const day = (iso: string | undefined): string | undefined => (iso && !Number.isNaN(Date.parse(iso)) ? dayKey(localDay(iso)) : undefined);
/** a planning date (target, due, a date field): the day the person picked, in any time zone */
const planDate = (iso: string | undefined): string | undefined => planKey(iso) || undefined;
const ISO = /^\d{4}-\d\d-\d\dT/;

/** The fixed properties every work item has. */
export const BASE_PROPS: Prop[] = [
  { id: "type", label: "Type", kind: "set", get: (w) => [w.type] },
  { id: "state", label: "State", kind: "set", get: (w) => [w.state] },
  { id: "category", label: "State group", kind: "set", get: (w) => [w.category] },
  { id: "owner", label: "Owner", kind: "set", get: (w) => [who(w.assignedTo)], shown: (w) => [nameOf(w.assignedTo)] },
  { id: "tags", label: "Tags", kind: "set", get: (w) => (w.tags.length ? w.tags : [""]), fold: true },
  // the full path: two teams can each have a "Sprint 4"
  { id: "sprint", label: "Sprint", kind: "set", get: (w) => [w.iteration], shown: (w) => [leafOf(w.iteration)] },
  { id: "area", label: "Area", kind: "set", get: (w) => [w.area] },
  { id: "column", label: "Board column", kind: "set", get: (w) => [w.boardColumn ?? ""] },
  { id: "priority", label: "Priority", kind: "set", get: (w) => [w.priority != null ? String(w.priority) : ""] },
  { id: "createdBy", label: "Created by", kind: "set", get: (w) => [who(w.createdBy)], shown: (w) => [nameOf(w.createdBy)] },
  { id: "changedBy", label: "Changed by", kind: "set", get: (w) => [who(w.changedBy)], shown: (w) => [nameOf(w.changedBy)] },
  { id: "effort", label: "Effort", kind: "number", get: (w) => w.effort },
  { id: "remaining", label: "Remaining work", kind: "number", get: (w) => w.remaining },
  { id: "created", label: "Created", kind: "date", get: (w) => day(w.created) },
  { id: "changed", label: "Changed", kind: "date", get: (w) => day(w.changed) },
  { id: "closed", label: "Closed", kind: "date", get: (w) => day(w.closed) },
  { id: "target", label: "Target date", kind: "date", get: (w) => planDate(w.targetDate ?? w.dueDate) },
  { id: "hasDesc", label: "Has a description", kind: "bool", get: (w) => Boolean(w.description && w.description.replace(/<[^>]*>/g, "").trim()) },
  { id: "hasAc", label: "Has acceptance criteria", kind: "bool", get: (w) => Boolean(w.acceptance && w.acceptance.replace(/<[^>]*>/g, "").trim()) },
  { id: "hasParent", label: "Has a parent", kind: "bool", get: (w) => Boolean(w.parent) },
  { id: "hasEffort", label: "Has an estimate", kind: "bool", get: (w) => w.effort != null },
];

/** Fields shown already as a plain property above, or not useful to filter on. */
const SKIP_FIELDS = /^(System\.(Id|Rev|Title|TeamProject|WorkItemType|State|Reason|AssignedTo|AreaPath|AreaId|IterationPath|IterationId|Tags|CreatedBy|ChangedBy|CreatedDate|ChangedDate|BoardColumn|BoardColumnDone|BoardLane|Description|History|Parent|Watermark|NodeName|AuthorizedAs|AuthorizedDate|RevisedDate|PersonId|CommentCount|AreaLevel\d|IterationLevel\d)|Microsoft\.VSTS\.(Common\.(AcceptanceCriteria|StackRank|BacklogPriority|Priority|ClosedDate|ClosedBy|ActivatedDate|ResolvedDate|StateChangeDate)|Scheduling\.(StoryPoints|Effort|Size|RemainingWork|TargetDate|DueDate)))$|^WEF_.*_Kanban\./;

/**
 * Properties for the extra fields the items carry (any field read but not mapped), typed by their values.
 * Items are read with different field lists (a list read asks for some fields, a full read has all),
 * and Azure DevOps leaves out empty fields. So a field is offered only when every item was read with
 * it: then an item without a value really has none ("(empty)"), and is not just "not read".
 */
export function fieldProps(items: Iterable<WorkItem>, names: Record<string, string> = {}): Prop[] {
  const seen = new Map<string, { num: number; date: number; bool: number; text: number }>();
  // the different field lists the items were read with (most items share one list)
  const lists = new Map<readonly string[], Set<string>>();
  for (const w of items) {
    if (w.fieldsRead && !lists.has(w.fieldsRead)) lists.set(w.fieldsRead, new Set(w.fieldsRead.map((f) => f.toLowerCase())));
    for (const [ref, v] of Object.entries(w.fields ?? {})) {
      if (SKIP_FIELDS.test(ref)) continue;
      if (v == null || v === "") continue;
      const s = seen.get(ref) ?? { num: 0, date: 0, bool: 0, text: 0 };
      if (typeof v === "number") s.num++;
      else if (typeof v === "boolean") s.bool++;
      else if (typeof v === "string" && ISO.test(v)) s.date++;
      else if (typeof v === "string" || (typeof v === "object" && v && "displayName" in v)) s.text++;
      else continue;
      seen.set(ref, s);
    }
  }
  const out: Prop[] = [];
  for (const [ref, s] of seen) {
    if ([...lists.values()].some((l) => !l.has(ref.toLowerCase()))) continue; // not read for every item
    const label = names[ref] ?? ref.split(".").pop()!.replace(/([a-z])([A-Z])/g, "$1 $2");

    const kind: PropKind = s.text ? "set" : s.date ? "date" : s.bool && !s.num ? "bool" : "number";
    const raw = (w: WorkItem): unknown => w.fields?.[ref];
    out.push({
      id: `field:${ref}`, label, kind,
      get: kind === "set" ? (w) => { const v = raw(w); return [v == null ? "" : typeof v === "object" ? String((v as { displayName?: string }).displayName ?? "") : String(v)]; }
        : kind === "date" ? (w) => { const v = raw(w); return typeof v === "string" ? planDate(v) : undefined; }
        : kind === "bool" ? (w) => Boolean(raw(w))
        : (w) => { const v = raw(w); return typeof v === "number" ? v : undefined; },
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Is a filter set (has something to check)? */
export function isActive(f: Filter, p: Prop | undefined): boolean {
  if (!p) return false;
  if (p.kind === "set") return Boolean(f.values?.length);
  if (p.kind === "number") return f.min != null || f.max != null;
  if (p.kind === "date") return Boolean(f.from || f.to);
  return f.is != null;
}

/** Does the item pass one filter? (An unset filter lets everything pass.) */
export function passes(w: WorkItem, f: Filter, p: Prop | undefined): boolean {
  if (!p || !isActive(f, p)) return true;
  const v = p.get(w);
  if (p.kind === "set") {
    const vals = Array.isArray(v) ? v : [String(v ?? "")];
    const want = p.fold ? f.values!.map((x) => x.toLowerCase()) : f.values!;
    const has = (x: string): boolean => want.includes(p.fold ? x.toLowerCase() : x);
    // filters saved before values were sign-ins and paths hold the shown words (a name, a sprint's name): they still match
    const hit = vals.some(has) || Boolean(p.shown?.(w).some((x) => x !== "" && has(x)));
    return f.op === "none" ? !hit : hit;
  }
  if (p.kind === "number") {
    if (typeof v !== "number") return false;
    return (f.min == null || v >= f.min) && (f.max == null || v <= f.max);
  }
  if (p.kind === "date") {
    if (typeof v !== "string" || !v) return false;
    return (!f.from || v >= f.from) && (!f.to || v <= f.to);
  }
  return Boolean(v) === f.is;
}

/** Does the item pass every filter? */
export function passesAll(w: WorkItem, filters: Filter[], props: Map<string, Prop>): boolean {
  return filters.every((f) => passes(w, f, props.get(f.prop)));
}

/** Two values of a property are the same (tags: whatever their case). */
export const sameValue = (p: Prop | undefined, a: string, b: string): boolean => (p?.fold ? a.toLowerCase() === b.toLowerCase() : a === b);

export interface ValueCount { value: string; n: number; label: string }

/** The values a set property takes across the items, most common first, with counts and the words shown for them. */
export function valueCounts(items: Iterable<WorkItem>, p: Prop): ValueCount[] {
  const m = new Map<string, ValueCount>();
  for (const w of items) {
    const v = p.get(w);
    const shown = p.shown?.(w);
    (Array.isArray(v) ? v : [String(v ?? "")]).forEach((x, i) => {
      // tags that differ only in case are one value: the first spelling met is kept
      const k = p.fold ? x.toLowerCase() : x;
      const c = m.get(k) ?? { value: x, n: 0, label: shown?.[i] || x };
      c.n++;
      m.set(k, c);
    });
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

/** The words shown for the values of a set property, by value (empty for a property that shows its values). */
export function valueLabels(items: Iterable<WorkItem>, p: Prop | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!p?.shown) return out;
  for (const w of items) {
    const v = p.get(w);
    const shown = p.shown(w);
    (Array.isArray(v) ? v : [String(v ?? "")]).forEach((x, i) => { if (!out.has(x) && shown[i]) out.set(x, shown[i]); });
  }
  return out;
}

/**
 * Filters saved with the shown words (a person's name, a sprint's name) instead of the values (sign-in, path):
 * each such word becomes the values it stands for among the items. The same list back when nothing changes.
 */
export function upgradeFilters(filters: Filter[], props: Map<string, Prop>, items: Iterable<WorkItem>): Filter[] {
  const list = [...items];
  let changed = false;
  const out = filters.map((f) => {
    const p = props.get(f.prop);
    if (!p?.shown || p.kind !== "set" || !f.values?.length) return f;
    const labels = valueLabels(list, p);
    const values: string[] = [];
    for (const v of f.values) {
      const stands = v === "" || labels.has(v) ? [] : [...labels].filter(([, l]) => l === v).map(([k]) => k);
      for (const x of stands.length ? stands : [v]) if (!values.includes(x)) values.push(x);
    }
    if (values.length === f.values.length && values.every((x, i) => x === f.values![i])) return f;
    changed = true;
    return { ...f, values };
  });
  return changed ? out : filters;
}

/** The chip of a filter whose property is no longer offered (a field no item has now). */
export const goneLabel = (prop: string): string => `${prop.startsWith("field:") ? prop.slice(6) : prop}: (field no longer available)`;

/** Short text for a filter chip, e.g. "State: Active, New" or "Effort: 3 to 8". `show` gives the words for a value. */
export function describe(f: Filter, p: Prop | undefined, show: (value: string) => string = (v) => v): string {
  if (!p) return f.prop;
  const empty = (x: string): string => (x ? show(x) || x : "(empty)");
  if (p.kind === "set") {
    const vals = f.values ?? [];
    const list = vals.length > 3 ? `${vals.slice(0, 2).map(empty).join(", ")} and ${vals.length - 2} more` : vals.map(empty).join(", ");
    return vals.length ? `${p.label}${f.op === "none" ? " is not" : ":"} ${list}` : `${p.label}: any`;
  }
  if (p.kind === "number") {
    if (f.min != null && f.max != null) return `${p.label}: ${f.min} to ${f.max}`;
    if (f.min != null) return `${p.label}: ${f.min} or more`;
    if (f.max != null) return `${p.label}: ${f.max} or less`;
    return `${p.label}: any`;
  }
  if (p.kind === "date") {
    if (f.from && f.to) return `${p.label}: ${f.from} to ${f.to}`;
    if (f.from) return `${p.label}: from ${f.from}`;
    if (f.to) return `${p.label}: until ${f.to}`;
    return `${p.label}: any`;
  }
  return f.is == null ? `${p.label}: any` : `${p.label}: ${f.is ? "yes" : "no"}`;
}

// ---------- saved filters ----------

const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const dayText = (v: unknown): string | undefined => (typeof v === "string" && DAY_RE.test(v) ? v : undefined);

/** Filters read back from storage: damaged entries are left out, damaged parts dropped. */
export function cleanFilters(raw: unknown): Filter[] {
  if (!Array.isArray(raw)) return [];
  const out: Filter[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    const r = x as Record<string, unknown>;
    if (typeof r.prop !== "string" || !r.prop) continue;
    const f: Filter = { prop: r.prop };
    if (r.op === "any" || r.op === "none") f.op = r.op;
    if (Array.isArray(r.values)) f.values = r.values.filter((v): v is string => typeof v === "string");
    const min = num(r.min), max = num(r.max), from = dayText(r.from), to = dayText(r.to);
    if (min != null) f.min = min;
    if (max != null) f.max = max;
    if (from) f.from = from;
    if (to) f.to = to;
    if (typeof r.is === "boolean") f.is = r.is;
    out.push(f);
  }
  return out;
}

/** Where the screen choices are read and written (prefs in the app; a plain map in the tests). */
export interface ChoiceStore { get: (key: string) => unknown; set: (key: string, value: unknown) => void }

/**
 * The key of a page's filters for one team (`board.filters@Org/Project/Team`), so each team keeps its own.
 * The first time, the filters kept under the page's old key (one for every team) move there, once:
 * the old key is emptied, so another team does not start with them too.
 */
export function teamKey(store: ChoiceStore, key: string, scope: string, empty: unknown, isEmpty: (v: unknown) => boolean): string {
  if (!scope) return key;
  const k = `${key}@${scope}`;
  if (store.get(k) === undefined) {
    const old = store.get(key);
    if (old !== undefined && !isEmpty(old)) { store.set(k, old); store.set(key, empty); }
  }
  return k;
}

// ---------- people ----------

/** The key of "nobody" (no owner) in person filters. */
export const NOBODY = "__nobody__";

/** A person's key in person filters; NOBODY when there is no person. */
export const keyOfPerson = (p: Person | undefined): string => (p ? personKey(p) : NOBODY);

/** Person filters: show only these people (when any), and never those. */
export interface PeoplePick { only: string[]; hidden: string[] }

/** Person filters read back from storage: anything damaged becomes empty. */
export function cleanPeople(raw: unknown): PeoplePick {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { only: list(r.only), hidden: list(r.hidden) };
}

/** Does a person (by key) pass the person filters? */
export function personPasses(key: string, pick: PeoplePick): boolean {
  if (pick.only.length && !pick.only.includes(key)) return false;
  return !pick.hidden.includes(key);
}

/** Click ("only": show only this person too, or stop) or right-click ("hide": hide, or show again). */
export function togglePerson(pick: PeoplePick, key: string, how: "only" | "hide"): PeoplePick {
  if (how === "only") {
    const on = pick.only.includes(key);
    return { only: on ? pick.only.filter((x) => x !== key) : [...pick.only, key], hidden: pick.hidden.filter((x) => x !== key) };
  }
  const off = pick.hidden.includes(key);
  return { only: pick.only.filter((x) => x !== key), hidden: off ? pick.hidden.filter((x) => x !== key) : [...pick.hidden, key] };
}

export interface PersonCount { key: string; person?: Person; n: number }

/** People of the items with how many each has: nobody first, then the most first, then by name.
 *  `extra` adds people who have none (they show with 0). */
export function countPeople(items: Iterable<WorkItem>, personOf: (w: WorkItem) => Person | undefined = (w) => w.assignedTo, extra: Person[] = []): PersonCount[] {
  const m = new Map<string, PersonCount>();
  for (const w of items) {
    const p = personOf(w);
    const k = keyOfPerson(p);
    const x = m.get(k) ?? { key: k, person: p, n: 0 };
    x.n++;
    m.set(k, x);
  }
  for (const p of extra) { const k = keyOfPerson(p); if (!m.has(k)) m.set(k, { key: k, person: p, n: 0 }); }
  const name = (c: PersonCount): string => c.person?.displayName ?? "";
  return [...m.values()].sort((a, b) => (a.key === NOBODY ? -1 : b.key === NOBODY ? 1 : b.n - a.n || name(a).localeCompare(name(b))));
}

// ---------- search ----------

/** The words of a search box, lower case. */
export const searchWords = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Search: every word must appear somewhere in the item's text (id, title, tags, owner, state, column, sprint, extra). */
export function textMatch(words: string[], w: WorkItem, extra = ""): boolean {
  if (!words.length) return true;
  const hay = `#${w.id} ${w.id} ${w.title} ${w.tags.join(" ")} ${w.assignedTo?.displayName ?? ""} ${w.state} ${w.boardColumn ?? ""} ${w.iteration} ${extra}`.toLowerCase();
  return words.every((x) => hay.includes(x));
}
