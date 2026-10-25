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

export type RetroDoc = RetroBoard | RetroNote | RetroAction;

export const totalVotes = (n: RetroNote): number => Object.values(n.votes ?? {}).reduce((a, b) => a + b, 0);

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

/** Notes of a column: by votes once voting started, else newest last. */
export function ordered(notes: RetroNote[], phase: Phase): RetroNote[] {
  const byTime = (a: RetroNote, b: RetroNote) => a.created.localeCompare(b.created);
  return [...notes].sort(phase === "write" ? byTime : (a, b) => totalVotes(b) - totalVotes(a) || byTime(a, b));
}

/** Every note of a board in one list to discuss: most votes first, then oldest first. */
export function ranked(notes: RetroNote[]): RetroNote[] {
  return [...notes].sort((a, b) => totalVotes(b) - totalVotes(a) || a.created.localeCompare(b.created));
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
