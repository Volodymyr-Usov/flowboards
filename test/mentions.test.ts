import { test } from "node:test";
import assert from "node:assert/strict";
import { matchItems, matchPeople, mentionQuery } from "../src/ui/mentions.ts";

test("mention query: @ or # right before the caret, after a space or at the start", () => {
  assert.deepEqual(mentionQuery("@"), { kind: "@", query: "", start: 0 });
  assert.deepEqual(mentionQuery("ask @ann"), { kind: "@", query: "ann", start: 4 });
  assert.deepEqual(mentionQuery("ask @Ann Ma"), { kind: "@", query: "Ann Ma", start: 4 });
  assert.deepEqual(mentionQuery("see #12"), { kind: "#", query: "12", start: 4 });
  assert.deepEqual(mentionQuery("x @b"), { kind: "@", query: "b", start: 2 });
  // an e-mail address is not a mention
  assert.equal(mentionQuery("mail ann@x.com"), null);
  assert.equal(mentionQuery("ask @ann and then"), null);
  assert.equal(mentionQuery("plain text"), null);
});

test("people: names that start with the words first, no doubles", () => {
  const people = [
    { id: "1", displayName: "Ann Martins", uniqueName: "ann@x.com" },
    { id: "2", displayName: "Joanna Bell", uniqueName: "jb@x.com" },
    { id: "3", displayName: "Ben Annet", uniqueName: "ben@x.com" },
    { id: "1", displayName: "Ann Martins", uniqueName: "ann@x.com" },
  ];
  assert.deepEqual(matchPeople(people, "ann").map((p) => p.id), ["1", "3", "2"]);
  assert.deepEqual(matchPeople(people, "").map((p) => p.id), ["1", "3", "2"]);
  assert.deepEqual(matchPeople(people, "jb").map((p) => p.id), ["2"]);
  assert.deepEqual(matchPeople(people, "zzz"), []);
});

test("work items: by the start of the number or by title words", () => {
  const items = [{ id: 12, title: "Login page", type: "Story" }, { id: 120, title: "Payments API", type: "Feature" }, { id: 7, title: "Login errors", type: "Bug" }];
  assert.deepEqual(matchItems(items, "12").map((i) => i.id), [12, 120]);
  assert.deepEqual(matchItems(items, "login").map((i) => i.id), [12, 7]);
  assert.deepEqual(matchItems(items, "login err").map((i) => i.id), [7]);
});
