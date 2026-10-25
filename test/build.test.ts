import { test } from "node:test";
import assert from "node:assert/strict";

// the build script is plain JavaScript: loaded by URL so the type check does not need its types
const build = await import(String(new URL("../tools/build.mjs", import.meta.url)));
// a module path inside src/ (on Windows without the "/" before the drive letter)
const file = decodeURIComponent(new URL("../src/views/sample.ts", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");
const wrap = (js: string): string => build.wrap({ file, js });

test("imports written in comments, strings or template text are not code", () => {
  const out = wrap([
    "// see: import { a } from \"./a.ts\";",
    "/* import { b } from \"./b.ts\"; */",
    "const re = /x\\/*y/;",
    "const t = `",
    "import { c } from \"./c.ts\";",
    "`;",
    "import { d } from \"./d.ts\";",
    "export const e = d;",
  ].join("\n"));
  assert.match(out, /const \{ d \} = __m_views_d;/);
  assert.doesNotMatch(out, /const \{ (a|b|c) \}/);
  assert.match(out, /\/\/ see: import \{ a \}/);
  assert.match(out, /return \{ e \};/);
});

test("forms the joiner cannot join fail the build with a clear message", () => {
  assert.throws(() => wrap("export { a } from \"./a.ts\";\n"), /export … from/);
  assert.throws(() => wrap("export * from \"./a.ts\";\n"), /export … from/);
  assert.throws(() => wrap("import a from \"./a.ts\";\nexport const b = a;\n"), /import form/);
  assert.throws(() => wrap("export default 1;\n"), /default exports/);
});

test("an exported let set again fails the build", () => {
  assert.throws(() => wrap("export let n = 1;\nexport function bump() { n += 1; }\n"), /exported let "n"/);
  assert.throws(() => wrap("export let n = 1;\nexport function bump() { n++; }\n"), /exported let "n"/);
  assert.throws(() => wrap("export let n;\nexport function set() { n = 2; }\n"), /exported let "n"/);
  assert.doesNotMatch(wrap("export let n = 1;\nexport const ok = n === 1 && n >= 0 && o.n === 2;\n"), /throw/);
});
