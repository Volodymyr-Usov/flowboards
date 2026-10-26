// Column widths you set by dragging, like in Excel: grab the right edge of a column title and drag.
// Double-click the edge for the automatic widths again. Widths are kept in this browser, per table.
// The app gives every table on a page this (tables of class "data" and the Backlog's tree).
import { prefs } from "../core/settings.ts";
import { h } from "./dom.ts";

const MIN = 40;

export function resizableColumns(table: HTMLTableElement, key: string): void {
  if (table.dataset.resizable) return;
  const head = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!head || head.cells.length < 2) return;
  table.dataset.resizable = "1";
  const ths = [...head.cells];
  // a table that sizes its columns with <col> elements (the Backlog) gets the widths there
  const cols = [...table.querySelectorAll<HTMLElement>(":scope > colgroup > col")];
  const useCols = cols.length === ths.length;
  const prefKey = `cols:${key}`;

  const apply = (widths: number[]): void => {
    widths.forEach((w, i) => {
      const px = `${Math.round(w)}px`;
      if (useCols) cols[i].style.width = px;
      else { ths[i].style.width = px; ths[i].style.maxWidth = px; }
    });
    table.style.tableLayout = "fixed";
    table.style.width = `${Math.round(widths.reduce((a, w) => a + w, 0))}px`;
    table.classList.add("cols-sized");
  };
  const reset = (): void => {
    for (const c of cols) c.style.width = "";
    for (const th of ths) { th.style.width = ""; th.style.maxWidth = ""; }
    table.style.tableLayout = "";
    table.style.width = "";
    table.classList.remove("cols-sized");
    prefs.set(prefKey, null);
  };

  const saved = prefs.get<number[] | null>(prefKey, null);
  if (saved && saved.length === ths.length && saved.every((w) => typeof w === "number" && w >= MIN)) apply(saved);

  ths.forEach((th, i) => {
    const name = (th.textContent ?? "").replace(/\s+/g, " ").trim() || `column ${i + 1}`;
    // a separator the keyboard can reach: the arrow keys change the width, Delete gives the automatic widths
    const grip = h("span.col-grip", {
      role: "separator", "aria-orientation": "vertical", tabindex: 0, "aria-label": `Width of ${name}`,
      title: "Drag (or the arrow keys) to change the width; double-click (or Delete) for the automatic widths",
    });
    // the title's own click (sorting) is not this
    grip.addEventListener("click", (e) => e.stopPropagation());
    grip.addEventListener("dblclick", (e) => { e.stopPropagation(); reset(); });
    grip.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step && e.key !== "Delete" && e.key !== "Backspace") return;
      // the title's own keys (sorting on Enter) are not this
      e.preventDefault();
      e.stopPropagation();
      if (!step) { reset(); return; }
      const widths = ths.map((t) => t.getBoundingClientRect().width);
      widths[i] = Math.max(MIN, widths[i] + step * (e.shiftKey ? 50 : 10));
      apply(widths);
      grip.setAttribute("aria-valuenow", String(Math.round(widths[i])));
      prefs.set(prefKey, widths.map((w) => Math.round(w)));
    });
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const widths = ths.map((t) => t.getBoundingClientRect().width);
      apply(widths);
      const x0 = e.clientX;
      const w0 = widths[i];
      grip.setPointerCapture(e.pointerId);
      grip.classList.add("on");
      const move = (ev: PointerEvent): void => { widths[i] = Math.max(MIN, w0 + ev.clientX - x0); apply(widths); };
      const up = (): void => {
        grip.removeEventListener("pointermove", move);
        grip.classList.remove("on");
        prefs.set(prefKey, widths.map((w) => Math.round(w)));
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up, { once: true });
      grip.addEventListener("pointercancel", up, { once: true });
    });
    th.append(grip);
  });
}

/** Every table under `root` that is not resizable yet: the key names the page and the table. */
export function resizeTablesIn(root: ParentNode, page: string): void {
  for (const t of root.querySelectorAll<HTMLTableElement>("table.data, table.tree-table")) {
    if (t.dataset.resizable) continue;
    const n = t.tHead?.rows[t.tHead.rows.length - 1]?.cells.length ?? 0;
    resizableColumns(t, `${page}:${[...t.classList].filter((c) => c !== "data" && c !== "cols-sized").join(".") || "table"}:${n}`);
  }
}
