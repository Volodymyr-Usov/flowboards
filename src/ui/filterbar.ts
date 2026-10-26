// The filter parts every page with work items uses, so filtering looks and works the same everywhere:
//   filterBar   chips for filters on any property, a "Filter" button with a property picker, an editor per kind
//   peopleStrip avatars with counts: click = only this person, right-click (or Shift+Enter) = hide; "+N" after 10 people
// The search field itself is part of every page's line 2: src/ui/pagebar.ts.
// Each page keeps its own choices in this browser (prefs) under its own key, per project and team (see scopeFilters).
// Both parts tell the page bar what they filter (filterSourceOf), so it can show "Filtered: 2 · Clear" even when
// the part itself is switched off in Settings. The logic: src/core/filters.ts.
import { blk } from "./blocks.ts";
import type { Api } from "../api/api.ts";
import type { Person, ProcessInfo, WorkItem } from "../api/types.ts";
import type { ChoiceStore, Filter, PeoplePick, Prop, ValueCount } from "../core/filters.ts";
import {
  BASE_PROPS, cleanFilters, cleanPeople, countPeople, describe, fieldProps, goneLabel, isActive, keyOfPerson, passesAll, personPasses, sameValue,
  teamKey, togglePerson, upgradeFilters, valueCounts, valueLabels,
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

// ---------- the team the choices belong to, and what is filtered now ----------

/** The project and team open now (set once by the app; a team change loads the page again): each team keeps its own filters. */
export const filterScope = { org: "", project: "", team: "" };

/** Called by the app with the team it opens (the organization too: browser storage is shared by every organization). */
export function scopeFilters(project: string, team: string, org = ""): void {
  filterScope.org = org;
  filterScope.project = project;
  filterScope.team = team;
}

const prefStore: ChoiceStore = { get: (k) => prefs.get<unknown>(k, undefined), set: (k, v) => prefs.set(k, v) };
const scoped = (key: string, empty: unknown, isEmpty: (v: unknown) => boolean): string => {
  const { org, project, team } = filterScope;
  return teamKey(prefStore, key, project || team ? `${org ? org + "/" : ""}${project}/${team}` : "", empty, isEmpty);
};

/** What a filter part tells the page bar: how many choices are on, what they are, and how to clear them. */
export interface FilterSource {
  what: "filters" | "people";
  count: () => number;
  says: () => string[];
  clear: () => void;
}

const sources = new WeakMap<Element, FilterSource>();
/** The filter part drawn in this element (the filter bar's or the person chips' own element), if any. */
export const filterSourceOf = (el: Element): FilterSource | undefined => sources.get(el);
/** Sent (it bubbles) by a filter part whenever its choices or its chips changed. */
export const FILTERS_CHANGED = "filterschange";
const tell = (el: HTMLElement): void => { el.dispatchEvent(new CustomEvent(FILTERS_CHANGED, { bubbles: true })); };

// ---------- filters on any property ----------

export interface FilterBarOpts {
  /** where the filters are kept in this browser: one key per page (kept per project and team) */
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
  const key = opts.store ? opts.key : scoped(opts.key, [], (v) => cleanFilters(v).length === 0);
  let filters: Filter[] = cleanFilters(opts.store ? opts.store.get() : prefs.get<unknown>(key, []));
  let props = new Map<string, Prop>();
  /** the words shown for values, by property: people's names for their sign-ins, sprints' names for their paths */
  let labels = new Map<string, Map<string, string>>();
  /** the page has items: a field that none of them has is really gone (not just not loaded yet) */
  let anyItem = false;
  const el = blk("filters", h("div.fbar"));
  const save = (): void => { if (opts.store) opts.store.set(filters); else prefs.set(key, filters); };
  const setOn = (): Filter[] => filters.filter((f) => isActive(f, props.get(f.prop)));
  const changed = (): void => { save(); draw(); opts.onChange(); };
  const showOf = (prop: string) => (v: string): string => labels.get(prop)?.get(v) ?? v;
  const text = (f: Filter): string => {
    const p = props.get(f.prop);
    return p ? describe(f, p, showOf(f.prop)) : anyItem ? goneLabel(f.prop) : describe(f, p);
  };
  const remove = (f: Filter): void => { const i = filters.indexOf(f); if (i >= 0) { filters.splice(i, 1); changed(); } };

  function fill(): void {
    const items = [...opts.items()];
    anyItem = items.length > 0;
    props = new Map([...BASE_PROPS, ...fieldProps(items, opts.names?.() ?? {})].map((p) => [p.id, p]));
    // filters saved with people's or sprints' names get their sign-ins and paths (in place: an open editor keeps its filter)
    const up = upgradeFilters(filters, props, items);
    if (up !== filters) { up.forEach((u, i) => { if (u !== filters[i]) filters[i].values = u.values; }); save(); }
    labels = new Map();
    for (const f of filters) {
      const p = props.get(f.prop);
      if (p?.shown && !labels.has(p.id)) labels.set(p.id, valueLabels(items, p));
    }
  }

  function draw(): void {
    el.replaceChildren(
      ...filters.map((f) => {
        const p = props.get(f.prop);
        const gone = !p && anyItem;
        return h(`span.chip.tf-chip${isActive(f, p) ? ".on" : ""}${gone ? ".gone" : ""}`, null,
          h("button.tf-edit", {
            type: "button",
            title: gone ? "No item here has this field now, so this filter does nothing. Click to remove it." : "Change this filter",
            onclick: (e: Event) => edit(e.currentTarget as Element, f),
          }, text(f)),
          h("button.icon-btn.small", { type: "button", title: "Remove this filter", "aria-label": `Remove the filter ${text(f)}`, onclick: () => remove(f) }, icon("close", 12)));
      }),
      h("button.btn.small.fbar-add", { type: "button", title: "Show only items whose property matches: type, state, owner, tags, sprint, dates, numbers or any other field", onclick: (e: Event) => add(e.currentTarget as Element) }, icon("filter", 13), opts.addLabel ?? "Filter"),
      filters.length ? h("button.btn.link.small", { type: "button", title: "Remove every filter", onclick: () => { filters = []; changed(); } }, "Clear filters") : "");
    tell(el);
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
          if (chip) edit(chip, f, true);
        },
      }, h("span", null, p.label), p.id.startsWith("field:") ? h("small", null, p.id.slice(6)) : null)));
      if (!box.children.length) box.append(h("div.muted.pad", null, "No property found"));
    };
    input.addEventListener("input", list);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") (box.querySelector(".pick-item") as HTMLElement | null)?.click(); });
    list();
    close = popup(anchor, h("div.picker.wide", null, input, box), { label: "Add a filter: pick a property" });
    input.focus();
  }

  /** The editor of one filter; `fresh`: just added, so closing it with nothing chosen takes it away again (no empty "X: any" chip). */
  function edit(anchor: Element, f: Filter, fresh = false): void {
    const p = props.get(f.prop);
    if (!p) {
      // a filter on a field no longer offered: say so, and offer to take it away
      const close = popup(anchor, h("div.tf-body", null,
        h("p.small", null, anyItem ? "No item here has this field now (it was removed or renamed), so this filter does nothing." : "This field is not loaded yet."),
        h("button.btn.small", { type: "button", title: "Remove this filter", onclick: () => { close(); remove(f); } }, "Remove this filter")), { label: text(f) });
      return;
    }
    // every change applies at once; the chip text follows
    const live = (): void => {
      save();
      opts.onChange();
      const chip = el.querySelectorAll<HTMLElement>(".tf-edit")[filters.indexOf(f)];
      if (chip) { chip.textContent = text(f); chip.parentElement?.classList.toggle("on", isActive(f, p)); }
      tell(el);
    };
    let body: HTMLElement;
    if (p.kind === "set") {
      const counts: ValueCount[] = valueCounts(opts.items(), p);
      // the chip shows the same words as the list
      labels.set(p.id, new Map([...(labels.get(p.id) ?? []), ...counts.map((c): [string, string] => [c.value, c.label])]));
      // values chosen before that no item has now stay in the list, so they can be unticked
      for (const v of f.values ?? []) if (!counts.some((c) => sameValue(p, c.value, v))) counts.push({ value: v, n: 0, label: showOf(p.id)(v) });
      const norm = (v: string): string => (p.fold ? v.toLowerCase() : v);
      const chosen = new Map((f.values ?? []).map((v) => [norm(v), v]));
      const q = h("input.input", { type: "search", placeholder: "Find a value", "aria-label": "Find a value", hidden: counts.length <= 8 }) as HTMLInputElement;
      const list = h("div.tf-values");
      const drawList = (): void => {
        const t = q.value.trim().toLowerCase();
        const hit = (c: ValueCount): boolean => !t || (c.label || "(empty)").toLowerCase().includes(t) || c.value.toLowerCase().includes(t);
        list.replaceChildren(...counts.filter(hit).slice(0, 200).map((c) => h("label.tf-value", { title: c.value !== c.label && c.value ? c.value : undefined },
          h("input", { type: "checkbox", checked: chosen.has(norm(c.value)), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.set(norm(c.value), c.value); else chosen.delete(norm(c.value)); f.values = [...chosen.values()]; live(); } }),
          h("span", null, c.label || "(empty)"), h("small.muted", null, String(c.n)))));
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
    popup(anchor, body, {
      label: `Filter: ${p.label}`,
      // a filter just added and left with nothing chosen (Esc, a click beside it) goes again
      onClose: fresh ? () => { if (!isActive(f, p)) remove(f); } : undefined,
    });
    (body.querySelector("input:not([hidden]), select") as HTMLElement | null)?.focus();
  }

  const refresh = (): void => { fill(); draw(); };
  const clear = (): void => { if (filters.length) { filters = []; changed(); } };
  sources.set(el, { what: "filters", count: () => setOn().length, says: () => setOn().map(text), clear });
  refresh();
  return {
    el,
    test: (w) => passesAll(w, filters, props),
    active: () => setOn().length > 0,
    refresh,
    clear,
    filters: () => filters,
    props: () => props,
  };
}

// ---------- people ----------

export interface PeopleStripOpts {
  api: Api;
  /** where the choices are kept in this browser (kept per project and team); or `store` to keep them elsewhere */
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
  const key = opts.store ? "" : scoped(opts.key ?? "people", { only: [], hidden: [] }, (v) => { const p = cleanPeople(v); return !p.only.length && !p.hidden.length; });
  const store = opts.store ?? {
    get: () => cleanPeople(prefs.get<unknown>(key, {})),
    set: (p: PeoplePick) => prefs.set(key, p),
  };
  let pick = cleanPeople(store.get());
  /** names by key, from the last count (for the page bar's "Filtered" text) */
  let names = new Map<string, string>();
  const el = blk("people", h("div.people"));
  const set = (next: PeoplePick): void => { pick = next; store.set(pick); draw(); opts.onChange(); };

  function draw(): void {
    const sorted = countPeople(opts.items(), personOf, opts.extra?.() ?? []);
    names = new Map(sorted.map((c) => [c.key, c.person?.displayName ?? "Nobody"]));
    let closeMore = (): void => {};
    const chip = (c: { key: string; person?: Person; n: number }): HTMLElement => {
      const on = pick.only.includes(c.key);
      const off = pick.hidden.includes(c.key);
      const name = c.person?.displayName ?? "Nobody";
      return h(`button.pchip${on ? ".on" : ""}${off ? ".off" : ""}`, {
        type: "button", "aria-pressed": String(on),
        "aria-label": `${name}, ${c.n}${on ? ", only this person is shown" : off ? ", hidden" : ""}`,
        title: `${name}: ${c.n}. Click: only this person. Right-click or Shift+Enter: ${off ? "show this person again" : "hide this person"}.`,
        onclick: () => { closeMore(); set(togglePerson(pick, c.key, "only")); },
        // the context menu key and Shift+F10 also send contextmenu
        oncontextmenu: (e: Event) => { e.preventDefault(); closeMore(); set(togglePerson(pick, c.key, "hide")); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); closeMore(); set(togglePerson(pick, c.key, "hide")); } },
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
      onclick: (e: Event) => { closeMore = popup(e.currentTarget as Element, h("div.pmore-pop", null, h("p.small.muted", null, "Click: only this person. Right-click or Shift+Enter: hide."), h("div.people", null, rest.map(chip))), { label: `${rest.length} more people` }); },
    }, `+${rest.length}`, icon("down", 12)));
    if (pick.only.length || pick.hidden.length) kids.push(h("button.btn.link.small.pclear", { type: "button", title: "Show every person again", onclick: () => set({ only: [], hidden: [] }) }, "Clear person filters"));
    el.replaceChildren(...kids);
    tell(el);
  }

  const testPerson = (p: Person | undefined): boolean => personPasses(keyOfPerson(p), pick);
  const clear = (): void => { if (pick.only.length || pick.hidden.length) set({ only: [], hidden: [] }); };
  const nameOf = (k: string): string => names.get(k) ?? k;
  sources.set(el, {
    what: "people",
    count: () => pick.only.length + pick.hidden.length,
    says: () => [
      pick.only.length ? `Only: ${pick.only.map(nameOf).join(", ")}` : "",
      pick.hidden.length ? `Hidden: ${pick.hidden.map(nameOf).join(", ")}` : "",
    ].filter(Boolean),
    clear,
  });
  draw();
  return {
    el,
    test: (w) => testPerson(personOf(w)),
    testPerson,
    active: () => pick.only.length > 0 || pick.hidden.length > 0,
    refresh: draw,
    clear,
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
