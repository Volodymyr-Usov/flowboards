import { test } from "node:test";
import assert from "node:assert/strict";
import { dropEmptyColumns, headerText, MAX_CELL, safeName, toCell, tsv, xlsx, xlsxFiles } from "../src/ui/xlsx.ts";

test("sheets: header bold, numbers as numbers, text escaped, names made safe", () => {
  const files = xlsxFiles([{ name: "Done / Not done?", rows: [["Id", "Title"], [7, "a < b & \"c\""]] }, { name: "Done / Not done?", rows: [["x"]] }]);
  const book = files.find((f) => f.name === "xl/workbook.xml")!.data;
  assert.match(book, /name="Done   Not done"/);
  assert.match(book, /name="Done   Not done 2"/);
  const sheet = files.find((f) => f.name === "xl/worksheets/sheet1.xml")!.data;
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1">/);
  assert.match(sheet, /<c r="A2"><v>7<\/v><\/c>/);
  assert.match(sheet, /a &lt; b &amp; &quot;c&quot;/);
});

test("the zip holds every file unchanged", () => {
  const bytes = xlsx([{ name: "S", rows: [["a"]] }]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  assert.equal(view.getUint32(0, true), 0x04034b50);
  // walk the local headers (files are stored, not compressed) and read each name
  const names: string[] = [];
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    names.push(text.decode(bytes.subarray(at + 30, at + 30 + nameLen)));
    at += 30 + nameLen + size;
  }
  assert.deepEqual(names, ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
  assert.equal(tsv([["a\tb", 1], [null, "x"]]), "\"a\tb\"\t1\n\tx");
});

test("cell values: plain numbers become numbers, codes and long ids stay text", () => {
  assert.equal(toCell(" 42 "), 42);
  assert.equal(toCell("-3.5"), -3.5);
  assert.equal(toCell("1,234"), 1234);
  assert.equal(toCell("0.5"), 0.5);
  assert.equal(toCell("007"), "007");
  assert.equal(toCell("12,34"), "12,34");
  assert.equal(toCell("1234567890123456789"), "1234567890123456789");
  assert.equal(toCell("feature/269 → main"), "feature/269 → main");
  assert.equal(headerText("Stories closed ↑"), "Stories closed");
  assert.equal(headerText(" Age ▼ "), "Age");
  const sheet = xlsxFiles([{ name: "S", rows: [["a"], ["x → y"]] }]).find((f) => f.name === "xl/worksheets/sheet1.xml")!.data;
  assert.match(sheet, /x → y/);
});

test("columns with no header and no value are left out", () => {
  assert.deepEqual(dropEmptyColumns([["Tag", "", "Count"], ["a", "", 3], ["b", null, ""]]), [["Tag", "Count"], ["a", 3], ["b", ""]]);
  assert.deepEqual(dropEmptyColumns([["A", "B"], [1, 2]]), [["A", "B"], [1, 2]]);
});

test("sheet names Excel would refuse are made safe", () => {
  const used = new Set<string>();
  assert.equal(safeName("'Quoted'", used), "Quoted");
  assert.equal(safeName("' '", used), "Sheet");
  assert.equal(safeName("::", used), "Sheet 2");
  assert.equal(safeName("History", used), "History 2");
  assert.equal(safeName("history", used), "history 3");
  // cut to 31 characters, the apostrophe left at the end goes too
  assert.equal(safeName("A".repeat(30) + "'x", new Set()), "A".repeat(30));
  const long = new Set<string>();
  const names = Array.from({ length: 12 }, () => safeName("B".repeat(40), long));
  for (const n of names) assert.ok(n.length <= 31 && !/^'|'$/.test(n), n);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 12);
  assert.equal(safeName("x￾￿\u0001y", new Set()), "xy");
});

test("cells: long text is cut to Excel's limit, characters XML forbids are dropped", () => {
  const sheet = (v: string) => xlsxFiles([{ name: "S", rows: [["h"], [v]] }]).find((f) => f.name === "xl/worksheets/sheet1.xml")!.data;
  const text = /<c r="A2" t="inlineStr"><is><t xml:space="preserve">([^<]*)<\/t>/.exec(sheet("x".repeat(40000)))![1];
  assert.equal(text.length, MAX_CELL);
  assert.ok(text.endsWith("…"));
  assert.ok(sheet("x".repeat(MAX_CELL)).includes("x".repeat(MAX_CELL) + "<"));
  assert.match(sheet("a￾b￿c\u0002d"), /abcd/);
});

test("copy: formulas are neutralised, numbers kept, quotes and line breaks quoted", () => {
  assert.equal(tsv([["=1+1", "+cmd", "-x", "@SUM(A1)", "- y", "-"]]), "'=1+1\t'+cmd\t'-x\t'@SUM(A1)\t'- y\t'-");
  assert.equal(tsv([["-3", "-0.5", "+2", "-1,234", -7, ".5"]]), "-3\t-0.5\t+2\t-1,234\t-7\t.5");
  assert.equal(tsv([["say \"hi\"", "two\nlines", "plain"]]), "\"say \"\"hi\"\"\"\t\"two\nlines\"\tplain");
  assert.equal(tsv([["=A1\tB"]]), "\"'=A1\tB\"");
});
