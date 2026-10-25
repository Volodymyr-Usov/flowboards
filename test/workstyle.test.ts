import { test } from "node:test";
import assert from "node:assert/strict";
import type { Iteration, WorkItem } from "../src/api/types.ts";
import { defaultLayout, detectStyle, resolveStyle, tabOrder } from "../src/core/workstyle.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const sprint = (name: string, start: string, finish: string): Iteration => ({ id: name, name, path: `P\\${name}`, start, finish });
const sprints = [sprint("S1", "2026-10-05", "2026-10-16"), sprint("S2", "2026-10-19", "2026-10-30")];
const story = (iteration: string): WorkItem => ({ id: 1, rev: 1, type: "User Story", title: "T", state: "Active", category: "InProgress", area: "", iteration, tags: [], created: "", changed: "", fields: {} });

test("working style: the guess", () => {
  assert.equal(detectStyle({ iterations: [], backlogPath: "P", open: [story("P")], now: NOW }).style, "kanban");
  assert.equal(detectStyle({ iterations: [sprint("Old", "2025-01-01", "2025-01-14")], backlogPath: "P", open: [], now: NOW }).style, "kanban");
  const inSprint = [story("P\\S2"), story("P\\S2"), story("P\\S2"), story("P")];
  assert.equal(detectStyle({ iterations: sprints, backlogPath: "P", open: inSprint, now: NOW }).style, "scrum");
  assert.equal(detectStyle({ iterations: sprints, backlogPath: "P", open: [story("P\\S2"), story("P"), story("P")], now: NOW }).style, "scrumban");
  assert.equal(detectStyle({ iterations: sprints, backlogPath: "P", open: [story("P"), story("P"), story("P"), story("P"), story("P\\S2"), story("P"), story("P")], now: NOW }).style, "kanban");
  assert.equal(detectStyle({ iterations: sprints, backlogPath: "P", open: [], now: NOW }).style, "scrum");
});

test("working style: which one applies, layout and tab order", () => {
  const team = { id: "style", style: "kanban" as const, by: "a", byName: "A", at: "" };
  assert.deepEqual(resolveStyle("scrum", team, "scrumban"), { style: "scrum", source: "mine" });
  assert.deepEqual(resolveStyle(undefined, team, "scrumban"), { style: "kanban", source: "team" });
  assert.deepEqual(resolveStyle("nonsense", null, "scrumban"), { style: "scrumban", source: "detected" });
  assert.equal(defaultLayout("scrum"), "taskboard");
  assert.equal(defaultLayout("scrumban"), "columns");
  const ids = ["board", "tree", "roadmap", "sprint", "retro", "poker", "flow", "prs", "log"];
  assert.deepEqual(tabOrder("kanban", ids), ["board", "flow", "tree", "prs", "roadmap", "sprint", "retro", "poker", "log"]);
  assert.deepEqual(tabOrder("scrum", ids).slice(0, 6), ["board", "sprint", "tree", "poker", "retro", "flow"]);
  assert.equal(tabOrder("scrumban", ids).length, ids.length);
});
