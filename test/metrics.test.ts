import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageClass, asLocal, cfdSeries, cycleDays, dailyCounts, dayIndex, dayIso, dayOfKey, histogram, likelyAtLeast, likelyWithin, mean,
  niceTicks, noStartDate, percentile, rollingMean, seededRandom, simulateHowMany, simulateWhen, stageDates,
  weeklySums, workAge,
} from "../src/core/metrics.ts";
import type { FlowDates } from "../src/core/metrics.ts";

const DAY = 86_400_000;
const d = (iso: string): string => iso + "T12:00:00.000Z";

test("dayIndex is the local calendar day; dayIso and dayOfKey give the date back", () => {
  // late in the evening and early in the morning of the same local day, in any time zone
  const i = dayIndex(new Date(2026, 2, 10, 23, 59).toISOString());
  assert.equal(dayIso(i), "2026-03-10");
  assert.equal(dayIndex(new Date(2026, 2, 11, 0, 0).getTime()), i + 1);
  assert.equal(dayIndex(new Date(2026, 2, 10, 0, 30).getTime()), i);
  assert.equal(dayOfKey("2026-03-10"), i);
  assert.ok(Number.isNaN(dayOfKey("not a date")));
  // asLocal: the local time read as UTC
  assert.equal(new Date(asLocal(new Date(2026, 2, 10, 23, 59).getTime())).toISOString().slice(0, 16), "2026-03-10T23:59");
});

test("noStartDate: cycle time falls back to the created date", () => {
  assert.equal(noStartDate({ created: d("2026-01-01"), closed: d("2026-01-08"), category: "Completed" }), true);
  assert.equal(noStartDate({ created: d("2026-01-01"), activated: d("2026-01-02"), closed: d("2026-01-08"), category: "Completed" }), false);
});

test("percentile interpolates between ranks", () => {
  assert.ok(Number.isNaN(percentile([], 50)));
  assert.equal(percentile([7], 85), 7);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([4, 1, 3, 2], 50), 2.5, "unsorted input");
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.equal(percentile([0, 10], 85), 8.5);
  const input = [3, 1, 2];
  percentile(input, 50);
  assert.deepEqual(input, [3, 1, 2], "does not sort the caller's array");
});

test("mean", () => {
  assert.ok(Number.isNaN(mean([])));
  assert.equal(mean([1, 2, 3, 6]), 3);
});

test("niceTicks gives round steps that reach the maximum", () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceTicks(7, 4), [0, 2, 4, 6, 8]);
  const t = niceTicks(1234, 4);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1] >= 1234);
  assert.deepEqual(niceTicks(1, 4), [0, 0.25, 0.5, 0.75, 1]);
});

test("stageDates keeps only dates that fit the current category", () => {
  const base: FlowDates = { created: d("2026-01-01"), activated: d("2026-01-05"), resolved: d("2026-01-09"), closed: d("2026-01-10"), category: "Completed" };
  assert.deepEqual(stageDates(base), { proposed: base.created, inProgress: base.activated, resolved: base.resolved, completed: base.closed });
  // moved back to Active: stale resolved/closed dates are ignored
  assert.deepEqual(stageDates({ ...base, category: "InProgress" }), { proposed: base.created, inProgress: base.activated });
  assert.deepEqual(stageDates({ ...base, category: "Proposed" }), { proposed: base.created });
  // a process that does not set ActivatedDate: the last state change stands in for the current category
  const noAct: FlowDates = { created: d("2026-01-01"), stateChanged: d("2026-01-03"), category: "InProgress" };
  assert.equal(stageDates(noAct).inProgress, noAct.stateChanged);
  // closed without activated or resolved dates: straight from proposed to completed
  const direct: FlowDates = { created: d("2026-01-01"), stateChanged: d("2026-01-04"), category: "Completed" };
  assert.deepEqual(stageDates(direct), { proposed: direct.created, inProgress: undefined, resolved: undefined, completed: direct.stateChanged });
});

test("cycleDays uses activated, falls back to created, never negative", () => {
  assert.equal(cycleDays({ created: d("2026-01-01"), activated: d("2026-01-03"), closed: d("2026-01-08"), category: "Completed" }), 5);
  assert.equal(cycleDays({ created: d("2026-01-01"), closed: d("2026-01-08"), category: "Completed" }), 7);
  assert.equal(cycleDays({ created: d("2026-01-01"), category: "InProgress" }), null);
  assert.equal(cycleDays({ created: d("2026-01-05"), activated: d("2026-01-09"), closed: d("2026-01-08"), category: "Completed" }), 0);
  assert.equal(cycleDays({ created: d("2026-01-01"), stateChanged: d("2026-01-03"), category: "Completed" }), 2);
});

test("workAge and ageClass", () => {
  const now = Date.parse(d("2026-01-11"));
  assert.equal(workAge({ created: d("2026-01-01"), activated: d("2026-01-06"), category: "InProgress" }, now), 5);
  assert.equal(workAge({ created: d("2026-01-01"), category: "InProgress" }, now), 10);
  assert.equal(ageClass(3, 4, 10), "ok");
  assert.equal(ageClass(4, 4, 10), "ok");
  assert.equal(ageClass(5, 4, 10), "warn");
  assert.equal(ageClass(11, 4, 10), "bad");
  assert.equal(ageClass(99, NaN, NaN), "ok", "no history: nothing is flagged");
});

test("dailyCounts, weeklySums and rollingMean", () => {
  const daily = dailyCounts([10, 10, 11, 18, 3, 30], 10, 14);
  assert.equal(daily.length, 14);
  assert.deepEqual(daily.slice(0, 9), [2, 1, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(daily.reduce((a, b) => a + b, 0), 4, "days outside the range are ignored");
  assert.deepEqual(weeklySums(daily), [3, 1]);
  assert.deepEqual(weeklySums([1, 1, 1, 1, 1, 1, 1, 2, 2]), [7, 4]);
  assert.deepEqual(rollingMean([2, 4, 6, 8], 2), [2, 3, 5, 7]);
  assert.deepEqual(rollingMean([3, 3, 3], 4), [3, 3, 3]);
});

test("cfdSeries counts each item in its category at the end of each day", () => {
  const start = dayIndex(d("2026-01-01"));
  const items: FlowDates[] = [
    // created before the range, active on day 1, closed on day 3
    { created: d("2025-12-20"), activated: d("2026-01-02"), resolved: d("2026-01-04"), closed: d("2026-01-04"), category: "Completed" },
    // created on day 2, still proposed
    { created: d("2026-01-03"), category: "Proposed" },
    // active since before, resolved on day 4
    { created: d("2025-12-01"), activated: d("2025-12-05"), resolved: d("2026-01-05"), category: "Resolved" },
  ];
  const s = cfdSeries(items, start, 6);
  assert.deepEqual(s.Proposed, [1, 0, 1, 1, 1, 1]);
  assert.deepEqual(s.InProgress, [1, 2, 2, 1, 0, 0]);
  assert.deepEqual(s.Resolved, [0, 0, 0, 0, 1, 1], "resolved and closed the same day goes straight to completed");
  assert.deepEqual(s.Completed, [0, 0, 0, 1, 1, 1]);
  // the total on a day equals the items created by then
  for (let i = 0; i < 6; i++) {
    const total = s.Proposed[i] + s.InProgress[i] + s.Resolved[i] + s.Completed[i];
    assert.equal(total, i < 2 ? 2 : 3);
  }
});

test("cfdSeries tolerates dates out of order", () => {
  const start = dayIndex(d("2026-01-01"));
  const s = cfdSeries([{ created: d("2026-01-03"), activated: d("2026-01-01"), closed: d("2026-01-02"), category: "Completed" }], start, 4);
  assert.deepEqual(s.Proposed, [0, 0, 0, 0]);
  assert.deepEqual(s.InProgress, [0, 0, 0, 0]);
  assert.deepEqual(s.Completed, [0, 0, 1, 1]);
});

test("seededRandom repeats for the same seed and stays in [0, 1)", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const c = seededRandom(43);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.notEqual(xs[0], c());
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(mean(xs) - 0.5) < 0.05);
});

test("simulateHowMany: constant samples give a constant answer; results are sorted and repeatable", () => {
  assert.deepEqual(new Set(simulateHowMany([2], 10, 100)), new Set([20]));
  const r1 = simulateHowMany([0, 1, 2, 0, 3], 28, 2000, 7);
  const r2 = simulateHowMany([0, 1, 2, 0, 3], 28, 2000, 7);
  assert.deepEqual(r1, r2);
  assert.equal(r1.length, 2000);
  for (let i = 1; i < r1.length; i++) assert.ok(r1[i] >= r1[i - 1]);
  // the expected value is 28 × mean(samples) = 33.6
  assert.ok(Math.abs(mean(r1) - 33.6) < 1);
  assert.deepEqual(simulateHowMany([], 10, 3), [0, 0, 0]);
});

test("simulateWhen: constant samples, no throughput, cap", () => {
  assert.deepEqual(new Set(simulateWhen([1], 10, 50)), new Set([10]));
  assert.deepEqual(new Set(simulateWhen([3], 10, 50)), new Set([4]));
  assert.deepEqual(simulateWhen([0, 0], 5, 10), [], "never finishing work cannot be forecast");
  assert.deepEqual(new Set(simulateWhen([5], 0, 5)), new Set([0]));
  const capped = simulateWhen([1], 100, 5, 1, 30);
  assert.deepEqual(new Set(capped), new Set([31]), "runs past maxDays count as maxDays + 1");
  const r = simulateWhen([0, 1], 20, 3000, 3);
  assert.ok(Math.abs(mean(r) - 40) < 2, "about target / mean(samples) days");
});

test("likelyAtLeast and likelyWithin read the right side of the distribution", () => {
  const counts = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(likelyAtLeast(counts, 0.5), 51);
  assert.equal(likelyAtLeast(counts, 0.85), 16);
  assert.equal(likelyAtLeast(counts, 0.95), 6);
  assert.equal(likelyAtLeast(counts, 1), 1);
  assert.equal(likelyAtLeast([], 0.85), 0);
  // at least 85% of runs reach 16 or more: 85 of 100 values are >= 16
  assert.equal(counts.filter((c) => c >= 16).length, 85);
  assert.equal(likelyWithin(counts, 0.5), 50);
  assert.equal(likelyWithin(counts, 0.85), 85);
  assert.equal(likelyWithin(counts, 0.95), 95);
  assert.ok(Number.isNaN(likelyWithin([], 0.5)));
  // more certainty never promises more items or an earlier date
  const sim = simulateHowMany([0, 1, 2], 20, 5000, 9);
  assert.ok(likelyAtLeast(sim, 0.5) >= likelyAtLeast(sim, 0.85) && likelyAtLeast(sim, 0.85) >= likelyAtLeast(sim, 0.95));
  const when = simulateWhen([0, 1, 2], 30, 5000, 9);
  assert.ok(likelyWithin(when, 0.5) <= likelyWithin(when, 0.85) && likelyWithin(when, 0.85) <= likelyWithin(when, 0.95));
});

test("histogram makes whole-number bins that hold every value", () => {
  assert.deepEqual(histogram([]), []);
  assert.deepEqual(histogram([3, 3, 4, 6]), [{ from: 3, to: 3, count: 2 }, { from: 4, to: 4, count: 1 }, { from: 5, to: 5, count: 0 }, { from: 6, to: 6, count: 1 }]);
  const values = Array.from({ length: 500 }, (_, i) => i);
  const bins = histogram(values, 30);
  assert.ok(bins.length <= 30);
  assert.equal(bins.reduce((a, b) => a + b.count, 0), 500);
  assert.equal(bins[0].from, 0);
  assert.ok(bins[bins.length - 1].to >= 499);
});

test("histogram leaves out values that are not numbers instead of failing", () => {
  const bins = histogram([1, 2, NaN, 3, Infinity], 30);
  assert.equal(bins.reduce((a, b) => a + b.count, 0), 3);
  assert.deepEqual(histogram([NaN]), []);
});

test("workAge is never negative", () => {
  assert.equal(workAge({ created: new Date(Date.now() + 5 * DAY).toISOString(), category: "InProgress" }), 0);
});
