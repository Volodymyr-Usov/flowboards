// Shared page parts: messages with Undo, dialogs, popup menus, person pictures and pickers,
// state and type marks, switches, and the loading, empty and error states.
import type { Api } from "../api/api.ts";
import type { Person, WorkItem } from "../api/types.ts";
import { initials, personKey, stateColor, typeColor } from "../core/model.ts";
import type { Workspace } from "../core/workspace.ts";
import type { Child } from "./dom.ts";
import { h, icon, once } from "./dom.ts";

// ---------- messages ----------

let toastHost: HTMLElement | null = null;
/** the latest message with Undo: Ctrl+Z (outside text boxes) runs it */
let lastUndo: { run: () => void; el: HTMLElement } | null = null;
const MAX_TOASTS = 3;

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
}

export function toast(message: Child, opts: { kind?: "info" | "ok" | "error"; undo?: () => Promise<unknown>; timeout?: number; action?: { label: string; run: () => void } } = {}): void {
  if (!toastHost) {
    toastHost = h("div.toasts", { role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z" || isTyping(e.target) || e.defaultPrevented) return;
      if (!lastUndo || !lastUndo.el.isConnected) return;
      e.preventDefault();
      lastUndo.run();
    });
  }
  const kind = opts.kind ?? "info";
  let timer = 0;
  const close = (): void => { clearTimeout(timer); el.classList.add("gone"); setTimeout(() => el.remove(), 200); if (lastUndo?.el === el) lastUndo = null; };
  // an Undo runs once: the button stops working after the first click
  const undo = opts.undo ? once(opts.undo) : undefined;
  const undoBtn = undo ? h("button.btn.link", {
    title: "Undo (Ctrl+Z)",
    onclick: async (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement;
      if (b.disabled) return;
      b.disabled = true;
      close();
      try { await undo(); toast("Undone", { kind: "ok", timeout: 2500 }); } catch (err) { toast("Undo failed: " + errorText(err), { kind: "error" }); }
    },
  }, icon("undo", 14), "Undo") as HTMLButtonElement : null;
  const el = h(`div.toast.${kind}`, null,
    h("div.msg", null, message),
    opts.action ? h("button.btn.link", { onclick: () => { close(); opts.action!.run(); } }, opts.action.label) : null,
    undoBtn,
    h("button.icon-btn", { title: "Close", "aria-label": "Close", onclick: close }, icon("close", 14)));
  // a success closes the error messages it answers
  if (kind === "ok") for (const old of toastHost.querySelectorAll<HTMLElement>(".toast.error:not(.gone)")) old.querySelector<HTMLButtonElement>(".icon-btn")?.click();
  toastHost.append(el);
  // only the newest few stay: older ones go first
  const live = [...toastHost.querySelectorAll<HTMLElement>(".toast:not(.gone)")];
  for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) old.querySelector<HTMLButtonElement>(".icon-btn")?.click();
  if (undoBtn) lastUndo = { run: () => undoBtn.click(), el };
  // the message waits while the mouse or the keyboard is on it
  const ms = opts.timeout ?? (kind === "error" ? 12000 : opts.undo ? 9000 : 4000);
  const start = (): void => { clearTimeout(timer); timer = window.setTimeout(close, ms); };
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", start);
  el.addEventListener("focusin", () => clearTimeout(timer));
  el.addEventListener("focusout", start);
  start();
}

export function errorText(e: unknown): string {
  const err = e as { status?: number; message?: string };
  if (err?.status === 412) return "Someone changed this item in the meantime. The latest version is now shown; please try again.";
  if (err?.status === 403 || err?.status === 401) return "Azure DevOps refused: you do not have permission for this. " + (err.message ?? "");
  return err?.message ?? String(e);
}

// ---------- dialogs ----------

export interface DialogAction { label: string; primary?: boolean; danger?: boolean; value?: string; onClick?: () => boolean | void | Promise<boolean | void> }

/** What someone typed or chose in a dialog, to tell whether closing it would lose work. Search boxes do not count. */
function formState(root: Element): string {
  return JSON.stringify([...root.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']")]
    .filter((x) => (x as HTMLInputElement).type !== "search")
    .map((x) => x.isContentEditable ? x.innerHTML : (x as HTMLInputElement).type === "checkbox" || (x as HTMLInputElement).type === "radio" ? String((x as HTMLInputElement).checked) : (x as HTMLInputElement).value));
}

/**
 * A modal dialog. Resolves with the chosen action's value ("" when closed).
 * Esc, the × and a click beside it ask before throwing away what was typed (`dirty`, by default: any
 * field changed since it opened). Enter in a one-line field, or Ctrl+Enter anywhere, presses the main button.
 */
export function dialog(title: string, body: Child, actions: DialogAction[] = [{ label: "Close", value: "" }], opts: { wide?: boolean; dirty?: () => boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const prev = document.activeElement as HTMLElement | null;
    const done = (v: string): void => { back.remove(); document.removeEventListener("keydown", onKey, true); prev?.focus?.(); resolve(v); };
    let asking = false;
    const isDirty = (): boolean => opts.dirty ? opts.dirty() : formState(box.querySelector(".dialog-body")!) !== initial;
    /** close without a choice: ask first when it would lose typed work */
    const dismiss = async (): Promise<void> => {
      if (asking) return;
      if (isDirty()) {
        asking = true;
        const ok = await confirm("Discard changes?", `What you typed in "${title}" will be lost.`, "Discard", true);
        asking = false;
        if (!ok) return;
      }
      done("");
    };
    // Only the topmost dialog takes keys (one can open over another), and not while a popup is open:
    // Escape then closes only the popup. Tab and Shift+Tab stay inside the dialog.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" && e.key !== "Tab" && e.key !== "Enter") return;
      const all = document.querySelectorAll(".backdrop");
      if (all[all.length - 1] !== back || openPopup?.el.isConnected || document.querySelector(".mention-pop")) return;
      if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); void dismiss(); return; }
      if (e.key === "Enter") {
        const t = e.target as HTMLElement;
        const oneLine = t.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes((t as HTMLInputElement).type);
        // a field that uses Enter itself (a new row in a list) says so with data-own-enter
        if (e.defaultPrevented || e.isComposing || !box.contains(t) || t.closest("[data-own-enter]") || !(oneLine || e.ctrlKey || e.metaKey)) return;
        const main = box.querySelector<HTMLButtonElement>(".dialog-foot button.primary:not(:disabled), .dialog-foot button.danger:not(:disabled)");
        if (!main) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        main.click();
        return;
      }
      const f = focusables(box);
      const active = document.activeElement;
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (!box.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    const box = h(`div.dialog${opts.wide ? ".wide" : ""}`, { role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div.dialog-head", null, h("h2", null, title), h("button.icon-btn", { "aria-label": "Close", onclick: () => void dismiss() }, icon("close"))),
      h("div.dialog-body", null, body),
      h("div.dialog-foot", null, actions.map((a) => h(`button.btn${a.primary ? ".primary" : ""}${a.danger ? ".danger" : ""}`, {
        onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          if (a.onClick) {
            btn.disabled = true;
            try { if ((await a.onClick()) === false) { btn.disabled = false; return; } } catch (err) { btn.disabled = false; toast(errorText(err), { kind: "error" }); return; }
          }
          // a plain Cancel (no value) also asks before throwing typed work away
          if (!a.primary && !a.danger && !a.onClick && !(a.value ?? "")) { void dismiss(); return; }
          done(a.value ?? a.label);
        },
      }, a.label))));
    const back = h("div.backdrop", { onmousedown: (e: Event) => { if (e.target === back) void dismiss(); } }, box);
    document.body.append(back);
    document.addEventListener("keydown", onKey, true);
    // a text box or the main button first; else the first control in the body or the buttons, else Close
    const start = focusables(box).find((x) => x.matches("input, textarea, select, button.primary"))
      ?? [...focusables(box.querySelector(".dialog-body")!), ...focusables(box.querySelector(".dialog-foot")!), ...focusables(box)][0];
    start?.focus();
    const initial = formState(box.querySelector(".dialog-body")!);
  });
}

/** The controls inside an element that Tab can reach, in order. */
function focusables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex], [contenteditable='true'], [contenteditable='plaintext-only']")]
    .filter((x) => !(x as HTMLButtonElement).disabled && x.tabIndex >= 0 && (x as HTMLInputElement).type !== "hidden" && x.getClientRects().length > 0);
}

export async function confirm(title: string, text: Child, okLabel = "OK", danger = false): Promise<boolean> {
  return (await dialog(title, h("p", null, text), [{ label: "Cancel", value: "" }, { label: okLabel, value: "ok", primary: !danger, danger }])) === "ok";
}

// ---------- popups ----------

let openPopup: { el: HTMLElement; close: () => void } | null = null;

export function closePopup(): void { openPopup?.close(); }

/** A popup next to an anchor; closes on Esc, a click outside or scroll. */
export function popup(anchor: Element, content: HTMLElement, opts: { align?: "left" | "right"; className?: string; onClose?: () => void } = {}): () => void {
  closePopup();
  const el = h(`div.popup${opts.className ? "." + opts.className : ""}`, { role: "dialog" }, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let left = opts.align === "right" ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 4;
  if (top + hgt > window.innerHeight - 8 && r.top - hgt - 4 > 8) top = r.top - hgt - 4;
  el.style.left = left + "px";
  el.style.top = Math.max(8, top) + "px";
  const onDown = (e: Event): void => { if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  // pressing what opened the popup again closes it (instead of opening it afresh)
  const onAnchor = (e: Event): void => { if (anchor.contains(e.target as Node)) { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
  // Escape closes only the popup, not a dialog or panel below it
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopImmediatePropagation(); close(); (anchor as HTMLElement).focus?.(); } };
  let closed = false;
  const close = (): void => {
    // the listeners go in every case (also when the popup left the page another way)
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("click", onAnchor, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    if (closed) return;
    closed = true;
    el.remove();
    if (openPopup?.el === el) openPopup = null;
    opts.onClose?.();
  };
  // listen from the next turn (the click that opened it must not close it), unless it closed already
  setTimeout(() => {
    if (closed) return;
    if (!el.isConnected) { close(); return; }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onAnchor, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
  });
  openPopup = { el, close };
  (el.querySelector("input, button") as HTMLElement | null)?.focus();
  return close;
}

export interface MenuItem { label: string; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }

export function menu(anchor: Element, items: (MenuItem | "-")[], align: "left" | "right" = "left"): void {
  let close = (): void => {};
  const list = h("div.menu", { role: "menu" }, items.map((it) => it === "-" ? h("hr", { role: "separator" }) : h(`button.menu-item${it.danger ? ".danger" : ""}`, {
    role: "menuitem", disabled: it.disabled, title: it.hint, tabindex: -1,
    onclick: () => { close(); it.onClick(); },
  }, it.icon ? icon(it.icon, 14) : null, h("span", null, it.label))));
  // arrows move between the items, Home and End jump, Tab leaves (one stop for the whole menu)
  const items$ = (): HTMLButtonElement[] => [...list.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
  list.addEventListener("keydown", (e) => {
    const all = items$();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (k: number): void => { e.preventDefault(); all[(k + all.length) % all.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? all.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Tab") { e.preventDefault(); close(); (anchor as HTMLElement).focus?.(); }
  });
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "true");
  close = popup(anchor, list, { align, onClose: () => anchor.setAttribute("aria-expanded", "false") });
  items$()[0]?.focus();
}

// ---------- people ----------

const avatarCache = new Map<string, string | null>();

/** A round picture of a person: initials first, the photo when Azure DevOps has one. */
export function avatar(api: Api, p: Person | undefined, size = 24, opts: { title?: string } = {}): HTMLElement {
  if (!p) return h("span.avatar.none", { style: { width: size + "px", height: size + "px", fontSize: Math.round(size * 0.45) + "px" }, title: opts.title ?? "Nobody" }, "?");
  const el = h("span.avatar", {
    style: { width: size + "px", height: size + "px", fontSize: Math.round(size * 0.42) + "px", "--hue": String(hue(personKey(p))) },
    title: opts.title ?? p.displayName,
  }, initials(p.displayName));
  const key = p.imageUrl ?? p.descriptor ?? "";
  if (!key) return el;
  const show = (url: string | null): void => {
    if (!url) return;
    const img = h("img", { src: url, alt: "", width: size, height: size, loading: "lazy" });
    img.onerror = () => img.remove();
    el.append(img);
  };
  if (avatarCache.has(key)) show(avatarCache.get(key)!);
  else void api.avatar(p).then((u) => { if (u) avatarCache.set(key, u); show(u); }, () => {});
  return el;
}

function hue(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x % 360;
}

/** Pick a person from a list with a search box. onPick(null) = nobody. */
export function personPicker(api: Api, anchor: Element, people: Person[], current: Person | undefined, onPick: (p: Person | null) => void, opts: { allowNone?: boolean } = {}): void {
  const input = h("input.input", { type: "search", placeholder: "Find a person", "aria-label": "Find a person" });
  const list = h("div.pick-list", { role: "listbox" });
  let close = (): void => {};
  const draw = (): void => {
    const q = input.value.trim().toLowerCase();
    list.replaceChildren();
    if (opts.allowNone !== false && !q) list.append(h("button.pick-item", { onclick: () => { close(); onPick(null); } }, avatar(api, undefined, 22), h("span", null, "Nobody")));
    for (const p of people.filter((x) => !q || x.displayName.toLowerCase().includes(q) || x.uniqueName.toLowerCase().includes(q)).slice(0, 60)) {
      list.append(h(`button.pick-item${current && personKey(current) === personKey(p) ? ".current" : ""}`, { onclick: () => { close(); onPick(p); } },
        avatar(api, p, 22), h("span", null, p.displayName), h("small", null, p.uniqueName.includes("@") ? p.uniqueName : "")));
    }
    if (!list.children.length) list.append(h("div.muted.pad", null, "Nobody found"));
  };
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") (list.querySelector(".pick-item") as HTMLElement | null)?.click(); });
  draw();
  close = popup(anchor, h("div.picker", null, input, list));
}

/** Pick a work item (by title or id) among the loaded ones. */
export function itemPicker(ws: Workspace, anchor: Element, filter: (w: WorkItem) => boolean, onPick: (w: WorkItem | null) => void, opts: { placeholder?: string; allowNone?: string } = {}): void {
  const input = h("input.input", { type: "search", placeholder: opts.placeholder ?? "Find by title or number" });
  const list = h("div.pick-list", { role: "listbox" });
  let close = (): void => {};
  const all = [...ws.items.values()].filter(filter);
  const draw = (): void => {
    const q = input.value.trim().toLowerCase();
    list.replaceChildren();
    if (opts.allowNone && !q) list.append(h("button.pick-item", { onclick: () => { close(); onPick(null); } }, h("span.muted", null, opts.allowNone)));
    const hits = all.filter((w) => !q || String(w.id).startsWith(q) || w.title.toLowerCase().includes(q)).slice(0, 80);
    for (const w of hits) list.append(h("button.pick-item", { onclick: () => { close(); onPick(w); } }, typeMark(ws, w.type), h("span.mono.muted", null, "#" + w.id), h("span", null, w.title)));
    if (!list.children.length) list.append(h("div.muted.pad", null, "Nothing found"));
  };
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") (list.querySelector(".pick-item") as HTMLElement | null)?.click(); });
  draw();
  close = popup(anchor, h("div.picker.wide", null, input, list));
}

// ---------- marks ----------

export function typeMark(ws: Workspace, type: string): HTMLElement {
  return h("span.type-mark", { style: { background: typeColor(ws.process, type) }, title: type });
}

export function stateMark(ws: Workspace, w: WorkItem): HTMLElement {
  return h("span.state", { title: `${w.state} (${w.category})` }, h("i", { style: { background: stateColor(ws.process, w.type, w.state) } }), w.state);
}

export function itemLink(ws: Workspace, w: WorkItem, onOpen?: (w: WorkItem) => void): HTMLElement {
  return h("a.item-link", {
    href: ws.itemUrl(w.id), target: "_blank", rel: "noopener",
    onclick: (e: MouseEvent) => { if (onOpen && !e.ctrlKey && !e.metaKey) { e.preventDefault(); onOpen(w); } },
  }, typeMark(ws, w.type), h("span.mono", null, "#" + w.id), " ", h("span.t", null, w.title));
}

// ---------- controls ----------

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, title?: string): HTMLElement {
  const input = h("input", { type: "checkbox", checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
  return h("label.switch", { title }, input, h("span.track"), h("span.lbl", null, label));
}

export function select<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void, props: Record<string, unknown> = {}): HTMLSelectElement {
  return h("select.input", { ...props, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) },
    options.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label)));
}

export function segmented<T extends string>(options: { value: T; label: string; title?: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const el = h("div.segmented", { role: "radiogroup" });
  for (const o of options) {
    el.append(h("button", {
      role: "radio", "aria-checked": String(o.value === value), title: o.title,
      onclick: () => { for (const b of el.children) b.setAttribute("aria-checked", "false"); el.querySelector(`[data-v="${o.value}"]`)?.setAttribute("aria-checked", "true"); onChange(o.value); },
      dataset: { v: o.value },
    }, o.label));
  }
  return el;
}

export function spinner(text = "Loading…"): HTMLElement {
  return h("div.loading", { role: "status" }, h("span.spin"), text);
}

export function empty(title: string, text?: Child, action?: { label: string; onClick: () => void }): HTMLElement {
  return h("div.empty", null, h("h3", null, title), text ? h("p", null, text) : null, action ? h("button.btn", { onclick: action.onClick }, action.label) : null);
}

export function failed(e: unknown, retry?: () => void): HTMLElement {
  return h("div.empty.error", null, h("h3", null, "Could not load this"), h("p", null, errorText(e)), retry ? h("button.btn", { onclick: retry }, "Try again") : null);
}

/** A small "?" that shows an explanation on hover and click. */
export function help(text: string): HTMLElement {
  return h("button.help", { type: "button", title: text, "aria-label": text, onclick: (e: Event) => popup(e.currentTarget as Element, h("div.help-pop", null, text)) }, "?");
}

/** Run an async job behind a button: disabled while it runs, errors as a message. */
export async function busy<T>(btn: HTMLButtonElement | null, job: () => Promise<T>): Promise<T | undefined> {
  if (btn) btn.disabled = true;
  try { return await job(); } catch (e) { toast(errorText(e), { kind: "error" }); return undefined; } finally { if (btn) btn.disabled = false; }
}
