import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rule } from "../src/core/rules.ts";
import { checkRules, placeRules, ruleProblem } from "../src/views/ruleeditor.ts";

test("a rule's problem names the field to mark", () => {
  const rule = (x: Partial<Rule>): Rule => ({ id: "r1", level: "requirement", target: "Active", requires: ["owner"], onlyBy: [], ...x });
  assert.equal(ruleProblem([rule({})]), null);
  assert.deepEqual(ruleProblem([rule({}), rule({ id: "r2", target: "" })]), { message: "Rule 2: pick the state or column it guards.", key: "rule:r2:target" });
  assert.equal(ruleProblem([rule({ requires: [] })])?.key, "rule:r1:needs");
  assert.equal(ruleProblem([rule({ from: "Active" })])?.key, "rule:r1:from");
  assert.equal(checkRules([rule({ requires: [] })]), "Rule 1: tick what it needs, add a field, or add a person.");
});

test("column rules keep their places in the project's list", () => {
  const all = ["a", "X1", "b", "X2", "c"];
  const was = ["X1", "X2"];
  assert.deepEqual(placeRules(all, was, ["X1", "X2"]), all, "nothing changed: same order");
  assert.deepEqual(placeRules(all, was, ["X2", "X1"]), ["a", "X2", "b", "X1", "c"], "swapped inside the column");
  assert.deepEqual(placeRules(all, was, ["X1", "X2", "X3"]), ["a", "X1", "b", "X2", "X3", "c"], "a new rule goes after the column's last");
  assert.deepEqual(placeRules(all, was, ["X2"]), ["a", "X2", "b", "c"], "a removed rule leaves no gap");
  assert.deepEqual(placeRules(all, was, []), ["a", "b", "c"]);
  assert.deepEqual(placeRules(["a", "b"], [], ["X1"]), ["a", "b", "X1"], "a column with no rules adds at the end");
});
