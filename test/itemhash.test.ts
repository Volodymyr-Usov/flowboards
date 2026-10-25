import { test } from "node:test";
import assert from "node:assert/strict";
import { hashWithItem, itemInHash } from "../src/app/app.ts";

test("the open item is read from the address", () => {
  assert.equal(itemInHash("#board?item=12"), 12);
  assert.equal(itemInHash("#settings?tab=rules&item=7"), 7);
  assert.equal(itemInHash("#board"), null);
  assert.equal(itemInHash(""), null);
  assert.equal(itemInHash("#board?item=x"), null);
  assert.equal(itemInHash("#board?item=-3"), null);
});

test("the open item goes into the address and out again; the view's own choices stay", () => {
  assert.equal(hashWithItem("#board", 12), "#board?item=12");
  assert.equal(hashWithItem("#settings?tab=rules", 7), "#settings?tab=rules&item=7");
  assert.equal(hashWithItem("#settings?tab=rules&item=7", 9), "#settings?tab=rules&item=9");
  assert.equal(hashWithItem("#settings?tab=rules&item=7", null), "#settings?tab=rules");
  assert.equal(hashWithItem("#board?item=3", null), "#board");
});
