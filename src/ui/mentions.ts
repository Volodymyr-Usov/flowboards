// Mentions in text boxes, as in Azure DevOps: type @ and a name for a person, # and a number or words
// for a work item; a list of suggestions opens at the caret. Arrows move, Enter or Tab picks, Esc closes.
// A picked person is saved the way Azure DevOps saves it, so they are notified:
//   <a href="#" data-vss-mention="version:2.0,{identity id}">@Name</a>
// and a work item as a link to it: <a href="{item url}" data-vss-mention="version:1.0">#123</a>.
import type { Person } from "../api/types.ts";
import type { App } from "../app/context.ts";
import { isRemoved } from "../core/model.ts";
import { h } from "./dom.ts";

export interface MentionItem { id: number; title: string; type: string }
export interface MentionSource {
  people(): Person[];
  items(): MentionItem[];
  itemUrl(id: number): string;
}

/** Who and what can be mentioned: the team's people (and you), the team's work items. */
export function mentionSourceFor(app: App): MentionSource {
  return {
    people: () => [app.api.ctx.me, ...app.ws.people()],
    items: () => [...app.ws.items.values()].filter((x) => !isRemoved(x)).map((x) => ({ id: x.id, title: x.title, type: x.type })),
    itemUrl: (id) => app.ws.itemUrl(id),
  };
}

type Hit = { kind: "person"; person: Person } | { kind: "item"; item: MentionItem };

/** What was typed right before the caret: "@ann" or "#12", with where it starts in the text node. */
export function mentionQuery(before: string): { kind: "@" | "#"; query: string; start: number } | null {
  const m = /(^|[\s(> ])([@#])([^\s@#<>()]{0,30}(?: [^\s@#<>()]{1,30})?)$/u.exec(before);
  if (!m) return null;
  return { kind: m[2] as "@" | "#", query: m[3], start: m.index + m[1].length };
}

/** People whose name or account matches: names that start with the words first. */
export function matchPeople(people: Person[], q: string, max = 8): Person[] {
  const s = q.trim().toLowerCase();
  const seen = new Set<string>();
  const scored: { p: Person; score: number }[] = [];
  for (const p of people) {
    const key = (p.id || p.uniqueName || p.displayName).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = p.displayName.toLowerCase();
    const acct = (p.uniqueName || "").toLowerCase();
    const score = !s ? 2 : name.startsWith(s) ? 0 : name.split(/\s+/).some((w) => w.startsWith(s)) || acct.startsWith(s) ? 1 : name.includes(s) || acct.includes(s) ? 2 : -1;
    if (score >= 0) scored.push({ p, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.p.displayName.localeCompare(b.p.displayName)).slice(0, max).map((x) => x.p);
}

/** Work items by number (start of the number) or by words of the title. */
export function matchItems(items: MentionItem[], q: string, max = 8): MentionItem[] {
  const s = q.trim().toLowerCase();
  if (/^\d+$/.test(s)) return items.filter((i) => String(i.id).startsWith(s)).sort((a, b) => a.id - b.id).slice(0, max);
  const words = s.split(/\s+/).filter(Boolean);
  return items.filter((i) => words.every((w) => i.title.toLowerCase().includes(w))).slice(0, max);
}

/** The node a picked person or item becomes. It moves as one piece in the box (no typing inside it). */
export function mentionNode(hit: Hit, src: MentionSource): HTMLElement {
  if (hit.kind === "person") {
    const p = hit.person;
    const a = h("a.mention", p.id ? { href: "#", "data-vss-mention": `version:2.0,${p.id}` } : {}, `@${p.displayName}`);
    a.contentEditable = "false";
    return a;
  }
  const a = h("a.mention", { href: src.itemUrl(hit.item.id), "data-vss-mention": "version:1.0", title: hit.item.title }, `#${hit.item.id}`);
  a.contentEditable = "false";
  return a;
}

/** Mentions already in a box (from Azure DevOps) move as one piece too. */
export function lockMentions(box: HTMLElement): void {
  for (const a of box.querySelectorAll<HTMLElement>("a[data-vss-mention], a.mention")) a.contentEditable = "false";
}

/**
 * Suggest mentions while someone types in an editable box. Returns a function that removes the list.
 * `changed` runs after a mention went in (the box's own "input" event runs too).
 */
export function attachMentions(box: HTMLElement, src: MentionSource): () => void {
  let pop: HTMLElement | null = null;
  let hits: Hit[] = [];
  let sel = 0;
  let at: { node: Text; start: number; end: number } | null = null;

  const close = (): void => { pop?.remove(); pop = null; hits = []; at = null; };

  function pick(i: number): void {
    const hit = hits[i];
    const where = at;
    close();
    if (!hit || !where || !where.node.isConnected) return;
    const range = document.createRange();
    range.setStart(where.node, where.start);
    range.setEnd(where.node, Math.min(where.end, where.node.length));
    range.deleteContents();
    const node = mentionNode(hit, src);
    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(node);
    const s = window.getSelection();
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    s?.removeAllRanges();
    s?.addRange(after);
    box.focus();
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function draw(rect: DOMRect): void {
    if (!hits.length) { close(); return; }
    if (!pop) {
      pop = h("div.mention-pop", { role: "listbox" });
      // a click in the list must not take the focus from the box
      pop.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.append(pop);
    }
    pop.replaceChildren(...hits.map((x, i) => h("div.mention-opt", {
      role: "option", "aria-selected": String(i === sel), class: i === sel ? "sel" : "",
      onclick: () => pick(i),
      onmouseenter: () => { sel = i; for (const [k, c] of [...pop!.children].entries()) c.classList.toggle("sel", k === i); },
    }, x.kind === "person"
      ? [h("b", null, x.person.displayName), x.person.uniqueName && x.person.uniqueName !== x.person.displayName ? h("span.muted.small", null, x.person.uniqueName) : null]
      : [h("b", null, `#${x.item.id}`), h("span", null, x.item.title), h("span.muted.small", null, x.item.type)])));
    const w = 300;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    const below = rect.bottom + 4;
    pop.style.left = `${left}px`;
    pop.style.width = `${w}px`;
    // under the caret, or above it when there is no room below
    const hgt = Math.min(pop.scrollHeight, 260);
    pop.style.top = below + hgt > window.innerHeight - 8 ? `${Math.max(8, rect.top - hgt - 4)}px` : `${below}px`;
  }

  function update(): void {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) { close(); return; }
    const r = s.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !box.contains(node)) { close(); return; }
    const text = (node as Text).data.slice(0, r.startOffset);
    const q = mentionQuery(text);
    if (!q) { close(); return; }
    hits = q.kind === "@"
      ? matchPeople(src.people(), q.query).map((person) => ({ kind: "person" as const, person }))
      : q.query ? matchItems(src.items(), q.query).map((item) => ({ kind: "item" as const, item })) : [];
    sel = 0;
    at = { node: node as Text, start: q.start, end: r.startOffset };
    const caret = r.getBoundingClientRect();
    draw(caret.width || caret.height ? caret : box.getBoundingClientRect());
  }

  box.addEventListener("input", () => update());
  box.addEventListener("click", () => update());
  box.addEventListener("blur", () => close());
  box.addEventListener("keydown", (e) => {
    if (!pop || !hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      for (const [k, c] of [...pop.children].entries()) { c.classList.toggle("sel", k === sel); if (k === sel) (c as HTMLElement).scrollIntoView({ block: "nearest" }); }
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      pick(sel);
    } else if (e.key === "Escape") {
      // closes the list only (not the box or the panel)
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  return close;
}
