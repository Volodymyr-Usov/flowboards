import { test } from "node:test";
import assert from "node:assert/strict";
import type { Iteration, WorkItem } from "../src/api/types.ts";
import { canSplit, cleanupSteps, continuedTitle, dropNeighbors, escapeHtml, nextSprint, sprintOver, tasksInSprint, workingDaysLeft } from "../src/views/sprintlogic.ts";

const sp = (n: number, start: string, finish: string): Iteration => ({ id: `s${n}`, name: `Sprint ${n}`, path: `P\\Sprint ${n}`, start: `${start}T00:00:00Z`, finish: `${finish}T00:00:00Z` });
const S1 = sp(1, "2026-09-28", "2026-10-09");
const S2 = sp(2, "2026-10-12", "2026-10-23");
const S3 = sp(3, "2026-10-26", "2026-11-06");
const S4 = sp(4, "2026-11-09", "2026-11-20");
const ALL = [S3, S1, S4, S2];

const w = (id: number, extra: Partial<WorkItem> = {}): WorkItem => ({
  id, rev: 1, type: "Story", title: `Story ${id}`, state: "Active", category: "InProgress", area: "A", iteration: S2.path, tags: [], created: "", changed: "", fields: {}, ...extra,
});

test("a sprint is over on its last day and after", () => {
  assert.equal(sprintOver(S2, "2026-10-22"), false);
  assert.equal(sprintOver(S2, "2026-10-23"), true);
  assert.equal(sprintOver(S2, "2026-11-01"), true);
  assert.equal(sprintOver({ id: "x", name: "x", path: "x", timeFrame: "past" }, "2026-10-01"), true);
});

test("the next sprint: the one after, or the first one not ended when cleaning up late", () => {
  assert.equal(nextSprint(ALL, S2, "2026-10-23")?.id, "s3");
  assert.equal(nextSprint(ALL, S1, "2026-10-10")?.id, "s2");
  // Sprint 1 cleaned up during Sprint 3: its work goes to Sprint 3, not the ended Sprint 2
  assert.equal(nextSprint(ALL, S1, "2026-10-28")?.id, "s3");
  // a sprint ending today still takes work
  assert.equal(nextSprint(ALL, S1, "2026-10-23")?.id, "s2");
  // nothing later: none; every later one ended: the one right after
  assert.equal(nextSprint(ALL, S4, "2026-11-20"), undefined);
  assert.equal(nextSprint([S1, S2], S1, "2026-12-01")?.id, "s2");
  assert.equal(nextSprint(ALL, { id: "n", name: "n", path: "n" }, "2026-10-01"), undefined);
});

test("continued titles get the word once", () => {
  assert.equal(continuedTitle("Login page"), "Login page (continued)");
  assert.equal(continuedTitle("Login page (continued)"), "Login page (continued)");
});

test("move: the story and its chosen tasks go to the next sprint", () => {
  const t1 = w(11, { type: "Task" });
  const t2 = w(12, { type: "Task", iteration: S3.path });
  const steps = cleanupSteps([{ story: w(1), mode: "move", tasks: [t1, t2] }], S3.path);
  assert.deepEqual(steps, [{ kind: "iteration", id: 1, path: S3.path }, { kind: "iteration", id: 11, path: S3.path }]);
});

test("split: a copy under the same parent, then the open tasks go under it and to the next sprint", () => {
  const t1 = w(11, { type: "Task" });
  const steps = cleanupSteps([
    { story: w(1, { parent: 50, title: "Search" }), mode: "split", tasks: [t1] },
    { story: w(2), mode: "leave", tasks: [w(21, { type: "Task" })] },
  ], S3.path);
  assert.deepEqual(steps, [
    { kind: "copy", ref: "copy-1", from: 1, title: "Search (continued)", path: S3.path, parent: 50 },
    { kind: "reparent", id: 11, ref: "copy-1" },
    { kind: "iteration", id: 11, path: S3.path },
  ]);
});

test("a story can be split only with finished and open work", () => {
  const done = (t: WorkItem): boolean => t.state === "Closed";
  assert.equal(canSplit([w(1, { state: "Closed" }), w(2)], done), true);
  assert.equal(canSplit([w(2), w(3)], done), false);
  assert.equal(canSplit([w(1, { state: "Closed" })], done), false);
  assert.equal(canSplit([], done), false);
});

test("the clean-up only takes the tasks that are in the sprint being cleaned up", () => {
  const tasks = [
    w(51, { type: "Task", iteration: S2.path }),
    w(52, { type: "Task", iteration: `${S2.path}\\Week 2` }),
    w(53, { type: "Task", iteration: S3.path }), // already planned in the next sprint
    w(54, { type: "Task", iteration: "P" }), // in the backlog
  ];
  assert.deepEqual(tasksInSprint(tasks, S2.path).map((t) => t.id), [51, 52]);
  assert.deepEqual(tasksInSprint(tasks, "P\\Sprint 2x").map((t) => t.id), []);
});

test("a drop in the sprint list names the items before and after, or nothing when the order stays", () => {
  const order = [1, 2, 3, 4];
  assert.deepEqual(dropNeighbors(order, [3], 0), { prev: 0, next: 1 }, "to the top");
  assert.deepEqual(dropNeighbors(order, [1], 3), { prev: 4, next: 0 }, "to the end");
  assert.deepEqual(dropNeighbors(order, [4], 1), { prev: 1, next: 2 });
  assert.equal(dropNeighbors(order, [2], 1), null, "back where it was");
  assert.deepEqual(dropNeighbors(order, [1, 3], 2), { prev: 4, next: 0 }, "several keep their order");
  assert.equal(dropNeighbors(order, [2, 3], 1), null);
  assert.equal(dropNeighbors(order, [9], 0), null, "not in the list");
});

test("working days left count from today, or from the first day of a sprint not started yet", () => {
  const wd = [1, 2, 3, 4, 5];
  // S2 runs Mon 12 Oct to Fri 23 Oct 2026: 10 working days
  assert.equal(workingDaysLeft(S2.start!, S2.finish!, "2026-10-12", wd), 10);
  assert.equal(workingDaysLeft(S2.start!, S2.finish!, "2026-10-14", wd), 8);
  // the Thursday and the Friday of the last week
  assert.equal(workingDaysLeft(S2.start!, S2.finish!, "2026-10-22", wd), 2);
  assert.equal(workingDaysLeft(S2.start!, S2.finish!, "2026-10-23", wd), 1);
  // not started: the whole sprint, not the days from today
  assert.equal(workingDaysLeft(S2.start!, S2.finish!, "2026-10-01", wd), 10);
  // over, or a day that is not a date
  assert.equal(workingDaysLeft(S2.start!, S2.finish!, "2026-10-24", wd), 0);
  assert.equal(workingDaysLeft(S2.start!, S2.finish!, "garbage", wd), 0);
});

test("working days left skip the team's days off", () => {
  const wd = [1, 2, 3, 4, 5];
  assert.equal(workingDaysLeft(S2.start!, S2.finish!, "2026-10-19", wd, [{ start: "2026-10-20T00:00:00Z", end: "2026-10-21T00:00:00Z" }]), 3);
});

test("text for a work item's HTML: markup and quotes are escaped, plain text stays", () => {
  assert.equal(escapeHtml(`R&D <b>"Sprint"</b>`), "R&amp;D &lt;b&gt;&quot;Sprint&quot;&lt;/b&gt;");
  assert.equal(escapeHtml("Sprint 41"), "Sprint 41");
  assert.equal(escapeHtml("a & b &amp; c"), "a &amp; b &amp;amp; c");
});
