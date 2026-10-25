// "Likely done by" for each Feature and Epic: a Monte Carlo forecast from the team's daily pace.
// Assumption (said on screen): the team works through Features in backlog order, so a Feature is done
// when the stories of every Feature above it, and its own, are done. Pure; covered by test/forecast.test.ts.
import { percentile, seededRandom } from "./metrics.ts";

export interface QueueItem { id: number; remaining: number }
export interface ItemForecast { id: number; p50: number; p85: number; p95: number }

/**
 * For each item of the queue (in order), the number of days from today until its stories are done,
 * at 50, 85 and 95 out of 100 simulated futures. `samples` = stories finished per day in the past.
 * Items with nothing remaining get 0. When the past shows no progress at all, the result is empty.
 */
export function queueForecast(queue: QueueItem[], samples: number[], runs = 2000, seed = 7, maxDays = 3650): ItemForecast[] {
  if (!queue.length || !samples.length || samples.every((s) => s === 0)) return [];
  const thresholds: number[] = [];
  let total = 0;
  for (const q of queue) { total += Math.max(0, q.remaining); thresholds.push(total); }
  const rand = seededRandom(seed);
  const days: number[][] = queue.map(() => []);
  for (let r = 0; r < runs; r++) {
    let done = 0;
    let next = 0;
    while (next < thresholds.length && thresholds[next] === 0) { days[next].push(0); next++; }
    for (let d = 1; d <= maxDays && next < thresholds.length; d++) {
      done += samples[Math.floor(rand() * samples.length)];
      while (next < thresholds.length && done >= thresholds[next]) { days[next].push(d); next++; }
    }
    while (next < thresholds.length) { days[next].push(maxDays); next++; }
  }
  return queue.map((q, i) => {
    const sorted = days[i].sort((a, b) => a - b);
    return { id: q.id, p50: Math.ceil(percentile(sorted, 50)), p85: Math.ceil(percentile(sorted, 85)), p95: Math.ceil(percentile(sorted, 95)) };
  });
}

/** Stories finished per day over the last `length` days, from their closed dates (index 0 = oldest day). */
export function dailyThroughput(closedDates: string[], length: number, now = Date.now()): number[] {
  const day = 86_400_000;
  const end = Math.floor(now / day);
  const out = new Array(length).fill(0);
  for (const c of closedDates) {
    const d = Math.floor(Date.parse(c) / day);
    const i = length - 1 - (end - d);
    if (i >= 0 && i < length) out[i]++;
  }
  return out;
}

/** Would it miss its target? Late when the 85-of-100 date is after the target date. */
export function riskOf(p85Day: number, targetDay: number | null): "late" | "ok" | "none" {
  if (targetDay == null) return "none";
  return p85Day > targetDay ? "late" : "ok";
}
