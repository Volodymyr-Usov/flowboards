// The cleaner keeps a safe part of the text's formatting (so a small edit saved back keeps it) and
// still takes out everything that could run or load something.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanStyle, keptAttrs, tagAction } from "../src/ui/sanitize.ts";

test("styles: colours, bold, italic, underline and alignment stay", () => {
  assert.equal(cleanStyle("color: rgb(255, 0, 0); font-weight: bold; font-style: italic", "span"), "color: rgb(255, 0, 0); font-weight: bold; font-style: italic");
  assert.equal(cleanStyle("BACKGROUND-COLOR:#FFEE00;text-decoration:underline line-through", "span"), "background-color: #FFEE00; text-decoration: underline line-through");
  assert.equal(cleanStyle("text-align: center", "div"), "text-align: center");
  assert.equal(cleanStyle("color: red !important", "span"), "color: red");
});

test("styles: sizes only on pictures and table cells, borders only on tables", () => {
  assert.equal(cleanStyle("width: 300px; height: 50%", "img"), "width: 300px; height: 50%");
  assert.equal(cleanStyle("width: 300px", "span"), "");
  assert.equal(cleanStyle("border: 1px solid rgb(0, 0, 0)", "td"), "border: 1px solid rgb(0, 0, 0)");
  assert.equal(cleanStyle("border: 1px solid #ccc", "div"), "");
  assert.equal(cleanStyle("border: 1px 2px solid", "table"), "", "one width only");
});

test("styles: nothing that loads or runs anything, and no other properties", () => {
  for (const bad of [
    "background-color: url(https://x.example/t.gif)",
    "color: expression(alert(1))",
    "color: javascript:alert(1)",
    "color: \\72 ed",
    "color: red; position: fixed",
    "background: url(javascript:alert(1))",
    "width: expression(1)",
    "color: \"red\"",
    "behavior: url(x.htc)",
    "color: red/**/",
    "font-weight: bold</style><script>",
  ]) {
    const kept = cleanStyle(bad, "img");
    assert.doesNotMatch(kept, /url|expression|javascript|position|behavior|\\|"|script|\//i, bad);
  }
  assert.equal(cleanStyle("color: red; position: fixed; top: 0", "span"), "color: red");
  assert.equal(cleanStyle("color: red; color: blue", "span"), "color: red", "a property once");
});

test("attributes: event handlers, classes and ids go; spans, picture sizes and font colours stay", () => {
  const attrs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
  assert.deepEqual(keptAttrs("div", attrs({ onclick: "alert(1)", onmouseover: "x()", class: "evil", id: "a", style: "color: red" })), [["style", "color: red"]]);
  assert.deepEqual(keptAttrs("td", attrs({ colspan: "2", rowspan: "x" })), [["colspan", "2"]]);
  assert.deepEqual(keptAttrs("img", attrs({ width: "200", height: "50%", onerror: "alert(1)" })), [["width", "200"], ["height", "50%"]]);
  assert.deepEqual(keptAttrs("img", attrs({ width: "javascript:1" })), []);
  assert.deepEqual(keptAttrs("font", attrs({ color: "#ff0000", face: "Arial" })), [["color", "#ff0000"]]);
  assert.deepEqual(keptAttrs("font", attrs({ color: "expression(alert(1))" })), []);
});

test("tags: scripts, svg and frames are dropped with their content; unknown tags give their text", () => {
  for (const t of ["script", "SVG", "iframe", "style", "object", "math", "template"]) assert.equal(tagAction(t), "drop", t);
  for (const t of ["span", "font", "u", "s", "b", "table", "img"]) assert.equal(tagAction(t), "keep", t);
  for (const t of ["article", "custom-x", "label"]) assert.equal(tagAction(t), "unwrap", t);
});
