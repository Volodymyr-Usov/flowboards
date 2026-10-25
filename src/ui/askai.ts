// "Ask AI": a question about the team's work. The answer names items (click to open) and may
// propose changes; nothing changes until the person ticks proposals and clicks Apply.
import type { App } from "../app/context.ts";
import { leaf, personKey } from "../core/model.ts";
import type { BoardAnswer, Proposal } from "./aihelp.ts";
import { askBoard } from "./aihelp.ts";
import { h } from "./dom.ts";
import { dialog, toast } from "./kit.ts";
import { sanitize, textToHtml } from "./sanitize.ts";

/** Open the Ask AI dialog; with a question, it is asked at once. */
export function openAskAi(app: App, question = ""): void {
  if (!app.ai.enabled) {
    void dialog("Ask AI", h("div", null,
      h("p", null, "Ask questions about the team's work in plain words, for example \"Which stories are stuck?\" or \"What should Ava pick next?\"."),
      h("p", null, "It needs your own AI key (Claude or an OpenAI-compatible service). The key is stored for you only, in this extension's storage in Azure DevOps."),
    ), [{ label: "Close", value: "" }, { label: "Open settings", value: "s", primary: true, onClick: () => { app.navigate("settings", { tab: "ai" }); } }]);
    return;
  }
  const history: { q: string; a: string }[] = [];
  const log = h("div.ask-log");
  const input = h("textarea.input", { rows: 2, placeholder: "Which stories are stuck? Who has too much work? What blocks the next release?" });
  const send = h("button.btn.primary", null, "Ask");
  let running = false;
  const ask = async (): Promise<void> => {
    const q = input.value.trim();
    // one question at a time: Enter and the button both come here
    if (!q || running) return;
    running = true;
    send.disabled = true;
    input.value = "";
    const turn = h("div.ask-turn", null, h("div.ask-q", null, q), h("div.ask-a", null, h("span.muted", null, "Thinking…")));
    log.append(turn);
    turn.scrollIntoView({ block: "end" });
    try {
      const r = await askBoard(app, q, history);
      history.push({ q, a: r.answer });
      turn.lastElementChild!.replaceWith(answer(app, r));
    } catch (e) {
      turn.lastElementChild!.replaceWith(h("div.ask-a.error", null, (e as Error).message));
    }
    running = false;
    send.disabled = false;
    input.focus();
  };
  send.addEventListener("click", () => void ask());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); } });
  void dialog("Ask AI about the team's work", h("div.ask-box", null, log, h("div.ask-input", null, input, send),
    h("p.muted.small", null, "The AI sees the titles, states, owners, sprints and tags of the items on this team. Proposed changes are only saved when you tick them and click Apply.")),
  [{ label: "Close", value: "" }], { wide: true });
  if (question.trim()) { input.value = question.trim(); void ask(); }
  else setTimeout(() => input.focus(), 50);
}

function answer(app: App, r: BoardAnswer): HTMLElement {
  const ws = app.ws;
  const el = h("div.ask-a", null, h("div.rich", null, sanitize(textToHtml(r.answer))));
  const items = r.items.map((id) => ws.get(id)).filter((x) => !!x);
  if (items.length) {
    el.append(h("div.ask-items", null, items.map((w) => h("button.chip", { onclick: () => app.openItem(w!.id), title: w!.title }, `#${w!.id} ${w!.title.slice(0, 40)}`))));
  }
  const valid = r.proposals.filter((p) => ws.get(p.id));
  if (valid.length && !app.actions.readOnly) {
    const rows = valid.map((p) => ({ p, cb: h("input", { type: "checkbox" }) as HTMLInputElement, status: h("span.small") }));
    const apply = h("button.btn.small.primary", {
      onclick: async () => {
        apply.disabled = true;
        for (const row of rows) {
          if (!row.cb.checked || row.cb.disabled) continue;
          const ok = await applyProposal(app, row.p);
          row.status.textContent = ok ? " saved" : " not saved";
          row.status.className = ok ? "small ok" : "small err";
          row.cb.disabled = true;
        }
        apply.disabled = false;
      },
    }, "Apply ticked changes");
    el.append(h("div.ask-props", null, h("b", null, "Proposed changes"),
      rows.map(({ p, cb, status }) => h("label.draft-row", null, cb, describe(app, p), status)), apply));
  }
  return el;
}

function describe(app: App, p: Proposal): string {
  const w = app.ws.get(p.id)!;
  const what = { state: "state", owner: "owner", sprint: "sprint", tags: "tags", parent: "parent", comment: "comment" }[p.change];
  return `#${p.id} ${w.title.slice(0, 40)}: ${what} → ${p.value}${p.why ? ` (${p.why})` : ""}`;
}

async function applyProposal(app: App, p: Proposal): Promise<boolean> {
  const ws = app.ws;
  const a = app.actions;
  switch (p.change) {
    case "state": return Boolean(await a.move(p.id, { state: p.value }));
    case "owner": {
      if (/^none$/i.test(p.value)) return Boolean(await a.assign(p.id, null));
      const person = ws.people().find((x) => personKey(x) === p.value.toLowerCase() || x.displayName.toLowerCase() === p.value.toLowerCase());
      if (!person) { toast(`Unknown person: ${p.value}`, { kind: "error" }); return false; }
      return Boolean(await a.assign(p.id, person.uniqueName));
    }
    case "sprint": {
      const it = ws.iterations.find((i) => i.name === p.value || i.path === p.value || leaf(i.path) === p.value);
      if (!it) { toast(`Unknown sprint: ${p.value}`, { kind: "error" }); return false; }
      return Boolean(await a.setField(p.id, "System.IterationPath", it.path));
    }
    case "tags": return Boolean(await a.setField(p.id, "System.Tags", p.value));
    case "parent": {
      // "none" takes the parent away; anything but an item number is refused, never read as "no parent"
      if (/^\s*none\s*$/i.test(p.value)) return Boolean(await a.reparent(p.id, 0));
      const m = /^\s*#?(\d+)\s*$/.exec(p.value);
      if (!m || Number(m[1]) <= 0) { toast(`Not an item number: ${p.value}`, { kind: "error" }); return false; }
      return Boolean(await a.reparent(p.id, Number(m[1])));
    }
    case "comment": return a.comment(p.id, textToHtml(p.value));
  }
  return false;
}
