import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO, refreshHint } from "../src/ui/hints.ts";
import { popupName } from "../src/ui/kit.ts";

// no document in the tests: a small stand-in for the few element calls the tooltips use
class El {
  attrs = new Map<string, string>();
  parentElement: El | null = null;
  textContent = "";
  constructor(text = "", attrs: Record<string, string> = {}) { this.textContent = text; for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  /** only the selector the tooltips use: something with a tooltip of its own */
  closest(): El | null {
    for (let x: El | null = this; x; x = x.parentElement) if (x.hasAttribute("title") && !x.hasAttribute(AUTO)) return x;
    return null;
  }
}

test("a made tooltip follows the control's words; one the page set stays", () => {
  const g = globalThis as Record<string, unknown>;
  const names = ["HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLAnchorElement"];
  for (const n of names) g[n] ??= class {};
  const b = new El("3 open");
  const el = b as unknown as Element;
  refreshHint(el);
  assert.equal(b.getAttribute("title"), "3 open");
  b.textContent = "4 open";
  refreshHint(el);
  assert.equal(b.getAttribute("title"), "4 open", "made again on the next hover");
  // the page writes its own tooltip later: kept from then on
  b.setAttribute("title", "Open items");
  b.textContent = "5 open";
  refreshHint(el);
  assert.equal(b.getAttribute("title"), "Open items");
  assert.equal(b.hasAttribute(AUTO), false);
  // inside something with a tooltip of its own: no made one (it would hide the outer one)
  const outer = new El("", { title: "The card" });
  const inner = new El("Go");
  inner.parentElement = outer;
  refreshHint(inner as unknown as Element);
  assert.equal(inner.hasAttribute("title"), false);
});

test("a popup is named for screen readers: the name given, else its anchor's", () => {
  const anchor = (attrs: Record<string, string>, text = "") => new El(text, attrs) as unknown as Element;
  assert.equal(popupName(anchor({ "aria-label": "Filter" }), "Filter: State"), "Filter: State");
  assert.equal(popupName(anchor({ "aria-label": "More controls", title: "x" })), "More controls");
  assert.equal(popupName(anchor({ title: "Change this filter" }, "State: Active")), "Change this filter");
  assert.equal(popupName(anchor({}, "  +3 \n more ")), "+3 more");
});
