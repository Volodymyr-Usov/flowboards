// Planning poker without the page: the deck, the result of a round, and who is here. Covered by test/pokerlogic.test.ts.

export const DECK = ["0", "0.5", "1", "2", "3", "5", "8", "13", "20", "40", "100", "?", "coffee"] as const;
export type Card = (typeof DECK)[number];
export const CARD_LABEL: Record<string, string> = { "0.5": "½", coffee: "☕" };

export interface PokerSession {
  id: "session";
  kind: "session";
  storyId: number | null;
  round: number;
  revealed: boolean;
  startedBy: string;
  updated: string;
}

export interface PokerVote {
  id: string;
  kind: "vote";
  storyId: number;
  round: number;
  user: string;
  name: string;
  value: Card;
  at: string;
}

export interface PokerPresence {
  id: string;
  kind: "here";
  user: string;
  name: string;
  seen: string;
}

export type PokerDoc = PokerSession | PokerVote | PokerPresence;

export const voteId = (storyId: number, round: number, user: string): string => `vote-${storyId}-${round}-${user.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
export const hereId = (user: string): string => `here-${user.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;

export interface RoundResult {
  count: number;
  numeric: number[];
  average: number | null;
  median: number | null;
  /** the deck card nearest the median: the suggested estimate */
  suggestion: number | null;
  consensus: boolean;
  /** value -> how many chose it, most chosen first */
  tally: { value: Card; n: number }[];
}

export function result(votes: PokerVote[]): RoundResult {
  const numeric = votes.map((v) => Number(v.value)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const average = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : null;
  const median = numeric.length ? (numeric.length % 2 ? numeric[(numeric.length - 1) / 2] : (numeric[numeric.length / 2 - 1] + numeric[numeric.length / 2]) / 2) : null;
  const cards = DECK.map(Number).filter((n) => Number.isFinite(n));
  const suggestion = median == null ? null : cards.reduce((best, c) => (Math.abs(c - median) < Math.abs(best - median) || (Math.abs(c - median) === Math.abs(best - median) && c > best) ? c : best), cards[0]);
  const counts = new Map<Card, number>();
  for (const v of votes) counts.set(v.value, (counts.get(v.value) ?? 0) + 1);
  const tally = [...counts].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || DECK.indexOf(a.value) - DECK.indexOf(b.value));
  const consensus = votes.length > 1 && counts.size === 1 && Number.isFinite(Number(votes[0].value));
  return { count: votes.length, numeric, average, median, suggestion, consensus, tally };
}

/** People seen in the last `withinMs` (they have the page open). */
export function present(docs: PokerPresence[], now = Date.now(), withinMs = 45_000): PokerPresence[] {
  return docs.filter((d) => now - Date.parse(d.seen) < withinMs).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Votes far apart: the highest is at least three times the lowest. A 0 counts as the smallest
 * card above it (½), or every round with a 0 in it would look wide.
 */
export function wideSpread(numeric: number[]): boolean {
  if (numeric.length < 2) return false;
  const lo = Math.min(...numeric);
  const hi = Math.max(...numeric);
  const smallest = Math.min(...DECK.map(Number).filter((n) => Number.isFinite(n) && n > 0));
  return hi > lo && hi >= Math.max(lo, smallest) * 3;
}
