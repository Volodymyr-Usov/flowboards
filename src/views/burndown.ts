// Sprint burndown: remaining work per working day, from the sprint's tasks as they were at the end
// of each day (Azure DevOps answers "as of" a moment: two requests a day for up to 400 tasks).
// Pure logic, no page: covered by test/burndown.test.ts.
//
// A task counts on a day when it existed, sat in the sprint and was not closed.
import { isUnder } from "../core/model.ts";
import { dayKey, planDay, weekday } from "../core/timeaxis.ts";

/** A task as it is now: what decides the remaining work of a task closed without ever recording it. */
export interface TaskNow {
  id: number;
  state: string;
  /** original estimate (or completed + remaining) */
  estimate?: number;
}

/** The fields read as of each moment. */
export const AS_OF_FIELDS = (remainingField: string): string[] => ["System.State", "System.IterationPath", remainingField];

export interface BurndownSpec {
  sprintPath: string;
  start: string;
  finish: string;
  /** 0 = Sunday */
  workDays: number[];
  daysOff?: { start: string; end: string }[];
  /** reference name of the remaining work field */
  remainingField: string;
  /** state names that end the work (Completed and Removed categories) */
  closedStates: string[];
  now?: number;
}

export interface BurndownPoint {
  /** ISO date (yyyy-mm-dd) of the working day */
  date: string;
  ideal: number;
  /** remaining at the end of the day; null for days still to come */
  actual: number | null;
}

export interface Burndown {
  points: BurndownPoint[];
  /** remaining at the end of the first day: where the ideal line starts */
  start: number;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Remaining work of one task from its fields at a moment (0 when it did not exist, was not in the sprint, or was closed). */
export function remainingOf(fields: Record<string, unknown> | undefined, task: TaskNow, spec: Pick<BurndownSpec, "sprintPath" | "remainingField" | "closedStates">): number {
  if (!fields) return 0;
  if (!isUnder(String(fields["System.IterationPath"] ?? ""), spec.sprintPath)) return 0;
  if (spec.closedStates.includes(String(fields["System.State"] ?? ""))) return 0;
  const raw = fields[spec.remainingField];
  // never recorded, and closed since: before closing it still had its estimate left
  if ((raw == null || raw === "") && spec.closedStates.includes(task.state)) return num(task.estimate);
  return num(raw);
}

/**
 * Day keys (yyyy-mm-dd) of the working days from start to finish, both included, minus days off.
 * Sprint dates and days off are planning dates: read as the day they name in any time zone.
 */
export function sprintDays(start: string, finish: string, workDays: number[], daysOff: { start: string; end: string }[] = []): string[] {
  const a = planDay(start);
  const b = planDay(finish);
  const out: string[] = [];
  if (a == null || b == null) return out;
  const off = daysOff.map((o) => ({ s: planDay(o.start), e: planDay(o.end) })).filter((o): o is { s: number; e: number } => o.s != null && o.e != null);
  for (let d = a; d <= b; d++) {
    if (!workDays.includes(weekday(d))) continue;
    if (off.some((o) => d >= o.s && d <= o.e)) continue;
    out.push(dayKey(d));
  }
  return out;
}

/**
 * Did the "as of" reads miss history? Azure DevOps answers "as of" by when a change was saved, so
 * history written later with earlier dates (a migration from another tool, imported data) is not
 * seen: a task created before a moment, by its own date, is then missing from that moment's answer.
 */
export function missedHistory(asOf: (Map<number, unknown> | null)[], moments: (string | null)[], created: Map<number, string | undefined>): boolean {
  return moments.some((m, i) => {
    const snap = asOf[i];
    if (!m || !snap) return false;
    for (const [id, c] of created) if (c && c <= m && !snap.has(id)) return true;
    return false;
  });
}

/** The same answers as "as of", from each task's revisions (dated by System.ChangedDate). */
export function snapshotsFromRevisions(revs: Map<number, { changed: string; fields: Record<string, unknown> }[]>, moments: (string | null)[], fields: string[]): (Map<number, Record<string, unknown>> | null)[] {
  return moments.map((m) => {
    if (!m) return null;
    const t = Date.parse(m);
    const snap = new Map<number, Record<string, unknown>>();
    for (const [id, list] of revs) {
      let last: Record<string, unknown> | undefined;
      for (const r of list) if (Date.parse(r.changed) <= t) last = r.fields;
      if (last) snap.set(id, Object.fromEntries(fields.map((f) => [f, last![f]])));
    }
    return snap;
  });
}

/**
 * The tasks of a burndown: those in the sprint now and those that were in it at the end of any past
 * day (moved out since), each once. Taking only today's would rewrite the past days.
 */
export function everInSprint(now: number[], before: number[][]): number[] {
  return [...new Set([...now, ...before.flat()])].sort((a, b) => a - b);
}

/** The moment each working day is measured: its end (local time), or now for today; null for days still to come. */
export function dayMoments(days: string[], now = Date.now()): (string | null)[] {
  return days.map((d) => {
    // the person's own day: from local midnight to the next local midnight
    const [y, m, dd] = d.split("-").map(Number);
    const start = new Date(y, m - 1, dd).getTime();
    const end = new Date(y, m - 1, dd + 1).getTime() - 1;
    return start > now ? null : new Date(Math.min(end, now)).toISOString();
  });
}

/** Remaining work per working day, from the tasks' fields at each day's moment, with the ideal line. */
export function burndown(days: string[], asOf: (Map<number, Record<string, unknown>> | null)[], tasks: TaskNow[], spec: Pick<BurndownSpec, "sprintPath" | "remainingField" | "closedStates">): Burndown {
  const actual = days.map((_, i) => {
    const snap = asOf[i];
    if (!snap) return null;
    let sum = 0;
    for (const t of tasks) sum += remainingOf(snap.get(t.id), t, spec);
    return Math.round(sum * 10) / 10;
  });
  const start = actual[0] ?? 0;
  const n = days.length;
  const points = days.map((date, i) => ({
    date,
    ideal: n > 1 ? Math.round(start * (1 - i / (n - 1)) * 10) / 10 : 0,
    actual: actual[i],
  }));
  return { points, start };
}
