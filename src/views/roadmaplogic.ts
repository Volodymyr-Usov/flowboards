// Roadmap, pure parts: the dependencies between shown items and which of them conflict
// (the item that waits starts before the item it waits for ends), also across teams.
import { REL, relId } from "../api/api.ts";
import type { WorkItem } from "../api/types.ts";
import type { Day, Span } from "../core/timeaxis.ts";
import { planIso } from "../core/timeaxis.ts";
import { dayIndex } from "../core/metrics.ts";

export interface Dependency {
  /** the item waited for */
  pred: number;
  /** the item that waits */
  succ: number;
  /** the two items belong to different teams */
  cross: boolean;
  /** the item that waits starts on or before the day the other one ends */
  conflict: boolean;
}

/** Predecessor → successor pairs from the links of these items, each once. */
export function dependencyPairs(items: Iterable<WorkItem>): [number, number][] {
  const pairs = new Map<string, [number, number]>();
  for (const it of items) {
    for (const rel of it.relations ?? []) {
      const other = relId(rel);
      if (!other || other === it.id) continue;
      if (rel.rel === REL.successor) pairs.set(`${it.id}>${other}`, [it.id, other]);
      else if (rel.rel === REL.predecessor) pairs.set(`${other}>${it.id}`, [other, it.id]);
    }
  }
  return [...pairs.values()];
}

/**
 * The dependencies whose two ends are both shown (have a bar), with conflicts marked.
 * teamOf gives a team key per item; items of different keys make a cross-team dependency.
 */
export function dependencies(pairs: [number, number][], spanOf: (id: number) => Span | null | undefined, teamOf: (id: number) => string | undefined): Dependency[] {
  const out: Dependency[] = [];
  for (const [pred, succ] of pairs) {
    const a = spanOf(pred);
    const b = spanOf(succ);
    if (!a || !b) continue;
    const ta = teamOf(pred);
    const tb = teamOf(succ);
    out.push({ pred, succ, cross: ta != null && tb != null && ta !== tb, conflict: b.start <= a.end });
  }
  return out;
}

/** Counts for the toolbar: all conflicts, and those between teams. */
export function conflictCounts(deps: Dependency[]): { all: number; cross: number } {
  let all = 0;
  let cross = 0;
  for (const d of deps) if (d.conflict) { all++; if (d.cross) cross++; }
  return { all, cross };
}

/** A team chosen for the roadmap: a team of this project or of another one. */
export interface TeamRef { project: string; team: string }

export const teamKey = (r: TeamRef): string => `${r.project}/${r.team}`;

/** Saved choices, cleaned: well formed, each once, never the current team. */
export function cleanTeams(raw: unknown, current: TeamRef, max = 12): TeamRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>([teamKey(current)]);
  const out: TeamRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { project, team } = r as Record<string, unknown>;
    if (typeof project !== "string" || typeof team !== "string" || !project || !team) continue;
    const k = teamKey({ project, team });
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ project, team });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Which drags a bar offers, from the planning date fields its type has: the whole bar needs both dates,
 * an end needs its own date. A type with neither cannot be dragged.
 */
export function dragsFor(fields: { start: boolean; target: boolean }): { move: boolean; start: boolean; end: boolean } {
  return { move: fields.start && fields.target, start: fields.start, end: fields.target };
}

/**
 * Late: not done, and its own target date has passed. A bar's end made up from a start date or the
 * sprints of its work is no target date, so such a bar is never called late.
 */
export function isLate(done: boolean, target: Day | null | undefined, today: Day): boolean {
  return !done && target != null && target < today;
}

/**
 * The note under the roadmap about the likely dates: how many stories the pace comes from, or why there
 * are no likely dates (nothing finished lately, or nothing open to forecast). `level`: the name of the
 * level that is forecast (Feature in most processes).
 */
export function forecastNote(closed: number, forecasts: number, perWeek: number, level = "portfolio item"): string {
  if (forecasts) return `Likely dates from ${closed} stories done in the last 12 weeks (about ${(Math.round(perWeek * 10) / 10).toLocaleString()} a week)`;
  if (closed) return `No open ${level} has open stories under it, so there is nothing to forecast.`;
  return "No stories were finished in the last 12 weeks, so there is no pace to forecast from.";
}

/**
 * Where the pace behind the likely dates starts: local midnight of the oldest of the `days` days that end today,
 * the very days dailyThroughput counts, so every story the note counts is in the pace too (the day before was
 * read but not counted). A moment, not a bare date, so Azure DevOps does not judge it by the day of its own time zone.
 */
export function paceSince(days: number, now = Date.now()): string {
  return planIso(dayIndex(now) - days + 1);
}
