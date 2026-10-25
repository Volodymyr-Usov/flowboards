// Other teams' Epics and Features, read-only, for the roadmap's team rows: read with the same queries the
// workspace uses for a team's area paths, with links (for dependencies). Kept for a few minutes per team,
// a few teams at a time. Nothing here writes.
import type { Api } from "../api/api.ts";
import { categoryOf } from "../api/normalize.ts";
import type { Iteration, ProcessInfo, TeamSettings, WorkItem } from "../api/types.ts";
import { DAY, isRemoved, statesOf } from "./model.ts";

export interface TeamPlan {
  project: string;
  team: string;
  process: ProcessInfo;
  settings: TeamSettings;
  iterations: Iteration[];
  /** open Epics and Features (every portfolio level) and those closed in the last days, with links */
  items: WorkItem[];
  readAt: number;
}

/** how long a team's read is kept */
export const PLAN_TTL = 5 * 60_000;
/** at most this many items per team */
const MAX_ITEMS = 1000;

const caches = new WeakMap<Api, Map<string, { at: number; job: Promise<TeamPlan> }>>();

/** Run jobs with at most `max` at once; each result in its place. */
export async function pool<T, R>(list: T[], max: number, job: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length) { const i = next++; out[i] = await job(list[i]); }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, max), list.length) }, worker));
  return out;
}

async function read(api: Api, project: string, team: string, closedDays: number): Promise<TeamPlan> {
  const [process, settings, iterations] = await Promise.all([
    api.process(project, team),
    api.teamSettings(project, team),
    api.iterations(project, team).catch(() => [] as Iteration[]),
  ]);
  const types = process.levels.filter((l) => l.kind === "portfolio").flatMap((l) => l.types);
  const plan: TeamPlan = { project, team, process, settings, iterations, items: [], readAt: Date.now() };
  if (!types.length) return plan;
  const closed = statesOf(process, types, ["Completed"]);
  const removed = statesOf(process, types, ["Removed"]);
  const areas = settings.areas.length ? settings.areas : undefined;
  const since = new Date(Date.now() - closedDays * DAY).toISOString().slice(0, 10);
  const [open, done] = await Promise.all([
    api.query(project, { project, types, areas, notStates: [...closed, ...removed], top: MAX_ITEMS }),
    closed.length ? api.query(project, { project, types, areas, states: closed, closedAfter: since, top: MAX_ITEMS }) : Promise.resolve([] as number[]),
  ]);
  const ids = [...new Set([...open, ...done])].slice(0, MAX_ITEMS);
  const items = ids.length ? await api.items(project, ids, { relations: true }) : [];
  for (const it of items) {
    // the client may not know this team's process: category and order from the process read above
    it.category = categoryOf(process, it.type, it.state);
    const order = Number(it.fields[process.fields.order]);
    if (Number.isFinite(order) && it.fields[process.fields.order] != null) it.order = order;
    it.project = it.project ?? project;
    it.relations = it.relations ?? [];
  }
  plan.items = items.filter((it) => !isRemoved(it));
  return plan;
}

/** One team's plan: from the cache when read in the last minutes (or still being read), else read now. */
export function teamPlan(api: Api, project: string, team: string, opts: { closedDays?: number; force?: boolean } = {}): Promise<TeamPlan> {
  let cache = caches.get(api);
  if (!cache) caches.set(api, (cache = new Map()));
  const key = `${project}/${team}`;
  const hit = cache.get(key);
  if (hit && !opts.force && Date.now() - hit.at < PLAN_TTL) return hit.job;
  const job = read(api, project, team, opts.closedDays ?? 30);
  const entry = { at: Date.now(), job };
  cache.set(key, entry);
  // a failed read is not kept: the next ask tries again
  job.catch(() => { if (cache!.get(key) === entry) cache!.delete(key); });
  return job;
}

/** Several teams, three at a time; a team that cannot be read gives its error in its place. */
export function teamPlans(api: Api, refs: { project: string; team: string }[], opts: { closedDays?: number; force?: boolean } = {}): Promise<(TeamPlan | Error)[]> {
  return pool(refs, 3, (r) => teamPlan(api, r.project, r.team, opts).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
}
