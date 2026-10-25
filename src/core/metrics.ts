// Pure flow math: percentiles, daily and weekly counts, cumulative flow and a seeded Monte Carlo
// forecast. No page, no network: covered by test/metrics.test.ts.
// Days are whole UTC days (dayIndex): the same item lands in the same day on every machine.
import type { Category } from "../api/types.ts";
import { DAY } from "./model.ts";

/** Whole UTC days since 1970 for an ISO date or a time in ms. */
export function dayIndex(t: string | number): number {
  return Math.floor((typeof t === "number" ? t : Date.parse(t)) / DAY);
}

/** ISO date (yyyy-mm-dd) of a day index. */
export function dayIso(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

/** The p-th percentile (0–100) with linear interpolation between ranks; NaN for no values. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = isSorted(values) ? values : [...values].sort((a, b) => a - b);
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function isSorted(v: number[]): boolean {
  for (let i = 1; i < v.length; i++) if (v[i] < v[i - 1]) return false;
  return true;
}

/** Round axis ticks from 0 to at least max, about `target` steps (1, 2, 2.5 or 5 × 10ⁿ). */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v < max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  if (out[out.length - 1] < max) out.push(Number((out[out.length - 1] + step).toFixed(10)));
  return out;
}

// ---------- items through the workflow ----------

/** The dates of an item's way through the workflow (a WorkItem fits). */
export interface FlowDates {
  created: string;
  activated?: string;
  resolved?: string;
  closed?: string;
  stateChanged?: string;
  category: Category;
}

/**
 * When the item entered each state category, trusting only dates that fit its current category
 * (an item moved back to an earlier state keeps no later dates). A date the process does not set
 * falls back to the time of the last state change.
 */
export function stageDates(w: FlowDates): { proposed: string; inProgress?: string; resolved?: string; completed?: string } {
  const c = w.category;
  const at = (date: string | undefined, cat: Category): string | undefined => date ?? (c === cat ? w.stateChanged : undefined);
  const out: { proposed: string; inProgress?: string; resolved?: string; completed?: string } = { proposed: w.created };
  if (c === "Proposed" || c === "Removed") return out;
  out.inProgress = at(w.activated, "InProgress");
  if (c === "InProgress") return out;
  out.resolved = at(w.resolved, "Resolved");
  if (c === "Resolved") return out;
  out.completed = at(w.closed, "Completed");
  return out;
}

/** Days from start of work (activated, else created) to closed; null when not closed. Never negative. */
export function cycleDays(w: FlowDates): number | null {
  const closed = w.closed ?? (w.category === "Completed" ? w.stateChanged : undefined);
  if (!closed) return null;
  const start = w.activated ?? w.created;
  return Math.max(0, (Date.parse(closed) - Date.parse(start)) / DAY);
}

/** Days since the item started work (activated, else last state change, else created). */
export function workAge(w: FlowDates, now = Date.now()): number {
  const start = w.activated ?? w.stateChanged ?? w.created;
  return Math.max(0, (now - Date.parse(start)) / DAY);
}

/** How an age compares with the team's cycle times: within the median, up to the 85th percentile, or beyond. */
export function ageClass(days: number, p50: number, p85: number): "ok" | "warn" | "bad" {
  if (!(p85 > 0) || Number.isNaN(p50)) return "ok";
  return days > p85 ? "bad" : days > p50 ? "warn" : "ok";
}

/** Count per day: out[i] = how many of these day indexes equal startDay + i. Days outside are ignored. */
export function dailyCounts(days: number[], startDay: number, length: number): number[] {
  const out = new Array<number>(length).fill(0);
  for (const d of days) {
    const i = d - startDay;
    if (i >= 0 && i < length) out[i]++;
  }
  return out;
}

/** Sums of consecutive 7-day blocks (the last block may be shorter). */
export function weeklySums(daily: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < daily.length; i += 7) out.push(daily.slice(i, i + 7).reduce((a, b) => a + b, 0));
  return out;
}

/** Trailing average over `window` values (fewer at the start). */
export function rollingMean(values: number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(sum / Math.min(i + 1, window));
  }
  return out;
}

export const CFD_CATEGORIES = ["Proposed", "InProgress", "Resolved", "Completed"] as const;
export type CfdCategory = (typeof CFD_CATEGORIES)[number];

/**
 * Cumulative flow: for each day from startDay, how many items were in each state category at the
 * end of that day. Items not yet created that day are not counted.
 */
export function cfdSeries(items: FlowDates[], startDay: number, length: number): Record<CfdCategory, number[]> {
  const diff: Record<CfdCategory, number[]> = { Proposed: [], InProgress: [], Resolved: [], Completed: [] };
  for (const c of CFD_CATEGORIES) diff[c] = new Array<number>(length + 1).fill(0);
  for (const w of items) {
    const s = stageDates(w);
    const stages: [CfdCategory, string | undefined][] = [["Proposed", s.proposed], ["InProgress", s.inProgress], ["Resolved", s.resolved], ["Completed", s.completed]];
    const known = stages.filter((x): x is [CfdCategory, string] => !!x[1]).map(([c, d]) => [c, dayIndex(d)] as [CfdCategory, number]);
    // dates out of order (data entered by hand): a later stage never starts before an earlier one
    for (let i = 1; i < known.length; i++) known[i][1] = Math.max(known[i][1], known[i - 1][1]);
    for (let i = 0; i < known.length; i++) {
      const from = Math.max(known[i][1], startDay) - startDay;
      const to = Math.min(i + 1 < known.length ? known[i + 1][1] : startDay + length, startDay + length) - startDay; // exclusive
      if (to <= from) continue;
      diff[known[i][0]][from]++;
      diff[known[i][0]][to]--;
    }
  }
  const out = { Proposed: [], InProgress: [], Resolved: [], Completed: [] } as Record<CfdCategory, number[]>;
  for (const c of CFD_CATEGORIES) {
    let run = 0;
    for (let i = 0; i < length; i++) { run += diff[c][i]; out[c].push(run); }
  }
  return out;
}

// ---------- Monte Carlo forecast ----------

/** A small seeded random generator (mulberry32): the same seed gives the same numbers. */
export function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Items done in `days` days, `runs` times, each day drawn from the daily samples. Sorted ascending. */
export function simulateHowMany(samples: number[], days: number, runs = 10_000, seed = 1): number[] {
  const out = new Array<number>(runs).fill(0);
  if (!samples.length || days <= 0) return out;
  const rnd = seededRandom(seed);
  const n = samples.length;
  for (let r = 0; r < runs; r++) {
    let sum = 0;
    for (let d = 0; d < days; d++) sum += samples[Math.floor(rnd() * n)];
    out[r] = sum;
  }
  return out.sort((a, b) => a - b);
}

/**
 * Days needed to finish `target` items, `runs` times. Sorted ascending. A run that does not get
 * there within maxDays counts as maxDays + 1. Empty when the samples have no finished item at all.
 */
export function simulateWhen(samples: number[], target: number, runs = 10_000, seed = 1, maxDays = 3650): number[] {
  if (target <= 0) return new Array<number>(runs).fill(0);
  if (!samples.some((s) => s > 0)) return [];
  const rnd = seededRandom(seed);
  const n = samples.length;
  const out = new Array<number>(runs);
  for (let r = 0; r < runs; r++) {
    let sum = 0;
    let d = 0;
    while (sum < target && d <= maxDays) { sum += samples[Math.floor(rnd() * n)]; d++; }
    out[r] = sum >= target ? d : maxDays + 1;
  }
  return out.sort((a, b) => a - b);
}

/** The most items reached in at least `likelihood` (0–1) of the runs. sorted: ascending results. */
export function likelyAtLeast(sorted: number[], likelihood: number): number {
  if (!sorted.length) return 0;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * (1 - likelihood) + 1e-9)));
  return sorted[k];
}

/** The fewest days within which at least `likelihood` (0–1) of the runs finished. sorted: ascending results. */
export function likelyWithin(sorted: number[], likelihood: number): number {
  if (!sorted.length) return NaN;
  const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * likelihood - 1e-9) - 1));
  return sorted[k];
}

export interface Bin { from: number; to: number; count: number }

/** Whole-number bins covering min..max (to is inclusive), at most maxBins of them. */
export function histogram(all: number[], maxBins = 30): Bin[] {
  const values = all.filter(Number.isFinite);
  if (!values.length) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  lo = Math.floor(lo);
  hi = Math.floor(hi);
  const width = Math.max(1, Math.ceil((hi - lo + 1) / maxBins));
  const bins: Bin[] = [];
  for (let f = lo; f <= hi; f += width) bins.push({ from: f, to: f + width - 1, count: 0 });
  for (const v of values) bins[Math.floor((Math.floor(v) - lo) / width)].count++;
  return bins;
}

