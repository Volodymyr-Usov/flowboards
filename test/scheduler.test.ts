import { test } from "node:test";
import assert from "node:assert/strict";
import type { Iteration } from "../src/api/types.ts";
import type { Schedule, Template } from "../src/core/scheduler.ts";
import {
  addDays, applyEdit, blankSchedule, cleanSchedule, describeTrigger, drawSeed, dueOccurrences, isoWeek, isoWeekYear, nextOccurrence, occurrences, pickAssignee, placementPath,
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

test("the next sprint when none is going on: the first that starts after today", () => {
  const base = { ...blankSchedule("s", "2026-10-01").template, placement: "next" as const };
  const o = { key: "k", date: "2026-10-17" };
  assert.equal(placementPath(base, o, sprints, undefined, "P", "2026-10-17"), "P\\Sprint 2"); // the weekend between two sprints
  assert.equal(placementPath(base, o, sprints, undefined, "P", "2026-09-01"), "P\\Sprint 1"); // before the first
  assert.equal(placementPath(base, o, sprints, undefined, "P", "2026-12-01"), "P"); // after the last: the backlog
  const undated: Iteration = { id: "x", name: "Undated", path: "P\\Undated", timeFrame: "current" };
  assert.equal(placementPath(base, o, sprints, undated, "P", "2026-10-17"), "P\\Sprint 2"); // a current sprint without dates
});

test("keys: a sprint occurrence is its sprint and point; an outlook its target date; the older date key is kept", () => {
  const s = make({ kind: "sprint", at: "start", offsetDays: 1, everySprints: 1 });
  const o = occurrences(s, ctx, "2026-10-19", "2026-10-25")[0];
  assert.equal(o.key, "sprint-2-start");
  assert.equal(o.legacyKey, "2026-10-20");
  // the sprint moves by two days: the same occurrence, the same key
  const moved = sprints.map((i) => (i.id === "2" ? { ...i, start: "2026-10-21T00:00:00Z", finish: "2026-11-01T00:00:00Z" } : i));
  const o2 = occurrences(s, { iterations: moved }, "2026-10-19", "2026-10-25")[0];
  assert.equal(o2.key, "sprint-2-start");
  assert.equal(o2.date, "2026-10-22");
  const out = occurrences(make({ kind: "outlook", date: "2026-12-01", leadDays: 14 }), ctx, "2026-11-01", "2026-12-31")[0];
  assert.equal(out.key, "2026-12-01");
  assert.equal(out.legacyKey, "2026-11-17");
  assert.equal(occurrences(make({ kind: "weekly", weekdays: [1], everyWeeks: 1 }), ctx, "2026-10-19", "2026-10-19")[0].legacyKey, undefined);
});

test("every N sprints counts from the sprint it was made in: an earlier sprint added later does not shift it", () => {
  const s = make({ kind: "sprint", at: "start", offsetDays: 0, everySprints: 2 }, "2026-10-03");
  const before: Iteration = { id: "0", name: "Sprint 0", path: "P\\Sprint 0", start: "2026-09-21T00:00:00Z", finish: "2026-10-02T00:00:00Z", timeFrame: "past" };
  assert.deepEqual(dates(s, "2026-10-01", "2026-11-30"), ["2026-10-05", "2026-11-02"]);
  assert.deepEqual(occurrences(s, { iterations: [before, ...sprints] }, "2026-10-01", "2026-11-30").map((o) => o.date), ["2026-10-05", "2026-11-02"]);
});

test("a schedule's first day: an edit or a restart does not fill in the past week", () => {
  const daily = { ...make({ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], everyWeeks: 1 }, "2026-10-01"), activeFrom: "2026-10-22" };
  assert.deepEqual(dueOccurrences(daily, ctx, "2026-10-23").map((o) => o.date), ["2026-10-22", "2026-10-23"]);
  assert.equal(cleanSchedule({ id: "x", created: "2026-10-01", trigger: { kind: "date", date: "2026-10-23" } })!.activeFrom, "2026-10-01"); // older documents
  assert.equal(cleanSchedule({ id: "x", created: "2026-10-01", activeFrom: "2026-10-20", trigger: { kind: "date", date: "2026-10-23" } })!.activeFrom, "2026-10-20");
});

test("an edit changes only what the form changed; a new trigger starts from today, a new title does not", () => {
  const stored = { ...make({ kind: "weekly", weekdays: [1], everyWeeks: 1 }, "2026-10-01"), name: "Review", template: { ...blankSchedule("s", "2026-10-01").template, title: "Old", tags: ["a"] } };
  const before = structuredClone(stored);
  // meanwhile someone else added a tag and renamed it
  const theirs = { ...stored, name: "Weekly review", template: { ...stored.template, tags: ["a", "b"] } };
  const titled = applyEdit(theirs, before, { ...before, template: { ...before.template, title: "New" } }, "2026-10-23");
  assert.equal(titled.template.title, "New");
  assert.deepEqual(titled.template.tags, ["a", "b"]);
  assert.equal(titled.name, "Weekly review");
  assert.equal(titled.activeFrom, "2026-10-01");
  const retimed = applyEdit(theirs, before, { ...before, trigger: { kind: "weekly", weekdays: [2], everyWeeks: 1 } }, "2026-10-23");
  assert.equal(retimed.activeFrom, "2026-10-23");
  assert.deepEqual(retimed.trigger, { kind: "weekly", weekdays: [2], everyWeeks: 1 });
});

test("an outlook made after its lead time, or left alone for long, is made at once while the date is ahead", () => {
  const late = { ...make({ kind: "outlook", date: "2026-11-01", leadDays: 14 }, "2026-10-23") };
  assert.deepEqual(dueOccurrences(late, ctx, "2026-10-23").map((o) => [o.date, o.due, o.key]), [["2026-10-23", "2026-11-01", "2026-11-01"]]);
  const old = make({ kind: "outlook", date: "2026-11-01", leadDays: 60 }, "2026-08-01"); // due on 2 September, nobody opened a page since
  assert.deepEqual(dueOccurrences(old, ctx, "2026-10-23").map((o) => o.date), ["2026-09-02"]);
  assert.deepEqual(dueOccurrences(old, ctx, "2026-11-02"), []); // the date has passed
  assert.deepEqual(dueOccurrences(make({ kind: "outlook", date: "2026-10-20", leadDays: 1 }, "2026-10-23"), ctx, "2026-10-23"), []);
});

test("titles: {weekyear} goes with {week}; {year} stays the calendar year; an outlook tells its target date", () => {
  assert.equal(isoWeekYear("2024-12-30"), 2025);
  assert.equal(isoWeekYear("2021-01-03"), 2020);
  assert.equal(renderTitle("Week {week} {weekyear} ({year})", { key: "k", date: "2024-12-30" }), "Week 1 2025 (2024)");
  assert.equal(renderTitle("Release {date} {month}", { key: "2026-12-01", date: "2026-11-17", due: "2026-12-01" }), "Release 2026-12-01 December");
});

test("a draw: the schedule counts, the same occurrence draws the same person, two people do not just take turns", () => {
  const pool = { mode: "random" as const, person: "", pool: [] };
  const team = ["a@x", "b@x"];
  const days = Array.from({ length: 40 }, (_, i) => addDays("2026-01-01", i));
  const seq = days.map((d) => pickAssignee(pool, team, undefined, drawSeed("s-1", d)));
  assert.deepEqual(seq, days.map((d) => pickAssignee(pool, team, "a@x", drawSeed("s-1", d))));
  const turns = seq.slice(1).filter((x, i) => x !== seq[i]).length;
  assert.ok(turns < 35, `alternates ${turns} of 39 times`);
  const a = seq.filter((x) => x === "a@x").length;
  assert.ok(a > 8 && a < 32, `a drawn ${a} of 40 times`);
  const other = days.map((d) => pickAssignee(pool, team, undefined, drawSeed("s-2", d)));
  assert.notDeepEqual(other, seq);
});
