import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProcessInfo, StateInfo } from "../src/api/types.ts";
import { railNeighbours } from "../src/views/boardmodel.ts";
import { dropState } from "../src/views/taskboard.ts";
import { orderedStates } from "../src/core/model.ts";

const st = (name: string, category: StateInfo["category"]): StateInfo => ({ name, category, color: "#000000" });
// Scrum with bugs managed with tasks: a Task and a Bug share the task level but not their state names
const SCRUM: ProcessInfo = {
  levels: [{ name: "Tasks", rank: 3, kind: "task", types: ["Task", "Bug"], defaultType: "Task" }] as ProcessInfo["levels"],
  types: {
    Task: { name: "Task", color: "#000000", states: [st("To Do", "Proposed"), st("In Progress", "InProgress"), st("Done", "Completed"), st("Removed", "Removed")] },
    Bug: { name: "Bug", color: "#000000", states: [st("New", "Proposed"), st("Approved", "Proposed"), st("Committed", "InProgress"), st("Done", "Completed"), st("Removed", "Removed")] },
  },
  fields: { order: "o", effort: "e", remaining: "r", activity: "", completed: "", original: "" },
  bugsBehavior: "asTasks",
};

test("taskboard: a task dropped in another type's column takes its own state of that kind", () => {
  const cols = orderedStates(SCRUM, ["Task", "Bug"]);
  const col = (name: string) => cols.find((c) => c.name === name)!;
  assert.deepEqual(cols.map((c) => c.name), ["To Do", "New", "Approved", "In Progress", "Committed", "Done"]);
  assert.equal(dropState(SCRUM, "Task", col("In Progress")), "In Progress", "its own column: as it is");
  assert.equal(dropState(SCRUM, "Task", col("Committed")), "In Progress", "a Bug's column: the Task's state of that kind");
  assert.equal(dropState(SCRUM, "Task", col("Approved")), "To Do");
  assert.equal(dropState(SCRUM, "Bug", col("To Do")), "New");
  assert.equal(dropState(SCRUM, "Bug", col("In Progress")), "Committed");
  assert.equal(dropState(SCRUM, "Bug", col("Done")), "Done");
  // a kind of state the type does not have (an Agile Task has no Resolved): no state, so nothing is sent
  assert.equal(dropState(SCRUM, "Task", { name: "Resolved", category: "Resolved" }), null);
});

test("left list: a Feature dropped next to another takes its neighbours from the backlog order, not the screen", () => {
  // backlog order F1, F3, F2, F4; on screen Epic A's box holds F1, F2 and Epic B's box F3, F4
  const order = [1, 3, 2, 4];
  // F4 dropped above F3: just before F3 in the backlog, so after F1 (on screen F2 is drawn above F3)
  assert.deepEqual(railNeighbours(order, 4, 3, true), { prev: 1, next: 3 });
  // F1 dropped below F2: just after F2
  assert.deepEqual(railNeighbours(order, 1, 2, false), { prev: 2, next: 4 });
  // the ends
  assert.deepEqual(railNeighbours(order, 4, 1, true), { prev: 0, next: 1 });
  assert.deepEqual(railNeighbours(order, 1, 4, false), { prev: 4, next: 0 });
  // a target that is not loaded: only that side is known
  assert.deepEqual(railNeighbours(order, 4, 9, true), { prev: 0, next: 9 });
});
