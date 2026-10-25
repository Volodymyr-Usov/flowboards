import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoApi } from "../src/api/demo.ts";
import { readOnlyApi, WRITES } from "../src/api/readonly.ts";
import { RestApi } from "../src/api/rest.ts";

test("read-only refuses every write and keeps reads", async () => {
  const api = readOnlyApi(new DemoApi());
  const projects = await api.projects();
  assert.ok(projects.length > 0);
  for (const name of WRITES) {
    const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
    await assert.rejects(fn("p", "t", 1, []), /Read-only/, name);
  }
  assert.ok(api.ctx.orgName !== undefined, "plain fields still read");
});

test("every call of the real client that sounds like a change is on the read-only list (a new one cannot slip through)", () => {
  const verbs = /^(set|create|update|delete|remove|restore|rename|add|reorder|put|save|patch|post)([A-Z]|$)/;
  const names = Object.getOwnPropertyNames(RestApi.prototype).filter((n) => n !== "constructor" && typeof (RestApi.prototype as unknown as Record<string, unknown>)[n] === "function");
  const changes = names.filter((n) => verbs.test(n));
  assert.ok(changes.length >= WRITES.length, "the verbs find the known changes");
  for (const n of changes) assert.ok((WRITES as readonly string[]).includes(n), `${n} changes something but is not on the read-only list`);
  for (const w of WRITES) assert.ok(names.includes(w), `${w} is listed but the client has no such call`);
});
