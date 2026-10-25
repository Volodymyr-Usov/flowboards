// The Scheduler's rules, with no page code: when a schedule is due, what story it makes, who gets it.
// A schedule says WHEN (a trigger) and WHAT (a template); the engine (app/scheduler.ts) creates a story for
// every occurrence that is due and not made yet. Dates are plain "YYYY-MM-DD" days in the browser's own
// calendar, so nothing here depends on a time zone or on daylight saving.
import type { Iteration } from "../api/types.ts";
import type { ChildTemplate } from "./templates.ts";
import { cleanTemplates } from "./templates.ts";

/** How far back a missed occurrence is still made when the page was not open (the owner's rule: one week). */
export const BACKFILL_DAYS = 7;

export type Trigger =
  /** on one date */
  | { kind: "date"; date: string }
  /** an outlook: the story appears `leadDays` before the date and carries the date as its target */
  | { kind: "outlook"; date: string; leadDays: number }
  /** every `everyWeeks` weeks on these weekdays (0 = Sunday … 6 = Saturday) */
  | { kind: "weekly"; weekdays: number[]; everyWeeks: number }
  /** every `everyMonths` months on this day (1–31; 0 = the last day of the month) */
  | { kind: "monthly"; day: number; everyMonths: number }
  /** bound to the team's sprints: at the start, the middle or the end, moved by `offsetDays` */
  | { kind: "sprint"; at: "start" | "mid" | "end"; offsetDays: number; everySprints: number }
  /** bound to a calendar period: the start or end of a month or a quarter, moved by `offsetDays` */
  | { kind: "period"; at: "month-start" | "month-end" | "quarter-start" | "quarter-end"; offsetDays: number };

export interface Template {
  /** the story's title; {date} {day} {week} {month} {quarter} {year} {sprint} are replaced */
  title: string;
  /** plain text; blank lines and "- " lists are kept */
  description: string;
  /** nobody, one person, the next person in turn, or one picked at random from the pool */
  assign: { mode: "none" | "person" | "rotate" | "random"; person: string; /** who the turn or the draw is among; empty = the whole team */ pool: string[] };
  /** whether the story comes with tasks: none, the team's standard tasks, or its own list */
  tasks: { mode: "none" | "standard" | "custom"; custom: ChildTemplate[] };
  /** where the story goes: the backlog, the current sprint, the next sprint, the sprint of the occurrence, or one chosen sprint (`iteration`) */
  placement: "backlog" | "current" | "next" | "occurrence" | "fixed";
  /** the chosen sprint's path, for "fixed" */
  iteration: string;
  /** the board column (or state, without board columns) the story starts in; empty = where Azure DevOps puts a new story */
  column: string;
  tags: string[];
}

export interface Schedule {
  id: string;
  __etag?: number;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  template: Template;
  /** the day it was made: nothing earlier than this is made afterwards */
  created: string;
  by?: string;
}

/** One time a schedule is due. `date` is when the story is made; `key` is the same for the same occurrence everywhere. */
export interface Occurrence {
  key: string;
  date: string;
  /** an outlook's target date */
  due?: string;
  sprint?: { name: string; path: string; start: string; finish: string };
}

export interface ScheduleContext { iterations: Iteration[] }

// ---------- days ----------

/** A day as a whole number (days since 1970-01-01) and back: plain arithmetic, no time zones. */
export const dayNo = (s: string): number => {
  const [y, m, d] = s.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};
export const ymd = (n: number): string => new Date(n * 86400000).toISOString().slice(0, 10);
export const addDays = (s: string, n: number): string => ymd(dayNo(s) + n);
/** 0 = Sunday … 6 = Saturday */
export const weekdayOf = (s: string): number => (dayNo(s) + 4) % 7;
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(dayNo(s)) === s;
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthIndex = (s: string): number => Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
const dayOf = (index: number, d: number): string => {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, "0")}`;
};
const lastDayOf = (index: number): string => dayOf(index, 31);
const mondayOf = (n: number): number => n - ((n + 4 + 6) % 7);

/** Today in the browser's own calendar. */
export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const weekdayName = (n: number): string => WEEKDAYS[((n % 7) + 7) % 7];

/** The ISO week number (Monday starts the week; week 1 holds the year's first Thursday). */
export function isoWeek(s: string): number {
  const n = dayNo(s);
  const thursday = n - ((n + 4 + 6) % 7) + 3;
  const jan1 = dayNo(`${ymd(thursday).slice(0, 4)}-01-01`);
  return Math.floor((thursday - jan1) / 7) + 1;
}

// ---------- when ----------

const sprintsOf = (ctx: ScheduleContext) => ctx.iterations
  .filter((i) => i.start && i.finish)
  .map((i) => ({ name: i.name, path: i.path, start: i.start!.slice(0, 10), finish: i.finish!.slice(0, 10) }))
  .sort((a, b) => a.start.localeCompare(b.start));

/**
 * Every occurrence of a schedule made on a day from `from` to `to` (both included), earliest first.
 * Nothing before the day the schedule was made.
 */
export function occurrences(s: Schedule, ctx: ScheduleContext, from: string, to: string): Occurrence[] {
  const lo = dayNo(from > s.created ? from : s.created);
  const hi = dayNo(to);
  if (hi < lo) return [];
  const t = s.trigger;
  const out: Occurrence[] = [];
  const add = (n: number, extra: Partial<Occurrence> = {}): void => { if (n >= lo && n <= hi) out.push({ key: ymd(n), date: ymd(n), ...extra }); };
  switch (t.kind) {
    case "date": if (isDay(t.date)) add(dayNo(t.date)); break;
    case "outlook": if (isDay(t.date)) add(dayNo(t.date) - Math.max(0, Math.round(t.leadDays)), { due: t.date }); break;
    case "weekly": {
      const every = Math.max(1, Math.round(t.everyWeeks));
      const anchor = mondayOf(dayNo(s.created));
      for (let n = lo; n <= hi; n++) {
        if (!t.weekdays.includes(weekdayOf(ymd(n)))) continue;
        if (((mondayOf(n) - anchor) / 7) % every === 0) add(n);
      }
      break;
    }
    case "monthly": {
      const every = Math.max(1, Math.round(t.everyMonths));
      const anchor = monthIndex(s.created);
      for (let m = monthIndex(ymd(lo)); m <= monthIndex(ymd(hi)); m++) {
        if ((m - anchor) % every !== 0) continue;
        add(dayNo(t.day === 0 ? lastDayOf(m) : dayOf(m, Math.max(1, Math.min(31, Math.round(t.day))))));
      }
      break;
    }
    case "sprint": {
      const every = Math.max(1, Math.round(t.everySprints));
      sprintsOf(ctx).forEach((sp, i) => {
        if (i % every !== 0) return;
        const a = dayNo(sp.start);
        const b = dayNo(sp.finish);
        const base = t.at === "start" ? a : t.at === "end" ? b : a + Math.floor((b - a) / 2);
        add(base + Math.round(t.offsetDays), { sprint: sp });
      });
      break;
    }
    case "period": {
      const offset = Math.round(t.offsetDays);
      // a month either side: an offset can move a day into the range from the next or the last month
      for (let m = monthIndex(ymd(lo)) - 2; m <= monthIndex(ymd(hi)) + 2; m++) {
        const inQuarter = m % 3;
        if (t.at === "month-start") add(dayNo(dayOf(m, 1)) + offset);
        else if (t.at === "month-end") add(dayNo(lastDayOf(m)) + offset);
        else if (t.at === "quarter-start" && inQuarter === 0) add(dayNo(dayOf(m, 1)) + offset);
        else if (t.at === "quarter-end" && inQuarter === 2) add(dayNo(lastDayOf(m)) + offset);
      }
      break;
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** What is due today: made on a day within the last week (or today), nothing from before the schedule existed. */
export function dueOccurrences(s: Schedule, ctx: ScheduleContext, today: string): Occurrence[] {
  return occurrences(s, ctx, addDays(today, -BACKFILL_DAYS), today);
}

/** The next occurrence after today (a year ahead at most), or undefined. */
export function nextOccurrence(s: Schedule, ctx: ScheduleContext, today: string): Occurrence | undefined {
  return occurrences({ ...s, created: s.created < today ? s.created : today }, ctx, addDays(today, 1), addDays(today, 400))[0];
}

// ---------- what ----------

/** The title with its {tokens} replaced for this occurrence. */
export function renderTitle(title: string, o: Occurrence): string {
  const [y, m] = [Number(o.date.slice(0, 4)), Number(o.date.slice(5, 7))];
  const table: Record<string, string> = {
    date: o.date, day: weekdayName(weekdayOf(o.date)), week: String(isoWeek(o.date)), month: MONTHS[m - 1], year: String(y),
    quarter: `Q${Math.floor((m - 1) / 3) + 1}`, sprint: o.sprint?.name ?? "",
  };
  const out = title.replace(/\{(\w+)\}/g, (all, k: string) => (k in table ? table[k] : all)).replace(/\s+/g, " ").trim();
  return out.slice(0, 255);
}

/** A short hash of text as a number (for a draw that gives the same answer on every screen). */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Who gets the story: nobody, the named person, the next one after `last` in the pool (a turn), or one
 * drawn from the pool by the occurrence's key, so a retry on another screen draws the same person.
 */
export function pickAssignee(a: Template["assign"], team: string[], last: string | undefined, key: string): string | undefined {
  if (a.mode === "none") return undefined;
  if (a.mode === "person") return a.person || undefined;
  const pool = (a.pool.length ? a.pool : team).filter((x, i, all) => x && all.indexOf(x) === i).sort((x, y) => x.localeCompare(y));
  if (!pool.length) return undefined;
  if (a.mode === "random") return pool[seedOf(key) % pool.length];
  const at = last ? pool.indexOf(last) : -1;
  return pool[(at + 1) % pool.length];
}

/** The iteration path a story goes to. */
export function placementPath(t: Template, o: Occurrence, iterations: Iteration[], current: Iteration | undefined, backlog: string): string {
  if (t.placement === "backlog") return backlog;
  if (t.placement === "fixed") return t.iteration || backlog;
  if (t.placement === "occurrence" && o.sprint) return o.sprint.path;
  if (t.placement === "next") {
    const list = sprintsOf({ iterations });
    const now = current ? list.findIndex((s) => s.path === current.path) : -1;
    const next = list[now + 1];
    return next?.path ?? backlog;
  }
  return current?.path ?? backlog;
}

// ---------- text ----------

const SPRINT_AT = { start: "at the start of every sprint", mid: "in the middle of every sprint", end: "at the end of every sprint" };
const PERIOD_AT = { "month-start": "the first day of every month", "month-end": "the last day of every month", "quarter-start": "the first day of every quarter", "quarter-end": "the last day of every quarter" };
const move = (n: number): string => (n === 0 ? "" : n > 0 ? `, ${n} day${n === 1 ? "" : "s"} after` : `, ${-n} day${n === -1 ? "" : "s"} before`);

/** The trigger in words. */
export function describeTrigger(t: Trigger): string {
  switch (t.kind) {
    case "date": return `On ${t.date}`;
    case "outlook": return `Outlook: ${t.leadDays} day${t.leadDays === 1 ? "" : "s"} before ${t.date}, with that date as its target`;
    case "weekly": {
      const days = [...t.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(weekdayName).join(", ");
      return `${t.everyWeeks > 1 ? `Every ${t.everyWeeks} weeks` : "Every week"} on ${days || "no day"}`;
    }
    case "monthly": return `${t.everyMonths > 1 ? `Every ${t.everyMonths} months` : "Every month"} on ${t.day === 0 ? "the last day" : `day ${t.day}`}`;
    case "sprint": return `${SPRINT_AT[t.at].replace("every sprint", t.everySprints > 1 ? `every ${t.everySprints} sprints` : "every sprint")}${move(t.offsetDays)}`.replace(/^./, (c) => c.toUpperCase());
    case "period": return `On ${PERIOD_AT[t.at]}${move(t.offsetDays)}`;
  }
}

// ---------- the document, read safely ----------

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

export const blankTemplate = (): Template => ({
  title: "", description: "", assign: { mode: "none", person: "", pool: [] }, tasks: { mode: "none", custom: [] }, placement: "backlog", iteration: "", column: "", tags: [],
});

export function blankTrigger(today: string): Trigger { return { kind: "weekly", weekdays: [1], everyWeeks: 1 }; }

export function blankSchedule(id: string, today: string): Schedule {
  return { id, name: "", enabled: true, trigger: blankTrigger(today), template: blankTemplate(), created: today };
}

/** A schedule as stored, made safe: a damaged or older document gives something that still works, or null. */
export function cleanSchedule(raw: unknown): Schedule | null {
  const r = raw as Partial<Schedule> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.trigger || typeof r.trigger !== "object") return null;
  const t = r.trigger as Record<string, unknown>;
  let trigger: Trigger;
  switch (t.kind) {
    case "date": if (!isDay(t.date)) return null; trigger = { kind: "date", date: t.date as string }; break;
    case "outlook": if (!isDay(t.date)) return null; trigger = { kind: "outlook", date: t.date as string, leadDays: num(t.leadDays, 14, 0, 365) }; break;
    case "weekly": trigger = { kind: "weekly", weekdays: [...new Set((Array.isArray(t.weekdays) ? t.weekdays : []).map(Number).filter((d) => d >= 0 && d <= 6))], everyWeeks: num(t.everyWeeks, 1, 1, 52) }; break;
    case "monthly": trigger = { kind: "monthly", day: num(t.day, 1, 0, 31), everyMonths: num(t.everyMonths, 1, 1, 12) }; break;
    case "sprint": trigger = { kind: "sprint", at: t.at === "mid" || t.at === "end" ? t.at : "start", offsetDays: num(t.offsetDays, 0, -60, 60), everySprints: num(t.everySprints, 1, 1, 12) }; break;
    case "period": trigger = { kind: "period", at: ["month-end", "quarter-start", "quarter-end"].includes(t.at as string) ? (t.at as "month-end") : "month-start", offsetDays: num(t.offsetDays, 0, -60, 60) }; break;
    default: return null;
  }
  const tp = (r.template ?? {}) as Partial<Template>;
  const a = (tp.assign ?? {}) as Partial<Template["assign"]>;
  const tk = (tp.tasks ?? {}) as Partial<Template["tasks"]>;
  const template: Template = {
    title: String(tp.title ?? "").slice(0, 255),
    description: String(tp.description ?? "").slice(0, 20000),
    assign: {
      mode: a.mode === "person" || a.mode === "rotate" || a.mode === "random" ? a.mode : "none",
      person: String(a.person ?? ""),
      pool: (Array.isArray(a.pool) ? a.pool : []).map(String).filter(Boolean),
    },
    tasks: { mode: tk.mode === "standard" || tk.mode === "custom" ? tk.mode : "none", custom: cleanTemplates(tk.custom) },
    placement: tp.placement === "current" || tp.placement === "next" || tp.placement === "occurrence" || (tp.placement === "fixed" && String(tp.iteration ?? "").trim()) ? tp.placement : "backlog",
    iteration: tp.placement === "fixed" ? String(tp.iteration ?? "").trim().slice(0, 400) : "",
    column: String(tp.column ?? "").trim().slice(0, 200),
    tags: (Array.isArray(tp.tags) ? tp.tags : []).map((x) => String(x).trim()).filter(Boolean),
  };
  return {
    id: r.id, __etag: r.__etag, name: String(r.name ?? "").slice(0, 120), enabled: r.enabled !== false, trigger, template,
    created: isDay(r.created) ? r.created : todayLocal(), by: typeof r.by === "string" ? r.by : undefined,
  };
}

/** What is wrong with a schedule, or "" when it is ready to save. */
export function scheduleProblem(s: Schedule): string {
  if (!s.name.trim()) return "Give the schedule a name.";
  if (!s.template.title.trim()) return "Give the story a title.";
  const t = s.trigger;
  if ((t.kind === "date" || t.kind === "outlook") && !isDay(t.date)) return "Pick the date.";
  if (t.kind === "weekly" && !t.weekdays.length) return "Pick at least one weekday.";
  if (s.template.assign.mode === "person" && !s.template.assign.person) return "Pick who gets the story, or choose another way to assign it.";
  if (s.template.placement === "occurrence" && t.kind !== "sprint") return "\"The sprint of the occurrence\" needs a sprint trigger.";
  return "";
}
