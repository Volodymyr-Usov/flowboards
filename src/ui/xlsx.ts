// A small Excel (.xlsx) writer with no library: an .xlsx file is a zip of a few XML files.
// Several sheets, a bold header row, numbers kept as numbers, dates as text. Plus the download.

export type Cell = string | number | null | undefined;
export interface Sheet { name: string; rows: Cell[][]; widths?: number[] }

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // characters XML 1.0 does not allow
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

/** Excel holds at most 32,767 characters in a cell: longer text is cut and ends with "…". */
export const MAX_CELL = 32767;
function fit(s: string): string {
  if (s.length <= MAX_CELL) return s;
  const cut = s.slice(0, MAX_CELL - 1);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut) + "…";
}

function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(sheet: Sheet): string {
  const widths = sheet.widths ?? guessWidths(sheet.rows);
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const rows = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    if (v == null || v === "") return "";
    const ref = `${colName(c)}${r + 1}`;
    const style = r === 0 ? ` s="1"` : "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(fit(String(v)))}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

function guessWidths(rows: Cell[][]): number[] {
  const n = Math.max(0, ...rows.map((r) => r.length));
  return Array.from({ length: n }, (_, c) => Math.min(60, Math.max(8, ...rows.slice(0, 200).map((r) => String(r[c] ?? "").length + 2))));
}

// Excel refuses a sheet name with \ / ? * [ ] :, over 31 characters, starting or ending with an
// apostrophe, empty, or "History" (reserved); names must differ ignoring case.
const trimName = (x: string): string => x.replace(/^[\s']+|[\s']+$/g, "");
export function safeName(s: string, used: Set<string>): string {
  const base = trimName(trimName(s.replace(/[\\/?*[\]:]/g, " ").replace(/[\u0000-\u001F￾￿]/g, "")).slice(0, 31)) || "Sheet";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()) || name.toLowerCase() === "history"; i++) name = `${trimName(base.slice(0, 30 - String(i).length))} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

export function xlsxFiles(sheets: Sheet[]): { name: string; data: string }[] {
  const used = new Set<string>();
  const names = sheets.map((s) => safeName(s.name, used));
  return [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
}

// ---------- a zip without compression (Excel reads it fine) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zipStored(files: { name: string; data: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

export function xlsx(sheets: Sheet[]): Uint8Array {
  return zipStored(xlsxFiles(sheets));
}

/** Offer the file to save. */
export function downloadXlsx(fileName: string, sheets: Sheet[]): void {
  const blob = new Blob([xlsx(sheets) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]+/g, " ").trim() + ".xlsx";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A cell's text as a value: plain numbers become numbers; codes with leading zeros and long ids stay text. */
export function toCell(text: string): Cell {
  const t = text.replace(/\s+/g, " ").trim();
  const plain = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t;
  return /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(plain) ? Number(plain) : t;
}

/** A header's text without the sort mark the table shows next to it. */
export function headerText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\s*[▲▼↑↓▴▾]$/, "");
}

// Decorations that are not data: pictures, icons, help buttons, hidden marks.
// Action buttons (Rename, Delete, Show…) are skipped too; a column left with no header and no values is dropped.
const SKIP = ".avatar, canvas, button.help, button.btn, [aria-hidden='true'], [data-xl-skip]";
// Inline tags that are part of a word; every other element is kept apart from its neighbours by a space.
const INLINE = new Set(["B", "I", "EM", "STRONG", "SUP", "SUB", "U", "MARK", "ABBR", "CODE"]);

/** The text of a table cell as Excel should get it: input values, picture labels, no decorations. */
export function cellText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const xl = el.getAttribute("data-xl");
  if (xl != null) return ` ${xl} `;
  if (el.matches(SKIP)) return "";
  if (el instanceof HTMLInputElement) return el.type === "checkbox" ? (el.checked ? "yes" : "no") : ` ${el.value} `;
  if (el instanceof HTMLTextAreaElement) return ` ${el.value} `;
  if (el instanceof HTMLSelectElement) return ` ${el.selectedOptions[0]?.textContent ?? ""} `;
  if (el.tagName.toLowerCase() === "svg") return el.getAttribute("role") === "img" ? ` ${el.getAttribute("aria-label") ?? ""} ` : "";
  if (el instanceof HTMLElement && el.hidden) return "";
  let s = "";
  for (const c of el.childNodes) s += cellText(c);
  return INLINE.has(el.tagName) ? s : ` ${s} `;
}

/** The rows of an HTML table as cells: header first; numbers stay numbers. */
export function tableRows(table: HTMLTableElement): Cell[][] {
  const out: Cell[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    if ((tr as HTMLElement).hidden || tr.hasAttribute("data-xl-skip") || tr.closest("table") !== table) continue;
    const row: Cell[] = [];
    for (const cell of tr.querySelectorAll<HTMLTableCellElement>(":scope > th, :scope > td")) {
      if (cell.hasAttribute("data-xl-skip")) continue;
      const text = cellText(cell);
      row.push(cell.tagName === "TH" && cell.closest("thead") ? headerText(text) : toCell(text));
      for (let i = 1; i < (Number(cell.colSpan) || 1); i++) row.push("");
    }
    if (row.some((c) => c !== "")) out.push(row);
  }
  return dropEmptyColumns(out);
}

/** Leave out columns that have neither a header nor any value (buttons-only columns). */
export function dropEmptyColumns(rows: Cell[][]): Cell[][] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const keep = Array.from({ length: width }, (_, c) => rows.some((r) => r[c] != null && r[c] !== ""));
  return keep.every(Boolean) ? rows : rows.map((r) => r.filter((_, c) => keep[c]));
}

/** Tab-separated text of the same rows (to paste into Excel when a download is blocked).
 *  Text Excel would take as a formula (=, +, -, @ first) gets an apostrophe in front; real numbers such
 *  as -3 stay numbers. A cell with a quote, tab or line break goes in quotes, as Excel itself copies it. */
export function tsv(rows: Cell[][]): string {
  return rows.map((r) => r.map(tsvCell).join("\t")).join("\n");
}

function tsvCell(c: Cell): string {
  if (c == null) return "";
  let s = String(c);
  if (typeof c !== "number" && /^[=+\-@\t\r]/.test(s) && !/^[-+]?((\d{1,3}(,\d{3})+|\d+)(\.\d+)?|\.\d+)$/.test(s.trim())) s = "'" + s;
  return /["\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
