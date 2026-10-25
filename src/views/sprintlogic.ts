// End-of-sprint clean-up, pure parts: which sprint comes next, and the list of changes that moves
// unfinished work there or splits a story. No page and no network: covered by unit tests.
import type { Iteration, WorkItem } from "../api/types.ts";
import { isUnder, workingDays } from "../core/model.ts";

const dayOf = (iso: string | undefined): number | null => (iso ? Date.parse(iso.slice(0, 10)) : null);

/** Text made safe to put in HTML (a comment or a description of a work item). */
export function escapeHtml(t: string): string {
  return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/**
 * Working days of a sprint from `today` (the local day, "YYYY-MM-DD") to its last day, today included:
 * the whole sprint when it has not started yet, 0 when it is over.
 */
export function workingDaysLeft(start: string, finish: string, today: string, workDays: number[], daysOff: { start: string; end: string }[] = []): number {
  const from = Math.max(Date.parse(start.slice(0, 10)), Date.parse(today));
  if (Number.isNaN(from) || from > Date.parse(finish.slice(0, 10))) return 0;
  return workingDays(new Date(from).toISOString(), finish, workDays, daysOff);
}

/** The sprint has ended, or ends today. `today`: the local day, "YYYY-MM-DD". */
export function sprintOver(s: Iteration, today: string): boolean {
  const end = dayOf(s.finish);
  if (end == null) return s.timeFrame === "past";
  return end <= Date.parse(today);
}

/**
 * Where unfinished work of a sprint goes: the first later sprint that has not ended yet (so an old sprint
 * cleaned up late sends its work to today's or a coming sprint), else the sprint right after it.
 * Later = starts after this one starts. Sprints without dates are left out.
 */
export function nextSprint(all: Iteration[], s: Iteration, today: string): Iteration | undefined {
  const start = dayOf(s.start);
  if (start == null) return undefined;
  const later = all.filter((i) => i.id !== s.id && (dayOf(i.start) ?? -Infinity) > start)
    .sort((a, b) => (dayOf(a.start) ?? 0) - (dayOf(b.start) ?? 0));
  const t = Date.parse(today);
  // a sprint that ends today still counts as not ended for receiving work
  return later.find((i) => (dayOf(i.finish) ?? Infinity) >= t) ?? later[0];
}

/** "Title (continued)", without adding a second "(continued)". */
export function continuedTitle(title: string): string {
  return /\(continued\)\s*$/i.test(title) ? title : `${title} (continued)`;
}

export type CleanupMode = "move" | "split" | "leave";

export interface CleanupChoice {
  story: WorkItem;
  mode: CleanupMode;
  /** open tasks that go along (to the next sprint, or to the copy when splitting) */
  tasks: WorkItem[];
}

export type CleanupStep =
  | { kind: "iteration"; id: number; path: string }
  /** make a copy of the story in the next sprint; `ref` names it for the steps after */
  | { kind: "copy"; ref: string; from: number; title: string; path: string; parent?: number }
  /** put a task under the copy made by the step with this ref */
  | { kind: "reparent"; id: number; ref: string };

/**
 * The changes, in order. Move: the story, then its chosen tasks, to the next sprint.
 * Split: a copy of the story in the next sprint (same parent), then each chosen task goes under the copy
 * and to the next sprint. The original keeps its finished tasks and is not changed.
 */
export function cleanupSteps(choices: CleanupChoice[], nextPath: string): CleanupStep[] {
  const out: CleanupStep[] = [];
  for (const c of choices) {
    if (c.mode === "move") {
      if (c.story.iteration !== nextPath) out.push({ kind: "iteration", id: c.story.id, path: nextPath });
      for (const t of c.tasks) if (t.iteration !== nextPath) out.push({ kind: "iteration", id: t.id, path: nextPath });
    } else if (c.mode === "split") {
      const ref = `copy-${c.story.id}`;
      out.push({ kind: "copy", ref, from: c.story.id, title: continuedTitle(c.story.title), path: nextPath, parent: c.story.parent });
      for (const t of c.tasks) {
        out.push({ kind: "reparent", id: t.id, ref });
        if (t.iteration !== nextPath) out.push({ kind: "iteration", id: t.id, path: nextPath });
      }
    }
  }
  return out;
}

/** A story can be split when some of its work is finished (a done task) and some is still open. */
export function canSplit(tasks: WorkItem[], isDoneTask: (t: WorkItem) => boolean): boolean {
  return tasks.some(isDoneTask) && tasks.some((t) => !isDoneTask(t));
}

/** The tasks of a story that are in this sprint (or a sprint under it): only these are offered, moved or split off. */
export function tasksInSprint(tasks: WorkItem[], sprintPath: string): WorkItem[] {
  return tasks.filter((t) => isUnder(t.iteration, sprintPath));
}

/**
 * Dropping dragged items in a list: `index` counts the rows without the dragged ones. Gives the item
 * before and after the drop (0 = none), or null when the order would not change.
 */
export function dropNeighbors(order: number[], moving: number[], index: number): { prev: number; next: number } | null {
  const rest = order.filter((id) => !moving.includes(id));
  const moved = order.filter((id) => moving.includes(id));
  if (!moved.length) return null;
  const i = Math.max(0, Math.min(index, rest.length));
  const after = [...rest.slice(0, i), ...moved, ...rest.slice(i)];
  if (after.every((id, k) => id === order[k])) return null;
  return { prev: rest[i - 1] ?? 0, next: rest[i] ?? 0 };
}
