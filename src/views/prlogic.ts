// Pure helpers for the Pull requests and Projects views: what a vote means, who a pull request
// waits on, medians and percentiles, weekly counts, and a small job pool. No page, no network.
import type { Person, PullRequest } from "../api/types.ts";
import { percentile } from "../core/metrics.ts";
import { DAY, samePerson } from "../core/model.ts";

export { percentile };

export type VoteKind = "approved" | "suggestions" | "waiting" | "rejected" | "none";

/** Azure DevOps votes: 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for the author, -10 rejected. */
export function voteKind(vote: number): VoteKind {
  if (vote >= 10) return "approved";
  if (vote > 0) return "suggestions";
  if (vote <= -10) return "rejected";
  if (vote < 0) return "waiting";
  return "none";
}

export const VOTE_LABEL: Record<VoteKind, string> = {
  approved: "Approved",
  suggestions: "Approved with suggestions",
  waiting: "Waiting for the author",
  rejected: "Rejected",
  none: "No vote yet",
};

export interface WaitingOn {
  /** reviewers: the listed reviewers must vote; author: the author must act (see why); none: nobody asked to review */
  kind: "reviewers" | "author" | "none";
  people: Person[];
  /** why the author: changes asked for, merge conflicts, or approved and ready to complete */
  why?: "changes" | "conflicts" | "complete";
}

/**
 * Who the pull request waits on:
 * - the author, when any reviewer voted "waiting" or "rejected";
 * - the author, when the merge has conflicts or failed;
 * - else the required reviewers who have not voted;
 * - else, when nobody has approved yet, every reviewer who has not voted;
 * - else, once approved, the author (to complete it);
 * - nobody when no one was asked to review.
 */
export function waitingOn(pr: PullRequest): WaitingOn {
  const author = (why: WaitingOn["why"]): WaitingOn => ({ kind: "author", people: [pr.createdBy], why });
  if (pr.reviewers.some((r) => r.vote < 0)) return author("changes");
  if (pr.mergeStatus === "conflicts" || pr.mergeStatus === "failure") return author("conflicts");
  const required = pr.reviewers.filter((r) => r.isRequired && r.vote === 0);
  if (required.length) return { kind: "reviewers", people: required.map((r) => r.person) };
  if (!pr.reviewers.some((r) => r.vote > 0)) {
    const open = pr.reviewers.filter((r) => r.vote === 0);
    return open.length ? { kind: "reviewers", people: open.map((r) => r.person) } : { kind: "none", people: [] };
  }
  return author("complete");
}

/** A group's name without its scope: "[Project]\Team" -> "Team". */
export function shortName(name: string): string {
  return name.replace(/^\[[^\]]*\]\\/, "");
}

/** The person as shown: a group without its "[Project]\" part, so its initials are right too. */
export function shownPerson<P extends Person>(p: P): P {
  const n = shortName(p.displayName);
  return n === p.displayName ? p : { ...p, displayName: n };
}

/** Up to `max` names, then how many more: "Ann", "Ann, Bob", "Ann, Bob +2". */
export function namesText(names: string[], max = 2): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} +${names.length - max}`;
}

/** True when the person is a reviewer who has not voted yet. */
export function needsReviewBy(pr: PullRequest, me: Person): boolean {
  return pr.reviewers.some((r) => r.vote === 0 && samePerson(r.person, me));
}

export function isAuthor(pr: PullRequest, me: Person): boolean {
  return samePerson(pr.createdBy, me);
}

export function isOpen(pr: PullRequest): boolean {
  return pr.status === "active" || pr.status === "draft";
}

/** The columns that have a title to sort by on each tab. */
const SORT_KEYS: Record<"open" | "completed" | "abandoned", string[]> = {
  open: ["age", "title", "author"],
  completed: ["closed", "merge", "title", "author"],
  abandoned: ["closed", "merge", "title", "author"],
};

/** The sort column to use on a tab: the saved one, or the tab's own when the saved one is another tab's. */
export function sortKeyFor(tab: "open" | "completed" | "abandoned", key: string): string {
  return SORT_KEYS[tab].includes(key) ? key : tab === "open" ? "age" : "closed";
}

/** Fractional days between two ISO dates (or from a date to now). */
export function daysBetween(fromIso: string, toIso?: string, now = Date.now()): number {
  const end = toIso ? Date.parse(toIso) : now;
  return Math.max(0, (end - Date.parse(fromIso)) / DAY);
}

/** ok below 3 days, warn from 3, bad from 7. */
export function ageLevel(days: number): "ok" | "warn" | "bad" {
  return days >= 7 ? "bad" : days >= 3 ? "warn" : "ok";
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

/** A duration in days as short text: "45m", "5h", "2.3d", "12d". */
export function fmtDuration(days: number): string {
  if (!Number.isFinite(days)) return "–";
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}m`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 10) return `${(Math.round(days * 10) / 10).toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

/** Monday 00:00 (UTC) of the week of a time. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return d.getTime() - dow * DAY;
}

/** Counts per week (Monday start) for the last `weeks` weeks, oldest first, the current week last. */
export function weeklyCounts(dates: string[], weeks: number, now = Date.now()): { start: number; count: number }[] {
  const last = weekStart(now);
  const out = Array.from({ length: weeks }, (_, i) => ({ start: last - (weeks - 1 - i) * 7 * DAY, count: 0 }));
  for (const iso of dates) {
    const w = weekStart(Date.parse(iso));
    const i = Math.round((w - out[0].start) / (7 * DAY));
    if (i >= 0 && i < weeks) out[i].count++;
  }
  return out;
}

/**
 * Per week (by when it was completed): the days from opened to the first approval and to merged, as the
 * median (the middle one: a single stuck pull request does not bend the line) or the mean.
 */
export function weeklyTimes(prs: { created: string; closed: string; approved?: string | null }[], weeks: number, now = Date.now(), stat: "median" | "mean" = "median"):
  { start: number; approval: number | null; merge: number | null; merged: number; approvedCount: number }[] {
  const last = weekStart(now);
  const out = Array.from({ length: weeks }, (_, i) => ({ start: last - (weeks - 1 - i) * 7 * DAY, a: [] as number[], m: [] as number[] }));
  for (const pr of prs) {
    const i = Math.round((weekStart(Date.parse(pr.closed)) - out[0].start) / (7 * DAY));
    if (i < 0 || i >= weeks) continue;
    out[i].m.push(daysBetween(pr.created, pr.closed));
    if (pr.approved) out[i].a.push(Math.max(0, daysBetween(pr.created, pr.approved)));
  }
  const avg = (xs: number[]): number | null => (xs.length ? (stat === "mean" ? xs.reduce((s, x) => s + x, 0) / xs.length : median(xs)) : null);
  return out.map((w) => ({ start: w.start, approval: avg(w.a), merge: avg(w.m), merged: w.m.length, approvedCount: w.a.length }));
}

/** The whole period: how many were merged and approved, and the median and 85th percentile of the days (null: none). */
export function timeSummary(prs: { created: string; closed: string; approved?: string | null }[]):
  { merged: number; mergeMedian: number | null; mergeP85: number | null; approved: number; approvalMedian: number | null; approvalP85: number | null } {
  const m = prs.map((p) => daysBetween(p.created, p.closed));
  const a = prs.filter((p) => p.approved).map((p) => Math.max(0, daysBetween(p.created, p.approved!)));
  const pick = (xs: number[], q: number): number | null => (xs.length ? percentile(xs, q) : null);
  return { merged: m.length, mergeMedian: pick(m, 50), mergeP85: pick(m, 85), approved: a.length, approvalMedian: pick(a, 50), approvalP85: pick(a, 85) };
}

/** Time to merge per group (e.g. repository): count, median and 85th percentile, busiest first. */
export function mergeStats<T>(list: T[], key: (x: T) => string, days: (x: T) => number): { key: string; count: number; median: number; p85: number }[] {
  const groups = new Map<string, number[]>();
  for (const x of list) {
    const k = key(x);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(days(x));
  }
  return [...groups].map(([k, v]) => ({ key: k, count: v.length, median: median(v), p85: percentile(v, 85) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Run a job for every input with at most `limit` running at once. Results keep the input order;
 * a failed job gives { error }. `onDone` runs after each job; `stop()` returning true skips the rest.
 */
export async function runLimited<I, O>(inputs: I[], limit: number, job: (x: I, i: number) => Promise<O>,
  onDone?: (done: number, x: I, result: { value?: O; error?: unknown }) => void, stop?: () => boolean): Promise<{ value?: O; error?: unknown }[]> {
  const out: { value?: O; error?: unknown }[] = new Array(inputs.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      if (stop?.()) return;
      const i = next++;
      try { out[i] = { value: await job(inputs[i], i) }; } catch (e) { out[i] = { error: e }; }
      done++;
      onDone?.(done, inputs[i], out[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, inputs.length)) }, worker));
  return out;
}

/** HTTP status of an API error, when there is one. */
export function errorStatus(e: unknown): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : 0;
}

/** Refused for lack of permission (or hidden from the person: 404 on a project). */
export function isNoAccess(e: unknown): boolean {
  const s = errorStatus(e);
  return s === 401 || s === 403 || s === 404;
}

// ---------- linked work items at the story level ----------

export type LevelKind = "portfolio" | "requirement" | "task";

/** What the story mapping needs to know of a work item. */
export interface LinkedItem { id: number; type: string; parent?: number }

export interface StoryLink {
  /** the story (requirement level); or the linked item itself when no story is above it */
  id: number;
  /** the pull request is linked to this item itself */
  direct: boolean;
  /** tasks under it that the pull request is linked to */
  via: number[];
}

/** The nearest requirement-level item above a task-level item, walking known parents only. */
function storyAbove(it: LinkedItem, get: (id: number) => LinkedItem | undefined, kindOf: (type: string) => LevelKind | undefined): number | undefined {
  const seen = new Set([it.id]);
  let p = it.parent;
  for (let i = 0; p && i < 6 && !seen.has(p); i++) {
    const x = get(p);
    if (!x) return undefined;
    const k = kindOf(x.type);
    if (k === "requirement") return x.id;
    if (k !== "task") return undefined;
    seen.add(p);
    p = x.parent;
  }
  return undefined;
}

/**
 * Linked work items shown at the story level: a task becomes the story above it (with the task in `via`);
 * every other item stays itself. Order of first appearance, each story once.
 */
export function storyLinks(ids: number[], get: (id: number) => LinkedItem | undefined, kindOf: (type: string) => LevelKind | undefined): StoryLink[] {
  const out = new Map<number, StoryLink>();
  for (const id of ids) {
    const it = get(id);
    const story = it && kindOf(it.type) === "task" ? storyAbove(it, get, kindOf) : undefined;
    const key = story ?? id;
    let s = out.get(key);
    if (!s) out.set(key, (s = { id: key, direct: false, via: [] }));
    if (story === undefined) s.direct = true;
    else if (!s.via.includes(id)) s.via.push(id);
  }
  return [...out.values()];
}

/** Parents not known yet that storyLinks needs to reach the stories above task-level items. */
export function missingParents(ids: number[], get: (id: number) => LinkedItem | undefined, kindOf: (type: string) => LevelKind | undefined): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    let it = get(id);
    for (let i = 0; it && kindOf(it.type) === "task" && it.parent && i < 6; i++) {
      const p = get(it.parent);
      if (!p) { out.add(it.parent); break; }
      it = p;
    }
  }
  return [...out];
}

// ---------- suggested work items for a pull request without one ----------

export interface Mention { id: number; where: "branch" | "title" | "description" }

const isYear = (s: string): boolean => /^(19|20)\d\d$/.test(s);
const isMonthOrDay = (s: string): boolean => /^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 31;
/** "20261022": a year 19xx/20xx, a month and a day written together */
const isCompactDate = (s: string): boolean => {
  const m = /^((?:19|20)\d\d)(\d\d)(\d\d)$/.exec(s);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31;
};

/**
 * Numbers of 2+ digits standing alone in a branch name, between "/", "-", "_" or "#". Left out: numbers
 * joined by dots ("1.2.3", "2026.10"), three or more numbers in a row ("2026-10-22", "1-2-3"), a year next to
 * a month or day ("2026-10", "10_2026"), a date written together ("20261022"), and numbers inside a word ("v2").
 */
export function branchNumbers(branch: string): string[] {
  const out: string[] = [];
  for (const seg of branch.split(/[/#]+/)) {
    for (const m of seg.matchAll(/\d+(?:[-_.]\d+)*/g)) {
      const at = m.index ?? 0;
      const before = seg[at - 1];
      const after = seg[at + m[0].length];
      if (m[0].includes(".")) continue; // a version
      const parts = m[0].split(/[-_]/);
      if (parts.length >= 3) continue; // a date or a version
      if (parts.length === 2 && ((isYear(parts[0]) && isMonthOrDay(parts[1])) || (isYear(parts[1]) && isMonthOrDay(parts[0])))) continue;
      // a number glued to letters ("v2", "abc123") is part of a word
      const sep = (c: string | undefined): boolean => c === undefined || c === "-" || c === "_";
      const alone = parts.filter((_, i) => (i > 0 || sep(before)) && (i < parts.length - 1 || sep(after)));
      for (const p of alone) if (/^\d{2,9}$/.test(p) && !isCompactDate(p)) out.push(p);
    }
  }
  return out;
}

/**
 * Work item numbers a pull request mentions:
 * - branch: "#123", "AB#123", or a number of 2+ digits standing alone between "/", "-", "_" or "#"
 *   ("feature/123-login", "bug_4567", "users/ann/123"); dates and versions are not (see branchNumbers);
 * - title and description: "#123", "AB#123", or the title starting with a number ("123: Fix login").
 */
export function mentionedIds(pr: { title: string; sourceBranch?: string; description?: string }): Mention[] {
  const out: Mention[] = [];
  const add = (n: string, where: Mention["where"]): void => {
    const id = Number(n);
    if (Number.isSafeInteger(id) && id > 0 && !out.some((m) => m.id === id)) out.push({ id, where });
  };
  const branch = (pr.sourceBranch ?? "").replace(/^refs\/heads\//, "");
  for (const n of branchNumbers(branch)) add(n, "branch");
  for (const m of branch.matchAll(/#(\d{1,9})\b/g)) add(m[1], "branch");
  const hashes = (text: string, where: Mention["where"]): void => {
    for (const m of text.matchAll(/(?:^|[^\w&!])(?:AB)?#(\d{1,9})\b/gi)) add(m[1], where);
  };
  hashes(pr.title, "title");
  const lead = /^\s*(\d{2,9})\s*[:\-–]\s/.exec(pr.title);
  if (lead) add(lead[1], "title");
  if (pr.description) hashes(pr.description, "description");
  return out;
}

const STOP = new Set(("the and for with from into onto that this these those when then than are was were has have had not but "
  + "you your our its use using add adds added new fix fixes fixed update updates make get set all any can will should "
  + "more less some via per out off too also just only wip draft feature features bugfix hotfix chore users main "
  + "master develop dev branch merge refs heads").split(" "));

/** Meaningful words of a title or branch, lower case, plural "s" dropped: "Fix payments page" -> payment, page. */
export function titleWords(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Words two titles share, and how strong that is (shared / words of the shorter one, 0..1). */
export function wordOverlap(a: Set<string>, b: Set<string>): { shared: string[]; score: number } {
  const shared = [...a].filter((w) => b.has(w));
  const n = Math.min(a.size, b.size);
  return { shared, score: n ? shared.length / n : 0 };
}

/** A story worth suggesting: at least 2 shared words that are 60% or more of the shorter title. */
export const MATCH_MIN_WORDS = 2;
export const MATCH_MIN_SCORE = 0.6;

export interface StoryRef { id: number; title: string; open: boolean }

export interface Candidate {
  id: number;
  /** short, plain: "branch mentions #123", "title mentions task #45", "title matches" */
  reason: string;
  /** mentions rank above title matches; within each, higher first */
  score: number;
  /** words shared with the story's title (title matches only) */
  words?: string[];
}

/**
 * Stories a pull request without a linked work item probably belongs to, best first, at most `max`.
 * `resolve` turns a mentioned number into a story the page can link (a task gives its story), or undefined.
 * Title matches look at open stories only.
 */
export function prCandidates(pr: { title: string; sourceBranch?: string; description?: string }, stories: StoryRef[],
  resolve: (id: number) => { story: number; task?: number } | undefined, max = 3): Candidate[] {
  const out: Candidate[] = [];
  const has = (id: number): boolean => out.some((c) => c.id === id);
  mentionedIds(pr).forEach((m, i) => {
    const r = resolve(m.id);
    if (!r || has(r.story)) return;
    const what = r.task ? `task #${r.task}` : `#${m.id}`;
    out.push({ id: r.story, reason: `${m.where} mentions ${what}`, score: 100 - i - (m.where === "description" ? 10 : 0) });
  });
  const branchTail = (pr.sourceBranch ?? "").replace(/^refs\/heads\//, "");
  const mine = titleWords(`${pr.title} ${branchTail}`);
  const matches: Candidate[] = [];
  for (const s of stories) {
    if (!s.open || has(s.id)) continue;
    const { shared, score } = wordOverlap(mine, titleWords(s.title));
    if (shared.length >= MATCH_MIN_WORDS && score >= MATCH_MIN_SCORE) matches.push({ id: s.id, reason: "title matches", score: score + shared.length / 100, words: shared });
  }
  matches.sort((a, b) => b.score - a.score || b.id - a.id);
  return [...out, ...matches].slice(0, max);
}

/** Azure DevOps's own page to create a pull request in a repository, with the branches when chosen. */
export function newPrUrl(orgUrl: string, project: string, repo: string, source?: string, target?: string): string {
  const base = `${orgUrl}${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequestcreate`;
  const q: string[] = [];
  const name = (b: string): string => encodeURIComponent(b.replace(/^refs\/heads\//, ""));
  if (source) q.push(`sourceRef=${name(source)}`);
  if (target) q.push(`targetRef=${name(target)}`);
  return q.length ? `${base}?${q.join("&")}` : base;
}
