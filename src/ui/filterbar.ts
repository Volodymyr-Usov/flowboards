// The filter parts every page with work items uses, so filtering looks and works the same everywhere:
//   filterBar   chips for filters on any property, a "Filter" button with a property picker, an editor per kind
//   peopleStrip avatars with counts: click = only this person, right-click = hide; "+N" after 10 people
// The search field itself is part of every page's line 2: src/ui/pagebar.ts.
// Each page keeps its own choices in this browser (prefs) under its own key. The logic: src/core/filters.ts.
import { blk } from "./blocks.ts";
import type { Api } from "../api/api.ts";
import type { Person, ProcessInfo, WorkItem } from "../api/types.ts";
import type { Filter, PeoplePick, Prop } from "../core/filters.ts";
import {
  BASE_PROPS, cleanFilters, cleanPeople, countPeople, describe, fieldProps, isActive, keyOfPerson, passesAll, personPasses, togglePerson, valueCounts,
} from "../core/filters.ts";
import { prefs } from "../core/settings.ts";
import { h, icon } from "./dom.ts";
import { avatar, popup, select } from "./kit.ts";

/** Display names of the fields of every type of the process (for the property list). */
export function processFieldNames(p: ProcessInfo): Record<string, string> {
  const names: Record<string, string> = {};
  for (const t of Object.values(p.types)) Object.assign(names, t?.fieldNames ?? {});
  return names;
}

// ---------- filters on any property ----------

export interface FilterBarOpts {
  /** where the filters are kept in this browser: one key per page */
  key: string;
  /** the page's items: the values offered, and the extra fields that become properties */
  items: () => Iterable<WorkItem>;
  /** called after every change (the page redraws) */
  onChange: () => void;
  /** field display names by reference name */
  names?: () => Record<string, string>;
  /** keep the filters somewhere else than this browser (e.g. a check being edited) */
  store?: { get: () => unknown; set: (f: Filter[]) => void };
  /** the add button's text (default "Filter") */
  addLabel?: string;
}

export interface FilterBar {
  el: HTMLElement;
  /** does the item pass every filter? */
  test: (w: WorkItem) => boolean;
  /** is any filter set? */
  active: () => boolean;
  /** read the properties again (after the items changed) and redraw the chips */
  refresh: () => void;
  /** remove every filter */
  clear: () => void;
  /** the filters as they are */
  filters: () => Filter[];
  /** the properties the filters can use (for testing items elsewhere) */
  props: () => Map<string, Prop>;
}

export function filterBar(opts: FilterBarOpts): FilterBar {
  let filters: Filter[] = cleanFilters(opts.store ? opts.store.get() : prefs.get<unknown>(opts.key, []));
  let props = new Map<string, Prop>();
  const el = blk("filters", h("div.fbar"));
  const save = (): void => { if (opts.store) opts.store.set(filters); else prefs.set(opts.key, filters); };
  const setOn = (): Filter[] => filters.filter((f) => isActive(f, props.get(f.prop)));
  const changed = (): void => { save(); draw(); opts.onChange(); };

  function fill(): void {
    props = new Map([...BASE_PROPS, ...fieldProps(opts.items(), opts.names?.() ?? {})].map((p) => [p.id, p]));
  }

  function draw(): void {
    el.replaceChildren(
      ...filters.map((f, i) => {
        const p = props.get(f.prop);
        return h(`span.chip.tf-chip${isActive(f, p) ? ".on" : ""}`, null,
          h("button.tf-edit", { type: "button", title: "Change this filter", onclick: (e: Event) => edit(e.currentTarget as Element, f) }, describe(f, p)),
          h("button.icon-btn.small", { type: "button", title: "Remove this filter", "aria-label": "Remove this filter", onclick: () => { filters.splice(i, 1); changed(); } }, icon("close", 12)));
      }),
      h("button.btn.small.fbar-add", { type: "button", title: "Show only items whose property matches: type, state, owner, tags, sprint, dates, numbers or any other field", onclick: (e: Event) => add(e.currentTarget as Element) }, icon("filter", 13), opts.addLabel ?? "Filter"),
      filters.length ? h("button.btn.link.small", { type: "button", title: "Remove every filter", onclick: () => { filters = []; changed(); } }, "Clear filters") : "");
  }

  function add(anchor: Element): void {
    const input = h("input.input", { type: "search", placeholder: "Find a property", "aria-label": "Find a property" }) as HTMLInputElement;
    const box = h("div.pick-list");
    let close = (): void => {};
    const list = (): void => {
      const q = input.value.trim().toLowerCase();
      const found = [...props.values()].filter((p) => !q || p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
      box.replaceChildren(...found.map((p) => h("button.pick-item", {
        title: p.id.startsWith("field:") ? p.id.slice(6) : p.label,
        onclick: () => {
          close();
          const f: Filter = p.kind === "set" ? { prop: p.id, op: "any", values: [] } : { prop: p.id };
          filters.push(f);
          changed();
          const chip = el.querySelectorAll<HTMLElement>(".tf-edit")[filters.length - 1];
          if (chip) edit(chip, f);
        },
      }, h("span", null, p.label), p.id.startsWith("field:") ? h("small", null, p.id.slice(6)) : null)));
      if (!box.children.length) box.append(h("div.muted.pad", null, "No property found"));
    };
    input.addEventListener("input", list);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") (box.querySelector(".pick-item") as HTMLElement | null)?.click(); });
    list();
    close = popup(anchor, h("div.picker.wide", null, input, box));
    input.focus();
  }

  function edit(anchor: Element, f: Filter): void {
    const p = props.get(f.prop);
    if (!p) return;
    // every change applies at once; the chip text follows
    const live = (): void => {
      save();
      opts.onChange();
      const chip = el.querySelectorAll<HTMLElement>(".tf-edit")[filters.indexOf(f)];
      if (chip) { chip.textContent = describe(f, p); chip.parentElement?.classList.toggle("on", isActive(f, p)); }
    };
    let body: HTMLElement;
    if (p.kind === "set") {
      const counts = valueCounts(opts.items(), p);
      // values chosen before that no item has now stay in the list, so they can be unticked
      for (const v of f.values ?? []) if (!counts.some((c) => c.value === v)) counts.push({ value: v, n: 0 });
      const chosen = new Set(f.values ?? []);
      const q = h("input.input", { type: "search", placeholder: "Find a value", "aria-label": "Find a value", hidden: counts.length <= 8 }) as HTMLInputElement;
      const list = h("div.tf-values");
      const drawList = (): void => {
        const t = q.value.trim().toLowerCase();
        list.replaceChildren(...counts.filter((c) => !t || (c.value || "(empty)").toLowerCase().includes(t)).slice(0, 200).map((c) => h("label.tf-value", null,
          h("input", { type: "checkbox", checked: chosen.has(c.value), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(c.value); else chosen.delete(c.value); f.values = [...chosen]; live(); } }),
          h("span", null, c.value || "(empty)"), h("small.muted", null, String(c.n)))));
        if (!list.children.length) list.append(h("div.muted.small.pad", null, "No value found"));
      };
      q.addEventListener("input", drawList);
      drawList();
      const opSel = select([{ value: "any", label: "is any of" }, { value: "none", label: "is none of" }], f.op ?? "any", (v) => { f.op = v as Filter["op"]; live(); }, { "aria-label": "How to match" });
      body = h("div.tf-body", null, h("div.tf-row", null, h("b", null, p.label), opSel), q, list);
    } else if (p.kind === "number" || p.kind === "date") {
      const type = p.kind === "number" ? "number" : "date";
      const lo = h("input.input", { type, "aria-label": "From", value: p.kind === "number" ? String(f.min ?? "") : (f.from ?? "") }) as HTMLInputElement;
      const hi = h("input.input", { type, "aria-label": "To", value: p.kind === "number" ? String(f.max ?? "") : (f.to ?? "") }) as HTMLInputElement;
      const read = (): void => {
        if (p.kind === "number") {
          const n = (s: string): number | undefined => (s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
          f.min = n(lo.value);
          f.max = n(hi.value);
        } else { f.from = lo.value || undefined; f.to = hi.value || undefined; }
        live();
      };
      lo.addEventListener("input", read);
      hi.addEventListener("input", read);
      body = h("div.tf-body", null, h("b", null, p.label), h("div.tf-row", null, h("span.small.muted", null, "from"), lo, h("span.small.muted", null, "to"), hi),
        h("p.small.muted", null, p.kind === "number" ? "Both ends included. Leave one empty for no bound. Items with no value are left out." : "Both days included. Items with no date are left out."));
    } else {
      const seg = select([{ value: "", label: "Any" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }], f.is == null ? "" : f.is ? "yes" : "no",
        (v) => { f.is = v === "" ? undefined : v === "yes"; live(); }, { "aria-label": p.label });
      body = h("div.tf-body", null, h("div.tf-row", null, h("b", null, p.label), seg));
    }
    popup(anchor, body);
    (body.querySelector("input:not([hidden]), select") as HTMLElement | null)?.focus();
  }

  const refresh = (): void => { fill(); draw(); };
  refresh();
  return {
    el,
    test: (w) => passesAll(w, filters, props),
    active: () => setOn().length > 0,
    refresh,
    clear: () => { if (filters.length) { filters = []; changed(); } },
    filters: () => filters,
    props: () => props,
  };
}

// ---------- people ----------

export interface PeopleStripOpts {
  api: Api;
  /** where the choices are kept in this browser; or `store` to keep them elsewhere */
  key?: string;
  store?: { get: () => PeoplePick; set: (p: PeoplePick) => void };
  /** the items counted per person */
  items: () => Iterable<WorkItem>;
  /** the person of an item (default: its owner) */
  personOf?: (w: WorkItem) => Person | undefined;
  /** people to show even with nothing (count 0) */
  extra?: () => Person[];
  onChange: () => void;
  /** people shown before the rest go into a "+N" list (default 10) */
  max?: number;
}

export interface PeopleStrip {
  el: HTMLElement;
  /** does the item's person pass? */
  test: (w: WorkItem) => boolean;
  /** does this person pass? (no person = nobody) */
  testPerson: (p: Person | undefined) => boolean;
  /** is any person filter set? */
  active: () => boolean;
  /** count again and redraw */
  refresh: () => void;
  clear: () => void;
}

export function peopleStrip(opts: PeopleStripOpts): PeopleStrip {
  const max = opts.max ?? 10;
  const personOf = opts.personOf ?? ((w: WorkItem) => w.assignedTo);
  const store = opts.store ?? {
    get: () => cleanPeople(prefs.get<unknown>(opts.key ?? "people", {})),
    set: (p: PeoplePick) => prefs.set(opts.key ?? "people", p),
  };
  let pick = cleanPeople(store.get());
  const el = blk("people", h("div.people"));
  const set = (next: PeoplePick): void => { pick = next; store.set(pick); draw(); opts.onChange(); };

  function draw(): void {
    const sorted = countPeople(opts.items(), personOf, opts.extra?.() ?? []);
    let closeMore = (): void => {};
    const chip = (c: { key: string; person?: Person; n: number }): HTMLElement => {
      const on = pick.only.includes(c.key);
      const off = pick.hidden.includes(c.key);
      const name = c.person?.displayName ?? "Nobody";
      return h(`button.pchip${on ? ".on" : ""}${off ? ".off" : ""}`, {
        type: "button", "aria-pressed": String(on),
        title: `${name}: ${c.n}. Click: only this person. Right-click: hide this person.`,
        onclick: () => { closeMore(); set(togglePerson(pick, c.key, "only")); },
        oncontextmenu: (e: Event) => { e.preventDefault(); closeMore(); set(togglePerson(pick, c.key, "hide")); },
      }, avatar(opts.api, c.person, 22, { title: "" }), h("span", null, String(c.n)));
    };
    // the first people show; the rest wait in a dropdown (anyone filtered stays in sight)
    const filtered = (k: string): boolean => pick.only.includes(k) || pick.hidden.includes(k);
    const shown = sorted.filter((c, i) => i < max || filtered(c.key));
    const rest = sorted.filter((c) => !shown.includes(c));
    const kids: HTMLElement[] = shown.map(chip);
    if (rest.length) kids.push(h("button.pchip.pmore", {
      type: "button",
      title: `${rest.length} more people: ${rest.map((c) => c.person?.displayName ?? "Nobody").join(", ")}`,
      onclick: (e: Event) => { closeMore = popup(e.currentTarget as Element, h("div.pmore-pop", null, h("p.small.muted", null, "Click: only this person. Right-click: hide."), h("div.people", null, rest.map(chip)))); },
    }, `+${rest.length}`, icon("down", 12)));
    if (pick.only.length || pick.hidden.length) kids.push(h("button.btn.link.small.pclear", { type: "button", title: "Show every person again", onclick: () => set({ only: [], hidden: [] }) }, "Clear person filters"));
    el.replaceChildren(...kids);
  }

  const testPerson = (p: Person | undefined): boolean => personPasses(keyOfPerson(p), pick);
  draw();
  return {
    el,
    test: (w) => testPerson(personOf(w)),
    testPerson,
    active: () => pick.only.length > 0 || pick.hidden.length > 0,
    refresh: draw,
    clear: () => { if (pick.only.length || pick.hidden.length) set({ only: [], hidden: [] }); },
  };
}

// ---------- search ----------

/** A page's search (the Search side of the field in src/ui/pagebar.ts). */
export interface SearchBox {
  el: HTMLElement;
  input: HTMLInputElement;
  /** the words typed, lower case */
  words: () => string[];
  /** set the text (and tell the page) */
  set: (v: string) => void;
}
