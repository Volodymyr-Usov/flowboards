// Retrospectives without the page: templates, phases, votes and ordering. Covered by test/retrologic.test.ts.

export type Phase = "write" | "vote" | "act" | "closed";
export const PHASES: { id: Phase; label: string; help: string }[] = [
  { id: "write", label: "Write", help: "Everyone adds notes. Other people's notes stay hidden until the board moves on." },
  { id: "vote", label: "Vote", help: "All notes show. Everyone spends their votes on the notes to talk about first." },
  { id: "act", label: "Discuss", help: "Notes in vote order. Agree on action items; each can become a task in Azure DevOps." },
  { id: "closed", label: "Closed", help: "The retrospective is over. Its action items show at the start of the next one." },
];

export interface RetroColumn { id: string; title: string; color: string }

export const TEMPLATES: { id: string; label: string; columns: RetroColumn[] }[] = [
  { id: "classic", label: "Went well / To improve / Ideas", columns: [
    { id: "good", title: "Went well", color: "var(--ok)" }, { id: "improve", title: "To improve", color: "var(--warn)" }, { id: "ideas", title: "Ideas", color: "var(--accent)" }] },
  { id: "ssc", label: "Start / Stop / Continue", columns: [
    { id: "start", title: "Start", color: "var(--ok)" }, { id: "stop", title: "Stop", color: "var(--bad)" }, { id: "continue", title: "Continue", color: "var(--accent)" }] },
  { id: "msg", label: "Mad / Sad / Glad", columns: [
    { id: "mad", title: "Mad", color: "var(--bad)" }, { id: "sad", title: "Sad", color: "var(--warn)" }, { id: "glad", title: "Glad", color: "var(--ok)" }] },
  { id: "4l", label: "Liked / Learned / Lacked / Longed for", columns: [
    { id: "liked", title: "Liked", color: "var(--ok)" }, { id: "learned", title: "Learned", color: "var(--accent)" },
    { id: "lacked", title: "Lacked", color: "var(--warn)" }, { id: "longed", title: "Longed for", color: "var(--s4)" }] },
];

export interface RetroBoard {
  id: string;
  kind: "board";
  iteration: string; // iteration id
  iterationName: string;
  start?: string;
  columns: RetroColumn[];
  phase: Phase;
  votesPerPerson: number;
  anonymous: boolean;
  created: string;
  createdBy: string;
  /** its notes, actions and ballots are in a collection of its own (older boards kept them with the boards) */
  notesApart?: boolean;
}

export interface RetroNote {
  id: string;
  kind: "note";
  board: string; // iteration id
  column: string;
  text: string;
  /** unique name of the writer, absent on an anonymous board */
  author?: string;
  authorName?: string;
  created: string;
  /** unique name -> votes given */
  votes: Record<string, number>;
}

export interface RetroAction {
  id: string;
  kind: "action";
  board: string;
  text: string;
  owner?: string;
  ownerName?: string;
  workItemId?: number;
  done?: boolean;
  created: string;
  noteId?: string;
}

/**
 * One person's votes on one board, without their name: the id is a one-way hash of the board, the
 * person and a random salt kept in their own (personal) storage (see ballotId), so nobody can tell
 * whose votes these are. Only this person's tabs write it.
 */
export interface RetroBallot {
  id: string;
  kind: "ballot";
  board: string; // iteration id
  /** note id -> votes given */
  votes: Record<string, number>;
}

export type RetroDoc = RetroBoard | RetroNote | RetroAction | RetroBallot;

/** Votes kept on the note itself, by name (older versions); new votes are in ballots. */
export const totalVotes = (n: RetroNote): number => Object.values(n.votes ?? {}).reduce((a, b) => a + b, 0);

/**
 * The documents the page works with: the boards from the team's collection (with the notes and actions
 * of boards not split yet), and the notes, actions and ballots of each split board from its own collection.
 * Old copies of a split board's notes still in the team's collection are not used.
 */
export function mergeRetroDocs(main: RetroDoc[], own: Map<string, RetroDoc[]>): RetroDoc[] {
  const apart = new Set(main.filter((d): d is RetroBoard => d.kind === "board" && !!d.notesApart).map((b) => b.iteration));
  const out = main.filter((d) => d.kind === "board" || !apart.has(d.board));
  const seen = new Set(out.map((d) => d.id));
  for (const list of own.values()) for (const d of list) {
    if (d.kind === "board" || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

/** Notes and actions of a split board still only in the team's collection (written there just before the split): to copy over. */
export function strays(main: RetroDoc[], own: RetroDoc[], iteration: string): (RetroNote | RetroAction)[] {
  const have = new Set(own.map((d) => d.id));
  return main.filter((d): d is RetroNote | RetroAction => (d.kind === "note" || d.kind === "action") && d.board === iteration && !have.has(d.id));
}

/** A random salt for ballotId, as 64 hex digits. */
export function newSalt(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The id of a person's ballot on a board: "ballot-" and 40 hex digits of SHA-256(board, person, salt). */
export async function ballotId(board: string, uniqueName: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${board}\n${uniqueName.toLowerCase()}\n${salt}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return "ballot-" + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

/** Votes per note: those on the note (older, by name) and those in the ballots. */
export function noteTotals(notes: RetroNote[], ballots: RetroBallot[]): Map<string, number> {
  const out = new Map(notes.map((n) => [n.id, totalVotes(n)]));
  for (const b of ballots) for (const [id, c] of Object.entries(b.votes ?? {})) if (out.has(id) && c > 0) out.set(id, out.get(id)! + c);
  return out;
}

/** How many people voted on these notes: names on the notes (older votes) and ballots with a vote on a note still there. */
export function voterCount(notes: RetroNote[], ballots: RetroBallot[]): number {
  const ids = new Set(notes.map((n) => n.id));
  const names = new Set(notes.flatMap((n) => Object.entries(n.votes ?? {}).filter(([, c]) => c > 0).map(([k]) => k.toLowerCase())));
  return names.size + ballots.filter((b) => Object.entries(b.votes ?? {}).some(([id, c]) => c > 0 && ids.has(id))).length;
}

/** My votes on a note: on the note by name (older) and in my ballot. */
export function myVotesOn(n: RetroNote, mine: RetroBallot | undefined, me: string): number {
  const key = me.toLowerCase();
  const old = Object.entries(n.votes ?? {}).find(([k]) => k.toLowerCase() === key)?.[1] ?? 0;
  return old + Math.max(0, mine?.votes?.[n.id] ?? 0);
}

/** Votes I spent on these notes (a vote on a deleted note is free again). */
export function myVotesUsed(notes: RetroNote[], mine: RetroBallot | undefined, me: string): number {
  return notes.reduce((s, n) => s + myVotesOn(n, mine, me), 0);
}

/**
 * Add (+1) or take back (-1) one vote in my ballot (made when there is none). Refuses (null) when no
 * votes are left, or there is no vote of mine in the ballot to take back (one on the note itself, from
 * an older version, is taken back with `vote`).
 */
export function ballotVote(ballot: RetroBallot | null, id: string, board: string, noteId: string, delta: 1 | -1, left: number): RetroBallot | null {
  const b: RetroBallot = ballot ? { ...ballot, votes: { ...(ballot.votes ?? {}) } } : { id, kind: "ballot", board, votes: {} };
  const mine = b.votes[noteId] ?? 0;
  if (delta > 0 && left <= 0) return null;
  if (delta < 0 && mine <= 0) return null;
  const next = mine + delta;
  if (next > 0) b.votes[noteId] = next; else delete b.votes[noteId];
  return b;
}

/** Votes this person has spent on this board. */
export function votesUsed(notes: RetroNote[], me: string): number {
  const key = me.toLowerCase();
  let used = 0;
  for (const n of notes) for (const [who, c] of Object.entries(n.votes ?? {})) if (who.toLowerCase() === key) used += c;
  return used;
}

/** Add (+1) or take back (-1) one vote; refuses when no votes are left or none were given. */
export function vote(note: RetroNote, me: string, delta: 1 | -1, left: number): RetroNote | null {
  const votes = { ...(note.votes ?? {}) };
  const key = Object.keys(votes).find((k) => k.toLowerCase() === me.toLowerCase()) ?? me;
  const mine = votes[key] ?? 0;
  if (delta > 0 && left <= 0) return null;
  if (delta < 0 && mine <= 0) return null;
  const next = mine + delta;
  if (next) votes[key] = next; else delete votes[key];
  return { ...note, votes };
}

/** Notes of a column: by votes once voting started, else newest last. `count` gives a note's votes. */
export function ordered(notes: RetroNote[], phase: Phase, count: (n: RetroNote) => number = totalVotes): RetroNote[] {
  const byTime = (a: RetroNote, b: RetroNote) => a.created.localeCompare(b.created);
  return [...notes].sort(phase === "write" ? byTime : (a, b) => count(b) - count(a) || byTime(a, b));
}

/** Every note of a board in one list to discuss: most votes first, then oldest first. */
export function ranked(notes: RetroNote[], count: (n: RetroNote) => number = totalVotes): RetroNote[] {
  return [...notes].sort((a, b) => count(b) - count(a) || a.created.localeCompare(b.created));
}

/** While writing, people see only their own notes; the rest show as a count. */
export function visibleNotes(notes: RetroNote[], phase: Phase, mine: (n: RetroNote) => boolean): { shown: RetroNote[]; hidden: number } {
  if (phase !== "write") return { shown: notes, hidden: 0 };
  const shown = notes.filter(mine);
  return { shown, hidden: notes.length - shown.length };
}

/**
 * The retrospective before this one: the board of the latest earlier sprint. With no board for the
 * viewed sprint, `before` (its start) is the limit, so boards of later sprints never count.
 */
export function previousBoard(boards: RetroBoard[], current: RetroBoard | undefined, startOf: (iterationId: string) => string | undefined, before?: string): RetroBoard | undefined {
  const key = (b: RetroBoard) => startOf(b.iteration) ?? b.start ?? b.created;
  const mine = current ? key(current) : before ?? new Date().toISOString();
  return boards.filter((b) => b !== current && b.iteration !== current?.iteration && key(b) < mine).sort((a, b) => key(b).localeCompare(key(a)))[0];
}

export function nextPhase(p: Phase): Phase {
  const i = PHASES.findIndex((x) => x.id === p);
  return PHASES[Math.min(PHASES.length - 1, i + 1)].id;
}
