// Local test server. Two ways to open the extension page:
//   http://127.0.0.1:4320/                 demo data (no Azure DevOps)
//   http://127.0.0.1:4320/host.html?org=ORG&project=PROJECT&team=TEAM
//       a stand-in for the Azure DevOps host: it frames the page, answers its handshake the way
//       Azure DevOps does, and hands it a token from the Azure CLI (`az login`). Real data.
// The page is built again on every load. Local only (127.0.0.1); never part of the extension.
import http from "node:http";
import { execFile } from "node:child_process";
import { build } from "./build.mjs";

const PORT = Number(process.env.PORT ?? 4320);
let token = null;
let lastGood = null; // a file being edited can break the build for a moment: keep serving the last good page

// ADO_PAT_FILE=path: use a personal access token instead of the Azure CLI (an organization the CLI account cannot see)
const patFile = process.env.ADO_PAT_FILE;

function azToken() {
  if (patFile) return import("node:fs").then((fs) => ({ token: fs.readFileSync(patFile, "utf8").trim(), expiresAt: Date.now() + 8 * 3600000, pat: true }));
  return new Promise((resolve, reject) => {
    execFile(process.platform === "win32" ? "az.cmd" : "az",
      ["account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--query", "{t:accessToken,e:expiresOn}", "-o", "json"],
      { timeout: 60000, shell: process.platform === "win32" },
      (err, out) => {
        if (err) return reject(err);
        const j = JSON.parse(out);
        resolve({ token: j.t, expiresAt: Date.parse(j.e) || Date.now() + 30 * 60000 });
      });
  });
}

const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Dev host</title>
<style>html,body{margin:0;height:100%;font:13px system-ui;background:#1b1b1b;color:#ddd}
#bar{height:30px;display:flex;align-items:center;gap:10px;padding:0 10px;background:#333}
iframe{border:0;width:100%;height:calc(100% - 30px);display:block;background:#fff}</style></head>
<body><div id="bar">Stand-in Azure DevOps host · <span id="who"></span>
<button id="light">Light theme</button><button id="dark">Dark theme</button><span id="log"></span></div>
<iframe id="f"></iframe>
<script>
const p = new URLSearchParams(location.search);
const org = p.get("org"), project = p.get("project"), team = p.get("team");
document.getElementById("who").textContent = org + " / " + project + (team ? " / " + team : "");
const f = document.getElementById("f");
f.src = "/index.html" + (p.has("readonly") ? "?readonly" : "") + location.hash;
const theme = (dark) => dark ? { "background-color": "rgba(32, 31, 30, 1)", "text-primary-color": "rgba(255,255,255,.9)" } : { "background-color": "rgba(255, 255, 255, 1)", "text-primary-color": "rgba(0,0,0,.9)" };
let dark = p.has("dark");
const send = (m) => f.contentWindow.postMessage(JSON.stringify(m), "*");
window.addEventListener("message", async (e) => {
  if (e.source !== f.contentWindow) return;
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (!m.methodName) return;
  const reply = (result, error) => send({ id: m.id, jsonrpc: "2.0", result, error, handshakeToken: m.handshakeToken });
  document.getElementById("log").textContent = "last call: " + m.methodName;
  if (m.methodName === "initialHandshake") {
    const me = await (await fetch("/dev/me?org=" + encodeURIComponent(org))).json();
    reply({
      contributionId: "dev.dashboard-hub",
      context: {
        extension: { id: "dev.dashboard", publisherId: "", extensionId: "", version: "0.0.0" },
        user: me,
        host: { id: "dev", name: org, serviceVersion: "dev", type: 4 },
        pageContext: { webContext: {
          collection: { uri: "https://dev.azure.com/" + encodeURIComponent(org) + "/" },
          project: { id: "", name: project },
          team: team ? { id: "", name: team } : undefined,
        } },
      },
      themeData: theme(dark),
    });
  } else if (m.methodName === "getAccessToken") {
    const r = await fetch("/dev/token");
    if (!r.ok) return reply(undefined, { message: await r.text() });
    reply({ token: (await r.json()).token });
  } else if (m.methodName === "notifyLoadSucceeded" || m.methodName === "notifyLoadFailed") {
    reply(null);
  } else {
    reply(undefined, { message: "Not available in the stand-in host: " + m.methodName });
  }
});
document.getElementById("light").onclick = () => { dark = false; send({ id: 900000 + Date.now() % 1000, jsonrpc: "2.0", methodName: "dispatchEvent", instanceId: "DevOps.SdkClient", params: ["themeChanged", { detail: theme(false) }] }); };
document.getElementById("dark").onclick = () => { dark = true; send({ id: 900000 + Date.now() % 1000, jsonrpc: "2.0", methodName: "dispatchEvent", instanceId: "DevOps.SdkClient", params: ["themeChanged", { detail: theme(true) }] }); };
</script></body></html>`;

const json = (res, body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };

// The /dev/ routes hand out a real token: answer only pages of this server. A page on another site
// could reach 127.0.0.1 through a name it controls (DNS rebinding), so the Host must be ours, and a
// request from another origin is refused.
const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function devRequestAllowed(headers) {
  if (!OWN_HOSTS.has(String(headers.host ?? "").toLowerCase())) return false;
  if (headers.origin == null) return true;
  try { const o = new URL(headers.origin); return o.protocol === "http:" && OWN_HOSTS.has(o.host.toLowerCase()); } catch { return false; }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/dev/") && !devRequestAllowed(req.headers)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden: only pages of this local server may ask for this.");
  }
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let html;
      try { html = (await build({ write: false })).html; lastGood = html; } catch (e) {
        if (!lastGood) throw e;
        console.warn("Build failed, serving the last good page:", e.message);
        html = lastGood;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    if (url.pathname === "/host.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(HOST_PAGE);
    }
    if (url.pathname === "/dev/token") {
      if (!token || Date.now() > token.expiresAt - 5 * 60000) token = await azToken();
      return json(res, { token: token.token });
    }
    if (url.pathname === "/dev/me") {
      if (!token || Date.now() > token.expiresAt - 5 * 60000) token = await azToken();
      if (token.pat) {
        const org = url.searchParams.get("org");
        const c = await (await fetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/connectionData`, { headers: { Authorization: "Bearer " + token.token } })).json();
        const u = c.authenticatedUser ?? {};
        return json(res, { id: u.id ?? "", name: u.properties?.Account?.$value ?? "", displayName: u.providerDisplayName ?? "" });
      }
      const payload = JSON.parse(Buffer.from(token.token.split(".")[1], "base64url").toString());
      return json(res, { id: payload.oid ?? "", name: payload.upn ?? payload.unique_name ?? "", displayName: payload.name ?? "" });
    }
    res.writeHead(404);
    res.end("Not found");
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(e?.message ?? e));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Demo: http://127.0.0.1:${PORT}/\nReal data: http://127.0.0.1:${PORT}/host.html?org=ORG&project=PROJECT&team=TEAM`));
