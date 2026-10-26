import { test } from "node:test";
import assert from "node:assert/strict";
import { REL } from "../src/api/api.ts";
import type { ProcessInfo, WorkItem } from "../src/api/types.ts";
import { childState, closableNow, closeCandidates, duplicateTagGroups, linkedChildren, runChecks, tagsAlike } from "../src/core/health.ts";
import type { ChildState } from "../src/core/health.ts";

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

test("could be closed: not suggested until its links are read, nor while a linked child that is not loaded may be open", () => {
  const run = (items: WorkItem[], outside?: Map<number, ChildState>) => runChecks({ items, process: P, staleDays: 14, iterations: [], today: Date.parse("2026-10-21T00:00:00Z"), outside })
    .filter((f) => f.checkId === "canClose").map((f) => f.itemId);
  const kid = item(2, "Story", "Done", { parent: 1 });
  // links not read yet: another team's child may be open
  assert.deepEqual(run([item(1, "Feature", "Doing"), kid]), []);
  assert.deepEqual(run([item(1, "Feature", "Doing", { relations: [link(REL.child, 2)] }), kid]), [1]);
  const two = item(1, "Feature", "Doing", { relations: [link(REL.child, 2), link(REL.child, 3)] });
  // #3 is not loaded (another team's area): not read, open, done, or removed
  assert.deepEqual(run([two, kid]), []);
  assert.deepEqual(run([two, kid], new Map([[3, "open"]])), []);
  assert.deepEqual(run([two, kid], new Map([[3, "done"]])), [1]);
  assert.deepEqual(run([two, kid], new Map([[3, "gone"]])), [1]);
});

test("closable now: every linked child read again is done or removed; one that could not be read counts as open", () => {
  const f = item(1, "Feature", "Doing", { relations: [link(REL.child, 2), link(REL.child, 3)] });
  const kids = (...list: WorkItem[]) => new Map(list.map((k) => [k.id, k]));
  assert.equal(closableNow(f, kids(item(2, "Story", "Done"), item(3, "Story", "Done"))), true);
  assert.equal(closableNow(f, kids(item(2, "Story", "Done"), item(3, "Story", "Doing"))), false);
  assert.equal(closableNow(f, kids(item(2, "Story", "Done"))), false, "#3 could not be read");
  assert.equal(closableNow(f, kids(item(2, "Story", "Done"), { ...item(3, "Story", "Done"), category: "Removed" })), true);
  assert.equal(closableNow(item(1, "Feature", "Doing", { relations: [] }), kids()), false, "no children at all");
  assert.equal(closableNow(item(1, "Feature", "Doing"), kids(item(2, "Story", "Done"))), false, "links not read");
  assert.equal(closableNow({ ...f, state: "Done", category: "Completed" }, kids(item(2, "Story", "Done"), item(3, "Story", "Done"))), false, "closed already");
  assert.deepEqual(closeCandidates([f, item(2, "Story", "Done", { parent: 1 }), item(4, "Feature", "Doing"), item(5, "Feature", "Doing"), item(6, "Story", "Doing", { parent: 5 })]).map((w) => w.id), [1]);
  assert.deepEqual(linkedChildren(f), [2, 3]);
  assert.equal(childState(undefined), "open");
});
