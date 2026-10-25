import { test } from "node:test";
import assert from "node:assert/strict";
import { barsOf, blockingPoints, cleanUrgency, deadlinePressure, DEFAULT_URGENCY, explainUrgency, priorityPoints, sprintPoints, urgency, waitingPoints } from "../src/core/urgency.ts";

const base = { daysWaiting: 0, staleDays: 14, sprintDaysLeft: null, blocks: 0, valueShare: null, deadlineDaysLeft: null };

test("priority 1 to 4 as points; none is nothing", () => {
  assert.deepEqual([1, 2, 3, 4, undefined, 0, 9].map(priorityPoints), [100, 75, 50, 25, 0, 0, 25]);
});

test("waiting climbs to 40 by the stale days, then steeply to 100 two stale periods later", () => {
  assert.equal(waitingPoints(0, 14), 0);
  assert.equal(waitingPoints(14, 14), 40);
  assert.equal(waitingPoints(28, 14), 70);
  assert.equal(waitingPoints(42, 14), 100);
  assert.equal(waitingPoints(400, 14), 100);
});

test("sprint end, blockers and the deadline's pressure", () => {
  assert.equal(sprintPoints(null), 0);
  assert.equal(sprintPoints(14), 0);
  assert.equal(sprintPoints(7), 50);
  assert.equal(sprintPoints(0), 100);
  assert.equal(sprintPoints(-3), 100);
  assert.equal(blockingPoints(1), 34);
  assert.equal(blockingPoints(5), 100);
  assert.equal(deadlinePressure(null, 28), 0);
  assert.equal(deadlinePressure(40, 28), 0);
  assert.equal(deadlinePressure(14, 28), 0.5);
  assert.equal(deadlinePressure(0, 28), 1);
  assert.equal(deadlinePressure(-5, 28), 1);
});

test("urgency: the weights are scaled to add up to 100; a pressing deadline adds up to 50 more; the score stops at 100", () => {
  const w = DEFAULT_URGENCY;
  // priority 1 alone: 40 of 100 weight, full points = 40
  const a = urgency({ ...base, priority: 1 }, w);
  assert.equal(Math.round(a.base), 40);
  assert.equal(a.boost, 0);
  assert.equal(a.bars, 2);
  // the same story with its deadline passed: 40 + 50 points
  const b = urgency({ ...base, priority: 1, deadlineDaysLeft: -2 }, w);
  assert.equal(Math.round(b.score), 90);
  assert.equal(b.bars, 5);
  // half way into the horizon: half the boost
  assert.equal(Math.round(urgency({ ...base, priority: 1, deadlineDaysLeft: 14 }, w).boost), 25);
  // nothing known: nothing
  assert.equal(urgency(base, w).score, 0);
  assert.equal(urgency(base, w).bars, 0);
  // everything at the top: capped at 100
  const top = urgency({ priority: 1, featurePriority: 1, daysWaiting: 90, staleDays: 14, sprintDaysLeft: 0, blocks: 3, valueShare: 1, deadlineDaysLeft: 0 }, { ...w, value: 20 });
  assert.equal(top.score, 100);
  assert.equal(top.bars, 5);
  // weights of 0 leave a factor out; with the others scaled
  const only = urgency({ ...base, priority: 1, featurePriority: 4 }, { ...w, own: 50, feature: 50, waiting: 0, sprint: 0, blocking: 0, value: 0 });
  assert.equal(Math.round(only.base), 63); // (100 + 25) / 2
});

test("bars: 100 is five, 20 is one, 0 is none", () => {
  assert.deepEqual([0, 1, 20, 21, 40, 41, 60, 80, 81, 99, 100].map(barsOf), [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 5]);
});

test("cleanUrgency keeps numbers in range and falls back to the defaults", () => {
  assert.deepEqual(cleanUrgency(null), DEFAULT_URGENCY);
  const c = cleanUrgency({ own: 500, feature: -4, waiting: "x", deadlineMax: 70, deadlineDays: 0 });
  assert.equal(c.own, 100);
  assert.equal(c.feature, 0);
  assert.equal(c.waiting, DEFAULT_URGENCY.waiting);
  assert.equal(c.deadlineMax, 70);
  assert.equal(c.deadlineDays, 1);
});

test("explainUrgency names every factor and the deadline", () => {
  const i = { ...base, priority: 2, deadlineDaysLeft: 5 };
  const text = explainUrgency(urgency(i, DEFAULT_URGENCY), i);
  assert.match(text, /^Urgency \d+ of 100/);
  assert.match(text, /its own priority/);
  assert.match(text, /deadline in 5 days/);
  assert.match(explainUrgency(urgency({ ...base, deadlineDaysLeft: -1 }, DEFAULT_URGENCY), { deadlineDaysLeft: -1 }), /passed 1 day ago/);
});
