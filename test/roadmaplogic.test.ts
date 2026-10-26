import { test } from "node:test";
import assert from "node:assert/strict";
import { REL } from "../src/api/api.ts";
import type { WorkItem } from "../src/api/types.ts";
import { pool } from "../src/core/teamplans.ts";
import { cleanTeams, conflictCounts, dependencies, dependencyPairs, dragsFor } from "../src/views/roadmaplogic.ts";

test("roadmap drags only the dates the type has", () => {
  assert.deepEqual(dragsFor({ start: true, target: true }), { move: true, start: true, end: true });
  assert.deepEqual(dragsFor({ start: false, target: true }), { move: false, start: false, end: true });
  assert.deepEqual(dragsFor({ start: true, target: false }), { move: false, start: true, end: false });
  assert.deepEqual(dragsFor({ start: false, target: false }), { move: false, start: false, end: false });
});

const link = (rel: string, id: number) => ({ rel, url: `https://dev.azure.com/o/_apis/wit/workItems/${id}`, attributes: {} });
const w = (id: number, relations: ReturnType<typeof link>[]): WorkItem => ({
  id, rev: 1, type: "Feature", title: `F${id}`, state: "New", category: "Proposed", area: "A", iteration: "I", tags: [], created: "", changed: "", fields: {}, relations,
});

test("dependency pairs come from either side of the link, once", () => {
  const items = [
    w(1, [link(REL.successor, 2), link(REL.child, 9)]),
    w(2, [link(REL.predecessor, 1), link(REL.successor, 3)]),
    w(3, []),
  ];
  assert.deepEqual(dependencyPairs(items), [[1, 2], [2, 3]]);
});

test("conflicts: the waiting item starts on or before the day the other ends; across teams marked", () => {
  const spans: Record<number, { start: number; end: number }> = { 1: { start: 0, end: 10 }, 2: { start: 11, end: 20 }, 3: { start: 15, end: 30 }, 4: { start: 10, end: 12 } };
  const team: Record<number, string> = { 1: "", 2: "", 3: "P/Platform", 4: "P/Platform" };
  const deps = dependencies([[1, 2], [2, 3], [1, 4], [1, 5]], (id) => spans[id], (id) => team[id]);
  assert.deepEqual(deps, [
    { pred: 1, succ: 2, cross: false, conflict: false },
    { pred: 2, succ: 3, cross: true, conflict: true },
    { pred: 1, succ: 4, cross: true, conflict: true }, // starts on the day the other ends
  ]); // #5 has no bar: left out
  assert.deepEqual(conflictCounts(deps), { all: 2, cross: 2 });
});

test("saved teams are cleaned: well formed, once, never this team, at most the limit", () => {
  const me = { project: "P", team: "A" };
  const raw = [{ project: "P", team: "B" }, { project: "P", team: "A" }, { project: "P", team: "B" }, { project: "Q", team: "B" }, { team: "C" }, "x", null, { project: "P", team: "D" }];
  assert.deepEqual(cleanTeams(raw, me), [{ project: "P", team: "B" }, { project: "Q", team: "B" }, { project: "P", team: "D" }]);
  assert.deepEqual(cleanTeams(raw, me, 1), [{ project: "P", team: "B" }]);
  assert.deepEqual(cleanTeams("nonsense", me), []);
});

test("the team loader runs at most a few jobs at once and keeps the order", async () => {
  let running = 0;
  let most = 0;
  const out = await pool([5, 1, 4, 2, 3], 2, async (n) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, n * 3));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(most, 2);
});
