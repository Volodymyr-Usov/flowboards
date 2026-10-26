// The Scheduler's engine: whoever has Flowboards open checks the team's schedules and makes the stories that
// are due and not made yet. Two people (or two tabs) may check at the same moment, so every occurrence is
// CLAIMED first: one small record per occurrence, created only when none has its id (storage refuses the
// second create). How a claim becomes exactly one story, also when answers get lost or a tab sleeps, is in
// core/schedrun.ts. A story that was deleted on purpose is not made again (the record stays). Occurrences
// missed while nobody had the page open are made later, up to a week back (see core/scheduler.ts).
import type { ExtensionDoc } from "../api/api.ts";
import type { WorkItem } from "../api/types.ts";
import { addDays, cleanSchedule, drawSeed, dueOccurrences, pickAssignee, placementPath, renderTitle, todayLocal } from "../core/scheduler.ts";
import type { Occurrence, Schedule } from "../core/scheduler.ts";
import { ClaimWatch, hasStory, isConflict, lastRun, pruneMark, runId, runOccurrence, runsToPrune } from "../core/schedrun.ts";
import type { RunDoc, RunOutcome, RunStore } from "../core/schedrun.ts";
import { cleanTemplates } from "../core/templates.ts";
import { collectionName, every, newDocId, TeamStore } from "../core/teamstore.ts";
import { errorText, toast } from "../ui/kit.ts";
import { textToHtml } from "../ui/sanitize.ts";
import type { App } from "./context.ts";

/** Fired on the document when the engine has made stories (the Scheduler page reloads its cards). */
export const SCHEDULED_EVENT = "flowboards:scheduled";
const TARGET = "Microsoft.VSTS.Scheduling.TargetDate";
const TICK_MS = 60 * 1000;
/** After a failure, the next try waits longer each time: 5 minutes, 15 minutes, an hour, then 6 hours. */
const BACKOFF_MS = [5, 15, 60, 360].map((m) => m * 60 * 1000);
/** How far back a story made earlier is looked for (a week of backfill and a day of slack). */
const FIND_DAYS = 8;
/** At most this many old records are deleted in one day's clean-up. */
const PRUNE_MAX = 200;

export const scheduleStore = (app: App): TeamStore<Schedule> => new TeamStore<Schedule>(app.api, collectionName("schedules", app.ws.project, app.ws.team));
export const runStore = (app: App): TeamStore<RunDoc> => new TeamStore<RunDoc>(app.api, collectionName("schedruns", app.ws.project, app.ws.team));

/** The schedules as stored, the damaged ones left out, in the order they were made. */
export async function loadSchedules(app: App): Promise<Schedule[]> {
  return cleanList(await scheduleStore(app).all());
}
const cleanList = (docs: unknown[]): Schedule[] =>
  docs.map(cleanSchedule).filter((s): s is Schedule => !!s).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));

/** Who is in the team (the pool for a turn or a draw): the members' sign-in names. */
const teamPool = (app: App): string[] => (app.ws.teamMembers().length ? app.ws.teamMembers() : app.ws.people()).map((p) => p.uniqueName).filter(Boolean);

/** The run records for the claim rules: saves are checked against the version read (core/schedrun.ts). */
function claimStore(app: App, store = runStore(app)): RunStore {
  return {
    get: (id) => store.get(id),
    create: (doc) => store.create(doc),
    // a record only in the older collection (-1) is created in the new one; refused when someone did that first
    replace: async (doc) => (doc.__etag == null || doc.__etag === -1
      ? store.create({ ...doc, __etag: undefined })
      : (await app.api.setDoc(store.collection, doc as unknown as ExtensionDoc, "shared")) as unknown as RunDoc),
    remove: async (id, etag) => { await store.removeIfUnchanged(id, etag); },
  };
}

/** Create the story of one occurrence (only the story: tasks and the starting column come after it is recorded). */
async function createStory(app: App, s: Schedule, occ: Occurrence, assignee: string | undefined): Promise<WorkItem> {
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
  const fs = ws.process.types[type]?.fields;
  if (occ.due && (!fs || fs.includes(TARGET))) fields[TARGET] = occ.due;
  // the Writer, not app.actions: an error must reach the claim rules (refused or no answer), not only a message
  return app.actions.writer.create(type, fields);
}

/** The story's starting column (or state) and its tasks. Problems are told, never thrown: the story exists. */
async function completeStory(app: App, s: Schedule, id: number): Promise<void> {
  const ws = app.ws;
  const t = s.template;
  const type = ws.requirementLevel().defaultType;
  try {
    // the column (or state) the story starts in: the board column field and the state it stands for. Azure DevOps may refuse a new
    // item in a later state, so the story is made first and put there after (a refusal leaves it where it was made, with a message)
    const placing: { field: string; value: unknown }[] = [];
    if (t.column) {
      const col = ws.board?.columnField ? ws.board.columns.find((c) => c.name === t.column) : undefined;
      if (col && ws.board?.columnField) {
        const state = col.stateMappings[type];
        if (state) placing.push({ field: "System.State", value: state });
        placing.push({ field: ws.board.columnField, value: col.name });
      } else if (ws.process.types[type]?.states?.some((x) => x.name === t.column)) placing.push({ field: "System.State", value: t.column });
    }
    if (placing.length) {
      try { await app.actions.writer.setFields(id, placing); } catch (e) { toast(`#${id} was made but could not be put in ${t.column}: ${errorText(e)}`, { kind: "error" }); }
    }
    const tasks = t.tasks.mode === "standard" ? cleanTemplates(app.settings.shared.childTemplates?.[type]) : t.tasks.mode === "custom" ? t.tasks.custom : [];
    if (tasks.length) await app.actions.addStandardChildren(id, tasks);
  } catch (e) { toast(`#${id} was made, but its tasks or column were not set: ${errorText(e)}`, { kind: "error" }); }
}

/**
 * A story made for this occurrence already, whose record was never finished (its answer was lost, or the
 * page closed): the team's story with the Scheduled tag and this exact title, made in the last days, that
 * no other record of the schedule has.
 */
async function findStory(app: App, s: Schedule, occ: Occurrence, runs: RunDoc[]): Promise<{ id: number; title: string; assignee?: string } | undefined> {
  const ws = app.ws;
  const title = renderTitle(s.template.title, occ);
  const known = new Set(runs.filter((r) => r.scheduleId === s.id).flatMap((r) => [r.itemId ?? 0, ...(r.also ?? [])]));
  const since = [addDays(todayLocal(), -FIND_DAYS), addDays(occ.date, -1)].sort()[1];
  const areas = [...ws.settings.areas, { path: ws.defaultArea(), includeChildren: false }];
  const ids = (await app.api.query(ws.project, { types: ws.requirementLevel().types, tag: "Scheduled", createdAfter: since, areas }))
    .filter((id) => !known.has(id)).sort((a, b) => a - b).slice(-200);
  if (!ids.length) return undefined;
  const hit = (await app.api.items(ws.project, ids)).filter((it) => it.title === title).sort((a, b) => a.id - b.id)[0];
  return hit ? { id: hit.id, title: hit.title, assignee: hit.assignedTo?.uniqueName } : undefined;
}

/** Claim one occurrence and make its story (core/schedrun.ts has the rules). */
function runOne(app: App, s: Schedule, occ: Occurrence, runs: RunDoc[], watch: ClaimWatch, store: RunStore, suspect = false): Promise<RunOutcome<WorkItem>> {
  const assignee = pickAssignee(s.template.assign, teamPool(app), lastRun(runs, s.id)?.assignee, drawSeed(s.id, occ.key));
  return runOccurrence<WorkItem>({
    id: runId(s.id, occ.key), scheduleId: s.id, date: occ.date, key: occ.key,
    by: app.api.ctx.me?.displayName ?? "someone", token: newDocId("t"), assignee, suspect,
    store, watch, now: () => Date.now(),
    story: {
      make: () => createStory(app, s, occ, assignee),
      complete: (id) => completeStory(app, s, id),
      find: () => findStory(app, s, occ, runs),
    },
  });
}

/**
 * Make one occurrence's story now (the Scheduler page's "Make now"). Resolves to the story, or null when
 * someone else has it; throws when Azure DevOps refused it or did not answer.
 */
export async function produce(app: App, s: Schedule, occ: Occurrence, runs: RunDoc[]): Promise<WorkItem | null> {
  const out = await runOne(app, s, occ, runs, new ClaimWatch(), claimStore(app));
  if (out.kind === "made") return out.item;
  if (out.kind === "refused" || out.kind === "unsure") throw out.error;
  return null;
}

/** What one tab remembers between checks. */
export interface EngineMemory {
  /** run id -> when to try again and how many tries failed */
  failed: Map<string, { until: number; count: number }>;
  /** problems told once per occurrence per visit */
  told: Set<string>;
  watch: ClaimWatch;
  /** the day this tab last tried the clean-up */
  prunedOn: string;
}
export const engineMemory = (): EngineMemory => ({ failed: new Map(), told: new Set(), watch: new ClaimWatch(), prunedOn: "" });

/** One check of every schedule. Returns the stories made. */
export async function checkSchedules(app: App, mem: EngineMemory): Promise<WorkItem[]> {
  if (app.actions.readOnly || !app.ws.loadedAt) return [];
  const raw = await scheduleStore(app).all();
  const schedules = cleanList(raw).filter((s) => s.enabled);
  if (!schedules.length) return [];
  const today = todayLocal();
  const ctx = { iterations: app.ws.iterations };
  const records = runStore(app);
  const runs = await records.all();
  const store = claimStore(app, records);
  const made: WorkItem[] = [];
  const fail = (id: string): void => {
    const count = (mem.failed.get(id)?.count ?? 0) + 1;
    mem.failed.set(id, { until: Date.now() + BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1], count });
  };
  const tell = (id: string, text: string): void => {
    if (mem.told.has(id)) return;
    mem.told.add(id);
    toast(text, { kind: "error" });
  };
  for (const s of schedules) {
    for (const occ of dueOccurrences(s, ctx, today)) {
      const id = runId(s.id, occ.key);
      const rec = runs.find((r) => r.id === id);
      if (rec?.state === "done") continue;
      let suspect = false;
      // made by an older version under the older key: counts. Its unfinished claim is waited for, then looked into
      const old = occ.legacyKey ? runs.find((r) => r.id === runId(s.id, occ.legacyKey!)) : undefined;
      if (old && hasStory(old)) continue;
      if (old && !rec) {
        if (!mem.watch.stale(old, Date.now())) continue;
        suspect = true;
      }
      if ((mem.failed.get(id)?.until ?? 0) > Date.now()) continue;
      const title = renderTitle(s.template.title, occ);
      try {
        const out = await runOne(app, s, occ, runs, mem.watch, store, suspect);
        if (out.kind === "made" || out.kind === "found") {
          mem.failed.delete(id);
          const itemId = out.kind === "made" ? out.item.id : out.itemId;
          runs.push({ id, scheduleId: s.id, date: occ.date, key: occ.key, state: "done", by: "", at: new Date().toISOString(), itemId, assignee: out.kind === "made" ? out.item.assignedTo?.uniqueName : undefined });
        }
        if (out.kind === "made") {
          made.push(out.item);
          toast(`Scheduled story made: #${out.item.id} ${out.item.title}`, { kind: "ok", timeout: 8000, action: { label: "Open", run: () => app.openItem(out.item.id) } });
          if (out.double) tell(`${id}:double`, `"${title}" was made twice (another page made it at the same moment): #${out.item.id} is the second. Delete one of them.`);
        } else if (out.kind === "refused") {
          fail(id);
          tell(id, `The scheduled story "${title}" could not be made: ${errorText(out.error)}. It is tried again later.`);
        } else if (out.kind === "unsure") {
          fail(id);
          tell(id, `The scheduled story "${title}": Azure DevOps did not answer, so it may or may not be made. It is checked in 10 minutes and made only if it is not there.`);
        }
      } catch (e) {
        console.warn("Scheduled story not made", e);
        fail(id);
      }
    }
  }
  if (mem.prunedOn !== today) {
    mem.prunedOn = today;
    await prune(app, records, new Set(raw.map((d) => d.id)), runs, today).catch((e) => console.warn("Old schedule records not cleaned up", e));
  }
  return made;
}

/**
 * Once a day per team, the tab that creates the day's mark deletes the records nobody needs any more
 * (core/schedrun.ts runsToPrune), so the storage every tab reads each minute does not grow for ever.
 */
async function prune(app: App, records: TeamStore<RunDoc>, schedules: Set<string>, runs: RunDoc[], today: string): Promise<void> {
  const drop = runsToPrune(runs, schedules, today);
  if (!drop.length) return;
  try {
    await records.create({ id: pruneMark(today), scheduleId: "", date: today, state: "done", by: app.api.ctx.me?.displayName ?? "someone", at: new Date().toISOString() });
  } catch (e) {
    if (isConflict(e)) return; // another tab cleans up today
    throw e;
  }
  for (const id of drop.slice(0, PRUNE_MAX)) await records.remove(id).catch(() => {});
}

/** Delete the records of a schedule (when the schedule is deleted). */
export async function removeRuns(app: App, scheduleId: string, runs: RunDoc[]): Promise<void> {
  const records = runStore(app);
  for (const r of runs.filter((x) => x.scheduleId === scheduleId)) await records.remove(r.id).catch(() => {});
}

/** Start checking while the page is open (and visible): a first check soon after the team's work is read, then every minute. */
export function startScheduler(app: App): () => void {
  const mem = engineMemory();
  let busy = false;
  const run = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const made = await checkSchedules(app, mem);
      if (made.length) document.dispatchEvent(new CustomEvent(SCHEDULED_EVENT));
    } finally { busy = false; }
  };
  const first = setTimeout(() => void run().catch((e) => console.warn(e)), 6000);
  const stop = every(TICK_MS, run);
  const onVisible = (): void => { if (document.visibilityState === "visible") void run().catch((e) => console.warn(e)); };
  document.addEventListener("visibilitychange", onVisible);
  return () => { clearTimeout(first); stop(); document.removeEventListener("visibilitychange", onVisible); };
}
