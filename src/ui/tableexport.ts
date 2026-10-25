// Excel and Copy: what a page shows as an .xlsx file (after a short dialog: file name and a preview),
// or copied straight to the clipboard as a table to paste. The top bar's Excel and Copy act on the page:
// its own sheets when it gives them (the Board's cards), else every table shown, one sheet each.
import { h, icon, svg } from "./dom.ts";
import { dialog, toast } from "./kit.ts";
import type { Cell, Sheet } from "./xlsx.ts";
import { downloadXlsx, tableRows, tsv } from "./xlsx.ts";

export async function copyRows(rows: Cell[][], what?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(tsv(rows));
    toast(`Copied ${what ?? `${rows.length - 1} rows`}: paste into Excel`, { kind: "ok" });
  } catch {
    toast("The browser did not allow copying here.", { kind: "error" });
  }
}

/** The Excel mark: a green sheet with a white X. */
export function excelIcon(size = 16): SVGElement {
  return svg("svg", { class: "xl-icon", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" },
    svg("path", { d: "M8 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8z", fill: "#21a366" }),
    svg("path", { d: "M14.5 3v18M8 9h13M8 15h13", stroke: "#ffffff", "stroke-opacity": ".45", "stroke-width": 1, fill: "none" }),
    svg("rect", { x: 2, y: 6, width: 11, height: 12, rx: 1.5, fill: "#107c41" }),
    svg("path", { d: "M5 9l5 6M10 9l-5 6", stroke: "#ffffff", "stroke-width": 1.8, "stroke-linecap": "round", fill: "none" }));
}

/** Ask for the file name and show what goes in, then download. */
export async function excelDialog(name: string, sheets: Sheet[]): Promise<void> {
  const filled = sheets.filter((sh) => sh.rows.length > 1 || sheets.length > 1);
  if (!filled.length) { toast("Nothing to export", { kind: "error" }); return; }
  const input = h("input.input.xl-name", { type: "text", value: fileName(name), "aria-label": "File name", spellcheck: false }) as HTMLInputElement;
  const preview = (sh: Sheet): HTMLElement => {
    const cols = Math.max(0, ...sh.rows.map((r) => r.length));
    return h("div.xl-sheet", null,
      h("p.small", null, h("b", null, sh.name), ` · ${sh.rows.length - 1} rows, ${cols} columns`),
      h("div.xl-preview", null, h("table.data", null,
        h("thead", null, h("tr", null, (sh.rows[0] ?? []).map((c) => h("th", null, String(c ?? ""))))),
        h("tbody", null, sh.rows.slice(1, 6).map((r) => h("tr", null, r.map((c) => h("td", null, String(c ?? "")))))))),
      sh.rows.length > 6 ? h("p.small.muted", null, `… and ${sh.rows.length - 6} more rows`) : null);
  };
  const go = (): boolean => {
    const n = input.value.trim().replace(/\.xlsx$/i, "");
    if (!n) { input.focus(); return false; }
    downloadXlsx(n, filled);
    toast(`Downloading ${n}.xlsx`, { kind: "ok" });
    return true;
  };
  // Enter in the name box presses Download
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.closest(".dialog")?.querySelector<HTMLButtonElement>(".dialog-foot .btn.primary")?.click(); } });
  await dialog("Download as Excel", h("div.xl-dialog", null,
    h("label.set-field", null, h("span", null, "File name"), h("div.xl-namebox", null, input, h("span.muted", null, ".xlsx"))),
    h("p.small.muted", null, "The rows as they are on screen, filters and sorting included."),
    filled.map(preview)), [
    { label: "Cancel", value: "" },
    { label: "Download", primary: true, onClick: () => go() },
  ], { wide: true });
}

/** Excel and Copy icons for several sheets (Copy puts them one after another). */
export function sheetButtons(name: string, sheets: () => Sheet[], copyWhat?: string): HTMLElement {
  return h("span.xl-tools", null,
    h("button.btn.small.xl-btn", { type: "button", title: "Download as an Excel file", "aria-label": "Download as an Excel file", onclick: () => void excelDialog(name, sheets()) }, excelIcon(16)),
    h("button.btn.small.xl-btn", { type: "button", title: "Copy as a table to paste into Excel", "aria-label": "Copy as a table", onclick: () => void copyRows(copyRowsOf(sheets()), copyWhat) }, icon("copy", 15)));
}

export function fileName(name: string): string {
  return `${name} ${new Date().toISOString().slice(0, 10)}`;
}

/** The nearest heading above a table inside the view (not a fold label such as "Table"), or "". */
export function headingOf(table: HTMLElement, root: HTMLElement): string {
  for (let el = table.parentElement; el && el !== root.parentElement; el = el.parentElement) {
    const above = [...el.querySelectorAll("h2, h3, h4")].filter((x) => !x.closest("table") && (x.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING));
    const text = above[above.length - 1]?.textContent?.replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

/** A table of the page: the heading above it and its rows (the first row is the header). */
export interface PageTable { heading: string; rows: Cell[][] }

/** One sheet per table that has rows, named after its heading (or the page), "2", "3"… when names repeat. */
export function pageSheets(pageTitle: string, tables: PageTable[]): Sheet[] {
  const taken = new Set<string>();
  const out: Sheet[] = [];
  for (const t of tables) {
    if (t.rows.length < 2) continue;
    const heading = t.heading.replace(/\s+/g, " ").trim();
    const base = heading && heading.length < 40 && heading !== pageTitle ? heading : pageTitle;
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
    taken.add(name.toLowerCase());
    out.push({ name, rows: t.rows });
  }
  return out;
}

/** What Copy puts on the clipboard: one table as it is; several one after another (name line, rows, blank line). */
export function copyRowsOf(sheets: Sheet[]): Cell[][] {
  if (sheets.length === 1) return sheets[0].rows;
  return sheets.flatMap((sh, i) => [...(i ? [[]] : []), [sh.name], ...sh.rows]);
}

/** The tables shown on the page: not in a popup or dialog, not hidden, with at least one row under the header. */
export function shownTables(root: HTMLElement): HTMLTableElement[] {
  return [...root.querySelectorAll<HTMLTableElement>("table")].filter((t) =>
    !t.closest(".popup, .dialog") && t.getClientRects().length > 0 && t.rows.length > 1);
}

/** Every table shown on the page as sheets, as on screen (filters and sorting included). */
export function tableSheets(root: HTMLElement, pageTitle: string): Sheet[] {
  return pageSheets(pageTitle, shownTables(root).map((t) => ({ heading: headingOf(t, root), rows: tableRows(t) })));
}
