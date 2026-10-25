import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBoardAnswer, checkDrafts, checkTasks } from "../src/ui/aihelp.ts";

test("AI answers without the expected fields give a clear message, not a TypeError", () => {
  for (const bad of [null, "text", [], {}, { answer: 3 }, { items: [] }]) assert.throws(() => checkBoardAnswer(bad), /not in the expected form/);
  assert.throws(() => checkDrafts({ description: "x" }), /not in the expected form/);
  assert.throws(() => checkTasks({ tasks: "a, b" }), /not in the expected form/);
  assert.throws(() => checkTasks(null), /not in the expected form/);
});

test("AI answers: missing lists become empty, odd entries are left out", () => {
  assert.deepEqual(checkBoardAnswer({ answer: "ok" }), { answer: "ok", items: [], proposals: [] });
  const r = checkBoardAnswer({
    answer: "a", items: [5, "#7", "x", -1, 2.5],
    proposals: [
      { id: 5, change: "state", value: "Done", why: "finished" },
      { id: "#6", change: "parent", value: 12 },
      { id: 7, change: "delete", value: "x", why: "" },
      { change: "owner", value: "a@b" },
      "junk",
    ],
  });
  assert.deepEqual(r.items, [5, 7]);
  assert.deepEqual(r.proposals, [
    { id: 5, change: "state", value: "Done", why: "finished" },
    { id: 6, change: "parent", value: "12", why: "" },
  ]);
  assert.deepEqual(checkTasks({ tasks: [{ title: " Write tests ", hours: "3" }, { title: "", hours: 1 }, { hours: 2 }, { title: "Review", hours: -1 }] }),
    [{ title: "Write tests", hours: 3 }, { title: "Review", hours: 0 }]);
  assert.deepEqual(checkDrafts({ description: "d", acceptance: "a", extra: 1 }), { description: "d", acceptance: "a" });
});
