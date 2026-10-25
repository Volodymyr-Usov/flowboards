// HTML from Azure DevOps (descriptions, comments) and from AI answers is cleaned before it is shown:
// only formatting tags stay, links get safe targets, scripts, styles and event handlers go.
const ALLOWED = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "sub", "sup", "br", "p", "div", "span", "ul", "ol", "li",
  "code", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "td", "th", "img",
]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button", "textarea", "select", "svg", "math", "template", "noscript"]);

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
  if (DROP.has(tag)) return null;
  if (forSaving && tag === "a" && el.getAttribute("data-image") === "1") {
    const src = safeUrl(el.getAttribute("href") ?? "", true);
    if (src) { const img = doc.createElement("img"); img.setAttribute("src", src); img.setAttribute("alt", ""); img.setAttribute("loading", "lazy"); return img; }
  }
  const kids = [...el.childNodes].map((c) => clean(c, doc, forSaving)).filter((x): x is Node => !!x);
  if (!ALLOWED.has(tag)) {
    const frag = doc.createDocumentFragment();
    frag.append(...kids);
    return frag;
  }
  const out = doc.createElement(tag);
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
  } else if (tag === "td" || tag === "th") {
    for (const a of ["colspan", "rowspan"]) { const v = el.getAttribute(a); if (v && /^\d+$/.test(v)) out.setAttribute(a, v); }
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
