// Sprint numbers read from Azure DevOps: the burndown and the velocity. No page: the Sprint page and the
// Taskboard use the same code.
import type { Api } from "../api/api.ts";
import type { Iteration, QuerySpec } from "../api/types.ts";
import { isUnder, statesOf } from "../core/model.ts";
import { pool } from "../core/teamplans.ts";
import type { Workspace } from "../core/workspace.ts";
import { AS_OF_FIELDS, burndown, dayMoments, everInSprint, missedHistory, snapshotsFromRevisions, sprintDays } from "./burndown.ts";
import type { BurndownPoint } from "./burndown.ts";

/** reading "as of" each day takes two requests a day per 400 tasks: past this the chart would be slow */
export const MAX_TASKS = 2000;
/** reading each task's revisions (when "as of" misses imported history) takes a request per task */
export const MAX_REVISION_TASKS = 400;

/** The team's items of these types in a sprint: only the team's own areas, as other teams may share the sprint. */
export function sprintQuery(ws: Pick<Workspace, "settings">, types: string[], path: string): QuerySpec {
  return { types, areas: ws.settings.areas.length ? ws.settings.areas : undefined, iterationUnder: path };
}

export type BurndownResult =
  | { kind: "points"; points: BurndownPoint[] }
  | { kind: "tooMany"; tasks: number }
  | { kind: "noTasks" };

/**
 * A sprint's burndown: its tasks as they were at the end of each working day. `alive` false stops the
 * reading (the page went away); the answer is then null.
 */
export async function loadBurndown(api: Api, ws: Workspace, it: Iteration, opts: { onProgress?: (text: string) => void; alive?: () => boolean; now?: number } = {}): Promise<BurndownResult | null> {
  const alive = opts.alive ?? (() => true);
  const task = ws.taskLevel();
  if (!task || !it.start || !it.finish) return { kind: "noTasks" };
  const remainingField = ws.process.fields.remaining;
  const now = opts.now ?? Date.now();
  const spec = sprintQuery(ws, task.types, it.path);
  // the team's days off are not working days of the sprint
  const [current, teamOff] = await Promise.all([
    api.query(ws.project, spec),
    api.capacity(ws.project, ws.team, it.id).then((c) => c.teamDaysOff, () => [] as { start: string; end: string }[]),
  ]);
  if (!alive()) return null;
  const days = sprintDays(it.start, it.finish, ws.settings.workingDays, teamOff);
  const moments = dayMoments(days, now);
  // tasks moved out of the sprint since ("move unfinished") still count on the days they were in it:
  // ask which tasks were in the sprint at the end of each past day, not only which are in it now
  const past = moments.filter((m): m is string => m != null && Date.parse(m) < now);
  opts.onProgress?.("Finding the tasks that were in the sprint each day…");
  const before = await pool(past, 3, (m) => api.query(ws.project, { ...spec, asOf: m }));
  if (!alive()) return null;
  const ids = everInSprint(current, before);
  if (ids.length > MAX_TASKS) return { kind: "tooMany", tasks: ids.length };
  if (!ids.length) return { kind: "noTasks" };
  const items = await api.items(ws.project, ids);
  if (!alive()) return null;
  // each day's tasks as they were at its end: a few requests a day, three days at a time
  let read = 0;
  const total = moments.filter(Boolean).length;
  let asOf = await pool(moments, 3, async (m) => {
    if (!m) return null;
    const snap = await api.fieldsAsOf(ws.project, ids, AS_OF_FIELDS(remainingField), m);
    read++;
    opts.onProgress?.(`Reading the sprint's tasks as they were each day: ${read} of ${total}…`);
    return snap;
  });
  if (!alive()) return null;
  // history saved later with earlier dates (imported, migrated) is not seen "as of": read each task's revisions
  if (ids.length <= MAX_REVISION_TASKS && missedHistory(asOf, moments, new Map(items.map((w) => [w.id, w.created])))) {
    let done = 0;
    const revs = new Map(await pool(ids, 6, async (id) => {
      const list = await api.revisions(ws.project, id);
      done++;
      opts.onProgress?.(`Reading each task's history: ${done} of ${ids.length}…`);
      return [id, list] as const;
    }));
    if (!alive()) return null;
    asOf = snapshotsFromRevisions(revs, moments, AS_OF_FIELDS(remainingField));
  }
  const closedStates = statesOf(ws.process, task.types, ["Completed", "Removed"]);
  const tasks = items.map((w) => ({
    id: w.id, state: w.state,
    estimate: w.originalEstimate ?? (w.completedWork != null || w.remaining != null ? (w.completedWork ?? 0) + (w.remaining ?? 0) : undefined),
  }));
  return { kind: "points", points: burndown(days, asOf, tasks, { sprintPath: it.path, remainingField, closedStates }).points };
}

/** A sprint's velocity: the effort of its finished stories (requirement level, Completed states). */
export async function sprintVelocity(api: Api, ws: Workspace, reqTypes: string[], path: string): Promise<number> {
  const done = statesOf(ws.process, reqTypes, ["Completed"]);
  const ids = await api.query(ws.project, { ...sprintQuery(ws, reqTypes, path), states: done });
  const items = ids.length ? await api.items(ws.project, ids) : [];
  return items.filter((w) => isUnder(w.iteration, path)).reduce((s, w) => s + (w.effort ?? 0), 0);
}
