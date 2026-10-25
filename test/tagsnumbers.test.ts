import { test } from "node:test";
import assert from "node:assert/strict";
import { REL } from "../src/api/api.ts";
import type { ProcessInfo, WorkItem } from "../src/api/types.ts";
import { duplicateTagGroups, runChecks, tagsAlike } from "../src/core/health.ts";

test("tags that differ only in their numbers are not look-alikes", () => {
  assert.equal(tagsAlike("Q1-2026", "Q2-2026"), false);
  assert.equal(tagsAlike("sprint-12", "sprint-13"), false);
  assert.equal(tagsAlike("Release 1", "Release 2"), false);
  assert.equal(tagsAlike("phase-1", "phase-2"), false);
  assert.equal(tagsAlike("v1", "v10"), false);
  assert.deepEqual(duplicateTagGroups(["Q1-2026", "Q2-2026", "Q3-2026", "Q4-2026"]), []);
  // the same numbers still allow the usual look-alikes
  assert.equal(tagsAlike("Release 1", "release-1"), true);
  assert.equal(tagsAlike("Relase 1", "Release 1"), true);
  assert.equal(tagsAlike("Q1-2026", "q1 2026"), true);
});

test("short words are not grouped as singular and plural", () => {
  assert.equal(tagsAlike("io", "ios"), false);
  assert.equal(tagsAlike("ui", "uis"), false);
  assert.equal(tagsAlike("bug", "bugs"), true);
  assert.equal(tagsAlike("story", "stories"), true);
});

const S = [
  { name: "New", category: "Proposed" as const, color: "#888888" },
  { name: "Doing", category: "InProgress" as const, color: "#888888" },
  { name: "Done", category: "Completed" as const, color: "#888888" },
];
const P: ProcessInfo = {
  levels: [
    { id: "a", name: "Features", kind: "portfolio", rank: 0, types: ["Feature"], defaultType: "Feature" },
    { id: "b", name: "Stories", kind: "requirement", rank: 1, types: ["Story"], defaultType: "Story" },
  ],
  types: { Feature: { name: "Feature", color: "#000000", states: S }, Story: { name: "Story", color: "#000000", states: S } },
  fields: { order: "o", effort: "e", remaining: "r", activity: "", completed: "", original: "" },
  bugsBehavior: "off",
};
const cat = { New: "Proposed", Doing: "InProgress", Done: "Completed" } as const;
function item(id: number, type: string, state: "New" | "Doing" | "Done", extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id, rev: 1, type, title: `${type} ${id}`, state, category: cat[state], area: "P", iteration: "P", tags: [],
    created: "2026-10-01T00:00:00Z", changed: "2026-10-20T00:00:00Z", fields: {}, description: "<p>text text</p>", ...extra,
  };
}
const link = (rel: string, id: number) => ({ rel, url: `https://dev.azure.com/o/_apis/wit/workItems/${id}`, attributes: {} });

test("could be closed: not suggested while a linked child is not loaded", () => {
  const run = (items: WorkItem[]) => runChecks({ items, process: P, staleDays: 14, iterations: [], today: Date.parse("2026-10-21T00:00:00Z") })
    .filter((f) => f.checkId === "canClose").map((f) => f.itemId);
  const kid = item(2, "Story", "Done", { parent: 1 });
  assert.deepEqual(run([item(1, "Feature", "Doing"), kid]), [1]);
  assert.deepEqual(run([item(1, "Feature", "Doing", { relations: [link(REL.child, 2)] }), kid]), [1]);
  assert.deepEqual(run([item(1, "Feature", "Doing", { relations: [link(REL.child, 2), link(REL.child, 3)] }), kid]), []);
});
