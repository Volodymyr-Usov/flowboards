import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkItem } from "../src/api/types.ts";
import { baseTitle, canSplitByHalf, followUpTitle, partTitles, splitTasks } from "../src/core/storysplit.ts";

const task = (id: number, order?: number): WorkItem => ({ id, order, title: `T${id}` } as WorkItem);

test("splitting by half keeps the backlog order and gives the first part the extra task", () => {
  const t = [task(5, 30), task(1, 10), task(3, 20), task(9, 50), task(7, 40)];
  const { first, second } = splitTasks(t);
  assert.deepEqual(first.map((x) => x.id), [1, 3, 5]);
  assert.deepEqual(second.map((x) => x.id), [7, 9]);
  const even = splitTasks([task(1, 1), task(2, 2), task(3, 3), task(4, 4)]);
  assert.deepEqual([even.first.length, even.second.length], [2, 2]);
  // tasks without an order fall back to their number
  assert.deepEqual(splitTasks([task(8), task(2)]).first.map((x) => x.id), [2]);
});

test("a story needs at least two tasks to be split by half", () => {
  assert.equal(canSplitByHalf([]), false);
  assert.equal(canSplitByHalf([task(1)]), false);
  assert.equal(canSplitByHalf([task(1), task(2)]), true);
});

test("part titles do not pile up; the follow-up names what it follows", () => {
  assert.deepEqual(partTitles("Pay by card"), ["Pay by card (part 1)", "Pay by card (part 2)"]);
  assert.equal(baseTitle("Pay by card (part 2)"), "Pay by card");
  assert.deepEqual(partTitles("Pay by card (part 1)"), ["Pay by card (part 1)", "Pay by card (part 2)"]);
  assert.equal(baseTitle("(part 1)"), "(part 1)");
  assert.equal(followUpTitle({ id: 42, title: "Pay by card" }), "Follow-up for Pay by card (#42)");
});
