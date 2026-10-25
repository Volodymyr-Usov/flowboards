import { test } from "node:test";
import assert from "node:assert/strict";
import type { Update } from "../src/api/types.ts";
import { valueAt } from "../src/core/history.ts";
import { burndown, dayMoments, remainingOf, sprintDays } from "../src/views/burndown.ts";
import type { TaskNow } from "../src/views/burndown.ts";

const REM = "Microsoft.VSTS.Scheduling.RemainingWork";
const SPRINT = "Proj\\Sprint 5";
const who = { displayName: "A", uniqueName: "a@x" };

function upd(rev: number, date: string, changes: Record<string, [unknown, unknown]>): Update {
  return { id: rev, rev, by: who, date, changes: Object.entries(changes).map(([field, [oldValue, newValue]]) => ({ field, oldValue, newValue })) };
}
const at = (state: string, iteration: string, remaining?: number): Record<string, unknown> => ({ "System.State": state, "System.IterationPath": iteration, [REM]: remaining });

// Sprint: Monday 2026-03-02 to Friday 2026-03-13 (10 working days)
const spec = {
  sprintPath: SPRINT, start: "2026-03-02T00:00:00Z", finish: "2026-03-13T00:00:00Z", workDays: [1, 2, 3, 4, 5],
  remainingField: REM, closedStates: ["Closed", "Removed"],
};

test("sprintDays skips weekends and days off", () => {
  assert.equal(sprintDays(spec.start, spec.finish, spec.workDays).length, 10);
  const off = sprintDays(spec.start, spec.finish, spec.workDays, [{ start: "2026-03-04T00:00:00Z", end: "2026-03-05T00:00:00Z" }]);
  assert.deepEqual(off.slice(0, 3), ["2026-03-02", "2026-03-03", "2026-03-06"]);
  assert.equal(off.length, 8);
});

test("valueAt reads the value before, between and after changes", () => {
  const ups = [upd(2, "2026-03-03T10:00:00Z", { [REM]: [8, 5] }), upd(3, "2026-03-05T10:00:00Z", { [REM]: [5, 2] })];
  assert.equal(valueAt(ups, REM, 2, Date.parse("2026-03-02T12:00:00Z")), 8);
  assert.equal(valueAt(ups, REM, 2, Date.parse("2026-03-04T12:00:00Z")), 5);
  assert.equal(valueAt(ups, REM, 2, Date.parse("2026-03-09T12:00:00Z")), 2);
  assert.equal(valueAt([], REM, 7, 0), 7);
});

test("remainingOf: not yet there, outside the sprint, closed, estimate for a task closed without hours", () => {
  const closed: TaskNow = { id: 1, state: "Closed", estimate: 6 };
  assert.equal(remainingOf(undefined, closed, spec), 0, "did not exist yet");
  assert.equal(remainingOf(at("New", "Proj"), closed, spec), 0, "still in the backlog");
  assert.equal(remainingOf(at("New", SPRINT), closed, spec), 6, "in the sprint, never recorded: the estimate");
  assert.equal(remainingOf(at("Closed", SPRINT), closed, spec), 0, "closed");
  const open: TaskNow = { id: 2, state: "Active", estimate: 9 };
  assert.equal(remainingOf(at("Active", SPRINT, 4), open, spec), 4);
  assert.equal(remainingOf(at("Active", SPRINT), open, spec), 0, "estimate only for tasks closed since");
});

test("dayMoments: the end of past days, now for today, nothing for days to come", () => {
  const now = Date.parse("2026-03-04T12:00:00Z");
  assert.deepEqual(dayMoments(["2026-03-03", "2026-03-04", "2026-03-05"], now), ["2026-03-03T23:59:59.999Z", "2026-03-04T12:00:00.000Z", null]);
});

test("burndown: actual per day, ideal from the first day to zero, future days empty", () => {
  const days = sprintDays(spec.start, spec.finish, spec.workDays);
  const tasks: TaskNow[] = [{ id: 1, state: "Active" }, { id: 2, state: "Closed", estimate: 10 }];
  const day = (r1: number, closed2: boolean): Map<number, Record<string, unknown>> => new Map([[1, at("Active", SPRINT, r1)], [2, at(closed2 ? "Closed" : "Active", SPRINT)]]);
  const asOf = [day(8, false), day(5, false), day(5, true), day(2, true), day(2, true), null, null, null, null, null];
  const b = burndown(days, asOf, tasks, spec);
  assert.equal(b.points.length, 10);
  assert.deepEqual(b.points.map((p) => p.actual), [18, 15, 5, 2, 2, null, null, null, null, null]);
  assert.equal(b.start, 18);
  assert.equal(b.points[0].ideal, 18);
  assert.equal(b.points[9].ideal, 0);
  assert.equal(b.points[3].ideal, 12);
});

test("history saved later with earlier dates: missed by 'as of', rebuilt from revisions", async () => {
  const { missedHistory, snapshotsFromRevisions, burndown } = await import("../src/views/burndown.ts");
  const moments = ["2026-10-19T23:59:59.999Z", "2026-10-20T23:59:59.999Z", "2026-10-21T23:59:59.999Z"];
  // "as of" saw nothing: the task was written today, dated Oct 19
  const empty = moments.map(() => new Map());
  const created = new Map([[1, "2026-10-19T09:00:00Z"]]);
  assert.equal(missedHistory(empty, moments, created), true);
  // a task created after every moment is no sign of missed history
  assert.equal(missedHistory(empty, moments, new Map([[1, "2026-10-22T09:00:00Z"]])), false);
  // seen as expected: nothing missed
  const seen = moments.map(() => new Map([[1, {}]]));
  assert.equal(missedHistory(seen, moments, created), false);

  const R = "Microsoft.VSTS.Scheduling.RemainingWork";
  const f = (state: string, rem: number) => ({ "System.State": state, "System.IterationPath": "P\\Sprint 4", [R]: rem });
  const revs = new Map([[1, [
    { changed: "2026-10-19T09:00:00Z", fields: f("New", 8) },
    { changed: "2026-10-20T10:00:00Z", fields: f("Active", 4) },
    { changed: "2026-10-21T10:00:00Z", fields: f("Closed", 0) },
  ]]]);
  const snaps = snapshotsFromRevisions(revs, [...moments, null], ["System.State", "System.IterationPath", R]);
  assert.deepEqual(snaps.slice(0, 3).map((s) => s?.get(1)?.[R]), [8, 4, 0]);
  assert.equal(snaps[3], null, "a future day has no answer");
  const b = burndown(["2026-10-19", "2026-10-20", "2026-10-21"], snaps.slice(0, 3), [{ id: 1, state: "Closed", estimate: 8 }], { sprintPath: "P\\Sprint 4", remainingField: R, closedStates: ["Closed"] });
  assert.deepEqual(b.points.map((p) => p.actual), [8, 4, 0]);
});
