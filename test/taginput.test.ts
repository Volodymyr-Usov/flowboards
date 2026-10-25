import { test } from "node:test";
import assert from "node:assert/strict";
import { addTags, matchTags, splitTags, usedTags } from "../src/ui/taginput.ts";
import { sprintChoices } from "../src/ui/create.ts";

test("tags typed in one go: split on ; and , trimmed, empty ones dropped", () => {
  assert.deepEqual(splitTags(" a; b ,c;; "), ["a", "b", "c"]);
  assert.deepEqual(splitTags("two  words"), ["two words"]);
  assert.deepEqual(splitTags(""), []);
});

test("adding a tag that is there already (any case) changes nothing", () => {
  assert.deepEqual(addTags(["Web"], ["web", "api"]), ["Web", "api"]);
  assert.deepEqual(addTags([], ["a", "A"]), ["a"]);
});

test("used tags: the most used first, one spelling each", () => {
  const items = [{ tags: ["web", "api"] }, { tags: ["Web"] }, { tags: ["mobile", "web"] }];
  assert.deepEqual(usedTags(items), ["web", "api", "mobile"]);
});

test("suggestions: starting with the text first, then containing it, never one already chosen", () => {
  const known = ["frontend", "backend", "front-office", "api"];
  assert.deepEqual(matchTags(known, "fro", []), ["frontend", "front-office"]);
  assert.deepEqual(matchTags(known, "end", []), ["frontend", "backend"]);
  assert.deepEqual(matchTags(known, "FRO", ["Frontend"]), ["front-office"]);
  assert.deepEqual(matchTags(known, "", ["api"], 2), ["frontend", "backend"]);
});

test("the panel's sprint list: backlog first, then current and coming, ended ones last and marked", () => {
  const iters = [
    { id: "1", name: "S1", path: "P\\S1", timeFrame: "past" as const },
    { id: "2", name: "S2", path: "P\\S2", timeFrame: "past" as const },
    { id: "3", name: "S3", path: "P\\S3", timeFrame: "current" as const },
    { id: "4", name: "S4", path: "P\\S4", timeFrame: "future" as const },
  ];
  const list = sprintChoices("P", iters, "P\\S1", { ended: true });
  assert.deepEqual(list.map((c) => c.path), ["P", "P\\S3", "P\\S4", "P\\S2", "P\\S1"]);
  assert.deepEqual(list.map((c) => c.label), ["P (backlog)", "S3 (current)", "S4", "S2 (ended)", "S1 (ended)"]);
  // an item in a path that is not a sprint of the team keeps it
  assert.equal(sprintChoices("P", iters, "Other\\X", { ended: true }).at(-1)?.path, "Other\\X");
});
