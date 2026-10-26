import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesNothing, needsTimePrecision, toWiql } from "../src/api/wiql.ts";

test("project, types, areas and states become WIQL", () => {
  const q = toWiql({ types: ["User Story", "Bug"], areas: [{ path: "P\\Team", includeChildren: true }, { path: "P\\Other", includeChildren: false }], notStates: ["Removed"] }, "P");
  assert.match(q, /\[System\.TeamProject\] = 'P'/);
  assert.match(q, /\[System\.WorkItemType\] IN \('User Story', 'Bug'\)/);
  assert.match(q, /\(\[System\.AreaPath\] UNDER 'P\\Team' OR \[System\.AreaPath\] = 'P\\Other'\)/);
  assert.match(q, /\[System\.State\] NOT IN \('Removed'\)/);
});

test("quotes are doubled, ids and parents are numbers", () => {
  const q = toWiql({ tag: "it's", ids: [1, 2], parents: [7] }, "O'Brien");
  assert.match(q, /'O''Brien'/);
  assert.match(q, /CONTAINS 'it''s'/);
  assert.match(q, /\[System\.Id\] IN \(1, 2\)/);
  assert.match(q, /\[System\.Parent\] IN \(7\)/);
});

test("ids that are not whole numbers never reach the query text", () => {
  assert.match(toWiql({ ids: [NaN, 3, 1.7, Infinity] }, "P"), /\[System\.Id\] IN \(3, 1\)/);
  const none = toWiql({ ids: [NaN], parents: [Infinity] }, "P");
  assert.match(none, /\[System\.Id\] < 0/);
  assert.doesNotMatch(none, /IN \(\)|NaN|Infinity/);
  assert.equal(matchesNothing({ ids: [NaN] }), true);
  assert.equal(matchesNothing({ ids: [NaN, 4] }), false);
});

test("every project leaves the project out", () => {
  assert.doesNotMatch(toWiql({ project: "*", types: ["Task"] }, "P"), /TeamProject/);
});

test("time precision only for dates with a time", () => {
  assert.equal(needsTimePrecision({ changedAfter: "2026-01-01" }), false);
  assert.equal(needsTimePrecision({ changedAfter: "2026-01-01T10:00:00Z" }), true);
});

test("asOf asks for the items that matched at that moment", () => {
  const q = toWiql({ types: ["Task"], iterationUnder: "P\\Sprint 1", asOf: "2026-03-03T23:59:59.999Z" }, "P");
  assert.match(q, /ORDER BY \[System\.Id\] ASC ASOF '2026-03-03T23:59:59\.999Z'$/);
  assert.doesNotMatch(toWiql({ types: ["Task"] }, "P"), /ASOF/);
});
