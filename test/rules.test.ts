import { test } from "node:test";
import assert from "node:assert/strict";
import type { Facts, Rule } from "../src/core/rules.ts";
import { checkMove, missing, rulesForMove, suggestedRules } from "../src/core/rules.ts";

const facts = (p: Partial<Facts> = {}): Facts => ({
  kind: "requirement", description: "", acceptance: "", hasOwner: false, hasParent: false, hasEffort: false, inSprint: false,
  children: 0, openChildren: 0, openPrs: 0, openPredecessors: 0, tags: 0, me: "me@x.com", ...p,
});
const steps = ["New", "Ready", "Active", "Resolved", "Closed"];
const rule = (target: string, requires: Rule["requires"], onlyBy: string[] = []): Rule => ({ id: target, level: "requirement", target, requires, onlyBy });

test("only the target and the steps passed count, and moving back passes no rule", () => {
  const rules = [rule("Ready", ["description"]), rule("Active", ["owner"]), rule("Closed", ["childrenDone"])];
  assert.deepEqual(rulesForMove(rules, "requirement", steps, "New", "Active").map((r) => r.target), ["Ready", "Active"]);
  assert.deepEqual(rulesForMove(rules, "requirement", steps, "Active", "Ready"), []);
  assert.deepEqual(rulesForMove(rules, "task", steps, "New", "Active"), []);
});

test("missing lists what is not there", () => {
  const r = rule("Active", ["description", "owner", "childrenDone", "prsMerged"]);
  assert.deepEqual(missing(r, facts({ description: "x".repeat(25), openChildren: 2, openPrs: 1 })), ["Owner", "Children done (2 open)", "Pull requests merged (1 open)"]);
  assert.deepEqual(missing(r, facts({ description: "x".repeat(25), hasOwner: true })), []);
});

test("only these people may", () => {
  const r = rule("Closed", [], ["boss@x.com"]);
  assert.equal(checkMove([r], facts(), steps, "Resolved", "Closed").ok, false);
  assert.equal(checkMove([r], facts({ me: "BOSS@x.com" }), steps, "Resolved", "Closed").ok, true);
});

test("suggested rules follow the categories", () => {
  const s = suggestedRules([{ name: "New", category: "Proposed" }, { name: "Doing", category: "InProgress" }, { name: "Done", category: "Completed" }]);
  assert.deepEqual(s.map((r) => r.target), ["Doing", "Done"]);
});

test("a rule from one state to another names the fields it needs", () => {
  const r: Rule = { id: "x", level: "requirement", target: "Resolved", from: "Active", requires: [], onlyBy: [], fields: ["Custom.Release", "System.Description"] };
  assert.deepEqual(rulesForMove([r], "requirement", steps, "Active", "Resolved").length, 1);
  assert.deepEqual(rulesForMove([r], "requirement", steps, "Ready", "Resolved"), [], "another start state is not guarded");
  const back: Rule = { ...r, from: "Closed", target: "Active" };
  assert.equal(rulesForMove([back], "requirement", steps, "Closed", "Active").length, 1, "a move back can be guarded too");
  const f = facts({ values: { "Custom.Release": "", "System.Description": "<div> </div>" }, fieldNames: { "Custom.Release": "Release" } });
  assert.deepEqual(missing(r, f), ["Release", "Description"]);
  assert.deepEqual(missing(r, facts({ values: { "Custom.Release": "2026.4", "System.Description": "<p>ok</p>" } })), []);
});

test("inheritance: a rule holds in its column and those to its right, a forward move needs what holds in the target, and a rule can break the chain", async () => {
  const { inheritedRules, missingParts } = await import("../src/core/rules.ts");
  const steps = ["New", "Ready", "Doing", "Review", "Done"];
  const r = (id: string, target: string, requires: string[], extra: object = {}): Rule => ({ id, level: "requirement", target, requires: requires as never[], onlyBy: [], ...extra });
  const rules = [r("a", "Ready", ["description"]), r("b", "Review", ["hasChildren"])];
  const where = (x: Rule): number => steps.indexOf(x.target);
  assert.deepEqual(inheritedRules(rules, "requirement", 2, where).map((x) => x.id), ["a"]);
  assert.deepEqual(inheritedRules(rules, "requirement", 3, where).map((x) => x.id), ["a", "b"]);
  // a rule that starts fresh at Review: Ready's rule no longer holds there
  const broken = [r("a", "Ready", ["description"]), r("b", "Review", ["hasChildren"], { breaks: true })];
  assert.deepEqual(inheritedRules(broken, "requirement", 2, where).map((x) => x.id), ["a"]);
  assert.deepEqual(inheritedRules(broken, "requirement", 3, where).map((x) => x.id), ["b"]);
  assert.deepEqual(inheritedRules(broken, "requirement", 4, where).map((x) => x.id), ["b"]);
  // moving from Ready to Doing with no description: Doing has no rule of its own, but Ready's holds in Doing
  const facts: Facts = { kind: "requirement", description: "", acceptance: "", hasOwner: true, hasParent: true, hasEffort: true, inSprint: true, children: 0, openChildren: 0, openPrs: 0, openPredecessors: 0, tags: 0, me: "me@x.example" };
  const c = checkMove(rules, facts, steps, "Ready", "Doing");
  assert.equal(c.ok, false);
  assert.deepEqual(c.problems.map((p) => [p.rule.id, p.missing]), [["a", ["Description"]]]);
  assert.equal(checkMove(rules, facts, steps, "Doing", "Ready").ok, true); // back: no rule
  // the parts say what each thing is, for the fix form
  assert.deepEqual(missingParts(rules[1], facts).map((p) => [p.label, p.req]), [["Tasks present", "hasChildren"]]);
});
