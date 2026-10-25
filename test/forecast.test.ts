import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyThroughput, queueForecast, riskOf } from "../src/core/forecast.ts";

test("a steady pace of one story a day finishes the queue in order", () => {
  const f = queueForecast([{ id: 1, remaining: 3 }, { id: 2, remaining: 2 }, { id: 3, remaining: 0 }], [1, 1, 1]);
  assert.deepEqual(f.map((x) => [x.id, x.p50, x.p85]), [[1, 3, 3], [2, 5, 5], [3, 5, 5]]);
});

test("an item with nothing left above it is done today", () => {
  const f = queueForecast([{ id: 1, remaining: 0 }, { id: 2, remaining: 1 }], [1]);
  assert.equal(f[0].p50, 0);
  assert.equal(f[1].p50, 1);
});

test("uneven pace: the 85 date is not earlier than the 50 date, and later items finish later", () => {
  const f = queueForecast([{ id: 1, remaining: 5 }, { id: 2, remaining: 5 }], [0, 0, 1, 2, 0, 3, 1], 3000, 3);
  for (const x of f) assert.ok(x.p85 >= x.p50 && x.p95 >= x.p85);
  assert.ok(f[1].p50 > f[0].p50);
});

test("no progress in the past gives no forecast", () => {
  assert.deepEqual(queueForecast([{ id: 1, remaining: 2 }], [0, 0, 0]), []);
  assert.deepEqual(queueForecast([], [1]), []);
});

test("daily throughput counts closed dates per day, oldest first", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.deepEqual(dailyThroughput(["2026-10-21T08:00:00Z", "2026-10-21T09:00:00Z", "2026-10-19T10:00:00Z", "2026-09-01T00:00:00Z"], 4, now), [0, 1, 0, 2]);
  assert.equal(riskOf(10, 9), "late");
  assert.equal(riskOf(9, 9), "ok");
  assert.equal(riskOf(9, null), "none");
});
