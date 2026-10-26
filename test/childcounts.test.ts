import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProcessInfo, QuerySpec, WorkItem } from "../src/api/types.ts";
import type { Workspace } from "../src/core/workspace.ts";
import { ChildCounts, descendantsOf, outsideCounts } from "../src/views/childcounts.ts";
import type { Found } from "../src/views/childcounts.ts";

const f = (id: number, parent: number, kind: Found["kind"], done = false, removed = false): Found => ({ id, parent, kind, done, removed });

test("descendantsOf: requirement items under a portfolio item (through lower portfolio items), tasks under a story", () => {
  const found = [
    f(10, 1, "portfolio"), f(11, 10, "requirement", true), f(12, 10, "requirement"), f(13, 10, "requirement", true, true),
    f(14, 1, "requirement", true), f(20, 11, "task", true), f(21, 11, "task"), f(22, 11, "task", false, true),
  ];
  const d = descendantsOf([{ id: 1, kind: "portfolio" }, { id: 11, kind: "requirement" }, { id: 99, kind: "portfolio" }], found);
  assert.deepEqual([...d.get(1)!].sort(), [[11, true], [12, false], [14, true]], "removed ones do not count; tasks are not counted for an Epic");
  assert.deepEqual([...d.get(11)!].sort(), [[20, true], [21, false]]);
  assert.deepEqual([...d.get(99)!], []);
});

test("outsideCounts counts only the children that are not loaded", () => {
  const kids = new Map([[1, true], [2, false], [3, true]]);
  assert.deepEqual(outsideCounts(kids, (id) => id === 1), { done: 1, total: 2 });
  assert.deepEqual(outsideCounts(undefined, () => false), { done: 0, total: 0 });
});

const S = [{ name: "New", category: "Proposed" as const, color: "#888888" }, { name: "Done", category: "Completed" as const, color: "#888888" }];
const P: ProcessInfo = {
  levels: [
    { id: "a", name: "Features", kind: "portfolio", rank: 0, types: ["Feature"], defaultType: "Feature" },
    { id: "b", name: "Stories", kind: "requirement", rank: 1, types: ["Story"], defaultType: "Story" },
    { id: "c", name: "Tasks", kind: "task", rank: 2, types: ["Task"], defaultType: "Task" },
  ],
  types: { Feature: { name: "Feature", color: "#000000", states: S }, Story: { name: "Story", color: "#000000", states: S }, Task: { name: "Task", color: "#000000", states: S } },
  fields: { order: "o", effort: "e", remaining: "r", activity: "", completed: "", original: "" },
  bugsBehavior: "off",
};
const item = (id: number, type: string, done: boolean, parent?: number): WorkItem => ({
  id, rev: 1, type, title: `${type} ${id}`, state: done ? "Done" : "New", category: done ? "Completed" : "Proposed", area: "P", iteration: "P", tags: [],
  created: "", changed: "", fields: {}, parent,
});

test("ChildCounts reads the children a Feature has beyond the loaded ones, by parent, and keeps them", async () => {
  // the server: Feature 1 has stories 2 (loaded, open), 3 and 4 (closed long ago, not loaded), 5 (another team's, open)
  const server = new Map<number, WorkItem>([2, 3, 4, 5].map((id) => [id, item(id, "Story", id === 3 || id === 4, 1)]));
  const loaded = new Map<number, WorkItem>([[1, item(1, "Feature", false)], [2, server.get(2)!]]);
  const queries: QuerySpec[] = [];
  const reads: number[][] = [];
  const ws = {
    project: "P", process: P, items: loaded,
    get: (id: number) => loaded.get(id),
    ancestors: () => [],
    api: {
      query: async (_p: string, spec: QuerySpec) => { queries.push(spec); return [...server.values()].filter((w) => spec.parents!.includes(w.parent!)).map((w) => w.id); },
      items: async (_p: string, ids: number[]) => { reads.push(ids); return ids.map((id) => server.get(id)!); },
    },
  } as unknown as Workspace;
  let told = 0;
  let tell = (): void => {};
  const cc = new ChildCounts(ws, () => { told++; tell(); });
  await new Promise<void>((resolve) => { tell = resolve; cc.want([1]); });
  assert.equal(told, 1);
  assert.deepEqual(cc.extra(1), { done: 2, total: 3 }, "2 is loaded and counted by the page itself");
  assert.deepEqual(reads, [[3, 4, 5]], "only the children that are not loaded are read");
  assert.deepEqual(queries.map((q) => q.parents), [[1]], "stories only lead no further down");
  // asked again: kept, no new query
  cc.want([1]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(queries.length, 1);
  // a change of the Feature: read again when asked
  cc.changed([1]);
  assert.deepEqual(cc.extra(1), { done: 0, total: 0 });
  cc.stop();
});
