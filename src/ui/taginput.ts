// Tags as chips with ×, and a box that suggests the tags already in use (as in Azure DevOps).
// Enter, ";" or "," adds what was typed; arrows move in the list, Enter or Tab picks, Esc closes it.
// Backspace in the empty box removes the last chip.
import { h, icon } from "./dom.ts";
import { paintTag, pickTagColor, tagColorsOn } from "./tagchip.ts";

/** a tag chip in its colour */
const paintedChip = (name: string, el: HTMLElement): HTMLElement => { paintTag(el, name); return el; };

/** Tags typed in one go ("a; b, c"), trimmed, empty ones dropped. */
export function splitTags(text: string): string[] {
  return text.split(/[;,]/).map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** The list with `add` appended, unless it is there already (any case). */
export function addTags(list: string[], add: string[]): string[] {
  const out = [...list];
  for (const t of add) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

/** Tags used in these items, the most used first. */
export function usedTags(items: Iterable<{ tags: string[] }>): string[] {
  const n = new Map<string, { name: string; count: number }>();
  for (const it of items) {
    for (const t of it.tags) {
      const k = t.toLowerCase();
      const e = n.get(k);
      if (e) e.count++;
      else n.set(k, { name: t, count: 1 });
    }
  }
  return [...n.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map((e) => e.name);
}

/** Known tags for what was typed: ones that start with it first, then ones that contain it; never one already chosen. */
export function matchTags(known: string[], typed: string, have: string[], max = 8): string[] {
  const q = typed.trim().toLowerCase();
  const taken = new Set(have.map((t) => t.toLowerCase()));
  const free = known.filter((t) => !taken.has(t.toLowerCase()));
  if (!q) return free.slice(0, max);
  const starts = free.filter((t) => t.toLowerCase().startsWith(q));
  const inside = free.filter((t) => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q));
  return [...starts, ...inside].slice(0, max);
}

export interface TagInput {
  el: HTMLElement;
  input: HTMLInputElement;
  /** the chips, plus what is typed and not added yet */
  value(): string[];
  /** show these tags (what Azure DevOps has), dropping anything typed */
  set(tags: string[]): void;
}

export function tagInput(opts: {
  tags: string[];
  /** tags to suggest, the most used first */
  known: () => string[];
  /** a tag was added or removed (the whole list after it) */
  onChange?: (tags: string[]) => void;
  disabled?: boolean;
  label?: string;
}): TagInput {
  let tags = [...opts.tags];
  const input = h("input.tag-box", { type: "text", disabled: opts.disabled, maxlength: 400, "aria-label": opts.label ?? "Add a tag", autocomplete: "off",
    "aria-autocomplete": "list", role: "combobox", "aria-expanded": "false" }) as HTMLInputElement;
  const chips = h("span.tag-chips");
  const el = h("div.input.tag-input", { class: opts.disabled ? "disabled" : "" }, chips, input);
  // a click on the empty part of the field goes to the box
  el.addEventListener("mousedown", (e) => { if (e.target === el || e.target === chips) { e.preventDefault(); input.focus(); } });

  let pop: HTMLElement | null = null;
  let hits: { tag: string; isNew: boolean }[] = [];
  let sel = 0;

  function drawChips(): void {
    chips.replaceChildren(...tags.map((t) => paintedChip(t, h("span.tag-chip", { dataset: { tag: t } }, h("span", { title: tagColorsOn() ? `${t}: click to change its colour` : undefined, onmousedown: (e: Event) => e.preventDefault(), onclick: (e: Event) => { if (tagColorsOn()) pickTagColor(e.currentTarget as Element, t); } }, t),
      opts.disabled ? null : h("button.tag-x", { type: "button", tabindex: -1, title: `Remove ${t}`, "aria-label": `Remove tag ${t}`,
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: () => remove(t) }, icon("close", 11))))));
    input.placeholder = tags.length ? "" : opts.disabled ? "No tags" : "Add tags";
  }

  function changed(): void { drawChips(); opts.onChange?.([...tags]); }

  function add(list: string[]): void {
    const next = addTags(tags, list);
    if (next.length === tags.length) return;
    tags = next;
    changed();
  }

  function remove(t: string): void {
    tags = tags.filter((x) => x !== t);
    changed();
    input.focus();
  }

  function close(): void {
    pop?.remove();
    pop = null;
    hits = [];
    input.setAttribute("aria-expanded", "false");
    window.removeEventListener("scroll", onScroll, true);
  }
  const onScroll = (e: Event): void => { if (!pop?.contains(e.target as Node)) close(); };

  /** The list under the box: matching tags, and "Add …" for a new one. `all`: also with nothing typed. */
  function suggest(all = false): void {
    const q = input.value.trim();
    if (!q && !all) { close(); return; }
    const known = opts.known();
    hits = matchTags(known, q, tags).map((tag) => ({ tag, isNew: false }));
    const exact = q && (known.some((t) => t.toLowerCase() === q.toLowerCase()) || tags.some((t) => t.toLowerCase() === q.toLowerCase()));
    if (q && !exact) hits.push({ tag: q, isNew: true });
    if (!hits.length) { close(); return; }
    sel = 0;
    if (!pop) {
      // the mentions list's look; dialogs leave Enter and Esc to it while it is open
      pop = h("div.mention-pop.tag-pop", { role: "listbox" });
      pop.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.append(pop);
      input.setAttribute("aria-expanded", "true");
      window.addEventListener("scroll", onScroll, true);
    }
    pop.replaceChildren(...hits.map((x, i) => h("div.mention-opt", {
      role: "option", "aria-selected": String(i === sel), class: i === sel ? "sel" : "",
      onclick: () => pick(i),
      onmouseenter: () => mark(i),
    }, x.isNew ? [h("span.muted.small", null, "New tag"), h("b", null, x.tag)] : h("span", null, x.tag))));
    const r = el.getBoundingClientRect();
    const w = Math.max(200, Math.min(320, r.width));
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const hgt = Math.min(pop.scrollHeight, 260);
    pop.style.top = r.bottom + 4 + hgt > window.innerHeight - 8 ? `${Math.max(8, r.top - hgt - 4)}px` : `${r.bottom + 4}px`;
  }

  function mark(i: number): void {
    sel = i;
    for (const [k, c] of [...(pop?.children ?? [])].entries()) {
      c.classList.toggle("sel", k === i);
      c.setAttribute("aria-selected", String(k === i));
      if (k === i) (c as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }

  function pick(i: number): void {
    const hit = hits[i];
    close();
    if (!hit) return;
    input.value = "";
    add([hit.tag]);
    input.focus();
  }

  /** what is typed becomes chips */
  function commitTyped(): void {
    const t = splitTags(input.value);
    input.value = "";
    close();
    if (t.length) add(t);
  }

  input.addEventListener("input", () => {
    // ";" or "," ends a tag; what follows stays in the box
    if (/[;,]/.test(input.value)) {
      const parts = input.value.split(/[;,]/);
      const rest = parts.pop() ?? "";
      const done = splitTags(parts.join(";"));
      input.value = rest.trimStart();
      if (done.length) add(done);
    }
    suggest();
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!pop) { if (e.key === "ArrowDown") { e.preventDefault(); suggest(true); } return; }
      e.preventDefault();
      mark((sel + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === "Enter") {
      if (pop) { e.preventDefault(); e.stopPropagation(); pick(sel); }
      else if (input.value.trim()) { e.preventDefault(); e.stopPropagation(); commitTyped(); }
      // with nothing typed, Enter is left to the dialog (Create)
    } else if (e.key === "Tab" && !e.shiftKey && pop && input.value.trim() && !hits[sel]?.isNew) {
      // Tab completes a known tag; a new one is added on leaving the box, and Tab moves on
      e.preventDefault();
      pick(sel);
    } else if (e.key === "Escape") {
      // first the list, then what is typed; never the panel or dialog at the same time
      if (pop) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (input.value) { e.preventDefault(); e.stopPropagation(); input.value = ""; input.blur(); }
    } else if (e.key === "Backspace" && !input.value && tags.length && input.selectionStart === 0) {
      e.preventDefault();
      tags = tags.slice(0, -1);
      changed();
    }
  });
  // leaving the box keeps what was typed
  input.addEventListener("blur", () => commitTyped());

  drawChips();
  return {
    el, input,
    value: () => addTags(tags, splitTags(input.value)),
    set: (next) => { tags = [...next]; input.value = ""; close(); drawChips(); },
  };
}
