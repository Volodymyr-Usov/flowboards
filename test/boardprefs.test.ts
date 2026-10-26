import { test } from "node:test";
import assert from "node:assert/strict";
import { prefs } from "../src/core/settings.ts";
import { readBoardOpts, saveBoardOpts, writeBoardOpts } from "../src/views/boardprefs.ts";

function withStorage(run: () => void): void {
  const data = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const old = g.localStorage;
  g.localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, String(v)); }, removeItem: (k: string) => { data.delete(k); } };
  try { run(); } finally { if (old === undefined) delete g.localStorage; else g.localStorage = old; }
}

test("hidden columns and people are kept per team; the card switches are the person's own", () => {
  withStorage(() => {
    // choices from before they were per team: each team starts from them once
    prefs.set("board", { hiddenCols: ["Review"], counts: false });
    const a = readBoardOpts("P/Team A");
    assert.deepEqual(a.hiddenCols, ["Review"]);
    assert.equal(a.counts, false);
    // Team A shows Review again: Team B still starts from the old choice, and keeps its own afterwards
    a.hiddenCols = [];
    a.counts = true;
    writeBoardOpts(a, "P/Team A");
    assert.deepEqual(readBoardOpts("P/Team B").hiddenCols, ["Review"]);
    saveBoardOpts({ hiddenCols: ["Done"] }, "P/Team B");
    assert.deepEqual(readBoardOpts("P/Team A").hiddenCols, []);
    assert.deepEqual(readBoardOpts("P/Team B").hiddenCols, ["Done"]);
    // a card switch follows the person to every board
    assert.equal(readBoardOpts("P/Team B").counts, true);
    assert.equal(readBoardOpts().counts, true);
  });
});
