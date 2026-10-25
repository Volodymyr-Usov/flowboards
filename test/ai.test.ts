import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointProblem, keyTarget } from "../src/core/ai.ts";

test("AI address: https anywhere, http only on this machine", () => {
  assert.equal(endpointProblem(""), null);
  assert.equal(endpointProblem("https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-10-21"), null);
  assert.equal(endpointProblem("http://localhost:11434/v1/chat/completions"), null);
  assert.equal(endpointProblem("http://127.0.0.1:1234/v1/chat/completions"), null);
  assert.ok(endpointProblem("http://example.com/v1/chat/completions"));
  assert.ok(endpointProblem("http://localhost.evil.com/v1"));
  assert.ok(endpointProblem("ftp://localhost/x"));
  assert.ok(endpointProblem("not a url"));
});

test("a saved key is tied to the provider and the address's host", () => {
  assert.equal(keyTarget("openai", ""), keyTarget("openai", "https://api.openai.com/v1/chat/completions"));
  assert.equal(keyTarget("openai", "https://a.openai.azure.com/x"), keyTarget("openai", "https://A.openai.azure.com/y?z=1"));
  assert.notEqual(keyTarget("openai", "https://a.openai.azure.com/x"), keyTarget("openai", "https://b.example.com/x"));
  assert.notEqual(keyTarget("openai", ""), keyTarget("anthropic", ""));
  assert.equal(keyTarget("anthropic", "https://whatever"), keyTarget("anthropic", ""));
  assert.equal(keyTarget("none", ""), "");
});
