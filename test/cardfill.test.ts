import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFill, cleanFills, fillCss, inkFor, luminance } from "../src/views/cardfill.ts";
import { readBoardOpts, saveBoardOpts } from "../src/views/boardprefs.ts";

test("a fill choice is checked: a #rrggbb colour and a strength from 10 to 100 in steps of 5", () => {
  assert.deepEqual(cleanFill({ color: "#AABBCC", strength: 37 }), { color: "#aabbcc", strength: 35 });
  assert.deepEqual(cleanFill({ color: "#aabbcc", strength: 400 }), { color: "#aabbcc", strength: 100 });
  assert.deepEqual(cleanFill({ color: "#aabbcc" }), { color: "#aabbcc", strength: 35 });
  assert.equal(cleanFill({ color: "red", strength: 50 }), null);
  assert.equal(cleanFill({ color: "#abc;background:url(x)", strength: 50 }), null);
  assert.equal(cleanFill(null), null);
  assert.deepEqual(cleanFills({ epic: { color: "#112233", strength: 20 }, feature: "x", story: { color: "nope" }, other: { color: "#000000" } }), { epic: { color: "#112233", strength: 20 } });
});

test("the colour is blended into the theme's own fill; 100% is the colour itself", () => {
  assert.equal(fillCss("feature", { color: "#3a78c2", strength: 30 }), "color-mix(in srgb, #3a78c2 30%, var(--feat))");
  assert.equal(fillCss("story", { color: "#3a78c2", strength: 100 }), "#3a78c2");
  assert.match(fillCss("epic", { color: "#c8660f", strength: 50 }), /var\(--epic-soft\)\)$/);
});

test("from half strength the text turns dark on light colours and light on dark ones", () => {
  assert.ok(luminance("#ffffff") > 0.99 && luminance("#000000") === 0);
  assert.equal(inkFor({ color: "#ffffff", strength: 40 }), null);
  assert.equal(inkFor({ color: "#fff3b0", strength: 80 })?.ink, "#141a24");
  assert.equal(inkFor({ color: "#1d2b4f", strength: 80 })?.ink, "#f4f6fa");
});

test("fills are kept with the Board's own choices for every board, and read back checked", () => {
  saveBoardOpts({ fills: { story: { color: "#336699", strength: 60 } } }, "P/A");
  assert.deepEqual(readBoardOpts("P/B").fills, { story: { color: "#336699", strength: 60 } });
  saveBoardOpts({ fills: {} });
  assert.deepEqual(readBoardOpts().fills, {});
});
