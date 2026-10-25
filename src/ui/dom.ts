// Tiny helpers to build the page without a framework.
//   h("div.card#x", { onclick: fn, title: "..." }, "text", child, [more])
//   svg("path", { d: "M0 0L10 10", class: "line" })

export type Child = Node | string | number | null | undefined | false | Child[];
export type Props = Record<string, unknown> & {
  class?: string | (string | false | null | undefined)[];
  style?: string | Partial<Record<string, string | number>>;
  dataset?: Record<string, string | number>;
};

function addChildren(el: Element, kids: Child[]): void {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) addChildren(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

function applyProps(el: Element, props: Props | undefined, isSvg: boolean): void {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") {
      const c = Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v);
      if (c) el.setAttribute("class", (el.getAttribute("class") ? el.getAttribute("class") + " " : "") + c);
    } else if (k === "style") {
      if (typeof v === "string") el.setAttribute("style", v);
      else for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) if (sv != null) (el as HTMLElement).style.setProperty(sk.startsWith("--") ? sk : sk.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), String(sv));
    } else if (k === "dataset") {
      for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) (el as HTMLElement).dataset[dk] = String(dv);
    } else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (!isSvg && (k === "value" || k === "checked" || k === "disabled" || k === "selected" || k === "indeterminate" || k === "hidden" || k === "innerHTML" || k === "textContent")) {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

/** The element type for a tag written with classes or an id: "select.input" -> HTMLSelectElement. */
type TagName<S extends string> = S extends `${infer T}.${string}` ? TagName<T> : S extends `${infer T}#${string}` ? T : S;
export type ElementOf<S extends string> = TagName<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagName<S>] : TagName<S> extends "" ? HTMLDivElement : HTMLElement;

/** Create an element. The tag may carry classes and an id: "button.btn.primary#save". */
export function h<S extends string>(tag: S, props?: Props | null, ...kids: Child[]): ElementOf<S>;
export function h(tag: string, props?: Props | null, ...kids: Child[]): HTMLElement {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const name = m?.[1] || "div";
  const el = document.createElement(name);
  if (m?.[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  applyProps(el, props ?? undefined, false);
  addChildren(el, kids);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag: string, props?: Props | null, ...kids: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props ?? undefined, true);
  addChildren(el, kids);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

export function replace(el: Element, ...kids: Child[]): void {
  clear(el);
  addChildren(el, kids);
}

/** One delegated listener: on(container, "click", ".card", (e, card) => ...) */
export function on<E extends Event = Event>(root: EventTarget, type: string, selector: string, fn: (e: E, el: HTMLElement) => void, opts?: AddEventListenerOptions): () => void {
  const handler = (e: Event): void => {
    const t = (e.target as Element | null)?.closest?.(selector) as HTMLElement | null;
    if (t && (root as Element).contains?.(t) !== false) fn(e as E, t);
  };
  root.addEventListener(type, handler, opts);
  return () => root.removeEventListener(type, handler, opts);
}

/** Run at most once per animation frame. */
export function rafThrottle<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
  let pending: A | null = null;
  return (...a: A) => {
    if (pending) { pending = a; return; }
    pending = a;
    requestAnimationFrame(() => { const p = pending!; pending = null; fn(...p); });
  };
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** A job that runs at most once: later calls get the first run's promise (an Undo clicked twice). */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let run: Promise<T> | undefined;
  return () => (run ??= fn());
}


/** Icons: small inline SVG paths (24×24 grid), drawn with currentColor. */
const ICONS: Record<string, string> = {
  board: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v7h-4z",
  tree: "M4 4h6v4H4zM8 8v4h4M12 10h6v4h-6zM8 12v6h4M12 16h6v4h-6z",
  roadmap: "M3 5h9v3H3zM8 10.5h10v3H8zM5 16h12v3H5z",
  deps: "M5 6a2 2 0 1 0 0 .1M19 12a2 2 0 1 0 0 .1M5 18a2 2 0 1 0 0 .1M7 6l10 5M7 18l10-5",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v5M16 3v5",
  sprint: "M4 12a8 8 0 1 0 3-6.2M4 4v4h4M12 8v4l3 2",
  flow: "M3 20V10M8 20V4M13 20v-8M18 20V7",
  people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 1 0 0-5M21 20c0-2.5-1.5-4.6-3.7-5.5",
  pr: "M6 3a2 2 0 1 0 0 .1M6 5v14M6 19a2 2 0 1 0 0 .1M18 19a2 2 0 1 0 0 .1M18 17V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2",
  health: "M3 12h4l2-5 4 10 2-5h6",
  strategy: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  tag: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  projects: "M3 7h7l2 2h9v10H3z",
  log: "M6 4h12v16H6zM9 8h6M9 12h6M9 16h4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  poker: "M4 6l7-2 2 12-7 2zM13 5.5l6 1.5-3 12-3.2-.8M7.5 9l1 4",
  retro: "M4 5h16v10H9l-5 4zM8 9h8M8 12h5",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  warn: "M12 3l10 18H2zM12 10v5M12 18v.5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  chevron: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  up: "M6 15l6-6 6 6",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  split: "M12 3v6m0 0l-6 7m6-7l6 7M6 16v5m12-5v5M4 21h4m8 0h4",
  followup: "M5 4v8a4 4 0 0 0 4 4h10m0 0l-4-4m4 4l-4 4",
  contrast: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18M12 7h5M12 11h7M12 15h6",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  check: "M5 12l5 5 9-10",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  drag: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  back: "M15 6l-6 6 6 6",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
};

export function icon(name: keyof typeof ICONS | string, size = 16, extraClass = ""): SVGElement {
  return svg("svg", { class: `icon ${extraClass}`.trim(), width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" },
    svg("path", { d: ICONS[name] ?? ICONS.info }));
}
