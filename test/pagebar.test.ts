import { test } from "node:test";
import assert from "node:assert/strict";
import { startMode } from "../src/ui/pagebar.ts";
import { copyRowsOf, pageSheets } from "../src/ui/tableexport.ts";

test("the field starts on the saved side, and on Ask AI where there is nothing to search", () => {
  assert.equal(startMode("search", true), "search");
  assert.equal(startMode("ask", true), "ask");
  assert.equal(startMode(undefined, true), "search");
  assert.equal(startMode("nonsense", true), "search");
  assert.equal(startMode("search", false), "ask");
});

test("each table with rows becomes a sheet named after its heading", () => {
  const sheets = pageSheets("Flow", [
    { heading: "Throughput", rows: [["Week", "Done"], ["1", 3]] },
    { heading: "", rows: [["A"], ["x"]] },
    { heading: "Empty", rows: [["Only a header"]] },
    { heading: "Flow", rows: [["B"], ["y"]] },
    { heading: "  Throughput ", rows: [["C"], ["z"]] },
    { heading: "A heading much too long to be the name of a sheet in Excel", rows: [["D"], ["w"]] },
  ]);
  assert.deepEqual(sheets.map((s) => s.name), ["Throughput", "Flow", "Flow 2", "Throughput 2", "Flow 3"]);
  assert.deepEqual(sheets[0].rows, [["Week", "Done"], ["1", 3]]);
});

test("Copy: one table as it is; several one after another with their names", () => {
  const one = [{ name: "Board", rows: [["Id"], [1]] }];
  assert.deepEqual(copyRowsOf(one), [["Id"], [1]]);
  const two = [{ name: "A", rows: [["x"], [1]] }, { name: "B", rows: [["y"], [2]] }];
  assert.deepEqual(copyRowsOf(two), [["A"], ["x"], [1], [], ["B"], ["y"], [2]]);
  assert.deepEqual(copyRowsOf([]), []);
});
