import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_PROCESS } from "../src/api/demo.ts";
import type { BoardInfo, WorkItem } from "../src/api/types.ts";
import { DEFAULT_RULES, alreadyBetween, boardColumns, cfdByColumn, columnOnDay, columnPath, cardOrder, nearestBox, capCards, CELL_CAP, clockClass, COLUMN_CAP, groupBy, limitShowing, columnEnteredAt, columnOf, countOf, featureGroups, matches, missing, movesToRow, placeAmong, prCount, prLinks, priorityMove, readAfterUndo, rowOf, runLimited, sharesState, sprintRows, tint } from "../src/views/boardmodel.ts";

test("a split column is split only when the board says which half a card is in", () => {
  const split = { ...board, columns: board.columns.map((c) => (c.name === "Doing" ? { ...c, isSplit: true } : c)) };
  assert.deepEqual(boardColumns(DEMO_PROCESS, req, { ...split, doneField: "WEF_X_Done" }, "columns").map((c) => Boolean(c.split)), [false, false, true, false]);
  assert.deepEqual(boardColumns(DEMO_PROCESS, req, split, "columns").map((c) => Boolean(c.split)), [false, false, false, false]);
  assert.deepEqual(boardColumns(DEMO_PROCESS, req, { ...split, doneField: "WEF_X_Done" }, "states").map((c) => Boolean(c.split)), [false, false, false, false]);
});

test("a drop while the search lifts matches takes neighbours of the same kind, in backlog order", () => {
  // on screen: matches 5 and 2 lifted to the top, then 1, 3, 4
  const cards = [{ id: 5, hit: true, mid: 10 }, { id: 2, hit: true, mid: 30 }, { id: 1, hit: false, mid: 50 }, { id: 3, hit: false, mid: 70 }, { id: 4, hit: false, mid: 90 }];
  // a card that does not match, dropped just under the last match: before the first card that does not match
  assert.deepEqual(placeAmong(cards, false, 40), { before: 0, after: 1 });
  assert.deepEqual(placeAmong(cards, false, 80), { before: 3, after: 4 });
  assert.deepEqual(placeAmong(cards, false, 99), { before: 4, after: 0 });
  // a match, dropped among the others: after the last match
  assert.deepEqual(placeAmong(cards, true, 60), { before: 2, after: 0 });
  assert.deepEqual(placeAmong(cards, true, 20), { before: 5, after: 2 });
  // no search: the plain screen order
  const plain = cards.map((c) => ({ ...c, hit: false }));
  assert.deepEqual(placeAmong(plain, false, 40), { before: 2, after: 1 });
});

test("menu order moves: top, up, down, bottom; none where the card already is", () => {
  const peers = [1, 2, 3, 4];
  assert.deepEqual(priorityMove(peers, 3, "top"), { prev: 0, next: 1 });
  assert.deepEqual(priorityMove(peers, 3, "up"), { prev: 1, next: 2 });
  assert.deepEqual(priorityMove(peers, 2, "down"), { prev: 3, next: 4 });
  assert.deepEqual(priorityMove(peers, 2, "bottom"), { prev: 4, next: 0 });
  assert.equal(priorityMove(peers, 1, "up"), null);
  assert.equal(priorityMove(peers, 1, "top"), null);
  assert.equal(priorityMove(peers, 4, "down"), null);
  assert.equal(priorityMove(peers, 4, "bottom"), null);
  assert.equal(priorityMove(peers, 9, "up"), null);
});

test("story map: a story in a sprint the team does not use can be dropped on the backlog row", () => {
  const b = String.fromCharCode(92);
  const rows = sprintRows([{ id: "s1", name: "Sprint 1", path: `P${b}Sprint 1`, timeFrame: "current", start: "2026-10-12T00:00:00Z", finish: "2026-10-23T00:00:00Z" }], "P");
  const backlog = rows[rows.length - 1];
  assert.equal(rowOf(rows, `P${b}Other team${b}Sprint 9`).key, "backlog");
  assert.equal(movesToRow(rows, backlog, `P${b}Other team${b}Sprint 9`), true);
  assert.equal(movesToRow(rows, backlog, "P"), false, "already in the backlog iteration");
  assert.equal(movesToRow(rows, rows[1], `P${b}Sprint 1`), false);
  assert.equal(movesToRow(rows, rows[1], "P"), true);
  assert.equal(movesToRow(rows, rows[0], "P"), false, "earlier sprints take no drops");
});

const req = DEMO_PROCESS.levels[2];
const item = (p: Partial<WorkItem>): WorkItem => ({ id: 1, rev: 1, type: "User Story", title: "T", state: "New", category: "Proposed", area: "", iteration: "", tags: [], created: "", changed: "", fields: {}, ...p });
const board: BoardInfo = {
  name: "Stories", columnField: "WEF_X", rows: [],
  columns: [
    { id: "1", name: "New", itemLimit: 0, isSplit: false, columnType: "incoming", stateMappings: { "User Story": "New" } },
    { id: "2", name: "Ready", itemLimit: 5, isSplit: false, columnType: "inProgress", stateMappings: { "User Story": "New" } },
    { id: "3", name: "Doing", itemLimit: 3, isSplit: false, columnType: "inProgress", stateMappings: { "User Story": "Active" } },
    { id: "4", name: "Closed", itemLimit: 0, isSplit: false, columnType: "outgoing", stateMappings: { "User Story": "Closed" } },
  ],
};

test("board columns, or one column per state", () => {
  assert.deepEqual(boardColumns(DEMO_PROCESS, req, board, "columns").map((c) => c.name), ["New", "Ready", "Doing", "Closed"]);
  assert.deepEqual(boardColumns(DEMO_PROCESS, req, board, "states").map((c) => c.name), ["New", "Active", "Resolved", "Closed"]);
});

test("a card stands in its board column, or the first column of its state", () => {
  const cols = boardColumns(DEMO_PROCESS, req, board, "columns");
  assert.equal(columnOf(cols, item({ boardColumn: "Ready" }), "columns")?.name, "Ready");
  assert.equal(columnOf(cols, item({ boardColumn: "Gone" }), "columns")?.name, "New");
  assert.equal(columnOf(cols, item({ state: "Active", boardColumn: "Ready" }), "columns")?.name, "Doing");
  assert.equal(sharesState(cols, cols[1], "User Story"), true);
  assert.equal(sharesState(cols, cols[2], "User Story"), false);
});

test("missing, colours and clock", () => {
  assert.deepEqual(missing(item({}), "descAc", 0, 0, true), ["description", "acceptance criteria"]);
  assert.deepEqual(missing(item({ category: "InProgress", description: "<div>long enough text</div>" }), "all", 0, 1, false), []);
  assert.deepEqual(missing(item({ category: "InProgress", description: "<div>long enough text</div>" }), "all", 0, 0, false), ["tasks"]);
  assert.equal(tint("both", 95, 0, "InProgress"), 2);
  assert.equal(tint("missing", 95, 1, "InProgress"), 1);
  assert.equal(tint("both", 95, 3, "Completed"), 0);
  assert.equal(clockClass(10, "inProgress", "InProgress"), "yellow");
  assert.equal(clockClass(30, "incoming", "Proposed"), "neutral");
});

test("colouring rules: thresholds and extra things missing", () => {
  const r = { ...DEFAULT_RULES, ageWarn: 10, ageBad: 20, missWarn: 2, missBad: 3 };
  assert.equal(tint("age", 9, 0, "InProgress", r), 0);
  assert.equal(tint("age", 10, 0, "InProgress", r), 1);
  assert.equal(tint("age", 20, 0, "InProgress", r), 2);
  assert.equal(tint("missing", 0, 1, "InProgress", r), 0);
  assert.equal(tint("missing", 0, 2, "InProgress", r), 1);
  assert.equal(tint("missing", 0, 3, "InProgress", r), 2);
  const described = { description: "<div>long enough text</div>" };
  assert.deepEqual(missing(item(described), "desc", 0, 0, false, { owner: true, effort: true }), ["owner", "effort"]);
  assert.deepEqual(missing(item({ ...described, effort: 3, assignedTo: { displayName: "A", uniqueName: "a" } }), "desc", 0, 0, false, { owner: true, effort: true }), []);
  assert.deepEqual(missing(item({}), "off", 0, 0, false, { owner: true }), []);
});

test("Features grouped by Epic, in backlog order", () => {
  const e1 = item({ id: 10, type: "Epic", order: 2 });
  const e2 = item({ id: 11, type: "Epic", order: 1 });
  const fs = [item({ id: 20, parent: 10, order: 1 }), item({ id: 21, parent: 11, order: 2 }), item({ id: 22, order: 3 }), item({ id: 23, parent: 10, order: 4 })];
  const all = new Map([e1, e2].map((e) => [e.id, e]));
  const g = featureGroups(fs, (id) => (id ? all.get(id) : undefined), new Set([20, 21, 22]), { empty: false, byEpic: true, showClosed: false });
  assert.deepEqual(g.map((x) => [x.epic?.id ?? 0, x.features.map((f) => f.id)]), [[11, [21]], [10, [20]], [0, [22]]]);
});

test("search words and column history", () => {
  assert.equal(matches(["consent", "#7"], item({ id: 7, title: "Consent banner" }), ""), true);
  assert.equal(matches(["missing"], item({ title: "x" }), "feature text"), false);
  const ups = [{ date: "2026-01-01", changes: [{ field: "WEF_X", newValue: "Ready" }] }, { date: "2026-02-01", changes: [{ field: "WEF_X", newValue: "Doing" }] }];
  assert.equal(columnEnteredAt(ups, "WEF_X", "Doing"), "2026-02-01");
});

const prRel = (repo: string, id: number) => ({ rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/proj%2F${repo}%2F${id}`, attributes: { name: "Pull Request" } });

test("a story's pull requests: its own and its tasks', each once", () => {
  const story = item({ id: 10, relations: [prRel("repo-a", 5), { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://x/_apis/wit/workItems/11", attributes: {} }] });
  const t1 = item({ id: 11, type: "Task", relations: [prRel("REPO-A", 5), prRel("repo-a", 6)] });
  const t2 = item({ id: 12, type: "Task", relations: [prRel("repo-b", 6), prRel("repo-a", 6)] });
  const links = prLinks(story, [t1, t2]);
  assert.deepEqual(links.map((l) => [l.key, l.from]), [["repo-a/5", 0], ["repo-a/6", 11], ["repo-b/6", 12]]);
  assert.deepEqual(prLinks(item({ id: 1 }), []), []);
  // the story's own link wins even when a task lists it first
  assert.equal(prLinks(story, [])[0].from, 0);
});

test("pull request counts under All, Open and Completed", () => {
  const links = prLinks(item({ relations: [prRel("r", 1), prRel("r", 2), prRel("r", 3), prRel("r", 4), prRel("r", 5)] }), []);
  const st: Record<number, string> = { 1: "completed", 2: "active", 3: "draft", 4: "abandoned", 5: "completed" };
  const of = (l: { prId: number }) => st[l.prId];
  assert.deepEqual([prCount(links, of, "all").label, prCount(links, of, "all").done], ["2/4", 2]);
  assert.equal(prCount(links, of, "open").label, "2 open");
  assert.equal(prCount(links, of, "completed").label, "2 done");
  // not read yet: All counts the links at once; the others wait
  const none = () => undefined;
  assert.deepEqual([prCount(links, none, "all").label, prCount(links, none, "all").unknown], ["0/5", 5]);
  assert.equal(prCount(links, none, "open").label, "0… open");
  assert.equal(prCount([], none, "all").label, "");
  assert.equal(prCount(links.slice(3, 4), of, "open").label, "");
});

test("only a few reads at a time", async () => {
  let running = 0;
  let most = 0;
  const done: number[] = [];
  await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 2));
    running--; done.push(x);
  });
  assert.equal(most, 3);
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test("story map rows by sprint, and the row of a card", () => {
  const day = 86_400_000;
  const today = Date.parse("2026-10-20T00:00:00Z");
  const p = (...parts: string[]): string => parts.join(String.fromCharCode(92)); // iteration paths use a backslash
  const it = (n: number, startDays: number, tf?: "past" | "current" | "future") => ({
    id: `i${n}`, name: `Sprint ${n}`, path: p("P", `Sprint ${n}`), timeFrame: tf,
    start: new Date(today + startDays * day).toISOString(), finish: new Date(today + (startDays + 13) * day).toISOString(),
  });
  const rows = sprintRows([it(3, 14, "future"), it(1, -28, "past"), it(2, -7, "current"), it(0, -42), it(4, 28)], "P", today);
  assert.deepEqual(rows.map((r) => r.key), ["past", p("P", "Sprint 2"), p("P", "Sprint 3"), p("P", "Sprint 4"), "backlog"]);
  assert.deepEqual(rows[0].paths, [p("P", "Sprint 0"), p("P", "Sprint 1")]);
  assert.equal(rows[1].kind, "current");
  assert.equal(rows[4].path, "P");
  assert.equal(rowOf(rows, p("P", "Sprint 3")).key, p("P", "Sprint 3"));
  assert.equal(rowOf(rows, p("p", "sprint 3", "Week 1")).key, p("P", "Sprint 3")); // a part of a sprint goes with the sprint
  assert.equal(rowOf(rows, p("P", "Sprint 1")).key, "past");
  assert.equal(rowOf(rows, "P").key, "backlog");
  assert.equal(rowOf(rows, p("Other", "Sprint 9")).key, "backlog");
  assert.equal(rowOf(rows, p("P", "Sprint 33")).key, "backlog"); // not "Sprint 3" by its first letters
});

test("counts with the level's name: one is singular", () => {
  assert.equal(countOf(1, "Stories"), "1 story");
  assert.equal(countOf(0, "Stories"), "0 stories");
  assert.equal(countOf(3, "Stories"), "3 stories");
  assert.equal(countOf(1, "Backlog items"), "1 backlog item");
  assert.equal(countOf(1, "Requirements"), "1 requirement");
});

test("a big column draws its first cards; Show more adds a step", () => {
  const list = Array.from({ length: 120 }, (_, i) => i);
  assert.equal(COLUMN_CAP, 50);
  assert.equal(CELL_CAP, 20);
  const a = capCards(list, COLUMN_CAP);
  assert.equal(a.shown.length, 50);
  assert.equal(a.hidden, 70);
  assert.deepEqual(a.shown.slice(0, 3), [0, 1, 2]);
  assert.deepEqual(capCards(list.slice(0, 10), 50), { shown: list.slice(0, 10), hidden: 0 });
  assert.equal(capCards(list, 150).hidden, 0);
  // a card further down (the pick, the selected one) gets its column drawn far enough
  assert.equal(limitShowing(10, 50, 50), 50);
  assert.equal(limitShowing(50, 50, 50), 100);
  assert.equal(limitShowing(149, 50, 50), 150);
  assert.equal(limitShowing(25, 20, 20), 40);
});

test("cards are split by a key in one pass, order kept", () => {
  const g = groupBy([{ c: "a", n: 1 }, { c: "b", n: 2 }, { c: "a", n: 3 }], (x) => x.c);
  assert.deepEqual([...g.keys()], ["a", "b"]);
  assert.deepEqual(g.get("a")!.map((x) => x.n), [1, 3]);
});

test("cards sort by backlog order (search matches first); a drop needs a reorder only when the order differs", () => {
  const a = item({ id: 1, order: 10 }), b = item({ id: 2, order: 20 }), c = item({ id: 3, order: 30 });
  const list = [{ w: c, hit: false }, { w: a, hit: false }, { w: b, hit: true }];
  assert.deepEqual(list.sort(cardOrder).map((x) => x.w.id), [2, 1, 3]);
  assert.equal(alreadyBetween(b, a, c), true);
  assert.equal(alreadyBetween(b, undefined, a), false);
  assert.equal(alreadyBetween(a, undefined, b), true);
  assert.equal(alreadyBetween(c, b, undefined), true);
  assert.equal(alreadyBetween(a, b, undefined), false);
});

test("arrow keys go to the nearest card that way", () => {
  const box = (left: number, top: number) => ({ left, top, right: left + 100, bottom: top + 50 });
  // two columns at x 0 and x 120 (the second one's cards a little lower), one far card at x 240
  const boxes = [box(0, 0), box(0, 60), box(0, 120), box(120, 30), box(120, 90), box(240, 500)];
  assert.equal(nearestBox(boxes[0], boxes, "down"), 1);
  assert.equal(nearestBox(boxes[2], boxes, "up"), 1);
  assert.equal(nearestBox(boxes[0], boxes, "up"), -1);
  assert.equal(nearestBox(boxes[2], boxes, "down"), -1);
  assert.equal(nearestBox(boxes[2], boxes, "right"), 4);
  assert.equal(nearestBox(boxes[0], boxes, "right"), 3);
  assert.equal(nearestBox(boxes[3], boxes, "left"), 0);
  assert.equal(nearestBox(boxes[4], boxes, "right"), 5);
  assert.equal(nearestBox(boxes[0], boxes, "left"), -1);
});

test("an Undo that reads the item again afterwards: in order, and the first answer comes back", async () => {
  const log: string[] = [];
  const r = readAfterUndo({ item: item({}), undo: async () => { log.push("undo"); return "undone"; } }, async () => { log.push("read"); });
  assert.equal(await r.undo!(), "undone");
  assert.deepEqual(log, ["undo", "read"]);
  assert.equal(r.item.id, 1);
});

test("a result without an Undo stays as it is", () => {
  const r: { item: WorkItem; undo?: () => Promise<unknown> } = { item: item({}) };
  assert.equal(readAfterUndo(r, async () => undefined), r);
});

test("a refused Undo is not followed by a read", async () => {
  const log: string[] = [];
  const r = readAfterUndo({ item: item({}), undo: async () => { throw new Error("refused"); } }, async () => { log.push("read"); });
  await assert.rejects(() => r.undo!(), /refused/);
  assert.deepEqual(log, []);
});

test("runLimited goes on with the other jobs when one throws", async () => {
  const done: number[] = [];
  await runLimited([1, 2, 3, 4, 5], 2, async (x) => { if (x === 2) throw new Error("boom"); done.push(x); });
  assert.deepEqual(done.sort(), [1, 3, 4, 5]);
});

// ---------- cumulative flow by board column ----------

const D = (day: number, hour = 10): string => new Date(Date.UTC(2026, 0, 1 + day, hour)).toISOString();
const dayOf = (iso: string): number => Math.floor(Date.parse(iso) / 86_400_000);
const up = (day: number, changes: Record<string, string>) => ({ date: D(day), changes: Object.entries(changes).map(([field, newValue]) => ({ field, newValue })) });

test("column path: state and column moves from the history, a move within a state too", () => {
  const cols = boardColumns(DEMO_PROCESS, req, board, "columns");
  const w = item({ state: "Active", category: "InProgress", boardColumn: "Doing", created: D(0), changed: D(5) });
  const path = columnPath(w, [up(0, { "System.State": "New", WEF_X: "New" }), up(2, { WEF_X: "Ready" }), up(5, { "System.State": "Active", WEF_X: "Doing" })], cols, "WEF_X");
  assert.deepEqual(path.map((s) => s.column), ["New", "Ready", "Doing"]);
  assert.equal(columnOnDay(path, dayOf(D(1))), "New");
  assert.equal(columnOnDay(path, dayOf(D(3))), "Ready");
  assert.equal(columnOnDay(path, dayOf(D(9))), "Doing");
  assert.equal(columnOnDay(path, dayOf(D(0)) - 1), null, "not created yet");
});

test("column path: a column that does not fit the state counts in the state's first column", () => {
  const cols = boardColumns(DEMO_PROCESS, req, board, "columns");
  // the state moved to Active but the column field still says Ready (moved outside the board)
  const w = item({ state: "Active", category: "InProgress", boardColumn: "Ready", created: D(0), changed: D(4) });
  const path = columnPath(w, [up(0, { "System.State": "New", WEF_X: "Ready" }), up(4, { "System.State": "Active" })], cols, "WEF_X");
  assert.deepEqual(path.map((s) => s.column), ["Ready", "Doing"]);
});

test("column path: without history the item's dates stand in, and it ends where it stands now", () => {
  const cols = boardColumns(DEMO_PROCESS, req, board, "columns");
  const closed = item({ state: "Closed", category: "Completed", boardColumn: "Closed", created: D(0), activated: D(3), closed: D(8), changed: D(8) });
  assert.deepEqual(columnPath(closed, null, cols, "WEF_X").map((s) => [s.column, dayOf(s.at)]), [["New", dayOf(D(0))], ["Ready", dayOf(D(3))], ["Closed", dayOf(D(8))]]);
  // an old history: the current column is added on the last change
  const moved = item({ state: "New", boardColumn: "Ready", created: D(0), changed: D(6) });
  assert.deepEqual(columnPath(moved, [up(0, { "System.State": "New", WEF_X: "New" })], cols, "WEF_X").map((s) => [s.column, dayOf(s.at)]), [["New", dayOf(D(0))], ["Ready", dayOf(D(6))]]);
});

test("column path: two moves on one day keep the last, dates out of order never go back", () => {
  const cols = boardColumns(DEMO_PROCESS, req, board, "columns");
  const w = item({ state: "Active", category: "InProgress", boardColumn: "Doing", created: D(0), changed: D(4) });
  const ups = [up(0, { "System.State": "New", WEF_X: "New" }), { date: D(2, 9), changes: [{ field: "WEF_X", newValue: "Ready" }] }, { date: D(2, 9), changes: [{ field: "System.State", newValue: "Active" }, { field: "WEF_X", newValue: "Doing" }] }, up(1, { WEF_X: "Doing" })];
  const path = columnPath(w, ups, cols, "WEF_X");
  assert.deepEqual(path.map((s) => s.column), ["New", "Doing"]);
  assert.ok(path.every((s, i) => i === 0 || Date.parse(s.at) >= Date.parse(path[i - 1].at)));
});

test("cumulative flow by column: each item counted once a day, in the column it stood in at the day's end", () => {
  const start = dayOf(D(0));
  const a = [{ at: D(0), column: "New" }, { at: D(2), column: "Ready" }, { at: D(4), column: "Doing" }];
  const b = [{ at: D(1), column: "New" }, { at: D(1, 15), column: "Doing" }, { at: D(3), column: "Closed" }];
  const c = [{ at: D(-10), column: "Ready" }, { at: D(2), column: null }]; // made before the period, then off the board
  const v = cfdByColumn([a, b, c], ["New", "Ready", "Doing", "Closed"], start, 6);
  assert.deepEqual(v.New, [1, 1, 0, 0, 0, 0]);
  assert.deepEqual(v.Ready, [1, 1, 1, 1, 0, 0]);
  assert.deepEqual(v.Doing, [0, 1, 1, 0, 1, 1]);
  assert.deepEqual(v.Closed, [0, 0, 0, 1, 1, 1]);
  // the last day equals where each item stands now
  assert.deepEqual(["New", "Ready", "Doing", "Closed"].map((k) => v[k][5]), [0, 0, 1, 1]);
});

test("column rules: a rule holds in its own column and every column to its right; one-way rules and who-may rules are no gaps", async () => {
  const { inheritedRules, ruleGaps, ruleColumn } = await import("../src/views/boardmodel.ts");
  const col = (name: string, state: string) => ({ name, states: { Story: state }, limit: 0, kind: "inProgress" as const, color: "#888" });
  const cols = [col("New", "New"), col("Ready", "Active"), col("Doing", "Active"), col("Review", "Resolved"), col("Done", "Closed")];
  const rule = (id: string, target: string, requires: string[], extra: object = {}) => ({ id, level: "requirement" as const, target, requires: requires as never[], onlyBy: [] as string[], ...extra });
  const rules = [rule("a", "Ready", ["description"]), rule("b", "Doing", ["acceptance"]), rule("c", "Review", ["hasChildren"], { onlyBy: ["boss@x.example"] }), rule("d", "Doing", ["owner"], { from: "Ready" })];
  assert.deepEqual(inheritedRules(rules, "requirement", cols, 0, "Story").map((r) => r.id), []);
  assert.deepEqual(inheritedRules(rules, "requirement", cols, 1, "Story").map((r) => r.id), ["a"]);
  assert.deepEqual(inheritedRules(rules, "requirement", cols, 2, "Story").map((r) => r.id), ["a", "b"]); // d is a one-way rule
  assert.deepEqual(inheritedRules(rules, "requirement", cols, 3, "Story").map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(inheritedRules(rules, "task", cols, 3, "Story").map((r) => r.id), []); // another level
  // a rule that names a state guards the first column of that state
  assert.equal(ruleColumn(rule("e", "Resolved", []), cols, "Story"), 3);
  assert.equal(ruleColumn(rule("e", "Nowhere", []), cols, "Story"), -1);
  const facts = { kind: "requirement" as const, description: "", acceptance: "", hasOwner: true, hasParent: true, hasEffort: true, inSprint: true, children: 0, openChildren: 0, openPrs: 0, openPredecessors: 0, tags: 0, me: "me@x.example", values: {} };
  const gaps = ruleGaps(rules, "requirement", cols, 3, "Story", facts);
  assert.deepEqual(gaps.map((g) => [g.rule.id, g.labels]), [["a", ["Description"]], ["b", ["Acceptance criteria"]], ["c", ["Tasks present"]]]); // the "only boss" part is no gap
  assert.deepEqual(ruleGaps(rules, "requirement", cols, 3, "Story", { ...facts, description: "x".repeat(30), acceptance: "y".repeat(12), children: 2 }), []);
  // a field rule is judged only for a field the card was read with
  const withField = [rule("f", "Ready", [], { fields: ["Custom.Why"] })];
  assert.deepEqual(ruleGaps(withField, "requirement", cols, 1, "Story", { ...facts, values: {} }), []);
  assert.deepEqual(ruleGaps(withField, "requirement", cols, 1, "Story", { ...facts, values: { "Custom.Why": "" } }).map((g) => g.labels), [["Why"]]);
});
