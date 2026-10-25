// Pull request times for the Flow and Pull request pages: the completed pull requests of a period, and when
// each got its first approval. The approval needs one request per pull request, so it is read once and kept
// in the team's storage (collection "prtimes", one document per month of completion): a completed pull
// request never changes, so what is stored stays right, and the next visit (yours or a colleague's) reads
// nothing but the few new ones.
import type { PullRequest } from "../api/types.ts";
import { DAY, personKey } from "../core/model.ts";
import { collectionName, TeamStore } from "../core/teamstore.ts";
import { runLimited } from "../views/prlogic.ts";
import type { App } from "./context.ts";

/** A month's stored approvals: "repository id:pull request id" → the time of the first approval in ms, 0 = it never had one */
interface MonthDoc { id: string; __etag?: number; approved: Record<string, number> }

/** At most this many approvals are read in one visit (newest first); the rest follow on later visits */
const READ_PER_VISIT = 250;
/** A month's document holds at most this many entries (it stays well under the storage limit) */
const MAX_PER_MONTH = 3000;
const LIST_MS = 5 * 60_000;

export const prKey = (pr: PullRequest): string => `${pr.repository.id}:${pr.id}`;
const monthOf = (iso: string): string => `m-${iso.slice(0, 7)}`;

interface Memory { loaded: Promise<void> | null; approved: Map<string, number>; asked: Set<string>; dirty: Set<string> }
const memory = new Map<string, Memory>();
const lists = new Map<string, { at: number; prs: Promise<PullRequest[]> }>();

const scopeKey = (app: App): string => `${app.api.ctx.orgUrl}|${app.ws.project}|${app.ws.team}`;
const store = (app: App): TeamStore<MonthDoc> => new TeamStore<MonthDoc>(app.api, collectionName("prtimes", app.ws.project, app.ws.team));
function mem(app: App): Memory {
  const k = scopeKey(app);
  let m = memory.get(k);
  if (!m) memory.set(k, (m = { loaded: null, approved: new Map(), asked: new Set(), dirty: new Set() }));
  return m;
}

/** Read the stored approvals once per visit of the app. */
function ensureLoaded(app: App): Promise<void> {
  const m = mem(app);
  m.loaded ??= store(app).all().then((docs) => { for (const d of docs) for (const [k, v] of Object.entries(d.approved ?? {})) if (typeof v === "number") m.approved.set(k, v); }, () => {});
  return m.loaded;
}

/** The completed pull requests of the project in the last `weeks` weeks (kept 5 minutes, so the two pages share one read). */
export function completedSince(app: App, weeks: number, fresh = false): Promise<PullRequest[]> {
  const key = `${app.api.ctx.orgUrl}|${app.ws.project}|${weeks}`;
  const hit = lists.get(key);
  if (hit && !fresh && Date.now() - hit.at < LIST_MS) return hit.prs;
  const since = new Date(Date.now() - weeks * 7 * DAY).toISOString();
  const prs = app.api.pullRequests(app.ws.project, { status: "completed", minTime: since, top: 1000 })
    .then((list) => list.filter((p) => p.status === "completed" && p.closed && Date.parse(p.closed) >= Date.parse(since)));
  lists.set(key, { at: Date.now(), prs });
  prs.catch(() => lists.delete(key));
  return prs;
}

/** When a completed pull request got its first approval: ms, null = never, undefined = not known yet. */
export function approvedAt(app: App, pr: PullRequest): number | null | undefined {
  const v = mem(app).approved.get(prKey(pr));
  return v === undefined ? undefined : v === 0 ? null : v;
}

/**
 * Make sure the first approval of these completed pull requests is known: from the team's storage, else read
 * (newest first, six at a time) and stored for the next visit. Resolves when this round of reading is done;
 * `left` is how many are still unknown (more than one visit's share).
 */
export async function readApprovals(app: App, prs: PullRequest[], stop: () => boolean = () => false, progress?: () => void): Promise<{ left: number }> {
  await ensureLoaded(app);
  const m = mem(app);
  const missing = prs.filter((p) => p.closed && !m.approved.has(prKey(p))).sort((a, b) => Date.parse(b.closed!) - Date.parse(a.closed!));
  const todo = missing.filter((p) => !m.asked.has(prKey(p))).slice(0, READ_PER_VISIT);
  for (const p of todo) m.asked.add(prKey(p));
  await runLimited(todo, 6, (pr) => app.api.firstApproval(pr.repository.project || app.ws.project, pr.repository.id, pr.id), (_n, pr, r) => {
    if (r.error) { m.asked.delete(prKey(pr)); return; }
    m.approved.set(prKey(pr), r.value ? Date.parse(r.value) : 0);
    m.dirty.add(monthOf(pr.closed!));
    progress?.();
  }, stop);
  await save(app, prs);
  return { left: prs.filter((p) => p.closed && !m.approved.has(prKey(p))).length };
}

/** Write the months that got new approvals (this team's storage; a failure only means the next visit reads them again). */
async function save(app: App, prs: PullRequest[]): Promise<void> {
  const m = mem(app);
  if (!m.dirty.size || app.actions.readOnly) return;
  const months = [...m.dirty];
  m.dirty.clear();
  const byMonth = new Map<string, Record<string, number>>();
  for (const p of prs) {
    const v = m.approved.get(prKey(p));
    if (v === undefined || !p.closed || !months.includes(monthOf(p.closed))) continue;
    const e = byMonth.get(monthOf(p.closed)) ?? {};
    e[prKey(p)] = v;
    byMonth.set(monthOf(p.closed), e);
  }
  for (const [id, entries] of byMonth) {
    try {
      await store(app).upsert(id, (cur) => {
        const merged = { ...(cur?.approved ?? {}), ...entries };
        return Object.keys(merged).length > MAX_PER_MONTH ? null : { ...(cur ?? { id }), id, approved: merged } as MonthDoc;
      });
    } catch { m.dirty.add(id); }
  }
}

/**
 * Is this pull request the team's? One of the team's members (Settings > Team) wrote it or was asked to review it
 * (a reviewer group does not count). A team with no members known has no filter: every pull request passes.
 */
export function isTeamPr(app: App, pr: PullRequest, keys: Set<string> = new Set(app.ws.teamMembers().map((p) => personKey(p)))): boolean {
  return !keys.size || keys.has(personKey(pr.createdBy)) || pr.reviewers.some((r) => !r.isContainer && keys.has(personKey(r.person)));
}
