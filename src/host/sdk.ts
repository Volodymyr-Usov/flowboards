// A small client for the Azure DevOps extension host, in place of Microsoft's extension SDK.
// The host page and our frame talk by window.postMessage with JSON-RPC messages ("XDM").
// We need four things from the host: the handshake (who, which organization and project),
// an access token, "loaded" (hides the host's spinner) and theme changes.

export interface HostUser { id: string; name: string; displayName: string; descriptor?: string; imageUrl?: string }
export interface HostContext {
  user: HostUser;
  host: { id: string; name: string; serviceVersion?: string; type?: number };
  extension: { id: string; publisherId: string; extensionId: string; version: string };
  collectionUri: string;
  project?: { id: string; name: string };
  team?: { id: string; name: string };
  theme?: Record<string, string>;
  contributionId?: string;
}

interface RpcMessage {
  id: number;
  jsonrpc?: "2.0";
  methodName?: string;
  instanceId?: string;
  instanceContext?: unknown;
  params?: unknown[];
  result?: unknown;
  error?: unknown;
  handshakeToken?: string;
  serializationSettings?: unknown;
}

const HOST_CONTROL = "DevOps.HostControl";
const SERVICE_MANAGER = "DevOps.ServiceManager";
const SDK_VERSION = 4.0;

export class Channel {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private targetOrigin: string | undefined;
  private token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private objects = new Map<string, Record<string, (...a: unknown[]) => unknown>>();
  private target: Window;

  constructor(target: Window) {
    this.target = target;
    window.addEventListener("message", (e) => this.receive(e));
  }

  register(instanceId: string, obj: Record<string, (...a: unknown[]) => unknown>): void {
    this.objects.set(instanceId, obj);
  }

  /**
   * A call to the host. It gives up after `timeoutMs` (default 60 s): a host that never answers cannot
   * keep a caller waiting, and the waiting entry is dropped so a late answer is ignored.
   */
  call<T>(methodName: string, instanceId: string, params: unknown[] = [], instanceContext?: unknown, serializationSettings?: unknown,
    timeout: { ms: number; what: string } = { ms: 60_000, what: methodName }): Promise<T> {
    const msg: RpcMessage = { id: this.next++, jsonrpc: "2.0", methodName, instanceId, params, instanceContext, serializationSettings };
    if (!this.targetOrigin) msg.handshakeToken = this.token;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`${timeout.what}: no answer from Azure DevOps after ${timeout.ms / 1000} s`));
      }, timeout.ms);
      this.pending.set(msg.id, {
        resolve: (v) => { clearTimeout(timer); (resolve as (v: unknown) => void)(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.target.postMessage(JSON.stringify(msg), "*");
    });
  }

  /** How many calls still wait for an answer (for tests). */
  waiting(): number { return this.pending.size; }

  private receive(e: MessageEvent): void {
    if (hostLog.length < 20) hostLog.push(`${e.source === this.target ? "parent" : "other"} ${e.origin}: ${String(typeof e.data === "string" ? e.data : JSON.stringify(e.data)).replace(/"token":"[^"]+"/g, '"token":"…"').slice(0, 240)}`);
    if (e.source !== this.target) return;
    let msg: RpcMessage;
    try { msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
    // current hosts send no "jsonrpc" field: recognise our messages by their numeric id instead
    if (!msg || typeof msg !== "object" || typeof msg.id !== "number") return;
    // The first answer proves who the host is: it echoes our handshake token. After that only that exact
    // origin counts (an empty or "null" origin, or one that only starts the same way, is not the host).
    if (this.targetOrigin) {
      if (e.origin !== this.targetOrigin) return;
    } else if (msg.handshakeToken === this.token && e.origin && e.origin !== "null") {
      this.targetOrigin = e.origin;
    } else return;

    if (msg.instanceId) { this.answer(msg); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(this.revive(msg.result));
  }

  private async answer(msg: RpcMessage): Promise<void> {
    const obj = this.objects.get(msg.instanceId!);
    const fn = obj && msg.methodName ? obj[msg.methodName] : undefined;
    const reply: RpcMessage = { id: msg.id, jsonrpc: "2.0" };
    if (msg.handshakeToken) reply.handshakeToken = msg.handshakeToken;
    try {
      if (!fn) throw new Error(`No method ${msg.methodName} on ${msg.instanceId}`);
      reply.result = await fn.apply(obj, msg.params ?? []);
    } catch (err) {
      reply.error = { message: String((err as Error)?.message ?? err) };
    }
    this.target.postMessage(JSON.stringify(reply), "*");
  }

  // Host services come back with functions replaced by { __proxyFunctionId: n }; calling one is a remote
  // call to "proxy<n>" on "__proxyFunctions". Dates come as { __proxyDate }.
  private revive(v: unknown, depth = 0): unknown {
    if (!v || typeof v !== "object" || depth > 50) return v;
    const o = v as Record<string, unknown>;
    if (o.__proxyFunctionId != null) {
      const id = "proxy" + String(o.__proxyFunctionId);
      return (...args: unknown[]) => this.call(id, "__proxyFunctions", args, {}, { includeUnderscoreProperties: true });
    }
    if (o.__proxyDate != null) return new Date(o.__proxyDate as string | number);
    if (Array.isArray(v)) return v.map((x) => this.revive(x, depth + 1));
    for (const k of Object.keys(o)) o[k] = this.revive(o[k], depth + 1);
    return o;
  }
}

let channel: Channel | null = null;
/** The first messages from the host, shown when the start fails (for diagnosis). */
export const hostLog: string[] = [];
let themeListener: ((theme: Record<string, string>) => void) | null = null;

export function inFrame(): boolean {
  try { return window.parent !== window; } catch { return true; }
}

/** A promise that gives up after `ms` (for a host function, whose waiting entry the channel drops itself after 60 s). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no answer from Azure DevOps after ${ms / 1000} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Start a channel to this host window (exported for tests; `connect` uses it). */
export function openChannel(target: Window): Channel {
  channel = new Channel(target);
  return channel;
}

/** Handshake with the host. Rejects when the page is not inside Azure DevOps. */
export async function connect(timeoutMs = 6000): Promise<HostContext> {
  if (!inFrame()) throw new Error("Not inside Azure DevOps");
  const ch = openChannel(window.parent);
  ch.register("DevOps.SdkClient", {
    dispatchEvent: (name: unknown, params: unknown) => {
      const detail = (params as { detail?: Record<string, string> })?.detail;
      if (name === "themeChanged" && detail && themeListener) themeListener(detail);
    },
  });
  const hs = await ch.call<Record<string, any>>("initialHandshake", HOST_CONTROL, [{ sdkVersion: SDK_VERSION, loaded: false, applyTheme: true }],
    undefined, undefined, { ms: timeoutMs, what: "Handshake" });
  const ctx = hs.context ?? {};
  // the page context sits inside "context" (older hosts put it at the top)
  const web = ctx.pageContext?.webContext ?? hs.pageContext?.webContext ?? {};
  const host = ctx.host ?? web.host ?? {};
  const extension = ctx.extension ?? {};
  let collectionUri: string = web.collection?.uri ?? web.host?.uri ?? "";
  if (!collectionUri && host.name) collectionUri = `https://dev.azure.com/${encodeURIComponent(host.name)}/`;
  if (!collectionUri.endsWith("/")) collectionUri += "/";
  const result: HostContext = {
    user: ctx.user ?? { id: web.user?.id, name: web.user?.uniqueName, displayName: web.user?.name },
    host, extension, collectionUri,
    project: web.project ? { id: web.project.id, name: web.project.name } : undefined,
    team: web.team ? { id: web.team.id, name: web.team.name } : undefined,
    theme: hs.themeData,
    contributionId: hs.contributionId,
  };
  if (!result.project) {
    // older hosts: the project comes from a host service
    try {
      const svc = await getService<{ getProject: () => Promise<{ id: string; name: string }> }>("ms.vss-tfs-web.tfs-page-data-service", 4000);
      const p = await withTimeout(svc.getProject(), 4000, "Project");
      if (p) result.project = { id: p.id, name: p.name };
    } catch { /* the app lets the person pick a project */ }
  }
  return result;
}

export function notifyLoaded(): void {
  channel?.call("notifyLoadSucceeded", HOST_CONTROL).catch(() => {});
}

export function notifyFailed(message: string): void {
  channel?.call("notifyLoadFailed", HOST_CONTROL, [message]).catch(() => {});
}

/** The signed-in person's token. Gives up after 20 s, so a host that does not answer cannot hold a request slot. */
export async function getAccessToken(): Promise<string> {
  if (!channel) throw new Error("Not connected to Azure DevOps");
  const t = await channel.call<string | { token: string }>("getAccessToken", HOST_CONTROL, [], undefined, undefined, { ms: 20_000, what: "Sign-in token" });
  return typeof t === "string" ? t : t.token;
}

/** A host service; gives up after `timeoutMs` (10 s), so a host that does not have it cannot keep the page waiting. */
export async function getService<T>(contributionId: string, timeoutMs = 10_000): Promise<T> {
  if (!channel) throw new Error("Not connected to Azure DevOps");
  return channel.call<T>("getService", SERVICE_MANAGER, [contributionId], undefined, undefined, { ms: timeoutMs, what: `Host service ${contributionId}` });
}

export function onThemeChanged(fn: (theme: Record<string, string>) => void): void {
  themeListener = fn;
}
