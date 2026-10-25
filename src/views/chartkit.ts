// Small chart parts for the Flow and People views: one tooltip, scales, axes, rounded bars, a
// legend, a table view under each chart, and a nearest-point hover layer for dot charts.
// Colors come from CSS tokens only (var(--s1)…); styles live in chartkit.css under .v-flow / .v-people.
import type { Child } from "../ui/dom.ts";
import { h, svg } from "../ui/dom.ts";
import { sortable } from "../ui/sortable.ts";

/** Series color token n (1–8). */
export const series = (n: number): string => `var(--s${n})`;

// ---------- tooltip ----------

export interface Tip {
  show(at: { clientX: number; clientY: number } | Element, body: Child): void;
  hide(): void;
}

/** One tooltip for a view, placed next to the pointer or the focused mark, kept inside the window. */
export function makeTip(host: HTMLElement): Tip {
  const el = h("div.ck-tip", { role: "tooltip", hidden: true });
  host.append(el);
  return {
    show(at, body) {
      el.replaceChildren(h("div", null, body));
      el.hidden = false;
      let x: number;
      let y: number;
      if (at instanceof Element) {
        const r = at.getBoundingClientRect();
        x = r.left + r.width / 2;
        y = r.top;
      } else { x = at.clientX; y = at.clientY; }
      const w = el.offsetWidth;
      const ht = el.offsetHeight;
      let left = x + 14;
      if (left + w > window.innerWidth - 8) left = x - w - 14;
      let top = y + 14;
      if (top + ht > window.innerHeight - 8) top = y - ht - 14;
      el.style.left = Math.max(8, left) + "px";
      el.style.top = Math.max(8, top) + "px";
    },
    hide() { el.hidden = true; },
  };
}

/** A tooltip line: the value first and strong, then what it is; an optional line key in the series color. */
export function tipRow(value: Child, label: Child, color?: string): HTMLElement {
  return h("div.ck-row", null, color ? h("i.ck-key", { style: { background: color } }) : null, h("b", null, value), h("span", null, label));
}

export function tipHead(text: Child): HTMLElement {
  return h("div.ck-head", null, text);
}

// ---------- scales and frame ----------

export type Scale = (v: number) => number;

export function linear(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

export interface Box { x0: number; x1: number; y0: number; y1: number }

/** An accessible chart: role img with a sentence that says what it shows. */
export function chartSvg(width: number, height: number, label: string): SVGElement {
  return svg("svg", { class: "ck", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
}

/** Horizontal hairline grid with labels on the left. */
export function yGrid(parent: SVGElement, ticks: number[], y: Scale, box: Box, fmt: (v: number) => string = String): void {
  const g = svg("g", { class: "ck-grid", "aria-hidden": "true" });
  for (const t of ticks) {
    const yy = Math.round(y(t)) + 0.5;
    g.append(svg("line", { x1: box.x0, x2: box.x1, y1: yy, y2: yy, class: t === 0 ? "base" : "" }));
    g.append(svg("text", { x: box.x0 - 6, y: yy, "text-anchor": "end", "dominant-baseline": "middle" }, fmt(t)));
  }
  parent.append(g);
}

/** Labels under the plot. */
export function xLabels(parent: SVGElement, labels: { x: number; text: string; anchor?: "start" | "middle" | "end" }[], y: number): void {
  const g = svg("g", { class: "ck-grid", "aria-hidden": "true" });
  for (const l of labels) g.append(svg("text", { x: l.x, y, "text-anchor": l.anchor ?? "middle", "dominant-baseline": "hanging" }, l.text));
  parent.append(g);
}

/** Pick about `max` evenly spaced indexes of n, always the last one. */
export function spacedIndexes(n: number, max: number): number[] {
  if (n <= 0) return [];
  const step = Math.max(1, Math.ceil(n / Math.max(1, max)));
  const out: number[] = [];
  for (let i = (n - 1) % step; i < n; i += step) out.push(i);
  return out;
}

/** A column: square at the baseline, 4px rounded at the data end. */
export function barPath(x: number, top: number, w: number, base: number): string {
  const hgt = base - top;
  if (hgt <= 0 || w <= 0) return "";
  const r = Math.min(4, w / 2, hgt);
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

/** Text width guess for 11px labels (no layout needed). */
export const textWidth = (s: string, px = 11): number => s.length * px * 0.58;

// ---------- legend and table view ----------

export function legend(items: { label: string; color: string; kind?: "rect" | "line" | "dot" }[]): HTMLElement {
  return h("div.ck-legend", null, items.map((i) => h("span", null, h(`i.ck-sw.${i.kind ?? "rect"}`, { style: { background: i.color } }), i.label)));
}

/** The chart's data as a table, folded away under the chart. */
export function tableView(head: string[], rows: Child[][], numeric: number[] = []): HTMLElement {
  return h("details.ck-table", null,
    h("summary", { title: "Show the numbers behind this chart as a table" }, "Table"),
    rows.length
      ? h("div.ck-table-scroll", null, sortable(h("table.data", null,
        h("thead", null, h("tr", null, head.map((t, i) => h(`th${numeric.includes(i) ? ".num" : ""}`, null, t)))),
        h("tbody", null, rows.map((r) => h("tr", null, r.map((c, i) => h(`td${numeric.includes(i) ? ".num" : ""}`, null, c))))))))
      : h("p.muted.small", null, "No data."));
}

// ---------- hover layers ----------

/**
 * A transparent layer over a dot chart: the pointer only has to be closest to a dot (within
 * `radius` px), not on it. Calls onHover(index or -1) and onClick(index).
 */
export function nearestLayer(parent: SVGElement, box: Box, points: { x: number; y: number }[],
  on: { hover: (i: number, e: PointerEvent) => void; click?: (i: number) => void }, radius = 24): void {
  const layer = svg("rect", { x: box.x0 - 6, y: box.y0 - 6, width: box.x1 - box.x0 + 12, height: box.y1 - box.y0 + 12, class: "ck-hit" });
  let cur = -1;
  const find = (e: PointerEvent): number => {
    const r = (parent as unknown as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best = -1;
    let bd = radius * radius;
    for (let i = 0; i < points.length; i++) {
      const dx = points[i].x - px;
      const dy = points[i].y - py;
      const dd = dx * dx + dy * dy;
      if (dd <= bd) { bd = dd; best = i; }
    }
    return best;
  };
  layer.addEventListener("pointermove", (e) => {
    const i = find(e as PointerEvent);
    cur = i;
    layer.classList.toggle("hot", i >= 0 && !!on.click);
    on.hover(i, e as PointerEvent);
  });
  layer.addEventListener("pointerleave", (e) => { cur = -1; layer.classList.remove("hot"); on.hover(-1, e as PointerEvent); });
  if (on.click) layer.addEventListener("click", () => { if (cur >= 0) on.click!(cur); });
  parent.append(layer);
}
