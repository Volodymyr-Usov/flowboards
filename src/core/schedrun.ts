// How one occurrence of a schedule becomes exactly one story, when every open tab checks every minute.
// No page code: the storage and the story are passed in, so test/schedrun.test.ts can lose answers, fail
// saves, put a tab to sleep and set clocks apart.
//
// The record of an occurrence (one document, id `r-<schedule>-<key>`) is the lock:
//   1. CLAIM: create the record (storage refuses a second create, so only one tab gets it).
//   2. Just before making the story, read the record again: still ours (our token), still no story?
//   3. MAKE the story. At once write its id into the record (saved only on the version we hold; retried).
//   4. Tasks and the starting column, then the record is "done".
// Rules that keep a story from being made twice, and an occurrence from being lost for good:
//   - A record is never deleted once a story exists or might exist. Only a definite refusal of the create
//     (an HTTP 4xx answer) gives the claim back.
//   - A create with no answer may have been saved: the record is marked "unsure", not retried blindly.
//   - A record nobody finished is taken over only when THIS tab has seen it unchanged for 10 minutes of its
//     own time (clocks of other computers are never compared). Before making a story for such a record,
//     the taker looks for one that was made already (the record's story id, or the same title, tagged
//     Scheduled, made in the last days); a story found is recorded, not made again.
//   - A tab that made a story but finds the record taken over meanwhile writes its story into the record,
//     so the other tab sees it and stops. Only a tab frozen in the moment between its last check and the
//     create can still make a second one; it is then listed on the record (`also`).
import { addDays } from "./scheduler.ts";

/** The record of one occurrence: who claimed it and, once made, the story. */
export interface RunDoc {
  id: string;
  __etag?: number;
  scheduleId: string;
  /** the day the occurrence was due */
  date: string;
  /** the occurrence's key (also part of the id) */
  key?: string;
  /**
   * claiming: someone is making the story; unsure: the create got no answer, the story may exist;
   * made: the story exists (its tasks may not yet); done
   */
  state: "claiming" | "unsure" | "made" | "done";
  by: string;
  at: string;
  /** which claim this is: a new random one for every claim and takeover */
  token?: string;
  itemId?: number;
  title?: string;
  assignee?: string;
  /** more stories made for this occurrence (a tab woke up too late); kept so a person can see them */
  also?: number[];
}

export const runId = (scheduleId: string, key: string): string => `r-${scheduleId}-${key}`;

/** Does the record stand for a story that was made? */
export const hasStory = (r: RunDoc | undefined): boolean => !!r && (r.state === "done" || !!r.itemId);

/** The record of an occurrence with a story: under its key, or under the key older versions used. */
export function runFor(runs: RunDoc[], scheduleId: string, occ: { key: string; legacyKey?: string }): RunDoc | undefined {
  const ids = [runId(scheduleId, occ.key), ...(occ.legacyKey ? [runId(scheduleId, occ.legacyKey)] : [])];
  return runs.find((r) => ids.includes(r.id) && hasStory(r));
}

/** A schedule's newest record with a story and an assignee: the turn goes on after its person. */
export function lastRun(runs: RunDoc[], scheduleId: string): RunDoc | undefined {
  return runs.filter((r) => r.scheduleId === scheduleId && hasStory(r) && r.assignee)
    .sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at)).pop();
}

/** How long the records of made stories are kept (only a week back is ever made again). */
export const KEEP_DAYS = 30;
/** The id of the day's clean-up mark: the one tab that creates it cleans up that day. */
export const pruneMark = (today: string): string => `prune-${today}`;

/**
 * The records that can go: those of deleted schedules, those of occurrences more than 30 days back
 * (except each schedule's newest one with an assignee, for the turn), and older clean-up marks.
 * `schedules` are the ids of every stored schedule, paused or not.
 */
export function runsToPrune(runs: RunDoc[], schedules: Set<string>, today: string): string[] {
  const cut = addDays(today, -KEEP_DAYS);
  const keep = new Set([...schedules].map((id) => lastRun(runs, id)).filter((r): r is RunDoc => !!r));
  return runs.filter((r) => {
    if (r.id.startsWith("prune-")) return r.id !== pruneMark(today);
    if (!r.id.startsWith("r-")) return false;
    if (!schedules.has(r.scheduleId)) return true;
    if (keep.has(r) || typeof r.date !== "string") return false;
    // an outlook's key is its target date: it stays due until then, so its record is kept until that date is old too
    const key = r.key ?? r.id.slice(`r-${r.scheduleId}-`.length);
    const last = /^\d{4}-\d{2}-\d{2}$/.test(key) && key > r.date ? key : r.date;
    return last < cut;
  }).map((r) => r.id);
}

/** The storage of the records. */
export interface RunStore {
  get(id: string): Promise<RunDoc | null>;
  /** create only: refused (409) when a record with this id exists */
  create(doc: RunDoc): Promise<RunDoc>;
  /** save over the stored record, only when it is still the version `doc.__etag` (409 or 412 otherwise) */
  replace(doc: RunDoc): Promise<RunDoc>;
  /** delete, only when the record is still the version `etag` */
  remove(id: string, etag: number | undefined): Promise<void>;
}

/** The story of one occurrence. */
export interface StoryMaker<I extends { id: number; title: string }> {
  /** create the story (only the story) */
  make(): Promise<I>;
  /** its tasks and starting column; never throws */
  complete(id: number): Promise<void>;
  /** a story made for this occurrence already (one whose answer was lost), or undefined */
  find(): Promise<{ id: number; title: string; assignee?: string } | undefined>;
}

export const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * Remembers, in this tab only, since when each unfinished record has looked exactly as it does now.
 * Its version (etag) changes on every save, so "the same" means nobody saved it meanwhile.
 */
export class ClaimWatch {
  private seen = new Map<string, { sig: string; since: number }>();
  /** Has this record stayed unchanged for 10 minutes of this tab's time? The first look starts the count. */
  stale(doc: RunDoc, now: number): boolean {
    const sig = [doc.__etag, doc.state, doc.by, doc.at, doc.token, doc.itemId].join("|");
    const s = this.seen.get(doc.id);
    // a clock set back starts the count again
    if (!s || s.sig !== sig || now < s.since) { this.seen.set(doc.id, { sig, since: now }); return false; }
    return now - s.since >= STALE_CLAIM_MS;
  }
}

const statusOf = (e: unknown): number | undefined => (e as { status?: unknown } | null)?.status as number | undefined;
export const isConflict = (e: unknown): boolean => statusOf(e) === 409 || statusOf(e) === 412;
/** Azure DevOps answered and refused: nothing was saved. (No answer, a server error or our own failure may have saved it.) */
export const isRefusal = (e: unknown): boolean => { const s = statusOf(e); return typeof s === "number" && s >= 400 && s < 500 && s !== 408; };

export type RunOutcome<I> =
  /** made now; `double`: another tab made one too (listed on the record) */
  | { kind: "made"; item: I; recorded: boolean; double: boolean }
  /** a story made earlier (whose record was not finished) was found and recorded */
  | { kind: "found"; itemId: number }
  /** nothing to do now: done already, or another tab has it */
  | { kind: "skip"; why: "done" | "busy" | "lost" }
  /** Azure DevOps refused the story: not made; the claim is given back */
  | { kind: "refused"; error: unknown }
  /** no answer: the story may be made; the claim stays ("unsure") until someone finds out */
  | { kind: "unsure"; error: unknown };

export interface RunInput<I extends { id: number; title: string }> {
  id: string;
  scheduleId: string;
  date: string;
  key: string;
  by: string;
  /** new for every call: tells our claim from anyone else's */
  token: string;
  assignee?: string;
  /** look for a made story before making one, also for a fresh claim (an older version left a claim) */
  suspect?: boolean;
  store: RunStore;
  story: StoryMaker<I>;
  watch: ClaimWatch;
  now: () => number;
  /** a wait before a retry (tests pass a quick one) */
  pause?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Claim an occurrence and make its story, following the rules at the top. Storage errors are thrown. */
export async function runOccurrence<I extends { id: number; title: string }>(o: RunInput<I>): Promise<RunOutcome<I>> {
  const at = (): string => new Date(o.now()).toISOString();
  let doc = await o.store.get(o.id);
  if (doc?.state === "done") return { kind: "skip", why: "done" };
  if (doc) {
    // someone's unfinished claim (maybe our own, from before): only when it has been left for 10 minutes
    if (!o.watch.stale(doc, o.now())) return { kind: "skip", why: "busy" };
    if (doc.itemId) return adopt(o, doc, { id: doc.itemId, title: doc.title ?? "", assignee: doc.assignee }, false);
    const found = await o.story.find();
    if (found) return adopt(o, doc, found, true);
    const taken = await swap(o, doc, { ...doc, state: "claiming", by: o.by, at: at(), token: o.token });
    if (!taken) return { kind: "skip", why: "busy" };
  } else {
    try {
      await o.store.create({ id: o.id, scheduleId: o.scheduleId, date: o.date, key: o.key, state: "claiming", by: o.by, at: at(), token: o.token });
    } catch (e) {
      if (isConflict(e)) return { kind: "skip", why: "busy" };
      if (isRefusal(e)) throw e;
      // no answer: the claim may be saved; ours only if it carries our token
      const cur = await o.store.get(o.id);
      if (!cur) throw e;
      if (cur.token !== o.token) return { kind: "skip", why: "busy" };
    }
    if (o.suspect) {
      const found = await o.story.find();
      if (found) {
        const mine = await o.store.get(o.id);
        return mine && mine.token === o.token ? adopt(o, mine, found, true) : { kind: "skip", why: "busy" };
      }
    }
  }
  // just before making the story: is the claim still ours? (a tab that slept may have lost it meanwhile)
  const check = await o.store.get(o.id);
  if (!check || check.token !== o.token || check.state !== "claiming" || check.itemId) return { kind: "skip", why: "lost" };
  let item: I;
  try {
    item = await o.story.make();
  } catch (e) {
    if (isRefusal(e)) {
      // definitely not made: give the claim back, so a later check can try again
      await o.store.remove(o.id, check.__etag).catch(() => {});
      return { kind: "refused", error: e };
    }
    // maybe made: keep the claim. Whoever takes it over after 10 minutes looks for the story first
    await swap(o, check, { ...check, state: "unsure", at: at() }).catch(() => null);
    return { kind: "unsure", error: e };
  }
  const { doc: saved, double } = await record(o, check, item);
  // still ours (not adopted by a tab that found our story meanwhile, which then adds its tasks)
  if (saved && saved.token === o.token && saved.state !== "done") {
    await o.story.complete(item.id);
    await swap(o, saved, { ...saved, state: "done" }).catch(() => null);
  }
  return { kind: "made", item, recorded: !!saved || double, double };
}

/** A story made earlier for this occurrence: write it into the record (and finish it when it was found by its title). */
async function adopt<I extends { id: number; title: string }>(o: RunInput<I>, doc: RunDoc, story: { id: number; title: string; assignee?: string }, finish: boolean): Promise<RunOutcome<I>> {
  const saved = await swap(o, doc, { ...doc, state: "made", itemId: story.id, title: story.title || doc.title, assignee: story.assignee ?? doc.assignee, by: o.by, token: o.token, at: new Date(o.now()).toISOString() });
  if (!saved) return { kind: "skip", why: "busy" };
  // found by its title: the tab that made it never got to its tasks
  if (finish) await o.story.complete(story.id);
  await swap(o, saved, { ...saved, state: "done" }).catch(() => null);
  return { kind: "found", itemId: story.id };
}

/**
 * Save `next` over `from` only if the record is still `from`. Null when someone saved first. With no
 * answer, the record is read back: the save counts when the record is now ours.
 */
async function swap<I extends { id: number; title: string }>(o: RunInput<I>, from: RunDoc, next: RunDoc): Promise<RunDoc | null> {
  try {
    return await o.store.replace({ ...next, __etag: from.__etag });
  } catch (e) {
    if (isConflict(e)) return null;
    if (isRefusal(e)) throw e;
    const cur = await o.store.get(o.id);
    return cur && cur.token === next.token && cur.state === next.state && cur.at === next.at && cur.itemId === next.itemId ? cur : null;
  }
}

/**
 * Write the story we made into the record at once: on our claim, or on the claim of a tab that took over
 * meanwhile (so it stops). Retried on conflicts and lost answers. Gives the saved record, or null with
 * `double` when another story is on it already, or null when it could not be written (storage away):
 * then a tab that takes the claim over later finds our story by its title.
 */
async function record<I extends { id: number; title: string }>(o: RunInput<I>, start: RunDoc, item: I): Promise<{ doc: RunDoc | null; double: boolean }> {
  const pause = o.pause ?? wait;
  let cur: RunDoc | null = start;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (cur?.itemId === item.id) return { doc: cur, double: false };
    const double = !!cur?.itemId;
    if (double && cur!.also?.includes(item.id)) return { doc: null, double: true };
    const next: RunDoc = double
      ? { ...cur!, also: [...(cur!.also ?? []), item.id] }
      : { ...(cur ?? start), state: "made", itemId: item.id, title: item.title, assignee: o.assignee, by: o.by, token: o.token, at: new Date(o.now()).toISOString() };
    try {
      // the record is gone (deleted meanwhile): made again, so the story is not made twice
      const saved = cur ? await o.store.replace(next) : await o.store.create({ ...next, __etag: undefined });
      return double ? { doc: null, double: true } : { doc: saved, double: false };
    } catch (e) {
      if (isRefusal(e) && !isConflict(e)) return { doc: null, double: false };
      await pause(300 * (attempt + 1));
      // the save may have gone through without an answer, or someone saved first: read it again and decide again
      try { cur = await o.store.get(o.id); } catch { /* no answer: try again with what we have */ }
    }
  }
  return { doc: null, double: false };
}
