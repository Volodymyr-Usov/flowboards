import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProcessInfo, WorkItem } from "../src/api/types.ts";
import { BUSINESS_VALUE, byScore, TIME_CRITICALITY, wsjfScore, wsjfSetup } from "../src/core/wsjf.ts";

const S = [{ name: "New", category: "Proposed" as const, color: "#888888" }];
const RR = "Microsoft.VSTS.Common.RiskReduction";
const EFFORT = "Microsoft.VSTS.Scheduling.Effort";
const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
function proc(types: Record<string, string[] | undefined>, effort = SP): ProcessInfo {
  return {
    levels: [
      { id: "f", name: "Features", kind: "portfolio", rank: 0, types: ["Feature"], defaultType: "Feature" },
      { id: "s", name: "Stories", kind: "requirement", rank: 1, types: ["Story"], defaultType: "Story" },
      { id: "t", name: "Tasks", kind: "task", rank: 2, types: ["Task"], defaultType: "Task" },
    ],
    types: Object.fromEntries(Object.entries(types).map(([name, fields]) => [name, { name, color: "#000000", states: S, fields }])),
    fields: { order: "o", effort, remaining: "r", activity: "", completed: "", original: "" },
    bugsBehavior: "off",
  };
}
const item = (id: number, type: string, fields: Record<string, unknown>): WorkItem => ({
  id, rev: 1, type, title: `#${id}`, state: "New", category: "Proposed", area: "A", iteration: "I", tags: [], created: "", changed: "", fields,
});

test("the setup finds the fields each type has; types without them get no score", () => {
  const p = proc({ Feature: [BUSINESS_VALUE, TIME_CRITICALITY, RR, EFFORT], Story: [SP], Task: [BUSINESS_VALUE, EFFORT] });
  const s = wsjfSetup(p);
  assert.deepEqual([...s.types.keys()], ["Feature"]); // stories have no value fields, tasks never count
  assert.equal(s.types.get("Feature")!.size.field, EFFORT); // the process's effort field is not on Features
  assert.deepEqual(new Set(s.fields), new Set([BUSINESS_VALUE, TIME_CRITICALITY, RR, EFFORT]));
});

test("a process with none of the fields has no score at all", () => {
  const s = wsjfSetup(proc({ Feature: [EFFORT], Story: [SP], Task: [] }));
  assert.equal(s.types.size, 0);
  assert.deepEqual(s.fields, []);
});

test("score = (value + time + risk) / size, rounded to one decimal", () => {
  const s = wsjfSetup(proc({ Feature: [BUSINESS_VALUE, TIME_CRITICALITY, RR, EFFORT], Story: [SP] }));
  const r = wsjfScore(item(1, "Feature", { [BUSINESS_VALUE]: 8, [TIME_CRITICALITY]: 5, [RR]: 3, [EFFORT]: 3 }), s);
  assert.equal(r.score, 5.3);
  assert.deepEqual(r.missing, []);
  // pick lists like "3 - Medium" count by their number
  assert.equal(wsjfScore(item(2, "Feature", { [BUSINESS_VALUE]: "3 - Medium", [TIME_CRITICALITY]: 1, [RR]: 0, [EFFORT]: 2 }), s).score, 2);
});

test("missing parts give no score and say which; a size of 0 is missing too", () => {
  const s = wsjfSetup(proc({ Feature: [BUSINESS_VALUE, TIME_CRITICALITY, RR, EFFORT], Story: [SP] }));
  const r = wsjfScore(item(1, "Feature", { [BUSINESS_VALUE]: 8, [EFFORT]: 0 }), s);
  assert.equal(r.score, undefined);
  assert.ok(r.applies);
  assert.deepEqual(r.missing, ["Time criticality", "Risk reduction", "Size above 0"]);
  assert.equal(wsjfScore(item(2, "Story", { [SP]: 3 }), s).applies, false);
});

test("value parts the type does not have are left out of its formula", () => {
  const s = wsjfSetup(proc({ Feature: [BUSINESS_VALUE, TIME_CRITICALITY, EFFORT], Story: [SP] }));
  assert.equal(wsjfScore(item(1, "Feature", { [BUSINESS_VALUE]: 6, [TIME_CRITICALITY]: 2, [EFFORT]: 4 }), s).score, 2);
});

test("display names of the process are used in the words", () => {
  const p = proc({ Feature: [BUSINESS_VALUE, EFFORT], Story: [SP] });
  p.types.Feature.fieldNames = { [BUSINESS_VALUE]: "Business Value", [EFFORT]: "Effort" };
  const r = wsjfScore(item(1, "Feature", {}), wsjfSetup(p));
  assert.deepEqual(r.missing, ["Business value", "Effort"]);
});

test("sorting: highest first, no score last, ties keep their order", () => {
  const sc: Record<number, number | undefined> = { 1: 2, 2: undefined, 3: 5, 4: 2, 5: undefined };
  const list = [1, 2, 3, 4, 5].map((id) => item(id, "Feature", {}));
  const sorted = list.slice().sort(byScore((w) => sc[w.id]));
  assert.deepEqual(sorted.map((w) => w.id), [3, 1, 4, 2, 5]);
});
