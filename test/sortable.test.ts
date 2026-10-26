import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, dateValue } from "../src/ui/sortable.ts";

test("dates without a year sort across New Year by the year nearest to today", () => {
  const now = new Date(2027, 0, 10).getTime();
  assert.ok(compare("28 Dec", "3 Jan", now) < 0, "28 Dec 2026 is before 3 Jan 2027");
  assert.ok(compare("Dec 28", "Jan 3", now) < 0);
  assert.equal(new Date(dateValue("28 Dec", now)).getFullYear(), 2026);
  // with a year the year decides
  assert.ok(compare("28 Dec 2027", "3 Jan 2027", now) > 0);
  assert.ok(compare("2026-12-28", "2027-01-03", now) < 0);
  // numbers and words as before
  assert.ok(compare("9", "10", now) < 0);
  assert.ok(compare("apple", "Banana", now) < 0);
});
