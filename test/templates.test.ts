import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTemplates, missingChildren, titleKey } from "../src/core/templates.ts";

test("only the standard children that are not there yet are added", () => {
  const template = [{ title: "Write tests", activity: "Testing", remaining: 4 }, { title: "Update documentation" }, { title: "Code review" }];
  assert.deepEqual(missingChildren(template, ["write  TESTS", "Something else"]).map((t) => t.title), ["Update documentation", "Code review"]);
  assert.deepEqual(missingChildren(template, ["Write tests", "Update documentation", " code review "]), []);
  assert.deepEqual(missingChildren(template, []).map((t) => t.title), ["Write tests", "Update documentation", "Code review"]);
  assert.deepEqual(missingChildren(undefined, []), []);
});

test("templates are cleaned: no empty or repeated titles, sane hours", () => {
  assert.deepEqual(cleanTemplates([
    { title: "  Write   tests ", type: " Task ", activity: " Testing ", remaining: 4 },
    { title: "" },
    { title: "write tests" },
    { title: "Review", activity: "  ", remaining: -1 },
    { title: "Deploy", remaining: 1.234 },
  ]), [
    { title: "Write tests", type: "Task", activity: "Testing", remaining: 4 },
    { title: "Review" },
    { title: "Deploy", remaining: 1.23 },
  ]);
  assert.equal(titleKey("  A  b "), "a b");
});
