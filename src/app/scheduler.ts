// The Scheduler's engine: whoever has Flowboards open checks the team's schedules and makes the stories that
// are due and not made yet. Two people (or two tabs) may check at the same moment, so every occurrence is
// CLAIMED first: one small document per occurrence, created only when none has its id (storage refuses the
// second create). Whoever created it makes the story and marks it done; the others skip it. A story that was
// deleted on purpose is not made again (the record stays). A claim that was never finished (the page was
// closed in between) is taken over after 10 minutes. Occurrences missed while nobody had the page open are
// made later, up to a week back (see core/scheduler.ts).
import type { WorkItem } from "../api/types.ts";
import { cleanSchedule, dueOccurrences, pickAssignee, placementPath, renderTitle, todayLocal } from "../core/scheduler.ts";
import type { Occurrence, Schedule } from "../core/scheduler.ts";
import { cleanTemplates } from "../core/templates.ts";
import { collectionName, every, TeamStore } from "../core/teamstore.ts";
import { errorText, toast } from "../ui/kit.ts";
import { textToHtml } from "../ui/sanitize.ts";
import type { App } from "./context.ts";

/** The record of one occurrence: who claimed it and, when done, the story made. */
export interface RunDoc {
  id: string;
  __etag?: number;
  scheduleId: string;
  /** the day the occurrence was due */
  date: string;
  state: "claiming" | "done";
  by: string;
  at: string;
  itemId?: number;
  title?: string;
  assignee?: string;
}

/** Fired on the document when the engine has made stories (the Scheduler page reloads its cards). */
export const SCHEDULED_EVENT = "flowboards:scheduled";
const TARGET = "Microsoft.VSTS.Scheduling.TargetDate";
const STALE_CLAIM_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

export const scheduleStore = (app: App): TeamStore<Schedule> => new TeamStore<Schedule>(app.api, collectionName("schedules", app.ws.project, app.ws.team));
export const runStore = (app: App): TeamStore<RunDoc> => new TeamStore<RunDoc>(app.api, collectionName("schedruns", app.ws.project, app.ws.team));
export const runId = (scheduleId: string, key: string): string => `r-${scheduleId}-${key}`;

const isConflict = (e: unknown): boolean => [409, 412].includes((e as { status?: number }).status ?? 0);

/** The schedules as stored, the damaged ones left out, in the order they were made. */
export async function loadSchedules(app: App): Promise<Schedule[]> {
  const docs = await scheduleStore(app).all();
  return docs.map(cleanSchedule).filter((s): s is Schedule => !!s).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

/** Who is in the team (the pool for a turn or a draw): the members' sign-in names. */
const teamPool = (app: App): string[] => (app.ws.teamMembers().length ? app.ws.teamMembers() : app.ws.people()).map((p) => p.uniqueName).filter(Boolean);

/** The latest assignee of a schedule's earlier runs (for the turn). */
function lastAssignee(runs: RunDoc[], scheduleId: string): string | undefined {
  return runs.filter((r) => r.scheduleId === scheduleId && r.state === "done" && r.assignee).sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at)).pop()?.assignee;
}

/** Make the story for one occurrence (and its tasks). Null when it could not be made (a message says why). */
export async function makeStory(app: App, s: Schedule, occ: Occurrence, assignee: string | undefined): Promise<WorkItem | null> {
  const ws = app.ws;
  const t = s.template;
  const type = ws.requirementLevel().defaultType;
  const fields: Record<string, unknown> = {
    "System.Title": renderTitle(t.title, occ),
    "System.Description": t.description.trim() ? textToHtml(t.description) : undefined,
    "System.AssignedTo": assignee,
    "System.IterationPath": placementPath(t, occ, ws.iterations, ws.currentIteration(), ws.settings.backlogIteration ?? ws.project),
    "System.AreaPath": ws.defaultArea(),
    "System.Tags": ["Scheduled", ...t.tags].join("; "),
  };
  // the column (or state) the story starts in: the board column field and the state it stands for. Azure DevOps may refuse a new
  // item in a later state, so the story is made first and put there after (a refusal leaves it where it was made, with a message)
  const placing: { field: string; value: unknown }[] = [];
  if (t.column) {
    const col = ws.board?.columnField ? ws.board.columns.find((c) => c.name === t.column) : undefined;
    if (col && ws.board?.columnField) {
      const state = col.stateMappings[type];
      if (state) placing.push({ field: "System.State", value: state });
      placing.push({ field: ws.board.columnField, value: col.name });
    } else if (ws.process.types[type]?.states?.some((s) => s.name === t.column)) placing.push({ field: "System.State", value: t.column });
  }
  const fs = ws.process.types[type]?.fields;
  if (occ.due && (!fs || fs.includes(TARGET))) fields[TARGET] = occ.due;
  const item = await app.actions.create(type, fields);
  if (!item) return null;
  if (placing.length) {
    try { await app.actions.writer.setFields(item.id, placing); } catch (e) { toast(`#${item.id} was made but could not be put in ${t.column}: ${errorText(e)}`, { kind: "error" }); }
  }
  const tasks = t.tasks.mode === "standard" ? cleanTemplates(app.settings.shared.childTemplates?.[type]) : t.tasks.mode === "custom" ? t.tasks.custom : [];
  if (tasks.length) await app.actions.addStandardChildren(item.id, tasks);
  return item;
}

/**
 * Claim one occurrence and make its story. Resolves to the story, or null when someone else has it, it is
 * not ours to make yet, or making it failed (a failed claim is given back so another screen can try).
 */
export async function produce(app: App, s: Schedule, occ: Occurrence, runs: RunDoc[]): Promise<WorkItem | null> {
  const store = runStore(app);
  const id = runId(s.id, occ.key);
  const known = runs.find((r) => r.id === id);
  const by = app.api.ctx.me?.displayName ?? "someone";
  const now = new Date().toISOString();
  if (known?.state === "done") return null;
  if (known) {
    // somebody's claim: ours to take only when it was never finished
    if (Date.now() - Date.parse(known.at) < STALE_CLAIM_MS) return null;
    let took = false;
    try { await store.update(id, (d) => (d.state === "claiming" && d.at === known.at ? (took = true, { ...d, by, at: now }) : null)); } catch (e) { if (!isConflict(e)) throw e; }
    if (!took) return null;
  } else {
    try { await store.create({ id, scheduleId: s.id, date: occ.date, state: "claiming", by, at: now }); } catch (e) { if (isConflict(e)) return null; throw e; }
  }
  // the claim is ours
  try {
    const assignee = pickAssignee(s.template.assign, teamPool(app), lastAssignee(runs, s.id), occ.key);
    const item = await makeStory(app, s, occ, assignee);
    if (!item) { await store.remove(id).catch(() => {}); return null; }
    await store.update(id, (d) => ({ ...d, state: "done", itemId: item.id, title: item.title, assignee }));
    return item;
  } catch (e) {
    await store.remove(id).catch(() => {});
    throw e;
  }
}

/** One check of every schedule. Returns the stories made. */
export async function checkSchedules(app: App, failed: Map<string, number>): Promise<WorkItem[]> {
  if (app.actions.readOnly || !app.ws.loadedAt) return [];
  const schedules = (await loadSchedules(app)).filter((s) => s.enabled);
  if (!schedules.length) return [];
  const today = todayLocal();
  const ctx = { iterations: app.ws.iterations };
  const runs = await runStore(app).all();
  const made: WorkItem[] = [];
  for (const s of schedules) {
    for (const occ of dueOccurrences(s, ctx, today)) {
      const id = runId(s.id, occ.key);
      if (runs.some((r) => r.id === id && r.state === "done")) continue;
      if ((failed.get(id) ?? 0) > Date.now()) continue;
      try {
        const item = await produce(app, s, occ, runs);
        if (item) { made.push(item); runs.push({ id, scheduleId: s.id, date: occ.date, state: "done", by: "", at: "", itemId: item.id, assignee: item.assignedTo?.uniqueName }); }
      } catch (e) {
        console.warn("Scheduled story not made", e);
        failed.set(id, Date.now() + RETRY_AFTER_FAILURE_MS);
      }
    }
  }
  return made;
}

/** Start checking while the page is open (and visible): a first check soon after the team's work is read, then every minute. */
export function startScheduler(app: App): () => void {
  const failed = new Map<string, number>();
  let busy = false;
  const run = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const made = await checkSchedules(app, failed);
      if (made.length) document.dispatchEvent(new CustomEvent(SCHEDULED_EVENT));
    } finally { busy = false; }
  };
  const first = setTimeout(() => void run().catch((e) => console.warn(e)), 6000);
  const stop = every(TICK_MS, run);
  const onVisible = (): void => { if (document.visibilityState === "visible") void run().catch((e) => console.warn(e)); };
  document.addEventListener("visibilitychange", onVisible);
  return () => { clearTimeout(first); stop(); document.removeEventListener("visibilitychange", onVisible); };
}
