import { test } from "node:test";
import assert from "node:assert/strict";
import type { Iteration } from "../src/api/types.ts";
import type { Schedule, Template } from "../src/core/scheduler.ts";
import {
  addDays, blankSchedule, cleanSchedule, describeTrigger, dueOccurrences, isoWeek, nextOccurrence, occurrences, pickAssignee, placementPath,
  renderTitle, scheduleProblem, todayLocal, weekdayOf,
} from "../src/core/scheduler.ts";

const sprints: Iteration[] = [
  { id: "1", name: "Sprint 1", path: "P\\Sprint 1", start: "2026-10-05T00:00:00Z", finish: "2026-10-16T00:00:00Z", timeFrame: "past" },
  { id: "2", name: "Sprint 2", path: "P\\Sprint 2", start: "2026-10-19T00:00:00Z", finish: "2026-10-30T00:00:00Z", timeFrame: "current" },
  { id: "3", name: "Sprint 3", path: "P\\Sprint 3", start: "2026-11-02T00:00:00Z", finish: "2026-11-13T00:00:00Z", timeFrame: "future" },
];
const ctx = { iterations: sprints };
const make = (trigger: Schedule["trigger"], created = "2026-01-01"): Schedule => ({ ...blankSchedule("s-1", created), name: "n", trigger, created });
const dates = (s: Schedule, from: string, to: string): string[] => occurrences(s, ctx, from, to).map((o) => o.date);

test("days: weekdays, ISO weeks and today", () => {
  assert.equal(weekdayOf("2026-10-23"), 5); // a Friday
  assert.equal(weekdayOf("2026-10-25"), 0);
  assert.equal(addDays("2026-02-27", 2), "2026-03-01");
  assert.equal(isoWeek("2026-01-01"), 1);
  assert.equal(isoWeek("2020-12-31"), 53);
  assert.equal(isoWeek("2021-01-03"), 53);
  assert.equal(isoWeek("2026-10-23"), 43);
  assert.match(todayLocal(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test("on a date, and as an outlook (made ahead, the date is its target)", () => {
  assert.deepEqual(dates(make({ kind: "date", date: "2026-11-05" }), "2026-11-01", "2026-11-30"), ["2026-11-05"]);
  assert.deepEqual(dates(make({ kind: "date", date: "2026-11-05" }), "2026-11-06", "2026-11-30"), []);
  const o = occurrences(make({ kind: "outlook", date: "2026-12-01", leadDays: 14 }), ctx, "2026-11-01", "2026-12-31");
  assert.deepEqual(o.map((x) => [x.date, x.due]), [["2026-11-17", "2026-12-01"]]);
});

test("weekly: chosen weekdays, every N weeks counted from the week it was made", () => {
  const weekly = make({ kind: "weekly", weekdays: [1, 4], everyWeeks: 1 }, "2026-10-01");
  assert.deepEqual(dates(weekly, "2026-10-19", "2026-10-25"), ["2026-10-19", "2026-10-22"]);
  const biweekly = make({ kind: "weekly", weekdays: [1], everyWeeks: 2 }, "2026-10-05"); // made in the week of Monday 5 Oct
  assert.deepEqual(dates(biweekly, "2026-10-05", "2026-11-09"), ["2026-10-05", "2026-10-19", "2026-11-02"]);
});

test("monthly: a day, clipped to short months, or the last day", () => {
  const m31 = make({ kind: "monthly", day: 31, everyMonths: 1 });
  assert.deepEqual(dates(m31, "2026-01-01", "2026-04-30"), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  const last = make({ kind: "monthly", day: 0, everyMonths: 1 });
  assert.deepEqual(dates(last, "2028-02-01", "2028-02-29"), ["2028-02-29"]);
  const quarterly = make({ kind: "monthly", day: 15, everyMonths: 3 }, "2026-01-10");
  assert.deepEqual(dates(quarterly, "2026-01-01", "2026-12-31"), ["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
});

test("sprints: start, middle, end, moved by days, every N sprints", () => {
  assert.deepEqual(dates(make({ kind: "sprint", at: "start", offsetDays: 0, everySprints: 1 }), "2026-10-01", "2026-11-30"), ["2026-10-05", "2026-10-19", "2026-11-02"]);
  assert.deepEqual(dates(make({ kind: "sprint", at: "end", offsetDays: -2, everySprints: 1 }), "2026-10-01", "2026-11-30"), ["2026-10-14", "2026-10-28", "2026-11-11"]);
  assert.deepEqual(dates(make({ kind: "sprint", at: "mid", offsetDays: 0, everySprints: 1 }), "2026-10-19", "2026-10-30"), ["2026-10-24"]);
  assert.deepEqual(dates(make({ kind: "sprint", at: "start", offsetDays: 1, everySprints: 2 }), "2026-10-01", "2026-11-30"), ["2026-10-06", "2026-11-03"]);
  const one = occurrences(make({ kind: "sprint", at: "start", offsetDays: 0, everySprints: 1 }), ctx, "2026-10-19", "2026-10-19")[0];
  assert.equal(one.sprint?.name, "Sprint 2");
});

test("periods: month and quarter starts and ends", () => {
  assert.deepEqual(dates(make({ kind: "period", at: "quarter-start", offsetDays: 0 }), "2026-01-01", "2026-12-31"), ["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
  assert.deepEqual(dates(make({ kind: "period", at: "quarter-end", offsetDays: 0 }), "2026-01-01", "2026-12-31"), ["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
  assert.deepEqual(dates(make({ kind: "period", at: "month-end", offsetDays: -1 }), "2026-02-01", "2026-03-31"), ["2026-02-27", "2026-03-30"]);
  assert.deepEqual(dates(make({ kind: "period", at: "month-start", offsetDays: 2 }), "2026-10-01", "2026-10-31"), ["2026-10-03"]);
});

test("what is due: the last week back, never before the schedule existed", () => {
  const daily = make({ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], everyWeeks: 1 }, "2026-10-01");
  assert.equal(dueOccurrences(daily, ctx, "2026-10-23").length, 8); // today and the seven days before
  assert.equal(dueOccurrences(daily, ctx, "2026-10-23")[0].date, "2026-10-16");
  const fresh = make({ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], everyWeeks: 1 }, "2026-10-21");
  assert.deepEqual(dueOccurrences(fresh, ctx, "2026-10-23").map((o) => o.date), ["2026-10-21", "2026-10-22", "2026-10-23"]);
});

test("the next occurrence", () => {
  const w = make({ kind: "weekly", weekdays: [1], everyWeeks: 1 }, "2026-10-01");
  assert.equal(nextOccurrence(w, ctx, "2026-10-23")?.date, "2026-10-26");
  assert.equal(nextOccurrence(make({ kind: "date", date: "2026-01-05" }), ctx, "2026-10-23"), undefined);
});

test("titles: tokens for the occurrence", () => {
  const o = occurrences(make({ kind: "sprint", at: "start", offsetDays: 0, everySprints: 1 }), ctx, "2026-10-19", "2026-10-19")[0];
  assert.equal(renderTitle("Retro prep {sprint} / week {week} {month} {year} {quarter} ({day}) {date} {nope}", o), "Retro prep Sprint 2 / week 43 October 2026 Q4 (Monday) 2026-10-19 {nope}");
  assert.equal(renderTitle("  Plain   title ", { key: "k", date: "2026-10-19" }), "Plain title");
});

test("who gets the story: nobody, a person, a turn, a draw", () => {
  const team = ["c@x", "a@x", "b@x"];
  const t = (mode: Template["assign"]["mode"], pool: string[] = [], person = ""): Template["assign"] => ({ mode, person, pool });
  assert.equal(pickAssignee(t("none"), team, undefined, "k"), undefined);
  assert.equal(pickAssignee(t("person", [], "z@x"), team, undefined, "k"), "z@x");
  assert.equal(pickAssignee(t("rotate"), team, undefined, "k"), "a@x");
  assert.equal(pickAssignee(t("rotate"), team, "a@x", "k"), "b@x");
  assert.equal(pickAssignee(t("rotate"), team, "c@x", "k"), "a@x"); // after the last, back to the first
  assert.equal(pickAssignee(t("rotate", ["b@x", "c@x"]), team, "gone@x", "k"), "b@x"); // the last one left the pool
  const draw = pickAssignee(t("random"), team, undefined, "2026-10-19");
  assert.equal(draw, pickAssignee(t("random"), team, "a@x", "2026-10-19")); // the same key draws the same person
  assert.ok(team.includes(draw!));
  assert.equal(pickAssignee(t("random"), [], undefined, "k"), undefined);
});

test("where the story goes", () => {
  const base = { ...blankSchedule("s", "2026-10-01").template };
  const o = { key: "k", date: "2026-10-19", sprint: { name: "Sprint 2", path: "P\\Sprint 2", start: "2026-10-19", finish: "2026-10-30" } };
  const cur = sprints[1];
  assert.equal(placementPath({ ...base, placement: "backlog" }, o, sprints, cur, "P"), "P");
  assert.equal(placementPath({ ...base, placement: "current" }, o, sprints, cur, "P"), "P\\Sprint 2");
  assert.equal(placementPath({ ...base, placement: "next" }, o, sprints, cur, "P"), "P\\Sprint 3");
  assert.equal(placementPath({ ...base, placement: "occurrence" }, o, sprints, cur, "P"), "P\\Sprint 2");
  assert.equal(placementPath({ ...base, placement: "next" }, o, sprints, sprints[2], "P"), "P"); // no sprint after the last: the backlog
  assert.equal(placementPath({ ...base, placement: "current" }, o, sprints, undefined, "P"), "P");
  assert.equal(placementPath({ ...base, placement: "fixed", iteration: "P\\Sprint 3" }, o, sprints, cur, "P"), "P\\Sprint 3"); // one chosen sprint
  assert.equal(placementPath({ ...base, placement: "fixed", iteration: "" }, o, sprints, cur, "P"), "P");
});

test("a stored schedule is read safely; a ready one has no problem", () => {
  assert.equal(cleanSchedule(null), null);
  assert.equal(cleanSchedule({ id: "x", trigger: { kind: "date", date: "nope" } }), null);
  assert.equal(cleanSchedule({ id: "x", trigger: { kind: "mystery" } }), null);
  const s = cleanSchedule({ id: "x", name: "", trigger: { kind: "weekly", weekdays: [1, 1, 9, "3"], everyWeeks: 0 }, template: { title: "T", assign: { mode: "bogus" }, tasks: { mode: "custom", custom: [{ title: " A " }, { title: "a" }] }, placement: "nowhere", tags: [" x ", ""] } })!;
  assert.deepEqual(s.trigger, { kind: "weekly", weekdays: [1, 3], everyWeeks: 1 });
  assert.equal(s.template.assign.mode, "none");
  assert.deepEqual(s.template.tasks.custom.map((c) => c.title), ["A"]);
  assert.equal(s.template.placement, "backlog");
  assert.deepEqual(s.template.tags, ["x"]);
  assert.equal(s.enabled, true);
  assert.match(scheduleProblem(s), /name/);
  const ok = { ...s, name: "Weekly", template: { ...s.template, title: "Hello" } };
  assert.equal(scheduleProblem(ok), "");
  assert.match(scheduleProblem({ ...ok, trigger: { kind: "weekly", weekdays: [], everyWeeks: 1 } }), /weekday/);
  assert.match(scheduleProblem({ ...ok, template: { ...ok.template, assign: { mode: "person", person: "", pool: [] } } }), /who/);
  assert.match(scheduleProblem({ ...ok, template: { ...ok.template, placement: "occurrence" } }), /sprint trigger/);
});

test("triggers in words", () => {
  assert.equal(describeTrigger({ kind: "weekly", weekdays: [4, 1], everyWeeks: 1 }), "Every week on Monday, Thursday");
  assert.equal(describeTrigger({ kind: "weekly", weekdays: [1], everyWeeks: 2 }), "Every 2 weeks on Monday");
  assert.equal(describeTrigger({ kind: "monthly", day: 0, everyMonths: 1 }), "Every month on the last day");
  assert.equal(describeTrigger({ kind: "sprint", at: "end", offsetDays: -2, everySprints: 1 }), "At the end of every sprint, 2 days before");
  assert.equal(describeTrigger({ kind: "sprint", at: "start", offsetDays: 0, everySprints: 2 }), "At the start of every 2 sprints");
  assert.equal(describeTrigger({ kind: "period", at: "quarter-start", offsetDays: 1 }), "On the first day of every quarter, 1 day after");
  assert.equal(describeTrigger({ kind: "outlook", date: "2026-12-01", leadDays: 14 }), "Outlook: 14 days before 2026-12-01, with that date as its target");
});

test("cleanSchedule keeps a chosen sprint and the starting column; a fixed placement without a sprint falls back to the backlog", () => {
  const mk = (template: Record<string, unknown>) => cleanSchedule({ id: "x", trigger: { kind: "date", date: "2026-10-23" }, template: { title: "T", ...template } })!;
  const a = mk({ placement: "fixed", iteration: " P\\Sprint 3 ", column: " Doing " });
  assert.equal(a.template.placement, "fixed");
  assert.equal(a.template.iteration, "P\\Sprint 3");
  assert.equal(a.template.column, "Doing");
  const b = mk({ placement: "fixed", iteration: "  " });
  assert.equal(b.template.placement, "backlog");
  assert.equal(b.template.iteration, "");
  assert.equal(mk({ placement: "next", iteration: "ignored" }).template.iteration, "");
  assert.equal(mk({}).template.column, "");
});
