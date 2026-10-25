// Tags drawn in colour: every tag has a colour of its own (picked from its name, so the same tag looks the same
// everywhere); a click on a tag opens a small palette to choose another one. The choice is yours (screen choices,
// kept in this browser and in your own storage); the switch "Tag colours" in Settings > Cards turns all of it off.
import { prefs } from "../core/settings.ts";
import { h } from "./dom.ts";
import { popup } from "./kit.ts";

/** the chosen colours: tag (lower case) → 0 for plain grey, 1–8 for the series colours; a tag with no entry has its automatic colour */
const CHOICE_KEY = "tags.colors";
const BOARD_KEY = "board";

export const TAG_COLORS = ["Blue", "Orange", "Green", "Purple", "Gold", "Pink", "Lime", "Slate"];

/** "Tag colours" in Settings > Cards (on unless switched off there). */
export const tagColorsOn = (): boolean => prefs.get<{ tagColors?: boolean }>(BOARD_KEY, {}).tagColors !== false;

const chosen = (): Record<string, number> => {
  const v = prefs.get<unknown>(CHOICE_KEY, {});
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
};

/** The same name always gives the same colour: 1–8. */
export function autoColor(name: string): number {
  let n = 0;
  for (const c of name.toLowerCase()) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return (n % TAG_COLORS.length) + 1;
}

/** The colour of a tag now: 0 plain grey, 1–8 a series colour. */
export function tagColor(name: string): number {
  const c = chosen()[name.toLowerCase()];
  return typeof c === "number" && c >= 0 && c <= TAG_COLORS.length ? c : autoColor(name);
}

const colorVar = (i: number): string => (i ? `var(--s${i})` : "");

/** Give an element the colour of its tag (the CSS reads --tg). */
export function paintTag(el: HTMLElement, name: string): void {
  if (!tagColorsOn()) { el.classList.remove("tg"); el.style.removeProperty("--tg"); return; }
  el.classList.add("tg");
  const v = colorVar(tagColor(name));
  if (v) el.style.setProperty("--tg", v); else el.style.removeProperty("--tg");
}

function save(name: string, color: number | null): void {
  const all = { ...chosen() };
  if (color == null) delete all[name.toLowerCase()]; else all[name.toLowerCase()] = color;
  prefs.set(CHOICE_KEY, all);
  // every chip of this tag on the page changes at once
  for (const el of document.querySelectorAll<HTMLElement>("[data-tag]")) if (el.dataset.tag!.toLowerCase() === name.toLowerCase()) paintTag(el, el.dataset.tag!);
}

/** The palette under a tag: eight colours, plain grey, and back to the automatic one. */
export function pickTagColor(anchor: Element, name: string): void {
  if (!tagColorsOn()) return;
  const now = tagColor(name);
  const sw = (i: number, label: string): HTMLElement => h("button.tg-sw", { type: "button", class: [now === i && "on"], title: label, "aria-label": `${label} for ${name}`,
    style: { "--tg": colorVar(i) || "var(--muted)" }, onclick: () => { save(name, i); close(); } });
  const content = h("div.tg-pop", null,
    h("div.tg-name", null, `Colour of “${name}”`),
    h("div.tg-row", null, TAG_COLORS.map((c, k) => sw(k + 1, c)), sw(0, "Plain grey")),
    h("button.btn.link.small", { type: "button", onclick: () => { save(name, null); close(); } }, "Automatic colour"));
  const close = popup(anchor, content, { className: "tg-popup" });
}

/** A tag as a small chip (a button: a click opens the palette). Plain, with no colour and no click, when tag colours are off. */
export function tagChip(name: string, title?: string): HTMLElement {
  if (!tagColorsOn()) return h("span.tag", { title }, name);
  const b = h("button.tag", { type: "button", tabindex: -1, dataset: { tag: name }, title: title ?? `${name}: click to change its colour`,
    onclick: (e: Event) => { e.stopPropagation(); e.preventDefault(); pickTagColor(b, name); } }, name);
  paintTag(b, name);
  return b;
}
