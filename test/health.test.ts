import { test } from "node:test";
import assert from "node:assert/strict";
import type { Iteration, ProcessInfo, WorkItem } from "../src/api/types.ts";
import {
  duplicateTagGroups, editDistanceUpTo1, firstStateIn, pastIterationPaths, replaceTag, runChecks, tagKey, tagsAlike, typeHasField,
} from "../src/core/health.ts";
import type { Finding, HealthInput } from "../src/core/health.ts";

// A Scrum-like process with made-up names, to make sure nothing depends on Agile's names.
const states = (list: [string, "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed"][]) => list.map(([name, category]) => ({ name, category, color: "#888888" }));
const S = states([["Idea", "Proposed"], ["Doing", "InProgress"], ["Done", "Completed"], ["Gone", "Removed"]]);
const P: ProcessInfo = {
  levels: [
    { id: "a", name: "Goals", kind: "portfolio", rank: 0, types: ["Goal"], defaultType: "Goal" },
    { id: "b", name: "Themes", kind: "portfolio", rank: 1, types: ["Theme"], defaultType: "Theme" },
    { id: "c", name: "Items", kind: "requirement", rank: 2, types: ["Item", "Defect"], defaultType: "Item" },
    { id: "d", name: "Steps", kind: "task", rank: 3, types: ["Step"], defaultType: "Step" },
  ],
  types: {
    Goal: { name: "Goal", color: "#000000", states: S },
    Theme: { name: "Theme", color: "#000000", states: S },
    Item: { name: "Item", color: "#000000", states: S, fields: ["System.Title", "Microsoft.VSTS.Common.AcceptanceCriteria", "Custom.Size"] },
    Defect: { name: "Defect", color: "#000000", states: S, fields: ["System.Title", "Custom.Size"] },
    Step: { name: "Step", color: "#000000", states: S },
  },
  fields: { order: "Custom.Rank", effort: "Custom.Size", remaining: "Custom.Left", activity: "", completed: "", original: "" },
  bugsBehavior: "asRequirements",
};

const NOW = Date.parse("2026-10-21T12:00:00Z");
const CAT: Record<string, WorkItem["category"]> = { Idea: "Proposed", Doing: "InProgress", Done: "Completed", Gone: "Removed" };
const OK_TEXT = "<div>Some text</div>";
const ME = { displayName: "Ann", uniqueName: "ann@x.example" };

function item(id: number, type: string, state: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id, rev: 1, type, title: `${type} ${id}`, state, category: CAT[state], area: "P", iteration: "P", tags: [],
    created: "2026-10-01T00:00:00Z", changed: "2026-10-20T00:00:00Z", fields: {}, assignedTo: ME,
    description: OK_TEXT, acceptance: OK_TEXT, effort: 3, ...extra,
  };
}

const ITERS: Iteration[] = [
  { id: "1", name: "S1", path: "P\\S1", start: "2026-09-01T00:00:00Z", finish: "2026-09-14T00:00:00Z", timeFrame: "past" },
  { id: "2", name: "S2", path: "P\\S2", start: "2026-10-12T00:00:00Z", finish: "2026-10-25T00:00:00Z", timeFrame: "current" },
];

function run(items: WorkItem[], extra: Partial<HealthInput> = {}): Finding[] {
  return runChecks({ items, process: P, staleDays: 14, iterations: ITERS, backlogRoot: "P", today: NOW, ...extra });
}
const ids = (f: Finding[], check: string): number[] => f.filter((x) => x.checkId === check).map((x) => x.itemId);

test("a clean tree has no findings", () => {
  const f = run([
    item(1, "Goal", "Doing"), item(2, "Theme", "Doing", { parent: 1 }), item(3, "Item", "Doing", { parent: 2 }),
    item(4, "Step", "Doing", { parent: 3, description: undefined }), item(5, "Step", "Idea", { parent: 3 }),
  ]);
  assert.deepEqual(f, []);
});

test("missing parents: requirement and portfolio below the top", () => {
  const f = run([item(1, "Goal", "Idea"), item(2, "Theme", "Idea"), item(3, "Item", "Idea"), item(4, "Item", "Done")]);
  assert.deepEqual(ids(f, "noParent"), [3]);
  assert.deepEqual(ids(f, "noPortfolioParent"), [2]);
});

test("no owner only while in progress", () => {
  const f = run([item(1, "Item", "Doing", { assignedTo: undefined, parent: 9 }), item(2, "Item", "Idea", { assignedTo: undefined, parent: 9 })]);
  assert.deepEqual(ids(f, "noOwner"), [1]);
});

test("description on requirement and portfolio, not on tasks", () => {
  const f = run([item(1, "Goal", "Idea", { description: "<div></div>" }), item(2, "Step", "Idea", { description: "", parent: 1 }), item(3, "Item", "Idea", { description: undefined, parent: 1 })]);
  assert.deepEqual(ids(f, "noDescription"), [1, 3]);
});

test("acceptance criteria only when the type has the field (or fields are unknown)", () => {
  const p2: ProcessInfo = { ...P, types: { ...P.types, Item: { ...P.types.Item, fields: undefined } } };
  const items = [item(1, "Item", "Idea", { acceptance: "", parent: 9 }), item(2, "Defect", "Idea", { acceptance: "", parent: 9 })];
  assert.deepEqual(ids(run(items), "noAcceptance"), [1]);
  assert.deepEqual(ids(runChecks({ items, process: p2, staleDays: 14, iterations: [], today: NOW }), "noAcceptance"), [1]);
  assert.equal(typeHasField(P, "Defect", "Microsoft.VSTS.Common.AcceptanceCriteria"), false);
  assert.equal(typeHasField(P, "Step", "anything"), true);
});

test("estimate missing on requirement in progress", () => {
  const f = run([item(1, "Item", "Doing", { effort: undefined, parent: 9 }), item(2, "Item", "Idea", { effort: undefined, parent: 9 }), item(3, "Item", "Doing", { effort: 0, parent: 9 })]);
  assert.deepEqual(ids(f, "noEstimate"), [1, 3]);
});

test("stale after staleDays without change", () => {
  const f = run([item(1, "Item", "Doing", { changed: "2026-10-01T00:00:00Z", parent: 9 }), item(2, "Item", "Doing", { changed: "2026-10-10T00:00:00Z", parent: 9 })]);
  assert.deepEqual(ids(f, "stale"), [1]);
  assert.match(f.find((x) => x.checkId === "stale")!.message, /20 days/);
  assert.deepEqual(ids(run([item(2, "Item", "Doing", { changed: "2026-10-10T00:00:00Z", parent: 9 })], { staleDays: 5 }), "stale"), [2]);
});

test("open work in a past sprint", () => {
  const f = run([
    item(1, "Item", "Doing", { iteration: "P\\S1", parent: 9 }), item(2, "Item", "Done", { iteration: "P\\S1", parent: 9 }),
    item(3, "Item", "Doing", { iteration: "P\\S2", parent: 9 }), item(4, "Item", "Idea", { iteration: "P", parent: 9 }),
  ]);
  assert.deepEqual(ids(f, "pastSprint"), [1]);
  assert.deepEqual([...pastIterationPaths([{ id: "x", name: "x", path: "P\\X", finish: "2026-10-01T00:00:00Z" }], NOW)], ["P\\X"]);
});

test("parent and children out of step", () => {
  const f = run([
    item(1, "Item", "Done", { parent: 9 }), item(2, "Step", "Doing", { parent: 1 }), item(3, "Step", "Done", { parent: 1, remaining: 2 }),
    item(4, "Item", "Doing", { parent: 9, relations: [5, 6].map((id) => ({ rel: "System.LinkTypes.Hierarchy-Forward", url: `https://x.example/_apis/wit/workItems/${id}`, attributes: {} })) }),
    item(5, "Step", "Done", { parent: 4 }), item(6, "Step", "Done", { parent: 4 }),
    item(7, "Item", "Idea", { parent: 9 }), item(8, "Step", "Doing", { parent: 7 }),
  ]);
  assert.deepEqual(ids(f, "doneWithOpenChildren"), [1]);
  assert.deepEqual(ids(f, "canClose"), [4]);
  assert.deepEqual(ids(f, "childAhead"), [7]);
  assert.deepEqual(ids(f, "remainingOnDone"), [3]);
});

test("target date in the past", () => {
  const f = run([item(1, "Theme", "Doing", { parent: 9, targetDate: "2026-10-20T00:00:00Z" }), item(2, "Theme", "Doing", { parent: 9, targetDate: "2026-10-21T00:00:00Z" }), item(3, "Theme", "Done", { parent: 9, targetDate: "2026-01-01T00:00:00Z" })],
  { today: new Date(2026, 9, 21, 12).getTime() });
  assert.deepEqual(ids(f, "pastTarget"), [1]);
});

test("target date: a date saved as local midnight is that day, in any time zone", () => {
  // Azure DevOps's own date picker saves local midnight: 20 Oct in Berlin is 2026-10-19T22:00:00Z
  const today = new Date(2026, 9, 21, 9).getTime();
  const at = (d: number): string => new Date(2026, 9, d).toISOString();
  const f = run([item(1, "Theme", "Doing", { parent: 9, targetDate: at(20) }), item(2, "Theme", "Doing", { parent: 9, targetDate: at(21) })], { today });
  assert.deepEqual(ids(f, "pastTarget"), [1]);
  assert.match(f.find((x) => x.checkId === "pastTarget")!.message, /2026-10-20/);
});

test("first state of a category", () => {
  assert.equal(firstStateIn(P, "Item", "Completed"), "Done");
  assert.equal(firstStateIn(P, "Item", "InProgress"), "Doing");
});

test("tag look-alikes", () => {
  assert.equal(tagKey("Tech-Debt "), "techdebt");
  assert.equal(editDistanceUpTo1("performance", "perfomance"), 1);
  assert.equal(editDistanceUpTo1("abc", "abd"), 1);
  assert.equal(editDistanceUpTo1("abc", "xyz"), 2);
  assert.ok(tagsAlike("Tech debt", "tech-debt"));
  assert.ok(tagsAlike("Performance", "Perfomance"));
  assert.ok(tagsAlike("bug", "bugs"));
  assert.ok(tagsAlike("Story", "Stories"));
  assert.ok(!tagsAlike("api", "app"));
  assert.ok(!tagsAlike("Security", "Quick win"));
  assert.deepEqual(duplicateTagGroups(["Security", "security", "Perfomance", "Performance", "UI", "UX", "Quick win"]),
    [["Perfomance", "Performance"], ["security", "Security"]]);
});

test("replace a tag without doubles", () => {
  assert.deepEqual(replaceTag(["a", "Perf", "b"], "perf", "Performance"), ["a", "b", "Performance"]);
  assert.deepEqual(replaceTag(["Performance", "Perf"], "Perf", "performance"), ["Performance"]);
});

test("ofTeam: the team's areas (and below where it includes them); no areas means every item", async () => {
  const { ofTeam } = await import("../src/core/scope.ts");
  const ws = (areas: { path: string; includeChildren: boolean }[]) => ({ settings: { areas } });
  assert.ok(ofTeam(ws([{ path: "P\\A", includeChildren: true }]), { area: "P\\A\\x" }));
  assert.ok(!ofTeam(ws([{ path: "P\\A", includeChildren: false }]), { area: "P\\A\\x" }));
  assert.ok(!ofTeam(ws([{ path: "P\\A", includeChildren: true }]), { area: "P\\B" }));
  assert.ok(ofTeam(ws([]), { area: "P\\B" }));
});
