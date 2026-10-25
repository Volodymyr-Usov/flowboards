// Builds the extension page with nothing but Node: TypeScript types are removed by Node's own
// stripper, the ES modules are joined into one script, and script and styles are put inside
// a single dist/index.html. One file means one request when Azure DevOps opens the hub.
//
//   node tools/build.mjs            build once
//   import { build } from "./build.mjs"   (the dev server builds on every page load)
//
// Module rules the joiner relies on (checked here, so a mistake fails the build):
//   - only relative imports of .ts files, named imports only (no default export, no `export … from`)
//   - no import cycles
//   - an exported `let` is never reassigned (importers get its first value); share state in objects
import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");

process.removeAllListeners("warning"); // the stripper prints an "experimental" warning on every call
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });

const IMPORT_RE = /^[ \t]*import\s+(?:(\*\s+as\s+\w+)|\{([^}]*)\})\s+from\s+["']([^"']+)["'];?/gm;
const SIDE_IMPORT_RE = /^[ \t]*import\s+["']([^"']+)["'];?/gm;

/** The code with comments (and, with `strings`, the text inside strings) turned into spaces. Same length
 *  and line breaks, so a match found here is at the same place in the code. Template text is always
 *  blanked; with `strings`, regular expressions too. Keeps import-like text in comments and strings
 *  from counting as code. */
export function codeOnly(js, { strings = false } = {}) {
  const out = js.split("");
  const blank = (i) => { if (out[i] !== "\n" && out[i] !== "\r") out[i] = " "; };
  const KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
  const templates = []; // brace depth at each open ${ … }
  let depth = 0;
  let prev = ""; // the last code character: decides whether "/" starts a regular expression
  let word = "";
  const template = (i) => { // from just after ` or the } closing a ${ … }: blank the text up to ` or ${
    for (; i < js.length; i++) {
      if (js[i] === "\\") { blank(i++); blank(i); continue; }
      if (js[i] === "`") return i;
      if (js[i] === "$" && js[i + 1] === "{") { templates.push(depth); return i + 1; }
      blank(i);
    }
    return i;
  };
  for (let i = 0; i < js.length; i++) {
    const c = js[i], n = js[i + 1];
    if (c === "/" && n === "/") { for (; i < js.length && js[i] !== "\n"; i++) blank(i); i--; continue; }
    if (c === "/" && n === "*") { const end = js.indexOf("*/", i + 2); const stop = end < 0 ? js.length : end + 2; for (; i < stop; i++) blank(i); i--; continue; }
    if (/\s/.test(c)) continue;
    if (c === "'" || c === '"') {
      for (i++; i < js.length && js[i] !== c && js[i] !== "\n"; i++) { if (js[i] === "\\") { if (strings) blank(i); i++; } if (strings) blank(i); }
      prev = c; word = ""; continue;
    }
    if (c === "`") { i = template(i + 1); prev = "`"; word = ""; continue; }
    if (c === "}" && templates.length && templates[templates.length - 1] === depth) { templates.pop(); i = template(i + 1); prev = "`"; word = ""; continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || KEYWORDS.has(word))) {
      let cls = false;
      for (i++; i < js.length && js[i] !== "\n"; i++) {
        if (js[i] === "\\") { if (strings) blank(i); i++; }
        else if (js[i] === "[") cls = true;
        else if (js[i] === "]") cls = false;
        else if (js[i] === "/" && !cls) break;
        if (strings) blank(i);
      }
      prev = ")"; word = ""; continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    word = /[\w$]/.test(c) ? (/[\w$]/.test(prev) ? word + c : c) : "";
    prev = c;
  }
  return out.join("");
}

/** Replace the matches of `re` found in code only (not in comments), using the found text. */
function replaceCode(code, re, fn) {
  const mask = codeOnly(code);
  let out = "", at = 0;
  for (const m of mask.matchAll(re)) { out += code.slice(at, m.index) + fn(...m); at = m.index + m[0].length; }
  return out + code.slice(at);
}

async function loadModule(file, seen, order, stack) {
  if (seen.has(file)) {
    if (stack.includes(file)) throw new Error("Import cycle: " + [...stack, file].map(rel).join(" -> "));
    return;
  }
  seen.add(file);
  const ts = await readFile(file, "utf8");
  let js;
  try {
    js = stripTypeScriptTypes(ts, { mode: "strip" });
  } catch (e) {
    throw new Error(`${rel(file)}: ${e.message}`);
  }
  const deps = [];
  const code = codeOnly(js); // an import written in a comment is no dependency
  // an import whose names were all types is empty after stripping: no dependency at run time
  for (const m of code.matchAll(IMPORT_RE)) if (m[1] || m[2].trim()) deps.push(resolve(file, m[3]));
  for (const m of code.matchAll(SIDE_IMPORT_RE)) deps.push(resolve(file, m[1]));
  for (const d of deps) await loadModule(d, seen, order, [...stack, file]);
  order.push({ file, js });
}

function resolve(from, spec) {
  if (!spec.startsWith(".")) throw new Error(`${rel(from)}: only relative imports are allowed (${spec})`);
  if (!spec.endsWith(".ts")) throw new Error(`${rel(from)}: import with the .ts extension (${spec})`);
  return path.resolve(path.dirname(from), spec);
}

const rel = (f) => path.relative(root, f).replaceAll("\\", "/");
const modName = (f) => "__m_" + rel(f).replace(/^src\//, "").replace(/\.ts$/, "").replace(/[^A-Za-z0-9_]/g, "_");

export function wrap({ file, js }) {
  const exported = [];
  const fail = (what) => { throw new Error(`${rel(file)}: ${what}`); };
  if (/^\s*export\s*(\*|\{[^}]*\})\s*from\b/m.test(codeOnly(js))) fail(`"export … from" is not supported; import the names and export them`);
  let code = replaceCode(js, IMPORT_RE, (_, star, names, spec) => {
    const target = modName(resolve(file, spec));
    if (star) return `const ${star.replace(/\*\s+as\s+/, "").trim()} = ${target};`;
    const parts = names.split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${a.trim()}: ${b.trim()}` : a.trim(); });
    return parts.length ? `const { ${parts.join(", ")} } = ${target};` : "";
  });
  code = replaceCode(code, SIDE_IMPORT_RE, () => "");
  const lets = [];
  code = replaceCode(code, /^export\s+((?:async\s+)?function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kw, name) => {
    exported.push(name);
    if (kw === "let" || kw === "var") lets.push(name);
    return `${kw} ${name}`;
  });
  code = replaceCode(code, /^export\s*\{([^}]*)\};?/gm, (_, names) => {
    for (const n of names.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [a, b] = n.split(/\s+as\s+/);
      exported.push(b ? `${b.trim()}: ${a.trim()}` : a.trim());
    }
    return "";
  });
  // what is left must be plain code: any other import or export form would break the joined script
  const left = codeOnly(code, { strings: true });
  if (/^\s*export\s+default\b/m.test(left)) fail("default exports are not allowed");
  if (/(?<![.\w$])export\b/.test(left)) fail("an export form the joiner does not know");
  if (/(?<![.\w$])import\b(?!\s*\.\s*meta\b)/.test(left)) fail("an import form the joiner does not know (only `import { a } from \"./x.ts\"`, `import * as x from \"./x.ts\"` and `import \"./x.ts\"`)");
  // importers get an exported let's first value only, so it must never be set again
  // (a local variable of the same name counts too: rename it)
  for (const name of lets) {
    const n = name.replace(/\$/g, "\\$");
    const assign = new RegExp(`(?<![.\\w$])${n}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)?=(?![=>])`, "g");
    const step = new RegExp(`(?:\\+\\+|--)\\s*${n}(?![\\w$])|(?<![.\\w$])${n}\\s*(?:\\+\\+|--)`);
    const declared = new RegExp(`\\b(?:let|var)\\s+${n}\\s*=(?!=)`).test(left) ? 1 : 0; // the declaration's own "="
    if ((left.match(assign)?.length ?? 0) > declared || step.test(left)) fail(`the exported let "${name}" is set again; share changing state in an object instead`);
  }
  // blank lines left by removed types carry nothing; keep line count small
  code = code.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l, i, a) => l || (a[i - 1] ?? "") !== "").join("\n");
  return `// ${rel(file)}\nconst ${modName(file)} = (() => {\n${code}\nreturn { ${exported.join(", ")} };\n})();\n`;
}

async function listCss(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listCss(p)));
    else if (e.name.endsWith(".css")) out.push(p);
  }
  return out.sort((a, b) => rel(a).localeCompare(rel(b)));
}

export async function build({ write = true } = {}) {
  const order = [];
  await loadModule(path.join(src, "main.ts"), new Set(), order, []);
  const js = `(() => {\n"use strict";\n${order.map(wrap).join("\n")}\n})();\n`;
  const cssFiles = await listCss(src);
  const css = (await Promise.all(cssFiles.map((f) => readFile(f, "utf8"))))
    .map((c) => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n\s*\n/g, "\n")).join("\n");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  let html = await readFile(path.join(src, "index.html"), "utf8");
  // functions as replacements: the bundle contains "$&"-like text that String.replace would expand
  html = html.replace("/*CSS*/", () => css).replace("/*JS*/", () => js.replaceAll("</script", "<\\/script")).replaceAll("%VERSION%", () => process.env.RELEASE_VERSION || pkg.version);
  if (write) {
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "index.html"), html);
    await copyFile(path.join(root, "images", "icon.png"), path.join(root, "dist", "icon.png")).catch(() => {});
  }
  return { html, modules: order.length, bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = Date.now();
  build().then((r) => console.log(`dist/index.html: ${r.modules} modules, ${(r.bytes / 1024).toFixed(0)} KB, ${Date.now() - t} ms`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
