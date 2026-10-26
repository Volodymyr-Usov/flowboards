import { test } from "node:test";
import assert from "node:assert/strict";
import type { Iteration } from "../src/api/types.ts";
import { addRange, applyDaysOff, awayFrom, dayRanges, followTo, rangeSummary, removeRange, splitBySprint, workingDaysIn } from "../src/views/daysoff.ts";
import { planDay } from "../src/views/timeaxis.ts";

const d = (s: string): number => planDay(s + "T00:00:00Z")!;
const sprint = (id: string, start: string, finish: string): Iteration => ({ id, name: id, path: id, start: start + "T00:00:00Z", finish: finish + "T00:00:00Z" });

test("a range is split over the sprints it touches", () => {
  const s = [sprint("s1", "2026-10-05", "2026-10-16"), sprint("s2", "2026-10-19", "2026-10-30")];
  const r = splitBySprint(d("2026-10-15"), d("2026-10-20"), s);
  assert.deepEqual(r.parts.map((p) => [p.iteration.id, p.end - p.start + 1]), [["s1", 2], ["s2", 2]]);
  assert.equal(r.outside, 2, "17 and 18 October fall in no sprint");
});

test("adding joins overlapping and touching ranges; removing cuts a hole", () => {
  const list = [{ start: "2026-10-05T00:00:00Z", end: "2026-10-06T00:00:00Z" }];
  const added = addRange(list, d("2026-10-07"), d("2026-10-08"));
  assert.deepEqual(added, [{ start: "2026-10-05T00:00:00Z", end: "2026-10-08T00:00:00Z" }]);
  assert.deepEqual(removeRange(added, d("2026-10-06"), d("2026-10-07")), [
    { start: "2026-10-05T00:00:00Z", end: "2026-10-05T00:00:00Z" },
    { start: "2026-10-08T00:00:00Z", end: "2026-10-08T00:00:00Z" },
  ]);
  assert.deepEqual(removeRange(added, d("2026-10-01"), d("2026-10-31")), []);
});

test("days off of people and of the team are read from capacity", () => {
  const it = sprint("s1", "2026-10-05", "2026-10-16");
  const away = awayFrom([{ iteration: it, capacity: {
    members: [{ person: { displayName: "Ann", uniqueName: "ann@x" }, activities: [], daysOff: [{ start: "2026-10-07T00:00:00Z", end: "2026-10-08T00:00:00Z" }] }],
    teamDaysOff: [{ start: "2026-10-06T00:00:00Z", end: "2026-10-06T00:00:00Z" }],
  } }]);
  assert.deepEqual(away.map((a) => [a.kind, a.person?.displayName ?? "", a.end - a.start + 1]), [["team", "", 1], ["person", "Ann", 2]]);
});

test("To follows From when it was before it or still on the old From", () => {
  assert.equal(followTo("2026-10-20", "2026-10-15", "2026-10-15"), "2026-10-20", "still on the old From");
  assert.equal(followTo("2026-10-20", "2026-10-01", "2026-10-10"), "2026-10-20", "before the new From");
  assert.equal(followTo("2026-10-20", "2026-10-15", "2026-10-25"), "2026-10-25", "a later To stays");
  assert.equal(followTo("", "2026-10-15", "2026-10-25"), "2026-10-25");
});

test("the summary counts working days and names the sprints", () => {
  const s = [sprint("Sprint 41", "2026-10-19", "2026-10-30"), sprint("Sprint 42", "2026-11-02", "2026-11-13")];
  const wd = [1, 2, 3, 4, 5];
  assert.deepEqual(rangeSummary(d("2026-10-21"), d("2026-10-23"), "off", s, wd), { text: "3 working days, in Sprint 41", ok: true });
  assert.equal(rangeSummary(d("2026-10-30"), d("2026-11-02"), "teamoff", s, wd).text, "2 working days, in Sprint 41 and Sprint 42; 2 days outside any sprint not kept");
  assert.equal(rangeSummary(d("2026-10-23"), d("2026-10-21"), "off", s, wd).ok, false);
  assert.equal(rangeSummary(d("2026-12-01"), d("2026-12-01"), "off", s, wd).ok, false);
  assert.equal(rangeSummary(d("2026-12-01"), d("2026-12-02"), "event", s, wd).text, "2 days");
  assert.equal(workingDaysIn(d("2026-10-19"), d("2026-10-25"), wd), 5);
});

test("Undo of a day-off change takes back only what it changed, on the list as it is now", () => {
  const z = (s: string, e = s) => ({ start: s + "T00:00:00Z", end: e + "T00:00:00Z" });
  assert.deepEqual(dayRanges([d("2026-10-07"), d("2026-10-05"), d("2026-10-06"), d("2026-10-09")]),
    [{ start: d("2026-10-05"), end: d("2026-10-07") }, { start: d("2026-10-09"), end: d("2026-10-09") }]);
  // 6 October was already off: adding 5 to 7 October really added 5 and 7
  const add = applyDaysOff([z("2026-10-06")], { op: "add", ranges: [{ start: d("2026-10-05"), end: d("2026-10-07") }] });
  assert.deepEqual(add.list, [z("2026-10-05", "2026-10-07")]);
  assert.deepEqual(add.undo, { op: "remove", ranges: [{ start: d("2026-10-05"), end: d("2026-10-05") }, { start: d("2026-10-07"), end: d("2026-10-07") }] });
  // meanwhile someone added 20 October: Undo keeps it, and keeps 6 October
  const back = applyDaysOff([...add.list, z("2026-10-20")], add.undo);
  assert.deepEqual(back.list, [z("2026-10-06"), z("2026-10-20")]);
  // removing takes back only the days that were off
  const rem = applyDaysOff([z("2026-10-06", "2026-10-07")], { op: "remove", ranges: [{ start: d("2026-10-05"), end: d("2026-10-08") }] });
  assert.deepEqual(rem.list, []);
  assert.deepEqual(rem.undo, { op: "add", ranges: [{ start: d("2026-10-06"), end: d("2026-10-07") }] });
  // nothing to change: nothing for Undo
  assert.deepEqual(applyDaysOff([z("2026-10-06")], { op: "add", ranges: [{ start: d("2026-10-06"), end: d("2026-10-06") }] }).undo.ranges, []);
});
