// Makes the .vsix package for the Visual Studio Marketplace with Node alone (no tfx-cli).
// A .vsix is a zip with two manifests made from vss-extension.json; the format below matches
// what Microsoft's tfx-cli writes.
//
//   node tools/package.mjs                      dist/<publisher>.<id>-<version>.vsix
//   node tools/package.mjs --publisher me --version 1.2.3 --public
//   node tools/package.mjs --no-tests          skip the unit tests (they run first by default)
//
// The About page shows the package's version: --version, else vss-extension.json (which must match package.json).
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : undefined; };

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function filesUnder(rel) {
  const abs = path.join(root, rel);
  const st = await stat(abs);
  if (st.isFile()) return [rel.replaceAll("\\", "/")];
  const out = [];
  for (const e of await readdir(abs, { withFileTypes: true })) out.push(...(await filesUnder(path.join(rel, e.name))));
  return out;
}

const TYPES = { ".html": "text/html", ".png": "image/png", ".md": "text/markdown", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".vsixmanifest": "text/xml", ".vsomanifest": "application/json" };

export async function makeVsix() {
  const m = JSON.parse(await readFile(path.join(root, "vss-extension.json"), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (!arg("version") && m.version !== pkg.version) throw new Error(`vss-extension.json says ${m.version} but package.json says ${pkg.version}; make them the same, or pass --version`);
  if (arg("publisher")) m.publisher = arg("publisher");
  if (arg("version")) m.version = arg("version");
  if (!args.includes("--no-tests")) {
    const t = spawnSync(process.execPath, ["--test", "--disable-warning=ExperimentalWarning", "test/**/*.test.ts"], { cwd: root, stdio: "inherit" });
    if (t.status !== 0) throw new Error("Unit tests failed: no package made");
  }
  // the About page shows the version of this package
  process.env.RELEASE_VERSION = m.version;
  await build();
  if (args.includes("--public")) m.public = true;
  const flags = [...(m.galleryFlags ?? []), ...(m.public ? ["Public"] : [])];

  const assets = [];
  const files = new Set();
  for (const f of m.files ?? []) for (const p of await filesUnder(f.path)) { files.add(p); if (f.addressable) assets.push(`    <Asset Type="${xml(p)}" d:Source="File" Path="${xml(p)}" Addressable="true"/>`); }
  const special = [];
  if (m.icons?.default) { files.add(m.icons.default); special.push(`    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" d:Source="File" Path="${xml(m.icons.default)}" Addressable="true"/>`); }
  if (m.content?.details?.path) { files.add(m.content.details.path); special.push(`    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" d:Source="File" Path="${xml(m.content.details.path)}" Addressable="true"/>`); }
  if (m.content?.license?.path) { files.add(m.content.license.path); special.push(`    <Asset Type="Microsoft.VisualStudio.Services.Content.License" d:Source="File" Path="${xml(m.content.license.path)}" Addressable="true"/>`); }
  special.push(`    <Asset Type="Microsoft.VisualStudio.Services.Manifest" d:Source="File" Path="extension.vsomanifest" Addressable="true"/>`);

  const LINK_IDS = { privacypolicy: "PrivacyPolicy", getstarted: "GetStarted" }; // the others are just capitalised
  const links = Object.entries(m.links ?? {}).map(([k, v]) => `      <Property Id="Microsoft.VisualStudio.Services.Links.${LINK_IDS[k] ?? k[0].toUpperCase() + k.slice(1)}" Value="${xml(v.uri)}"/>`);
  if (/github\.com/i.test(m.repository?.uri ?? "")) links.push(`      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${xml(m.repository.uri)}"/>`);

  const vsix = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(m.id)}" Publisher="${xml(m.publisher)}" Version="${xml(m.version)}"/>
    <DisplayName>${xml(m.name)}</DisplayName>
    <Description xml:space="preserve">${xml(m.description ?? "")}</Description>
${flags.length ? `    <GalleryFlags>${xml(flags.join(" "))}</GalleryFlags>\n` : ""}    <Categories>${xml((m.categories ?? []).join(","))}</Categories>
    <Tags>${xml((m.tags ?? []).join(","))}</Tags>
    <Properties>
${links.join("\n")}
    </Properties>
${m.icons?.default ? `    <Icon>${xml(m.icons.default)}</Icon>\n` : ""}${m.content?.license?.path ? `    <License>${xml(m.content.license.path)}</License>\n` : ""}  </Metadata>
  <Dependencies/>
  <Installation>
${(m.targets ?? []).map((t) => `    <InstallationTarget Id="${xml(t.id)}"/>`).join("\n")}
  </Installation>
  <Assets>
${[...assets, ...special].join("\n")}
  </Assets>
</PackageManifest>`;

  const vso = { manifestVersion: m.manifestVersion ?? 1, repository: m.repository, scopes: m.scopes ?? [], contributions: m.contributions ?? [], contributionTypes: m.contributionTypes ?? [] };
  if (m.baseUri) vso.baseUri = m.baseUri;

  const exts = new Set([...files].map((f) => path.extname(f)).filter(Boolean));
  const noExt = [...files].filter((f) => !path.extname(f));
  const ctypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${[...exts, ".vsixmanifest", ".vsomanifest"].map((e) => `  <Default Extension="${e}" ContentType="${TYPES[e] ?? "application/octet-stream"}"/>`).join("\n")}
${noExt.map((f) => `  <Override ContentType="text/plain" PartName="/${xml(f)}"/>`).join("\n")}
</Types>`;

  const entries = [
    ["[Content_Types].xml", Buffer.from(ctypes)],
    ["extension.vsomanifest", Buffer.from(JSON.stringify(vso, null, 4))],
    ...(await Promise.all([...files].sort().map(async (f) => [f, await readFile(path.join(root, f))]))),
    ["extension.vsixmanifest", Buffer.from(vsix)],
  ];
  const zip = zipFiles(entries);
  const out = path.join(root, "dist", `${m.publisher}.${m.id}-${m.version}.vsix`);
  await writeFile(out, zip);
  return { out, bytes: zip.length, files: entries.length };
}

// ---------- a minimal zip writer (deflate, no zip64) ----------

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export function zipFiles(entries) {
  const { time, date } = dosTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data, { level: 9 });
    const useDeflate = comp.length < data.length;
    const body = useDeflate ? comp : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeVsix().then((r) => console.log(`${path.relative(root, r.out)}: ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
