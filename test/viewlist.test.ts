import { test } from "node:test";
import assert from "node:assert/strict";

// the list of pages: ids are unique, every tab fits a short label, and the pages the owner removed stay removed
test("the pages and their tab names", async () => {
  const g = globalThis as unknown as { document?: unknown };
  const had = g.document !== undefined;
  if (!had) g.document = { createElement: () => ({}), addEventListener: () => {}, querySelector: () => null, body: {} };
  try {
    const { VIEWS } = await import("../src/views/index.ts");
    const ids = VIEWS.map((v) => v.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const gone of ["projects", "stats", "changelog", "goals", "audits"]) assert.ok(!ids.includes(gone), gone);
    const tabs = Object.fromEntries(VIEWS.map((v) => [v.id, v.tab ?? v.title]));
    assert.equal(tabs.recycle, "Recycle");
    assert.equal(tabs.prs, "Pull");
    assert.equal(tabs.deps, "Dependency");
    for (const v of VIEWS) assert.ok((v.tab ?? v.title).length <= 12, `${v.id} tab is short`);
  } finally { if (!had) delete g.document; }
});
