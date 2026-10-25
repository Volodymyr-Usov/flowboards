import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countByMonth, derivePillars, findAncestor, keepRenamed, monthKeyOf, monthKeys, monthsStart, monthsStartTime, NO_PILLAR, NONE_VALUE,
  pillarColor, pillarNamesFromTags, pillarOfEpic, pillarSource, progressOf, shortHash, slug, stateMismatch, sumRows,
} from "../src/views/strategylogic.ts";

test("pillar names come from tags with the prefix, without case", () => {
  assert.deepEqual(pillarNamesFromTags(["Pillar:Growth", "pillar: Platform", "Other", "Pillar:"], "Pillar:"), ["Growth", "Platform"]);
  assert.deepEqual(pillarNamesFromTags(["Pillar:Growth"], ""), []);
});

test("derived pillars are unique, sorted, with stable ids and colors", () => {
  const p = derivePillars([["Pillar:Platform"], ["Pillar:Growth", "x"], ["pillar:growth"], []], "Pillar:");
  assert.deepEqual(p.map((x) => x.name), ["Growth", "Platform"]);
  assert.deepEqual(p.map((x) => x.id), ["tag-growth", "tag-platform"]);
  assert.deepEqual(p.map((x) => x.color), ["--s1", "--s2"]);
});

test("an Epic's pillar: by hand first, then by tag, else none", () => {
  const pillars = [{ id: "a", name: "Growth" }, { id: "b", name: "Platform" }];
  assert.equal(pillarOfEpic(1, ["Pillar:Growth"], pillars, {}, "Pillar:"), "a");
  assert.equal(pillarOfEpic(1, ["Pillar:growth"], pillars, {}, "Pillar:"), "a");
  assert.equal(pillarOfEpic(1, ["Pillar:Growth"], pillars, { 1: "b" }, "Pillar:"), "b");
  assert.equal(pillarOfEpic(1, ["Pillar:Growth"], pillars, { 1: NONE_VALUE }, "Pillar:"), NO_PILLAR);
  assert.equal(pillarOfEpic(1, ["Pillar:Growth"], pillars, { 1: "deleted" }, "Pillar:"), "a");
  assert.equal(pillarOfEpic(1, ["Pillar:Unknown"], pillars, {}, "Pillar:"), NO_PILLAR);
  assert.equal(pillarSource(1, { 1: "b" }, pillars), "manual");
  assert.equal(pillarSource(1, { 1: NONE_VALUE }, pillars), "none");
  assert.equal(pillarSource(1, { 1: "deleted" }, pillars), "tag");
});

test("pillar colors are tokens only", () => {
  assert.equal(pillarColor("--s3", 0), "var(--s3)");
  assert.equal(pillarColor("s4", 0), "var(--s4)");
  assert.equal(pillarColor("#ff0000", 9), "var(--s2)");
  assert.equal(pillarColor(undefined, 0), "var(--s1)");
});

test("month keys end with the current month", () => {
  const now = new Date(2026, 9, 21).getTime();
  const k = monthKeys(now, 12);
  assert.equal(k.length, 12);
  assert.equal(k[11], "2026-10");
  assert.equal(k[0], "2025-11");
  assert.equal(monthsStart(now, 12), "2025-11-01");
  assert.equal(monthKeys(new Date(2026, 1, 15).getTime(), 3).join(","), "2025-12,2026-01,2026-02");
});

test("closed items are counted per group and month", () => {
  const months = ["2026-08", "2026-09", "2026-10"];
  const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();
  const rows = countByMonth([
    { closed: iso(2026, 8, 3), group: 1 },
    { closed: iso(2026, 10, 1), group: 1 },
    { closed: iso(2026, 10, 20), group: 1 },
    { closed: iso(2026, 9, 2), group: 2 },
    { closed: iso(2025, 1, 1), group: 2 },
    { closed: undefined, group: 2 },
    { closed: iso(2026, 9, 2), group: undefined },
  ], months);
  assert.deepEqual(rows.get(1), [1, 0, 2]);
  assert.deepEqual(rows.get(2), [0, 1, 0]);
  assert.deepEqual(sumRows([rows.get(1), rows.get(2), undefined], 3), [1, 1, 2]);
  assert.equal(monthKeyOf("not a date"), "");
});

test("the Epic above a story is found through its Feature", () => {
  const parent: Record<number, number> = { 30: 20, 20: 10, 99: 99 };
  const epics = new Set([10]);
  assert.equal(findAncestor(30, (id) => parent[id], (id) => epics.has(id)), 10);
  assert.equal(findAncestor(20, (id) => parent[id], (id) => id === 20), undefined);
  assert.equal(findAncestor(99, (id) => parent[id], () => false), undefined);
});

test("progress counts each item once and leaves removed out", () => {
  assert.deepEqual(progressOf([
    { id: 1, category: "Completed" }, { id: 2, category: "Resolved" }, { id: 3, category: "InProgress" },
    { id: 3, category: "Completed" }, { id: 4, category: "Removed" },
  ]), { done: 3, total: 3 });
});

test("an Epic's state is checked against the work under it", () => {
  assert.match(stateMismatch("Proposed", ["InProgress", "Proposed"])!, /Not started/);
  assert.equal(stateMismatch("Proposed", ["Proposed"]), null);
  assert.match(stateMismatch("Completed", ["Completed", "InProgress"])!, /still open/);
  assert.match(stateMismatch("InProgress", ["Completed", "Resolved"])!, /all work under it is done/);
  assert.equal(stateMismatch("InProgress", ["Completed", "Proposed"]), null);
  assert.equal(stateMismatch("Completed", []), null);
  assert.equal(stateMismatch("Completed", ["Removed"]), null);
});

test("pillar ids: any script, unique when slugs collide, stable", () => {
  assert.equal(slug("Рост"), "рост");
  assert.equal(slug(" Go Big! "), "go-big");
  assert.equal(slug("+++"), "pillar");
  const ru = derivePillars([["Pillar:Рост"], ["Pillar:Качество"]], "Pillar:");
  assert.deepEqual(ru.map((x) => x.id).sort(), ["tag-качество", "tag-рост"]);
  const c = derivePillars([["Pillar:C++"], ["Pillar:C#"]], "Pillar:");
  assert.equal(new Set(c.map((x) => x.id)).size, 2);
  assert.ok(c.some((x) => x.id === "tag-c"));
  const other = c.find((x) => x.id !== "tag-c")!;
  assert.equal(other.id, `tag-c-${shortHash(other.name.toLowerCase())}`);
  // the same tags give the same ids every time
  assert.deepEqual(derivePillars([["Pillar:C#"], ["Pillar:C++"]], "Pillar:").map((x) => x.id), c.map((x) => x.id));
  // Latin names keep the ids they had before
  assert.deepEqual(derivePillars([["Pillar:Growth"], ["Pillar:Go Big"]], "Pillar:").map((x) => x.id), ["tag-go-big", "tag-growth"]);
});

test("renaming a pillar keeps its Epics by id; others stay as they were", () => {
  const before = [{ id: "p1", name: "Growth" }, { id: "p2", name: "Platform" }];
  const after = [{ id: "p1", name: "Grow" }, { id: "p2", name: "Platform" }];
  const epics = [
    { id: 1, tags: ["Pillar:Growth"] }, // loses its tag match: kept by id
    { id: 2, tags: ["Pillar:Platform"] }, // pillar not renamed
    { id: 3, tags: ["Pillar:Growth"] }, // chosen by hand: untouched
    { id: 4, tags: [] },
  ];
  const r = keepRenamed(epics, before, after, { "3": NONE_VALUE }, "Pillar:", "Pillar:");
  assert.deepEqual(r.kept, [1]);
  assert.deepEqual(r.epicPillars, { "1": "p1", "3": NONE_VALUE });
  // a removed pillar's Epics are not kept
  assert.deepEqual(keepRenamed(epics, before, [after[1]], {}, "Pillar:", "Pillar:").kept, []);
  // a new tag prefix keeps every tagged Epic
  assert.deepEqual(keepRenamed(epics, before, before, {}, "Pillar:", "Goal:").kept, [1, 2, 3]);
});

test("the first month of the chart starts at local midnight, so a close on its first morning counts", () => {
  const now = new Date(2026, 9, 23, 12, 0, 0).getTime();
  const since = monthsStartTime(now, 12);
  const d = new Date(since);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2025, 10, 1, 0, 0]);
  // 00:30 local on 1 November 2025 is in the oldest month, in any time zone
  assert.ok(new Date(2025, 10, 1, 0, 30).getTime() >= since);
  assert.ok(new Date(2025, 9, 31, 23, 30).getTime() < since);
  // and it is the month monthKeys starts with
  assert.equal(monthKeyOf(new Date(since).toISOString()), monthKeys(now, 12)[0]);
});
