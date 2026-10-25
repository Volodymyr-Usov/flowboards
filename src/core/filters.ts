// Filters shared by every page that lists work items: any property (type, state, owner, tags, sprint,
// dates, numbers, or any other field that was read), each as "is any of / is none of" a list of values,
// a number range, a date range, or yes/no; person filters (only these people, hide those); and the
// text search. Pure logic, no page: tested in test/filters.test.ts. The page parts: src/ui/filterbar.ts.
import type { Person, WorkItem } from "../api/types.ts";
import { personKey } from "./model.ts";

export type PropKind = "set" | "number" | "date" | "bool";

export interface Prop {
  id: string;
  label: string;
  kind: PropKind;
  /** set: the item's values ("" = empty); number/date: one value or undefined; bool: yes or no */
  get: (w: WorkItem) => string[] | number | string | boolean | undefined;
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
const day = (iso: string | undefined): string | undefined => (iso ? iso.slice(0, 10) : undefined);
const ISO = /^\d{4}-\d\d-\d\dT/;

/** The fixed properties every work item has. */
export const BASE_PROPS: Prop[] = [
  { id: "type", label: "Type", kind: "set", get: (w) => [w.type] },
  { id: "state", label: "State", kind: "set", get: (w) => [w.state] },
  { id: "category", label: "State group", kind: "set", get: (w) => [w.category] },
  { id: "owner", label: "Owner", kind: "set", get: (w) => [w.assignedTo?.displayName ?? ""] },
  { id: "tags", label: "Tags", kind: "set", get: (w) => (w.tags.length ? w.tags : [""]) },
  { id: "sprint", label: "Sprint", kind: "set", get: (w) => [leafOf(w.iteration)] },
  { id: "area", label: "Area", kind: "set", get: (w) => [w.area] },
  { id: "column", label: "Board column", kind: "set", get: (w) => [w.boardColumn ?? ""] },
  { id: "priority", label: "Priority", kind: "set", get: (w) => [w.priority != null ? String(w.priority) : ""] },
  { id: "createdBy", label: "Created by", kind: "set", get: (w) => [w.createdBy?.displayName ?? ""] },
  { id: "changedBy", label: "Changed by", kind: "set", get: (w) => [w.changedBy?.displayName ?? ""] },
  { id: "effort", label: "Effort", kind: "number", get: (w) => w.effort },
  { id: "remaining", label: "Remaining work", kind: "number", get: (w) => w.remaining },
  { id: "created", label: "Created", kind: "date", get: (w) => day(w.created) },
  { id: "changed", label: "Changed", kind: "date", get: (w) => day(w.changed) },
  { id: "closed", label: "Closed", kind: "date", get: (w) => day(w.closed) },
  { id: "target", label: "Target date", kind: "date", get: (w) => day(w.targetDate ?? w.dueDate) },
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
        : kind === "date" ? (w) => { const v = raw(w); return typeof v === "string" ? v.slice(0, 10) : undefined; }
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
    const hit = vals.some((x) => f.values!.includes(x));
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

/** The values a set property takes across the items, most common first, with counts. */
export function valueCounts(items: Iterable<WorkItem>, p: Prop): { value: string; n: number }[] {
  const m = new Map<string, number>();
  for (const w of items) {
    const v = p.get(w);
    for (const x of Array.isArray(v) ? v : [String(v ?? "")]) m.set(x, (m.get(x) ?? 0) + 1);
  }
  return [...m].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

/** Short text for a filter chip, e.g. "State: Active, New" or "Effort: 3 to 8". */
export function describe(f: Filter, p: Prop | undefined): string {
  if (!p) return f.prop;
  const empty = (x: string): string => x || "(empty)";
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
