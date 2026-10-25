// What the AI is asked, and how its answers come back. Every answer is a proposal: the page shows it
// and the person decides what to save.
import type { WorkItem } from "../api/types.ts";
import type { App } from "../app/context.ts";
import type { AiMessage } from "../core/ai.ts";
import { daysInState, plainText } from "../core/model.ts";

const SYSTEM = `You help a software team keep its Azure DevOps work items clear.
Write in plain, short sentences that a busy reader understands on the first reading.
Never invent facts that are not in the input; when something is unknown, leave it out.`;

/** How long one AI answer may take before it is given up. */
export const AI_TIMEOUT_MS = 60_000;

/** The shape check failed: a custom service answered without the fields asked for. */
const badShape = (): Error => new Error("The AI answer was not in the expected form (a custom service may not support structured answers). Please try again or check the service in Settings → AI help.");

/** Ask the AI, giving up after AI_TIMEOUT_MS with a clear message. */
async function askTimed<T>(app: App, system: string, messages: AiMessage[], schema: Record<string, unknown>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    return await app.ai.ask<T>(system, messages, { schema, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`The AI did not answer within ${AI_TIMEOUT_MS / 1000} seconds. Please try again.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export interface Drafts { description: string; acceptance: string }

export async function draftTexts(app: App, it: { type: string; title: string; parent?: WorkItem; description?: string; acceptance?: string; id?: number }): Promise<Drafts> {
  const ws = app.ws;
  const siblings = it.parent ? ws.children(it.parent.id).filter((s) => s.id !== it.id).slice(0, 12).map((s) => `- #${s.id} ${s.title}`).join("\n") : "";
  const prompt = [
    `Draft the description and the acceptance criteria for this ${it.type}.`,
    `Title: ${it.title}`,
    it.parent ? `It belongs to ${it.parent.type} #${it.parent.id} "${it.parent.title}": ${plainText(it.parent.description).slice(0, 1500)}` : "",
    siblings ? `Other items under the same parent:\n${siblings}` : "",
    it.description ? `Current description (improve it, keep its facts): ${plainText(it.description).slice(0, 3000)}` : "",
    it.acceptance ? `Current acceptance criteria: ${plainText(it.acceptance).slice(0, 2000)}` : "",
    "Description: 2 to 5 sentences, what and why. Acceptance criteria: 3 to 6 checkable lines, each starting with '- '.",
  ].filter(Boolean).join("\n\n");
  const r = await askTimed<unknown>(app, SYSTEM, [{ role: "user", content: prompt }], {
    type: "object", additionalProperties: false, required: ["description", "acceptance"],
    properties: { description: { type: "string" }, acceptance: { type: "string" } },
  });
  return checkDrafts(r);
}

/** The drafts, checked: both texts must be there. */
export function checkDrafts(r: unknown): Drafts {
  if (!isObj(r) || typeof r.description !== "string" || typeof r.acceptance !== "string") throw badShape();
  return { description: r.description, acceptance: r.acceptance };
}

export interface TaskDraft { title: string; hours: number }

export async function draftTasks(app: App, story: WorkItem): Promise<TaskDraft[]> {
  const existing = app.ws.children(story.id).map((t) => `- ${t.title}`).join("\n");
  const prompt = [
    `Split this ${story.type} into the tasks a developer would track. Leave out tasks that already exist.`,
    `Title: ${story.title}`,
    `Description: ${plainText(story.description).slice(0, 3000)}`,
    `Acceptance criteria: ${plainText(story.acceptance).slice(0, 2000)}`,
    existing ? `Existing tasks:\n${existing}` : "",
    "Give 2 to 8 tasks with a short title and an estimate in hours.",
  ].filter(Boolean).join("\n\n");
  const r = await askTimed<unknown>(app, SYSTEM, [{ role: "user", content: prompt }], {
    type: "object", additionalProperties: false, required: ["tasks"],
    properties: { tasks: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "hours"], properties: { title: { type: "string" }, hours: { type: "number" } } } } },
  });
  return checkTasks(r);
}

/** The task drafts, checked: a list of titles with hours (a missing or odd estimate becomes 0). */
export function checkTasks(r: unknown): TaskDraft[] {
  if (!isObj(r) || !Array.isArray(r.tasks)) throw badShape();
  return r.tasks.filter((t): t is Record<string, unknown> => isObj(t) && typeof t.title === "string" && t.title.trim() !== "")
    .map((t) => { const hours = Number(t.hours); return { title: String(t.title).trim(), hours: Number.isFinite(hours) && hours >= 0 ? hours : 0 }; });
}

export interface Proposal { id: number; change: "state" | "owner" | "sprint" | "tags" | "parent" | "comment"; value: string; why: string }
export interface BoardAnswer { answer: string; items: number[]; proposals: Proposal[] }

/** A question about the team's work. The model sees every loaded item in short form. */
export async function askBoard(app: App, question: string, history: { q: string; a: string }[] = []): Promise<BoardAnswer> {
  const ws = app.ws;
  const lines = [...ws.items.values()].slice(0, 1500).map((w) => [
    `#${w.id}`, w.type, JSON.stringify(w.title), `state=${w.state}`, w.parent ? `parent=#${w.parent}` : "", w.assignedTo ? `owner=${JSON.stringify(w.assignedTo.displayName)}` : "owner=none",
    `sprint=${w.iteration.split("\\").pop()}`, w.tags.length ? `tags=${JSON.stringify(w.tags.join(";"))}` : "", `daysInState=${daysInState(w)}`,
    w.effort != null ? `effort=${w.effort}` : "", plainText(w.description) ? "" : "noDescription",
  ].filter(Boolean).join(" "));
  const states = [...new Set(Object.values(ws.process.types).flatMap((t) => t.states.map((s) => s.name)))].join(", ");
  const people = ws.people().map((p) => `${p.displayName} <${p.uniqueName}>`).join("; ");
  const context = `Team "${ws.team}" in project "${ws.project}". Today is ${new Date().toISOString().slice(0, 10)}.
States: ${states}. People: ${people}.
Sprints: ${ws.iterations.map((i) => `${i.name}${i.timeFrame === "current" ? " (current)" : ""}`).join(", ")}.
Work items, one per line:
${lines.join("\n")}`;
  const messages = [
    { role: "user" as const, content: context },
    ...history.flatMap((h) => [{ role: "user" as const, content: h.q }, { role: "assistant" as const, content: h.a }]),
    { role: "user" as const, content: `${question}\n\nAnswer in plain words. List the item numbers you mean in "items". Propose changes only when asked or clearly useful; each proposal changes one thing of one item (state = a state name, owner = an email from the people list or "none", sprint = a sprint name, tags = the full new tag list separated by "; ", parent = an item number, or "none" to take the parent away, comment = text to add).` },
  ];
  const r = await askTimed<unknown>(app, SYSTEM, messages, {
    type: "object", additionalProperties: false, required: ["answer", "items", "proposals"],
    properties: {
      answer: { type: "string" },
      items: { type: "array", items: { type: "integer" } },
      proposals: {
        type: "array", items: {
          type: "object", additionalProperties: false, required: ["id", "change", "value", "why"],
          properties: { id: { type: "integer" }, change: { type: "string", enum: [...CHANGES] }, value: { type: "string" }, why: { type: "string" } },
        },
      },
    },
  });
  return checkBoardAnswer(r);
}

const CHANGES: readonly Proposal["change"][] = ["state", "owner", "sprint", "tags", "parent", "comment"];

/** The answer, checked: an answer text is required; item numbers and proposals that do not fit are left out. */
export function checkBoardAnswer(r: unknown): BoardAnswer {
  if (!isObj(r) || typeof r.answer !== "string") throw badShape();
  const id = (x: unknown): number => typeof x === "number" ? x : typeof x === "string" && /^\s*#?\d+\s*$/.test(x) ? Number(x.replace(/\D/g, "")) : NaN;
  const items = (Array.isArray(r.items) ? r.items : []).map(id).filter((n) => Number.isInteger(n) && n > 0);
  const proposals = (Array.isArray(r.proposals) ? r.proposals : []).filter(isObj)
    .map((p) => ({ id: id(p.id), change: p.change as Proposal["change"], value: p.value == null ? "" : String(p.value), why: typeof p.why === "string" ? p.why : "" }))
    .filter((p) => Number.isInteger(p.id) && p.id > 0 && CHANGES.includes(p.change));
  return { answer: r.answer, items, proposals };
}
