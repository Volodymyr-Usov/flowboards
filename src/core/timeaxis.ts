// Day arithmetic and planning dates, shared by the Roadmap, the Calendar, the Scheduler, Health and the details panel. No page code: covered by test/timeaxis.test.ts.
//
// A day is a whole number: days since 1970-01-01, counted in UTC. Planning dates in Azure DevOps
// (start, target, due) are dates without a time, saved as midnight of the person's time zone turned
// into UTC ("2026-10-20T22:00:00Z" for 21 October in Berlin). Rounding to the nearest UTC midnight
// gives back the date they picked in any zone from UTC-12 to UTC+12. Moments (closed date) use the
// local calendar day instead.

export const DAY_MS = 86_400_000;

export type Day = number;

export interface Span { start: Day; end: Day }

/** The day of a planning date (start, target, due, sprint start or finish), or null when empty. */
export function planDay(iso: string | undefined | null): Day | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // midnight of this browser's zone (what planIso writes, also beyond UTC+12): that local date
  const d = new Date(t);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return localDay(d);
  return Math.floor((t + DAY_MS / 2) / DAY_MS);
}

/**
 * The ISO text Azure DevOps gets for a planning date the person picked: midnight of that day in this
 * browser's time zone, the way Azure DevOps's own date picker saves it (so its form shows the same day).
 */
export function planIso(day: Day): string {
  const p = parts(day);
  return new Date(p.y, p.m, p.d).toISOString();
}

/** The day of "2026-10-21", or null when it is not such a date. */
export function parseDayKey(key: string | undefined | null): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  return m ? fromYmd(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** The text Azure DevOps gets for the planning date "2026-10-21" (local midnight), or "" when it is not such a date. */
export function planIsoOfKey(key: string | undefined | null): string {
  const d = parseDayKey(key);
  return d == null ? "" : planIso(d);
}

/** "2026-10-21" for a planning date (start, target, due), or "" when empty. */
export function planKey(iso: string | undefined | null): string {
  const d = planDay(iso);
  return d == null ? "" : dayKey(d);
}

/** "2026-10-21": today in the local calendar. */
export function todayKey(now: Date = new Date()): string {
  return dayKey(todayDay(now));
}

/** The local calendar day of a moment (closed date, now). */
export function localDay(at: string | number | Date): Day {
  const d = at instanceof Date ? at : new Date(at);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

export function todayDay(now: Date = new Date()): Day {
  return localDay(now);
}

/** Midnight UTC of a day. For a planning date written to Azure DevOps use planIso. */
export function dayIso(day: Day): string {
  return new Date(day * DAY_MS).toISOString();
}

/** "2026-10-21" */
export function dayKey(day: Day): string {
  return dayIso(day).slice(0, 10);
}

export function fromYmd(y: number, m: number, d = 1): Day {
  return Math.floor(Date.UTC(y, m, d) / DAY_MS);
}

/** Year, month (0–11), day of month and weekday (0 = Sunday). */
export function parts(day: Day): { y: number; m: number; d: number; dow: number } {
  const dt = new Date(day * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), dow: dt.getUTCDay() };
}

export function weekday(day: Day): number {
  return (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

export function weekStart(day: Day, firstDow = 1): Day {
  return day - ((weekday(day) - firstDow + 7) % 7);
}

export function monthStart(day: Day): Day {
  const p = parts(day);
  return fromYmd(p.y, p.m, 1);
}

export function quarterStart(day: Day): Day {
  const p = parts(day);
  return fromYmd(p.y, p.m - (p.m % 3), 1);
}

/** The first day of the month n months after the month of `day`. */
export function addMonths(day: Day, n: number): Day {
  const p = parts(day);
  return fromYmd(p.y, p.m + n, 1);
}

/** "2026-10" for a month, and back. */
export function monthKey(day: Day): string {
  return dayKey(day).slice(0, 7);
}
export function parseMonthKey(key: string | undefined | null): Day | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? "");
  return m ? fromYmd(Number(m[1]), Number(m[2]) - 1, 1) : null;
}

/** The weeks shown for a month: whole weeks from the week of the 1st to the week of the last day. */
export function monthGrid(monthFirst: Day, firstDow = 1): Day[][] {
  const first = monthStart(monthFirst);
  const last = addMonths(first, 1) - 1;
  const weeks: Day[][] = [];
  for (let w = weekStart(first, firstDow); w <= last; w += 7) weeks.push(Array.from({ length: 7 }, (_, i) => w + i));
  return weeks;
}

export type TickUnit = "day" | "week" | "month" | "quarter";

/** Periods of a unit that touch [from, to], each clipped to it. */
export function ticks(from: Day, to: Day, unit: TickUnit, firstDow = 1): Span[] {
  const out: Span[] = [];
  const startOf = (d: Day): Day => unit === "day" ? d : unit === "week" ? weekStart(d, firstDow) : unit === "month" ? monthStart(d) : quarterStart(d);
  const next = (d: Day): Day => unit === "day" ? d + 1 : unit === "week" ? d + 7 : addMonths(d, unit === "month" ? 1 : 3);
  for (let s = startOf(from); s <= to; s = next(s)) {
    const e = next(s) - 1;
    out.push({ start: Math.max(s, from), end: Math.min(e, to) });
  }
  return out;
}

/** The part of [start, end] inside [from, to], or null. */
export function clip(span: Span, from: Day, to: Day): Span | null {
  const start = Math.max(span.start, from);
  const end = Math.min(span.end, to);
  return start <= end ? { start, end } : null;
}

/** Lanes for spans so that spans in one lane never overlap (first free lane, by start). */
export function packLanes(spans: Span[]): number[] {
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].start - spans[b].start || spans[b].end - spans[a].end);
  const laneEnds: number[] = [];
  const lanes = new Array<number>(spans.length).fill(0);
  for (const i of order) {
    let lane = laneEnds.findIndex((end) => end < spans[i].start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = spans[i].end;
    lanes[i] = lane;
  }
  return lanes;
}

/** Days between a pointer move and the bar's start, snapped to whole days. */
export function dragDays(dxPx: number, pxPerDay: number): number {
  return Math.round(dxPx / pxPerDay) || 0;
}

/** New span after dragging a bar's middle ("move") or one end; the bar keeps at least one day. */
export function dragSpan(span: Span, mode: "move" | "start" | "end", days: number): Span {
  if (mode === "move") return { start: span.start + days, end: span.end + days };
  if (mode === "start") return { start: Math.min(span.start + days, span.end), end: span.end };
  return { start: span.start, end: Math.max(span.end + days, span.start) };
}

/** Smallest span holding all given spans, or null. */
export function union(spans: (Span | null | undefined)[]): Span | null {
  let out: Span | null = null;
  for (const s of spans) {
    if (!s) continue;
    out = out ? { start: Math.min(out.start, s.start), end: Math.max(out.end, s.end) } : { start: s.start, end: s.end };
  }
  return out;
}

/** A day as text in the reader's language; the day is a UTC date, so format it in UTC. */
export function fmtDay(day: Day, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  return new Date(day * DAY_MS).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

/** "12 Oct – 4 Dec 2026" (the year once when both days are in the same year). */
export function fmtSpan(span: Span): string {
  const sameYear = parts(span.start).y === parts(span.end).y;
  const a = fmtDay(span.start, sameYear ? { day: "numeric", month: "short" } : undefined);
  return span.start === span.end ? fmtDay(span.end) : `${a} – ${fmtDay(span.end)}`;
}
