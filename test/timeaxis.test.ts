import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMonths, clip, dayIso, dayKey, dragSpan, dragDays, fromYmd, localDay, monthGrid, monthKey, monthStart, packLanes,
  parseMonthKey, parts, planDay, planIso, planKey, quarterStart, ticks, todayKey, union, weekday, weekStart,
} from "../src/core/timeaxis.ts";

test("planDay rounds a planning date to the day the person picked", () => {
  const oct21 = fromYmd(2026, 9, 21);
  assert.equal(planDay("2026-10-21T00:00:00Z"), oct21);
  assert.equal(planDay("2026-10-20T22:00:00Z"), oct21); // Berlin midnight
  assert.equal(planDay("2026-10-21T05:00:00Z"), oct21); // New York midnight
  assert.equal(planDay("2026-10-20T12:00:00Z"), oct21); // UTC+12
  assert.equal(planDay(undefined), null);
  assert.equal(planDay("not a date"), null);
});

test("dayIso writes midnight UTC and reads back the same day", () => {
  const d = fromYmd(2026, 0, 5);
  assert.equal(dayIso(d), "2026-01-05T00:00:00.000Z");
  assert.equal(dayKey(d), "2026-01-05");
  assert.equal(planDay(dayIso(d)), d);
});

test("localDay uses the local calendar date", () => {
  const at = new Date(2026, 9, 21, 23, 30);
  assert.equal(localDay(at), fromYmd(2026, 9, 21));
});

test("weekdays and week starts", () => {
  const wed = fromYmd(2026, 9, 21);
  assert.equal(weekday(wed), 3);
  assert.equal(parts(wed).dow, 3);
  assert.equal(weekStart(wed, 1), fromYmd(2026, 9, 19)); // Monday
  assert.equal(weekStart(wed, 0), fromYmd(2026, 9, 18)); // Sunday
  assert.equal(weekStart(fromYmd(2026, 9, 18), 1), fromYmd(2026, 9, 12)); // a Sunday belongs to the week before
  assert.equal(weekday(fromYmd(1969, 11, 31)), 3); // before 1970 still works
});

test("months and quarters", () => {
  const d = fromYmd(2026, 10, 17);
  assert.equal(monthStart(d), fromYmd(2026, 10, 1));
  assert.equal(quarterStart(d), fromYmd(2026, 9, 1));
  assert.equal(addMonths(d, 2), fromYmd(2027, 0, 1));
  assert.equal(addMonths(d, -11), fromYmd(2025, 11, 1));
  assert.equal(monthKey(d), "2026-11");
  assert.equal(parseMonthKey("2026-11"), fromYmd(2026, 10, 1));
  assert.equal(parseMonthKey("nonsense"), null);
});

test("monthGrid covers the month in whole weeks", () => {
  const weeks = monthGrid(fromYmd(2026, 9, 1), 1); // October 2026 starts on a Thursday
  assert.equal(weeks[0][0], fromYmd(2026, 8, 28));
  assert.equal(weeks.at(-1)!.at(-1), fromYmd(2026, 10, 1));
  assert.equal(weeks.length, 5);
  for (const w of weeks) assert.equal(w.length, 7);
  const feb = monthGrid(fromYmd(2027, 1, 1), 1); // February 2027 starts on a Monday, 28 days
  assert.equal(feb.length, 4);
});

test("ticks are clipped to the range", () => {
  const from = fromYmd(2026, 9, 15);
  const to = fromYmd(2026, 11, 3);
  const months = ticks(from, to, "month");
  assert.deepEqual(months.map((t) => [dayKey(t.start), dayKey(t.end)]), [
    ["2026-10-15", "2026-10-31"], ["2026-11-01", "2026-11-30"], ["2026-12-01", "2026-12-03"],
  ]);
  const weeks = ticks(from, fromYmd(2026, 9, 31), "week");
  assert.equal(dayKey(weeks[0].start), "2026-10-15");
  assert.equal(dayKey(weeks[1].start), "2026-10-19");
  assert.equal(ticks(from, to, "quarter").length, 1);
});

test("clip and union", () => {
  assert.deepEqual(clip({ start: 5, end: 20 }, 10, 15), { start: 10, end: 15 });
  assert.equal(clip({ start: 5, end: 8 }, 10, 15), null);
  assert.deepEqual(union([null, { start: 5, end: 8 }, { start: 2, end: 6 }]), { start: 2, end: 8 });
  assert.equal(union([undefined]), null);
});

test("packLanes keeps overlapping spans apart", () => {
  const lanes = packLanes([{ start: 0, end: 10 }, { start: 5, end: 12 }, { start: 11, end: 14 }, { start: 13, end: 20 }]);
  assert.deepEqual(lanes, [0, 1, 0, 1]);
});

test("dragging snaps to days and keeps at least one day", () => {
  assert.equal(dragDays(23, 10), 2);
  assert.equal(dragDays(-4, 10), 0);
  const s = { start: 10, end: 20 };
  assert.deepEqual(dragSpan(s, "move", 3), { start: 13, end: 23 });
  assert.deepEqual(dragSpan(s, "start", 15), { start: 20, end: 20 });
  assert.deepEqual(dragSpan(s, "end", -30), { start: 10, end: 10 });
  assert.deepEqual(dragSpan(s, "end", 4), { start: 10, end: 24 });
});

test("planIso writes local midnight, and planDay and planKey read back the same day in any zone", () => {
  for (const d of [fromYmd(2026, 0, 5), fromYmd(2026, 2, 29), fromYmd(2026, 9, 25), fromYmd(2026, 11, 31)]) {
    const iso = planIso(d);
    const back = new Date(iso);
    assert.equal(back.getHours(), 0);
    assert.equal(back.getDate(), parts(d).d);
    assert.equal(planDay(iso), d);
    assert.equal(planKey(iso), dayKey(d));
  }
  assert.equal(planKey(undefined), "");
  assert.equal(planKey("2026-10-20T22:00:00Z"), "2026-10-21"); // Berlin midnight
  assert.equal(todayKey(new Date(2026, 9, 25, 23, 30)), "2026-10-25");
});

test("a day key turns into the planning date Azure DevOps gets, and back", async () => {
  const { parseDayKey, planIsoOfKey } = await import("../src/core/timeaxis.ts");
  assert.equal(parseDayKey("2026-10-21"), fromYmd(2026, 9, 21));
  assert.equal(parseDayKey("21.10.2026"), null);
  assert.equal(planKey(planIsoOfKey("2027-03-01")), "2027-03-01");
  assert.equal(new Date(planIsoOfKey("2027-03-01")).getHours(), 0);
  assert.equal(planIsoOfKey(""), "");
});
