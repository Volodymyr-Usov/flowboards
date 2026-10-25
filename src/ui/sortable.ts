// Click a column title to sort the rows of a plain table by it: first click one way (numbers: highest
// first), second the other way, third back to the order the table was built in. A cell sorts by its
// data-sort attribute when it has one (a date, a duration), else by its text. Empty cells go last.
// Tables that sort themselves (a header with aria-sort) and tables with merged rows are left alone.

const kept = new Map<string, { col: number; dir: 1 | -1 }>();

const NUM = /^[-+]?\d[\d\s.,]*\s*(%|h|d)?$/;
const blank = (v: string): boolean => v === "" || v === "–" || v === "-";

function value(row: HTMLTableRowElement, col: number): string {
  const td = row.cells[col];
  return (td?.dataset.sort ?? td?.textContent ?? "").trim();
}

// "12 Oct 2026", "Oct 12", "2026-10-12": sorted by the day, not by the letters
const DATE = /^(\d{4}-\d{2}-\d{2}.*|\d{1,2} [A-Za-z]{3,9}( \d{4})?|[A-Za-z]{3,9} \d{1,2}(, \d{4})?)$/;

function compare(a: string, b: string): number {
  if (blank(a) || blank(b)) return Number(blank(a)) - Number(blank(b)); // blanks last; the caller keeps them there
  if (NUM.test(a) && NUM.test(b)) return parseFloat(a.replace(/[\s,]/g, "")) - parseFloat(b.replace(/[\s,]/g, ""));
  if (DATE.test(a) && DATE.test(b)) { const x = Date.parse(a); const y = Date.parse(b); if (Number.isFinite(x) && Number.isFinite(y)) return x - y; }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Make the table sortable by its column titles. `key` keeps the choice when the table is built again
 * (a view that draws its table anew). Rows with the class `pin` (totals, "unassigned") stay at the end.
 */
export function sortable<T extends HTMLTableElement>(table: T, key?: string): T {
  const head = table.tHead?.rows[table.tHead.rows.length - 1];
  const body = table.tBodies[0];
  if (!head || !body) return table;
  const rows = [...body.rows];
  if (rows.length < 2 || [...head.cells].some((c) => c.hasAttribute("aria-sort"))) return table;
  if (rows.some((r) => [...r.cells].some((c) => c.colSpan > 1))) return table;
  const pinned = rows.filter((r) => r.classList.contains("pin") || r.classList.contains("sp-unassigned"));
  const free = rows.filter((r) => !pinned.includes(r));
  let cur = key ? kept.get(key) : undefined;

  const paint = (): void => {
    for (const th of head.cells) {
      if (th.classList.contains("sortable")) th.setAttribute("aria-sort", cur && th.cellIndex === cur.col ? (cur.dir === 1 ? "ascending" : "descending") : "none");
    }
    const list = cur
      ? [...free].sort((a, b) => {
        const x = value(a, cur!.col);
        const y = value(b, cur!.col);
        return blank(x) !== blank(y) ? Number(blank(x)) - Number(blank(y)) : compare(x, y) * cur!.dir;
      })
      : free;
    body.append(...list, ...pinned);
  };

  for (const th of head.cells) {
    if (!th.textContent?.trim() || th.hasAttribute("data-xl-skip")) continue;
    const num = th.classList.contains("num");
    const col = th.cellIndex;
    const go = (): void => {
      if (!cur || cur.col !== col) cur = { col, dir: num ? -1 : 1 };
      else if (cur.dir === (num ? -1 : 1)) cur = { col, dir: (num ? 1 : -1) as 1 | -1 };
      else cur = undefined;
      if (key) { if (cur) kept.set(key, cur); else kept.delete(key); }
      paint();
    };
    th.classList.add("sortable");
    th.tabIndex = 0;
    th.title = th.title ? `${th.title}\nClick to sort` : "Click to sort by this column";
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }
  paint();
  return table;
}
