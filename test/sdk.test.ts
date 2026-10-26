import { test } from "node:test";
import assert from "node:assert/strict";

// the channel listens on `window`: a small stand-in is enough here
(globalThis as unknown as { window: unknown }).window ??= { addEventListener() {}, parent: null };
const { openChannel } = await import("../src/host/sdk.ts");

type Sent = { id: number; handshakeToken?: string };

function host() {
  const sent: Sent[] = [];
  const target = { postMessage: (m: string) => { sent.push(JSON.parse(m)); } } as unknown as Window;
  const ch = openChannel(target);
  const reply = (origin: string, msg: Record<string, unknown>, source: unknown = target): void =>
    (ch as unknown as { receive(e: unknown): void }).receive({ source, origin, data: JSON.stringify(msg) });
  return { ch, sent, reply, target };
}

test("host channel: after the handshake only the exact origin of the host is listened to", async () => {
  const { ch, sent, reply } = host();
  const first = ch.call<string>("initialHandshake", "x", [], undefined, undefined, { ms: 1000, what: "Handshake" });
  reply("https://dev.azure.com", { id: sent[0].id, handshakeToken: sent[0].handshakeToken, result: "hello" });
  assert.equal(await first, "hello");

  const second = ch.call<string>("getAccessToken", "x", [], undefined, undefined, { ms: 80, what: "Token" });
  // an origin that only starts the same way, an empty one and "null" are not the host
  reply("https://dev.azure", { id: sent[1].id, result: "evil" });
  reply("", { id: sent[1].id, result: "evil" });
  reply("null", { id: sent[1].id, result: "evil" });
  reply("https://dev.azure.com.example", { id: sent[1].id, result: "evil" });
  await assert.rejects(second, /Token: no answer/);
  assert.equal(ch.waiting(), 0, "a call that timed out is not kept waiting");

  const third = ch.call<string>("getAccessToken", "x", [], undefined, undefined, { ms: 1000, what: "Token" });
  reply("https://dev.azure.com", { id: sent[2].id, result: "tok" });
  assert.equal(await third, "tok");
  assert.equal(ch.waiting(), 0);
});

test("host channel: a handshake answer from an empty or \"null\" origin is not taken as the host", async () => {
  const { ch, sent, reply } = host();
  const first = ch.call<string>("initialHandshake", "x", [], undefined, undefined, { ms: 60, what: "Handshake" });
  reply("null", { id: sent[0].id, handshakeToken: sent[0].handshakeToken, result: "fake" });
  await assert.rejects(first, /Handshake: no answer/);
});

test("host channel: messages from another window are ignored", async () => {
  const { ch, sent, reply } = host();
  const first = ch.call<string>("initialHandshake", "x", [], undefined, undefined, { ms: 60, what: "Handshake" });
  reply("https://dev.azure.com", { id: sent[0].id, handshakeToken: sent[0].handshakeToken, result: "x" }, {});
  await assert.rejects(first, /no answer/);
});
