// Optional AI help: drafts of descriptions, acceptance criteria and tasks, and questions about the board.
// Off until a person adds their own key in Settings. The key is kept in the extension's storage for
// that person only and sent only to the provider they chose. Nothing the AI writes is saved until
// the person clicks Save or Apply.
//
// Plain fetch on purpose: the extension carries no libraries.
import type { AiSettings } from "./settings.ts";

export interface AiMessage { role: "user" | "assistant"; content: string }

export const ANTHROPIC_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best answers)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)" },
];

export class AiError extends Error {}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why an OpenAI-compatible address cannot be used, or null when it can. Empty means OpenAI itself. */
export function endpointProblem(endpoint: string): string | null {
  const e = endpoint.trim();
  if (!e) return null;
  let u: URL;
  try { u = new URL(e); } catch { return "The address is not a valid web address."; }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname.toLowerCase())) return null;
  return "The address must start with https:// (http:// only for a server on your machine: localhost or 127.0.0.1).";
}

/** Where a key is sent: the provider and the address's host. A saved key is reused only for the same place. */
export function keyTarget(provider: AiSettings["provider"], endpoint: string): string {
  if (provider === "none") return "";
  if (provider === "anthropic") return "anthropic|api.anthropic.com";
  try { return "openai|" + new URL(endpoint.trim() || OPENAI_URL).host.toLowerCase(); } catch { return "openai|?" + endpoint.trim(); }
}

/**
 * AI help (Ask AI in the search field, drafts in the details panel and the new item form, the
 * Settings tab) is switched off for now and comes in a later release. The code stays; true turns
 * every entry point back on.
 */
export const AI_FEATURES = false;

export class Ai {
  private get: () => AiSettings;
  constructor(get: () => AiSettings) { this.get = get; }

  get enabled(): boolean {
    if (!AI_FEATURES) return false;
    const s = this.get();
    return s.provider !== "none" && Boolean(s.apiKey || (s.provider === "openai" && s.endpoint && !/openai\.com/.test(s.endpoint)));
  }

  /** One answer as text. With `schema`, the answer is JSON that fits it (parsed for you). */
  async ask<T = string>(system: string, messages: AiMessage[], opts: { schema?: Record<string, unknown>; maxTokens?: number; signal?: AbortSignal } = {}): Promise<T> {
    const s = this.get();
    if (!this.enabled) throw new AiError("AI help is off. Add a key in Settings → AI help.");
    const text = s.provider === "anthropic" ? await this.anthropic(s, system, messages, opts) : await this.openai(s, system, messages, opts);
    if (!opts.schema) return text as T;
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as T;
    } catch {
      throw new AiError("The AI answer was not in the expected form. Please try again.");
    }
  }

  private async anthropic(s: AiSettings, system: string, messages: AiMessage[], opts: { schema?: Record<string, unknown>; maxTokens?: number; signal?: AbortSignal }): Promise<string> {
    const body: Record<string, unknown> = {
      model: s.model || ANTHROPIC_MODELS[0].id,
      max_tokens: opts.maxTokens ?? 16000,
      system,
      messages,
      fallbacks: "default",
    };
    if (opts.schema) body.output_config = { format: { type: "json_schema", schema: opts.schema } };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: opts.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": s.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message ?? `${res.status} ${res.statusText}`;
      throw new AiError(res.status === 401 ? "The AI key was refused. Check it in Settings → AI help." : `AI service: ${msg}`);
    }
    if (json?.stop_reason === "refusal") throw new AiError("The AI declined this request.");
    const text = (json?.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    if (!text) throw new AiError("The AI gave an empty answer.");
    return text;
  }

  private async openai(s: AiSettings, system: string, messages: AiMessage[], opts: { schema?: Record<string, unknown>; maxTokens?: number; signal?: AbortSignal }): Promise<string> {
    const url = s.endpoint || OPENAI_URL;
    const problem = endpointProblem(url);
    if (problem) throw new AiError(`${problem} Check Settings → AI help.`);
    const azure = /\.azure\.com/i.test(url);
    const body: Record<string, unknown> = {
      messages: [{ role: "system", content: system }, ...messages],
      max_completion_tokens: opts.maxTokens ?? 16000,
    };
    if (!azure || s.model) body.model = s.model || "gpt-4.1-mini";
    if (opts.schema) body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: opts.schema, strict: false } };
    const res = await fetch(url, {
      method: "POST",
      signal: opts.signal,
      headers: { "content-type": "application/json", ...(azure ? { "api-key": s.apiKey } : s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new AiError(`AI service: ${json?.error?.message ?? res.status + " " + res.statusText}`);
    const text = json?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new AiError("The AI gave an empty answer.");
    return text;
  }
}
