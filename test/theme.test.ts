import { test } from "node:test";
import assert from "node:assert/strict";
import { colorRgb, hostIsDark } from "../src/app/app.ts";

const host = (bg: string) => ({ theme: { "background-color": bg } }) as unknown as Parameters<typeof hostIsDark>[0];

test("host colours: hex and rgb forms are read right", () => {
  assert.deepEqual(colorRgb("#1e1e1e"), [30, 30, 30]);
  assert.deepEqual(colorRgb("#FFF"), [255, 255, 255]);
  assert.deepEqual(colorRgb("#11223344"), [17, 34, 51]);
  assert.deepEqual(colorRgb("rgba(32, 31, 30, 1)"), [32, 31, 30]);
  assert.deepEqual(colorRgb("255, 255, 255"), [255, 255, 255]);
  assert.equal(colorRgb("dark"), undefined);
  assert.equal(hostIsDark(host("#1b1a19")), true);
  assert.equal(hostIsDark(host("#ffffff")), false);
  assert.equal(hostIsDark(host("#fafafa")), false);
  assert.equal(hostIsDark(host("rgba(32, 31, 30, 1)")), true);
  assert.equal(hostIsDark(null), undefined);
});
