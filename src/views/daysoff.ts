// Days off and team events for the Calendar, without the page. Azure DevOps keeps days off per
// sprint (in the team's capacity); a range that spans sprints is split, and parts outside every
// sprint cannot be kept there. Covered by test/daysoff.test.ts.
import type { Capacity, Iteration, Person } from "../api/types.ts";
import type { Day } from "./timeaxis.ts";
import { dayKey, planDay, weekday } from "./timeaxis.ts";

export interface Away {
  kind: "person" | "team";
  person?: Person;
  start: Day;
  end: Day;
  iterationId: string;
}

export interface TeamEvent {
  id: string;
  kind: "event";
  title: string;
  start: string; // yyyy-mm-dd
  end: string;
  createdBy: string;
}

/** Everything off in these sprints: each person's days off and the team's. */
export function awayFrom(caps: { iteration: Iteration; capacity: Capacity }[]): Away[] {
  const out: Away[] = [];
  for (const { iteration, capacity } of caps) {
    for (const m of capacity.members) for (const d of m.daysOff) {
      const s = planDay(d.start);
      const e = planDay(d.end);
      if (s != null && e != null) out.push({ kind: "person", person: m.person, start: Math.min(s, e), end: Math.max(s, e), iterationId: iteration.id });
    }
    for (const d of capacity.teamDaysOff) {
      const s = planDay(d.start);
      const e = planDay(d.end);
      if (s != null && e != null) out.push({ kind: "team", start: Math.min(s, e), end: Math.max(s, e), iterationId: iteration.id });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Split a range over the sprints it touches. `outside` = days that fall in no sprint. */
export function splitBySprint(start: Day, end: Day, sprints: Iteration[]): { parts: { iteration: Iteration; start: Day; end: Day }[]; outside: number } {
  const parts: { iteration: Iteration; start: Day; end: Day }[] = [];
  let covered = 0;
  for (const it of sprints) {
    const s = planDay(it.start);
    const e = planDay(it.finish);
    if (s == null || e == null) continue;
    const a = Math.max(start, s);
    const b = Math.min(end, e);
    if (a <= b) { parts.push({ iteration: it, start: a, end: b }); covered += b - a + 1; }
  }
  return { parts, outside: Math.max(0, end - start + 1 - covered) };
}

/** Add a range to a list of day-off ranges (as Azure DevOps stores them), joining overlaps. */
export function addRange(list: { start: string; end: string }[], start: Day, end: Day): { start: string; end: string }[] {
  const ranges = list.map((r) => ({ s: planDay(r.start)!, e: planDay(r.end)! })).filter((r) => r.s != null && r.e != null);
  ranges.push({ s: start, e: end });
  ranges.sort((a, b) => a.s - b.s);
  const merged: { s: number; e: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.s <= last.e + 1) last.e = Math.max(last.e, r.e);
    else merged.push({ ...r });
  }
  return merged.map((r) => ({ start: dayKey(r.s) + "T00:00:00Z", end: dayKey(r.e) + "T00:00:00Z" }));
}

/** Take a range out of a list of day-off ranges (other days stay). */
export function removeRange(list: { start: string; end: string }[], start: Day, end: Day): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (const r of list) {
    const s = planDay(r.start);
    const e = planDay(r.end);
    if (s == null || e == null) continue;
    if (e < start || s > end) { out.push({ start: dayKey(s) + "T00:00:00Z", end: dayKey(e) + "T00:00:00Z" }); continue; }
    if (s < start) out.push({ start: dayKey(s) + "T00:00:00Z", end: dayKey(start - 1) + "T00:00:00Z" });
    if (e > end) out.push({ start: dayKey(end + 1) + "T00:00:00Z", end: dayKey(e) + "T00:00:00Z" });
  }
  return out;
}

/** Whole ranges of some days: sorted, touching days joined. */
export function dayRanges(days: Day[]): { start: Day; end: Day }[] {
  const out: { start: Day; end: Day }[] = [];
  for (const d of [...new Set(days)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && d === last.end + 1) last.end = d;
    else out.push({ start: d, end: d });
  }
  return out;
}

/** The days of [start, end] that are off in a list of day-off ranges. */
export function offDaysIn(list: { start: string; end: string }[], start: Day, end: Day): Day[] {
  const out: Day[] = [];
  for (let d = start; d <= end; d++) {
    if (list.some((r) => { const s = planDay(r.start); const e = planDay(r.end); return s != null && e != null && d >= s && d <= e; })) out.push(d);
  }
  return out;
}

export interface DaysOffChange { op: "add" | "remove"; ranges: { start: Day; end: Day }[] }

/**
 * One change to a sprint's days off, applied to the list as it is now (read just before), and what it
 * really changed: only those days are taken back by Undo, so a change someone made meanwhile stays.
 */
export function applyDaysOff(list: { start: string; end: string }[], change: DaysOffChange): { list: { start: string; end: string }[]; undo: DaysOffChange } {
  let out = list;
  const changed: Day[] = [];
  for (const r of change.ranges) {
    const off = new Set(offDaysIn(out, r.start, r.end));
    for (let d = r.start; d <= r.end; d++) if (off.has(d) === (change.op === "remove")) changed.push(d);
    out = change.op === "add" ? addRange(out, r.start, r.end) : removeRange(out, r.start, r.end);
  }
  return { list: out, undo: { op: change.op === "add" ? "remove" : "add", ranges: dayRanges(changed) } };
}

export function eventDays(e: TeamEvent):{ start: Day; end: Day } | null {
  const s = planDay(e.start);
  const t = planDay(e.end || e.start);
  return s == null || t == null ? null : { start: Math.min(s, t), end: Math.max(s, t) };
}

/** The new "To" after "From" changed: it follows From when it was before it or still on the old From. */
export function followTo(newFrom: string, oldFrom: string, to: string): string {
  if (!newFrom) return to;
  return !to || to < newFrom || to === oldFrom ? newFrom : to;
}

/** Days in a range that are working days (`workDays`: 0 = Sunday … 6 = Saturday). */
export function workingDaysIn(start: Day, end: Day, workDays: number[]): number {
  let n = 0;
  for (let d = start; d <= end; d++) if (workDays.includes(weekday(d))) n++;
  return n;
}

/** One line under the dates: how many days, and in which sprints ("3 working days, in Sprint 41"). */
export function rangeSummary(start: Day | null, end: Day | null, kind: "off" | "teamoff" | "event", sprints: Iteration[], workDays: number[]): { text: string; ok: boolean } {
  if (start == null || end == null) return { text: "Pick the dates.", ok: false };
  if (end < start) return { text: "The last day is before the first day.", ok: false };
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  const { parts, outside } = splitBySprint(start, end, sprints);
  const names = parts.map((p) => p.iteration.name);
  const where = names.length ? `, in ${names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0]}` : "";
  if (kind === "event") return { text: plural(end - start + 1, "day") + where, ok: true };
  if (!parts.length) return { text: "These days are in no sprint. Azure DevOps keeps days off per sprint: add the sprint first.", ok: false };
  const wd = workingDaysIn(start, end, workDays);
  return { text: `${plural(wd, "working day")}${where}${outside ? `; ${plural(outside, "day")} outside any sprint not kept` : ""}`, ok: true };
}
