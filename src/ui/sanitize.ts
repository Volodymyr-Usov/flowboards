// HTML from Azure DevOps (descriptions, comments) and from AI answers is cleaned before it is shown:
// only formatting tags stay, links get safe targets, scripts, style sheets and event handlers go.
// A few inline styles stay (colours, bold, alignment, sizes of pictures and table cells), each value
// checked against a strict pattern, so a small edit saved back does not strip the text's formatting.
const ALLOWED = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "sub", "sup", "br", "p", "div", "span", "font", "ul", "ol", "li",
  "code", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "td", "th", "img",
]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button", "textarea", "select", "svg", "math", "template", "noscript"]);

/** What happens to an element: kept (cleaned), dropped with its content, or replaced by its content. */
export function tagAction(tag: string): "keep" | "drop" | "unwrap" {
  const t = tag.toLowerCase();
  return DROP.has(t) ? "drop" : ALLOWED.has(t) ? "keep" : "unwrap";
}

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}%?\s*(,\s*\d{1,3}%?\s*){2}(,\s*(0|1|0?\.\d{1,3})\s*)?\)|[a-z]{3,20})$/i;
const LENGTH = /^(0|\d{1,4}(\.\d{1,2})?(px|pt|em|rem|%))$/i;
const SIZE = /^(auto|\d{1,4}(\.\d{1,2})?(px|pt|em|rem|%)?)$/i;
const BORDER_STYLE = /^(none|solid|dashed|dotted|double)$/i;
/** the value of each style kept, by property; width, height and border only where they make sense */
const STYLE: Record<string, { ok: (v: string) => boolean; tags?: string[] }> = {
  "color": { ok: (v) => COLOR.test(v) },
  "background-color": { ok: (v) => COLOR.test(v) },
  "font-weight": { ok: (v) => /^(normal|bold|bolder|lighter|[1-9]00)$/i.test(v) },
  "font-style": { ok: (v) => /^(normal|italic|oblique)$/i.test(v) },
  "text-decoration": { ok: (v) => /^(none|(underline|line-through|overline)(\s+(underline|line-through|overline)){0,2})$/i.test(v) },
  "text-decoration-line": { ok: (v) => /^(none|(underline|line-through|overline)(\s+(underline|line-through|overline)){0,2})$/i.test(v) },
  "text-align": { ok: (v) => /^(left|right|center|justify|start|end)$/i.test(v) },
  "width": { ok: (v) => SIZE.test(v), tags: ["img", "table", "td", "th"] },
  "height": { ok: (v) => SIZE.test(v), tags: ["img", "table", "td", "th"] },
  // "1px solid #ccc": a width, a line style and a colour, each at most once
  "border": { ok: (v) => borderOk(v), tags: ["table", "td", "th"] },
};

function borderOk(v: string): boolean {
  const parts = v.match(/rgba?\([^)]*\)|[^\s]+/gi) ?? [];
  if (!parts.length || parts.length > 3) return false;
  const kinds = parts.map((p) => (LENGTH.test(p) ? "w" : BORDER_STYLE.test(p) ? "s" : COLOR.test(p) ? "c" : "?"));
  return !kinds.includes("?") && new Set(kinds).size === kinds.length;
}

/**
 * The inline styles kept on an element, as "color: red; font-weight: bold" ("" for none). Only the
 * properties above, each value checked by its pattern; nothing that can load or run anything
 * (url(), expression(), escapes, "javascript") gets through.
 */
export function cleanStyle(style: string, tag: string): string {
  const out: string[] = [];
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim().replace(/\s*!important$/i, "").replace(/\s+/g, " ");
    const rule = STYLE[prop];
    if (!rule || (rule.tags && !rule.tags.includes(tag.toLowerCase()))) continue;
    // characters a safe value never needs: quotes, escapes, slashes, colons, angle brackets
    if (!value || /["'\\/:<>&@]|url|expression|script|import/i.test(value)) continue;
    if (rule.ok(value) && !out.some((x) => x.startsWith(prop + ":"))) out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

/**
 * The attributes kept on an element besides links and picture addresses (those are checked in clean):
 * cleaned styles, a table cell's span, a picture's size, a <font>'s colour. Every other attribute
 * (event handlers, classes, ids) goes.
 */
export function keptAttrs(tag: string, attrs: { name: string; value: string }[]): [string, string][] {
  const t = tag.toLowerCase();
  const get = (n: string): string | null => attrs.find((a) => a.name.toLowerCase() === n)?.value ?? null;
  const out: [string, string][] = [];
  const style = cleanStyle(get("style") ?? "", t);
  if (style) out.push(["style", style]);
  if (t === "td" || t === "th") for (const a of ["colspan", "rowspan"]) { const v = get(a); if (v && /^\d{1,3}$/.test(v)) out.push([a, v]); }
  if (t === "img") for (const a of ["width", "height"]) { const v = get(a)?.trim(); if (v && /^\d{1,4}%?$/.test(v)) out.push([a, v]); }
  if (t === "font") { const v = get("color")?.trim(); if (v && COLOR.test(v)) out.push(["color", v]); }
  return out;
}

/** Azure DevOps's mention mark: "version:2.0,{identity id}" for a person, "version:1.0" for a work item. */
const MENTION = /^version:\d+\.\d+(,[\w-]{1,64})?$/;

function safeUrl(u: string, img = false): string | null {
  const s = u.trim();
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) return s;
  if (img && /^data:image\/(png|gif|jpe?g|webp);/i.test(s)) return s;
  return null;
}

/** Hosts whose pictures are shown: Azure DevOps itself (attachments, avatars). Set by the app. */
let imageHosts: string[] = [];

/** Tell the cleaner the organization's address: pictures from its host are shown (Azure DevOps Server too). */
export function setImageHost(orgUrl: string): void {
  try { imageHosts = [new URL(orgUrl).hostname.toLowerCase()]; } catch { imageHosts = []; }
}

/**
 * May a picture with this address be shown? Pictures in the text (data:) and from Azure DevOps yes;
 * pictures from other sites no: they could tell that site who read the item and when.
 */
export function imageAllowed(src: string, hosts: string[] = imageHosts): boolean {
  const s = src.trim();
  if (/^data:image\/(png|gif|jpe?g|webp);/i.test(s)) return true;
  let host: string;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.hostname.toLowerCase();
  } catch { return false; }
  return host === "dev.azure.com" || host.endsWith(".dev.azure.com") || host.endsWith(".visualstudio.com") || hosts.includes(host);
}

/**
 * `forSaving`: the text goes back to Azure DevOps (built in a page that loads nothing), so a picture
 * shown as a link is written back as the picture it was.
 */
function clean(node: Node, doc: Document, forSaving = false): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const action = tagAction(tag);
  if (action === "drop") return null;
  if (forSaving && tag === "a" && el.getAttribute("data-image") === "1") {
    const src = safeUrl(el.getAttribute("href") ?? "", true);
    if (src) { const img = doc.createElement("img"); img.setAttribute("src", src); img.setAttribute("alt", ""); img.setAttribute("loading", "lazy"); return img; }
  }
  const kids = [...el.childNodes].map((c) => clean(c, doc, forSaving)).filter((x): x is Node => !!x);
  if (action === "unwrap") {
    const frag = doc.createDocumentFragment();
    frag.append(...kids);
    return frag;
  }
  const out = doc.createElement(tag);
  for (const [name, value] of keptAttrs(tag, [...el.attributes])) out.setAttribute(name, value);
  if (tag === "a") {
    const href = safeUrl(el.getAttribute("href") ?? "");
    if (href) { out.setAttribute("href", href); out.setAttribute("target", "_blank"); out.setAttribute("rel", "noopener noreferrer"); }
    // a mention (@person, #work item) keeps Azure DevOps's mark, so the person is notified and it shows as one
    const mention = el.getAttribute("data-vss-mention") ?? "";
    if (MENTION.test(mention)) {
      out.setAttribute("data-vss-mention", mention);
      out.setAttribute("class", "mention");
      if (!href && forSaving) out.setAttribute("href", "#");
    }
  } else if (tag === "img") {
    const src = safeUrl(el.getAttribute("src") ?? "", true);
    if (!src) return null;
    if (!forSaving && !imageAllowed(src)) {
      // a picture from another site is not loaded (it could track who reads the item): a link to it instead
      const a = doc.createElement("a");
      a.setAttribute("href", src);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      a.setAttribute("data-image", "1");
      a.textContent = `image: ${src}`;
      return a;
    }
    out.setAttribute("src", src);
    out.setAttribute("alt", el.getAttribute("alt") ?? "");
    out.setAttribute("loading", "lazy");
  }
  out.append(...kids);
  return out;
}

/** Clean HTML into a fragment ready to insert. */
export function sanitize(html: string | undefined): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!html) return frag;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const c of [...doc.body.childNodes]) { const n = clean(c, document); if (n) frag.append(n); }
  return frag;
}

/** Clean HTML back to a string (to save what someone typed in an editor). Built where nothing loads. */
export function sanitizeToString(html: string): string {
  const inert = document.implementation.createHTMLDocument("");
  const div = inert.createElement("div");
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const c of [...doc.body.childNodes]) { const n = clean(c, inert, true); if (n) div.append(n); }
  return div.innerHTML;
}


/** Plain text to HTML paragraphs (for AI drafts and comments typed as text). */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = text.trim().split(/\n/);
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join("")}</ul>`); list = []; } };
  for (const raw of lines) {
    const l = raw.trim();
    const m = /^[-*•]\s+(.*)$/.exec(l);
    if (m) { list.push(esc(m[1])); continue; }
    flush();
    if (l) out.push(`<div>${esc(l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}</div>`);
  }
  flush();
  return out.join("");
}
