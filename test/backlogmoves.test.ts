import { test } from "node:test";
import assert from "node:assert/strict";
import { endMoves, rangeOf, sprintMoveIds, stepPlace } from "../src/views/tree.ts";

test("move to top: the first goes before the first other item, the rest follow it in order", () => {
  assert.deepEqual(endMoves([1, 2, 3, 4, 5], [4, 2], "top"), [[4, 0, 1], [2, 4, 1]]);
});

test("move to bottom: the first goes after the last other item, the rest follow it", () => {
  assert.deepEqual(endMoves([1, 2, 3, 4, 5], [1, 3], "bottom"), [[1, 5, 0], [3, 1, 0]]);
});

test("moving every item of a level has no other item to go next to", () => {
  assert.deepEqual(endMoves([1, 2], [1, 2], "top"), [[1, 0, 0], [2, 1, 0]]);
});

test("a step up goes before the neighbour shown, right after the item before it", () => {
  // 3 is hidden (a search): 4 goes up past 2, so between 1 and 2
  assert.deepEqual(stepPlace([1, 2, 3, 4], [1, 2, 4], 4, -1), [1, 2]);
  assert.deepEqual(stepPlace([1, 2, 3, 4], [1, 2, 4], 1, -1), null);
});

test("a step down goes after the neighbour shown, before the item after it", () => {
  assert.deepEqual(stepPlace([1, 2, 3, 4], [1, 3, 4], 1, 1), [3, 4]);
  assert.deepEqual(stepPlace([1, 2, 3], [1, 2, 3], 2, 1), [3, 0]);
  assert.deepEqual(stepPlace([1, 2, 3], [1, 2, 3], 3, 1), null);
});

test("a Shift+click range runs either way and includes both ends", () => {
  assert.deepEqual(rangeOf([5, 6, 7, 8], 7, 5), [5, 6, 7]);
  assert.deepEqual(rangeOf([5, 6, 7, 8], 6, 8), [6, 7, 8]);
  assert.deepEqual(rangeOf([5, 6, 7, 8], 9, 6), [6]);
});

test("move to sprint: a story's open tasks go with it, each item once", () => {
  const story = { id: 1, iteration: "P\\Old", story: true, tasks: [{ id: 11, iteration: "P\\Old" }, { id: 12, iteration: "P\\New" }] };
  // 12 is in the sprint already
  assert.deepEqual(sprintMoveIds([story], "P\\New"), { ids: [1, 11], tasks: 1 });
});

test("move to sprint: a story and its task both picked write the task once, and it is not counted as along", () => {
  const story = { id: 1, iteration: "P\\Old", story: true, tasks: [{ id: 11, iteration: "P\\Old" }] };
  const task = { id: 11, iteration: "P\\Old", story: false, tasks: [] };
  assert.deepEqual(sprintMoveIds([story, task], "P\\New"), { ids: [1, 11], tasks: 0 });
  assert.deepEqual(sprintMoveIds([task, story], "P\\New"), { ids: [11, 1], tasks: 0 });
});

test("move to sprint: items already there are left alone, also a story whose tasks still move", () => {
  const story = { id: 1, iteration: "P\\New", story: true, tasks: [{ id: 11, iteration: "P\\Old" }] };
  assert.deepEqual(sprintMoveIds([story], "P\\New"), { ids: [11], tasks: 1 });
  assert.deepEqual(sprintMoveIds([{ id: 2, iteration: "P\\New", story: false, tasks: [] }], "P\\New"), { ids: [], tasks: 0 });
});

test("move to sprint: a Feature picked does not take its children along", () => {
  const feature = { id: 5, iteration: "P\\Old", story: false, tasks: [{ id: 51, iteration: "P\\Old" }] };
  assert.deepEqual(sprintMoveIds([feature], "P\\New"), { ids: [5], tasks: 0 });
});
