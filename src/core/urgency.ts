// Urgency: one live score from 0 to 100 for a story, from how important it was said to be, how long it waits, how near
// its sprint's end and its deadline are, and how many items wait for it. Computed on the page, never written to Azure
// DevOps. Pure: the page gathers the facts, this weighs them. The weights are the team's (Settings > Priority).

/** What counts and how much (the weights are relative: they are scaled to add up to 100). */
export interface UrgencyWeights {
  /** the story's own Priority field (1 = most important … 4) */
  own: number;
  /** the priority of the Feature above it (the Epic's when the Feature has none) */
  feature: number;
  /** how long it has been waiting (since created while not started, else in its state), growing steeply after the stale days */
  waiting: number;
  /** how near the end of its sprint is */
  sprint: number;
  /** how many open items wait for it */
  blocking: number;
  /** its priority score (value ÷ size) against the best of the team; off (0) by default */
  value: number;
  /** a deadline (due date, else target date) adds up to this many points on top, the closer or the later it is, the more */
  deadlineMax: number;
  /** a deadline begins to count this many days ahead */
  deadlineDays: number;
}

export const DEFAULT_URGENCY: UrgencyWeights = { own: 40, feature: 20, waiting: 20, sprint: 10, blocking: 10, value: 0, deadlineMax: 50, deadlineDays: 28 };

const num = (v: unknown, min: number, max: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

/** The saved weights made safe: numbers in range, defaults for what is missing. */
export function cleanUrgency(raw: unknown): UrgencyWeights {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof UrgencyWeights, unknown>>;
  const d = DEFAULT_URGENCY;
  return {
    own: num(r.own, 0, 100, d.own), feature: num(r.feature, 0, 100, d.feature), waiting: num(r.waiting, 0, 100, d.waiting), sprint: num(r.sprint, 0, 100, d.sprint),
    blocking: num(r.blocking, 0, 100, d.blocking), value: num(r.value, 0, 100, d.value),
    deadlineMax: num(r.deadlineMax, 0, 100, d.deadlineMax), deadlineDays: Math.round(num(r.deadlineDays, 1, 365, d.deadlineDays)),
  };
}

/** Priority 1 to 4 as points: 1 = 100, 2 = 75, 3 = 50, 4 = 25; none = 0. */
export const priorityPoints = (p: number | undefined): number => (p == null || !(p >= 1) ? 0 : Math.max(0, Math.min(100, 125 - 25 * Math.min(4, Math.round(p)))));

/** Waiting: up to the stale days it climbs to 40; from there it rises steeply and reaches 100 two stale periods later. */
export function waitingPoints(days: number, staleDays: number): number {
  const s = Math.max(1, staleDays);
  const d = Math.max(0, days);
  return d <= s ? (40 * d) / s : 40 + 60 * Math.min(1, (d - s) / (2 * s));
}

/** The sprint's end: nothing when it is not in a sprint (null), growing over its last 14 days, full at the end. */
export const sprintPoints = (daysLeft: number | null): number => (daysLeft == null ? 0 : 100 * Math.max(0, Math.min(1, 1 - daysLeft / 14)));

/** Items waiting for it: a third of the way to 100 each. */
export const blockingPoints = (n: number): number => Math.min(100, Math.max(0, n) * 34);

/** How pressing a deadline is, 0 to 1: nothing before the horizon, then rising to 1 on the day, and 1 once it has passed. */
export function deadlinePressure(daysLeft: number | null, horizonDays: number): number {
  if (daysLeft == null) return 0;
  if (daysLeft <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - daysLeft / Math.max(1, horizonDays)));
}

export interface UrgencyInput {
  priority?: number;
  featurePriority?: number;
  /** days it has waited */
  daysWaiting: number;
  staleDays: number;
  /** calendar days to the end of its sprint (null: not in a sprint, or the sprint is over) */
  sprintDaysLeft: number | null;
  /** open items that wait for it */
  blocks: number;
  /** its value ÷ size against the best of the team, 0 to 1 (null: no score) */
  valueShare: number | null;
  /** days to its deadline (negative: passed; null: no deadline) */
  deadlineDaysLeft: number | null;
}

export interface UrgencyPart { key: string; label: string; /** 0–100 */ value: number; /** its share of the base, in percent */ share: number; /** what it adds to the score */ points: number }

export interface UrgencyResult {
  /** 0–100 */
  score: number;
  /** 0–5, as the bars on the card: 100 is five, 20 is one */
  bars: number;
  /** what the weighted factors give, before a deadline */
  base: number;
  /** what the deadline added */
  boost: number;
  parts: UrgencyPart[];
}

/** The bars for a score: 100 is five bars, 20 is one, 0 is none. */
export const barsOf = (score: number): number => (score <= 0 ? 0 : Math.min(5, Math.ceil(score / 20 - 1e-9)));

export function urgency(i: UrgencyInput, w: UrgencyWeights): UrgencyResult {
  const rows: { key: string; label: string; value: number; weight: number }[] = [
    { key: "own", label: "its own priority", value: priorityPoints(i.priority), weight: w.own },
    { key: "feature", label: "the priority of its Feature", value: priorityPoints(i.featurePriority), weight: w.feature },
    { key: "waiting", label: "how long it waits", value: waitingPoints(i.daysWaiting, i.staleDays), weight: w.waiting },
    { key: "sprint", label: "the end of its sprint", value: sprintPoints(i.sprintDaysLeft), weight: w.sprint },
    { key: "blocking", label: "items waiting for it", value: blockingPoints(i.blocks), weight: w.blocking },
    { key: "value", label: "its value for the size", value: i.valueShare == null ? 0 : 100 * Math.max(0, Math.min(1, i.valueShare)), weight: w.value },
  ];
  const total = rows.reduce((s, r) => s + r.weight, 0);
  const parts: UrgencyPart[] = rows.filter((r) => r.weight > 0).map((r) => ({ key: r.key, label: r.label, value: r.value, share: total ? (100 * r.weight) / total : 0, points: total ? (r.value * r.weight) / total : 0 }));
  const base = parts.reduce((s, p) => s + p.points, 0);
  const boost = w.deadlineMax * deadlinePressure(i.deadlineDaysLeft, w.deadlineDays);
  const score = Math.max(0, Math.min(100, base + boost));
  return { score, bars: barsOf(score), base, boost, parts };
}

/** The score in words: what each factor is and what it adds, and the deadline. */
export function explainUrgency(r: UrgencyResult, i: Pick<UrgencyInput, "deadlineDaysLeft">): string {
  const lines = [`Urgency ${Math.round(r.score)} of 100 (${r.bars} of 5 bars).`];
  for (const p of r.parts) lines.push(`${p.label}: ${Math.round(p.value)} of 100, adds ${p.points.toFixed(1)}`);
  if (i.deadlineDaysLeft != null) {
    const d = i.deadlineDaysLeft;
    lines.push(`deadline ${d < 0 ? `passed ${-d} day${d === -1 ? "" : "s"} ago` : d === 0 ? "is today" : `in ${d} day${d === 1 ? "" : "s"}`}: adds ${r.boost.toFixed(1)}`);
  }
  lines.push("Change what counts in Settings > Priority.");
  return lines.join("\n");
}
