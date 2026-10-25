// The Azure DevOps REST client. Runs in the browser with the signed-in person's token.
import type { Api, ApiContext, ExtensionDoc } from "./api.ts";
import { LocalDocs } from "./localdocs.ts";
import { BASE_FIELDS, normalizeItem, normalizePr, normalizeUpdate, person, personOrBlank, processFields } from "./normalize.ts";
import { ApiError } from "./types.ts";
import type { BoardInfo, Capacity, Comment, DeletedItem, Iteration, Level, PatchOp, Person, ProcessInfo, Project, PullRequest, QuerySpec, Repository, Tag, Team, TeamSettings, TypeInfo, Update, WorkItem } from "./types.ts";
import { matchesNothing, needsTimePrecision, toWiql } from "./wiql.ts";

const V = "api-version=7.1";
const VP = (n: number): string => `api-version=7.1-preview.${n}`;
const enc = encodeURIComponent;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

type TokenSource = () => Promise<string>;

/** A small gate so a big load never opens more than `max` requests at once. */
export class Gate {
  private running = 0;
  private queue: (() => void)[] = [];
  private max: number;
  constructor(max: number) { this.max = max; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // a waiting job takes over the place of the one that ends (the count stays), so a new job cannot slip in between
    if (this.running >= this.max) await new Promise<void>((r) => this.queue.push(r));
    else this.running++;
    try { return await fn(); } finally {
      const next = this.queue.shift();
      if (next) next(); else this.running--;
    }
  }
}

function jwtExpiry(token: string): number {
  try {
    const p = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof p.exp === "number" ? p.exp * 1000 : Date.now() + 30 * 60_000;
  } catch { return Date.now() + 30 * 60_000; }
}

/**
 * May this request be sent again when the answer was lost? Reads yes (GET, and the POSTs that only
 * read: WIQL query, work items batch, file diffs, subject lookup). Writes no: they could happen twice.
 */
export function safeToRepeat(method: string, url: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  if (m !== "POST") return false;
  const path = url.split("?")[0];
  return /\/_apis\/(wit\/wiql|wit\/workitemsbatch|git\/repositories\/[^/]+\/FileDiffs|graph\/subjectlookup)$/i.test(path);
}

/** The field named in a "field not found" error (TF51535), without a closing full stop or quote. */
export function missingFieldName(message: string): string | undefined {
  const m = /TF51535[^']*'([^']+)'|Cannot find field ([\w.]+)/i.exec(message);
  const f = (m?.[1] ?? m?.[2])?.trim().replace(/[.,;:!?'"]+$/, "");
  return f || undefined;
}

/** Host name of another Azure DevOps service (vssps, extmgmt) for the same organization. */
export function serviceUrl(orgUrl: string, service: "vssps" | "extmgmt"): string {
  const u = new URL(orgUrl);
  if (u.hostname === "dev.azure.com") return `https://${service}.dev.azure.com${u.pathname}`;
  const m = /^([^.]+)\.visualstudio\.com$/.exec(u.hostname);
  if (m) return `https://${m[1]}.${service}.visualstudio.com/`;
  return orgUrl; // Azure DevOps Server: same host
}

export class RestApi implements Api {
  ctx: ApiContext;
  private tokenSource: TokenSource;
  private token = "";
  private tokenExp = 0;
  private gate = new Gate(6);
  /** per project: fields (lower case) it does not have */
  private missingFields = new Map<string, Set<string>>();
  private avatars = new Map<string, Promise<string | null>>();
  private processCache = new Map<string, Promise<ProcessInfo>>();
  private boardCache = new Map<string, { columnField?: string; doneField?: string; rowField?: string }>();
  /** how long a read may take before it is given up (a write is never cut off: it may have happened) */
  timeoutMs = 60_000;

  /** "basic": the token is a personal access token (scripts and the end-to-end tests), not the host's sign-in */
  private scheme: "bearer" | "basic";

  constructor(ctx: ApiContext, tokenSource: TokenSource, opts: { tokenKind?: "bearer" | "basic" } = {}) {
    this.ctx = ctx;
    this.tokenSource = tokenSource;
    this.scheme = opts.tokenKind ?? "bearer";
  }

  private tokenJob: Promise<string> | undefined;

  private async auth(force = false): Promise<string> {
    if (force || !this.token || Date.now() > this.tokenExp - 5 * 60_000) {
      // requests that need a token at the same time share one ask to the host
      this.tokenJob ??= this.tokenSource().then((t) => {
        this.token = t;
        this.tokenExp = jwtExpiry(t);
        return t;
      }).finally(() => { this.tokenJob = undefined; });
      return this.tokenJob;
    }
    return this.token;
  }

  /**
   * One request with the token; retries once on 401, waits on 429, and on 503 or no answer repeats reads only.
   * A read that takes longer than `timeoutMs` is given up, so nothing waits for ever (a poll, a place in the gate).
   */
  async req<T = any>(method: string, url: string, body?: unknown, contentType = "application/json", raw = false): Promise<T> {
    const repeatable = safeToRepeat(method, url);
    return this.gate.run(async () => {
      for (let attempt = 0; ; attempt++) {
        const token = await this.auth(attempt === 1);
        const ctl = repeatable ? new AbortController() : undefined;
        const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : undefined;
        const timedOut = (): ApiError => new ApiError(0, `Azure DevOps did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`);
        try {
          let res: Response;
          try {
            res = await fetch(url, {
              method,
              headers: {
                Authorization: this.scheme === "basic" ? `Basic ${btoa(":" + token)}` : `Bearer ${token}`,
                Accept: raw ? "image/*,*/*" : "application/json",
                "X-TFS-FedAuthRedirect": "Suppress",
                ...(body !== undefined ? { "Content-Type": contentType } : {}),
              },
              body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
              signal: ctl?.signal,
            });
          } catch (e) {
            if (ctl?.signal.aborted) throw timedOut();
            if (repeatable && attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
            throw new ApiError(0, "Azure DevOps did not answer (network): " + (e as Error).message
              + (repeatable ? "" : ". The change may or may not be saved; reload to check."));
          }
          if ((res.status === 401 || res.status === 203) && attempt === 0) continue;
          // 429 means the request was turned away, so any request may go again; 503 only when repeating is harmless
          if ((res.status === 429 || (res.status === 503 && repeatable)) && attempt < 3) {
            const wait = Number(res.headers.get("Retry-After")) || 2 ** attempt;
            await sleep(Math.min(wait, 30) * 1000);
            continue;
          }
          if (raw) {
            if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
            return res as unknown as T;
          }
          if (res.status === 204) return null as T;
          let text: string;
          try { text = await res.text(); } catch (e) { throw ctl?.signal.aborted ? timedOut() : e; }
          let json: any = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
          if (!res.ok) {
            const msg = json?.message ?? json?.value?.Message ?? `${res.status} ${res.statusText}`;
            const conflict = res.status === 412 || /VS403351|TF26071|test operation/i.test(msg);
            throw new ApiError(conflict ? 412 : res.status, msg, json);
          }
          if (json === null && text) throw new ApiError(res.status, "Azure DevOps answered with something that is not JSON (sign-in page?)");
          const cont = res.headers.get("x-ms-continuationtoken");
          if (cont && json && typeof json === "object") json.__continuation = cont;
          return json as T;
        } finally {
          clearTimeout(timer);
        }
      }
    });
  }

  private p(project: string): string { return `${this.ctx.orgUrl}${enc(project)}/`; }
  private pt(project: string, team: string): string { return `${this.ctx.orgUrl}${enc(project)}/${enc(team)}/`; }

  itemUrl(project: string, id: number): string { return `${this.p(project)}_workitems/edit/${id}`; }

  // ---------- organization, projects, teams ----------

  async projects(): Promise<Project[]> {
    const out: Project[] = [];
    let cont = "";
    do {
      const r = await this.req(`GET`, `${this.ctx.orgUrl}_apis/projects?$top=500${cont ? "&continuationToken=" + enc(cont) : ""}&${V}`);
      out.push(...r.value.map((p: any) => ({ id: p.id, name: p.name, description: p.description, lastUpdateTime: p.lastUpdateTime, visibility: p.visibility })));
      cont = r.__continuation ?? "";
    } while (cont);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async teams(project: string, opts: { mine?: boolean } = {}): Promise<Team[]> {
    const r = await this.req("GET", `${this.ctx.orgUrl}_apis/projects/${enc(project)}/teams?$top=1000${opts.mine ? "&$mine=true" : ""}&${V}`);
    return r.value.map((t: any) => ({ id: t.id, name: t.name, description: t.description, projectId: t.projectId, projectName: t.projectName }))
      .sort((a: Team, b: Team) => a.name.localeCompare(b.name));
  }

  async teamMembers(project: string, team: string): Promise<Person[]> {
    const r = await this.req("GET", `${this.ctx.orgUrl}_apis/projects/${enc(project)}/teams/${enc(team)}/members?$top=1000&${V}`);
    return r.value.map((m: any) => person(m.identity)).filter((p?: Person): p is Person => !!p && !/^\[.*\]\\/.test(p.uniqueName));
  }

  async teamSettings(project: string, team: string): Promise<TeamSettings> {
    const [s, a] = await Promise.all([
      this.req("GET", `${this.pt(project, team)}_apis/work/teamsettings?${V}`),
      this.req("GET", `${this.pt(project, team)}_apis/work/teamsettings/teamfieldvalues?${V}`),
    ]);
    const field = a.field?.referenceName ?? "System.AreaPath";
    return {
      backlogIteration: s.backlogIteration?.name ? iterPath(project, s.backlogIteration) : undefined,
      defaultIteration: s.defaultIteration?.path ?? s.defaultIteration?.name,
      bugsBehavior: s.bugsBehavior ?? "off",
      workingDays: (s.workingDays ?? []).map((d: string) => DAYS.indexOf(String(d).toLowerCase())).filter((d: number) => d >= 0),
      areas: field === "System.AreaPath" ? (a.values ?? []).map((v: any) => ({ path: v.value, includeChildren: Boolean(v.includeChildren) })) : [],
      defaultArea: a.defaultValue,
    };
  }

  async iterations(project: string, team: string): Promise<Iteration[]> {
    const r = await this.req("GET", `${this.pt(project, team)}_apis/work/teamsettings/iterations?${V}`);
    return r.value.map((i: any) => ({
      id: i.id, name: i.name, path: i.path,
      start: i.attributes?.startDate ?? undefined, finish: i.attributes?.finishDate ?? undefined,
      timeFrame: i.attributes?.timeFrame,
    }));
  }

  process(project: string, team: string): Promise<ProcessInfo> {
    const key = project + "|" + team;
    if (!this.processCache.has(key)) {
      const p = this.loadProcess(project, team);
      p.catch(() => this.processCache.delete(key));
      this.processCache.set(key, p);
    }
    return this.processCache.get(key)!;
  }

  private async loadProcess(project: string, team: string): Promise<ProcessInfo> {
    const [cfg, wits] = await Promise.all([
      this.req("GET", `${this.pt(project, team)}_apis/work/backlogconfiguration?${V}`),
      this.req("GET", `${this.p(project)}_apis/wit/workitemtypes?${V}`),
    ]);
    const types: Record<string, TypeInfo> = {};
    for (const t of wits.value) {
      types[t.name] = {
        name: t.name,
        color: t.color ? "#" + String(t.color).replace(/^#/, "").slice(-6) : "#888888",
        icon: t.icon?.url,
        states: (t.states ?? []).map((s: any) => ({ name: s.name, category: s.category, color: "#" + String(s.color ?? "888888").slice(-6) })),
        fields: (t.fields ?? []).map((f: any) => f.referenceName),
        fieldNames: Object.fromEntries((t.fields ?? []).map((f: any) => [f.referenceName, f.name])),
      };
    }
    const toLevel = (b: any, kind: Level["kind"]): Level => ({
      id: b.id, name: b.name, kind, rank: 0,
      types: (b.workItemTypes ?? []).map((w: any) => w.name),
      defaultType: b.defaultWorkItemType?.name ?? b.workItemTypes?.[0]?.name,
      color: b.color ? "#" + String(b.color).slice(-6) : undefined,
    });
    const portfolio = [...(cfg.portfolioBacklogs ?? [])].sort((a: any, b: any) => b.rank - a.rank).map((b: any) => toLevel(b, "portfolio"));
    const req = toLevel(cfg.requirementBacklog, "requirement");
    const task = toLevel(cfg.taskBacklog, "task");
    const bugTypes: string[] = (cfg.bugWorkItems?.workItemTypes ?? []).map((w: any) => w.name);
    const bugs = cfg.bugsBehavior ?? "off";
    if (bugs === "asRequirements") for (const b of bugTypes) if (!req.types.includes(b)) req.types.push(b);
    if (bugs === "asTasks") for (const b of bugTypes) if (!task.types.includes(b)) task.types.push(b);
    const levels = [...portfolio, req, task].map((l, i) => ({ ...l, rank: i }));
    const tf = cfg.backlogFields?.typeFields ?? {};
    return {
      levels, types, bugsBehavior: bugs,
      fields: {
        order: tf.Order ?? "Microsoft.VSTS.Common.StackRank",
        effort: tf.Effort ?? "Microsoft.VSTS.Scheduling.StoryPoints",
        remaining: tf.RemainingWork ?? "Microsoft.VSTS.Scheduling.RemainingWork",
        activity: tf.Activity ?? "Microsoft.VSTS.Common.Activity",
        completed: "Microsoft.VSTS.Scheduling.CompletedWork",
        original: "Microsoft.VSTS.Scheduling.OriginalEstimate",
      },
    };
  }

  async board(project: string, team: string, levelName: string): Promise<BoardInfo | null> {
    const list = await this.req("GET", `${this.pt(project, team)}_apis/work/boards?${V}`);
    const b = list.value.find((x: any) => x.name === levelName) ?? null;
    if (!b) return null;
    const d = await this.req("GET", `${this.pt(project, team)}_apis/work/boards/${enc(b.id)}?${V}`);
    const info: BoardInfo = {
      name: d.name,
      columns: (d.columns ?? []).map((c: any) => ({
        id: c.id, name: c.name, itemLimit: c.itemLimit ?? 0, stateMappings: c.stateMappings ?? {}, isSplit: Boolean(c.isSplit), columnType: c.columnType,
      })),
      columnField: d.fields?.columnField?.referenceName,
      doneField: d.fields?.doneField?.referenceName,
      rowField: d.fields?.rowField?.referenceName,
      rows: (d.rows ?? []).map((r: any) => r.name ?? ""),
    };
    this.boardCache.set(project + "|" + team, { columnField: info.columnField, doneField: info.doneField, rowField: info.rowField });
    return info;
  }

  async setColumnLimit(project: string, team: string, boardName: string, column: string, limit: number): Promise<void> {
    const base = `${this.pt(project, team)}_apis/work/boards`;
    const list = await this.req("GET", `${base}?${V}`);
    const b = list.value.find((x: any) => x.name === boardName);
    if (!b) throw new Error(`The board "${boardName}" was not found.`);
    // read the board fresh and send every column back as it is, so only this limit changes
    const d = await this.req("GET", `${base}/${enc(b.id)}?${V}`);
    const cols: any[] = d.columns ?? [];
    const c = cols.find((x) => x.name === column);
    if (!c) throw new Error(`The column "${column}" was not found on the board.`);
    c.itemLimit = limit;
    await this.req("PUT", `${base}/${enc(b.id)}/columns?${V}`, cols);
  }

  async capacity(project: string, team: string, iterationId: string): Promise<Capacity> {
    const base = `${this.pt(project, team)}_apis/work/teamsettings/iterations/${enc(iterationId)}`;
    const [c, off] = await Promise.all([
      this.req("GET", `${base}/capacities?${V}`),
      this.req("GET", `${base}/teamdaysoff?${V}`).catch(() => ({ daysOff: [] })),
    ]);
    const rows = c.teamMembers ?? c.value ?? [];
    return {
      members: rows.map((m: any) => ({
        person: personOrBlank(m.teamMember),
        activities: (m.activities ?? []).map((a: any) => ({ name: a.name ?? "", capacityPerDay: a.capacityPerDay ?? 0 })),
        daysOff: (m.daysOff ?? []).map((d: any) => ({ start: d.start, end: d.end })),
      })),
      teamDaysOff: (off.daysOff ?? []).map((d: any) => ({ start: d.start, end: d.end })),
    };
  }

  async setTeamDaysOff(project: string, team: string, iterationId: string, daysOff: { start: string; end: string }[]): Promise<void> {
    await this.req("PATCH", `${this.pt(project, team)}_apis/work/teamsettings/iterations/${enc(iterationId)}/teamdaysoff?${V}`, { daysOff });
  }

  async setCapacity(project: string, team: string, iterationId: string, memberId: string, body: { activities: { name: string; capacityPerDay: number }[]; daysOff: { start: string; end: string }[] }): Promise<void> {
    await this.req("PATCH", `${this.pt(project, team)}_apis/work/teamsettings/iterations/${enc(iterationId)}/capacities/${enc(memberId)}?${V}`, body);
  }

  // ---------- work items ----------

  async query(project: string, spec: QuerySpec): Promise<number[]> {
    if (matchesNothing(spec)) return [];
    const url = spec.project === "*" ? `${this.ctx.orgUrl}_apis/wit/wiql` : `${this.p(project)}_apis/wit/wiql`;
    const r = await this.req("POST", `${url}?$top=${spec.top ?? 20000}${needsTimePrecision(spec) ? "&timePrecision=true" : ""}&${V}`, { query: toWiql(spec, project) });
    return (r.workItems ?? []).map((w: any) => w.id as number);
  }

  async items(project: string, ids: number[], opts: { fields?: string[]; relations?: boolean } = {}): Promise<WorkItem[]> {
    if (!ids.length) return [];
    const proc = await this.processFor(project);
    const board = this.boardCache.get(project + "|" + (this.currentTeam ?? ""));
    const extra = [board?.columnField, board?.doneField, board?.rowField].filter((x): x is string => Boolean(x));
    const chunks: number[][] = [];
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 200) chunks.push(unique.slice(i, i + 200));
    const fields = [...new Set([...BASE_FIELDS, ...(proc ? processFields(proc) : []), ...extra, ...(opts.fields ?? [])])];
    const parts = await Promise.all(chunks.map((c) => this.batch(project, c, fields, Boolean(opts.relations))));
    // a read with links has every field; a list read only the fields asked for
    return parts.flat().map((raw) => {
      const it = normalizeItem(raw, proc, board?.columnField, board?.doneField, board?.rowField);
      if (!opts.relations) it.fieldsRead = fields;
      return it;
    });
  }

  /** An item as Azure DevOps sent it, with the process and the team's board fields of its project. */
  private async normalize(project: string, raw: any): Promise<WorkItem> {
    const proc = await this.processFor(project);
    const board = this.boardCache.get(project + "|" + (this.currentTeam ?? ""));
    return normalizeItem(raw, proc, board?.columnField, board?.doneField, board?.rowField);
  }

  /** The team whose board fields (column, lane) are read with items; set by the workspace. */
  currentTeam: string | undefined;

  private async processFor(project: string): Promise<ProcessInfo | undefined> {
    const p = this.processCache.get(project + "|" + (this.currentTeam ?? ""));
    return p ? p.catch(() => undefined) : undefined;
  }

  async revisions(project: string, id: number): Promise<{ changed: string; fields: Record<string, unknown> }[]> {
    const out: { changed: string; fields: Record<string, unknown> }[] = [];
    // 200 a page; long histories take a few pages
    for (let skip = 0; skip < 5000; skip += 200) {
      const r = await this.req("GET", `${this.p(project)}_apis/wit/workItems/${id}/revisions?$top=200&$skip=${skip}&${V}`);
      const page: any[] = r.value ?? [];
      for (const x of page) out.push({ changed: String(x.fields?.["System.ChangedDate"] ?? ""), fields: x.fields ?? {} });
      if (page.length < 200) break;
    }
    return out;
  }

  async fieldsAsOf(project: string, ids: number[], fields: string[], asOf: string): Promise<Map<number, Record<string, unknown>>> {
    const out = new Map<number, Record<string, unknown>>();
    const unique = [...new Set(ids)];
    const chunks: number[][] = [];
    for (let i = 0; i < unique.length; i += 200) chunks.push(unique.slice(i, i + 200));
    await Promise.all(chunks.map(async (c) => {
      // "Omit": an item that did not exist at that moment comes back empty instead of failing the batch
      const r = await this.req("POST", `${this.p(project)}_apis/wit/workitemsbatch?${V}`, { ids: c, fields, asOf, errorPolicy: "Omit" });
      for (const w of r.value ?? []) if (w?.id) out.set(w.id, w.fields ?? {});
    }));
    return out;
  }

  private async batch(project: string, ids: number[], fields: string[], relations: boolean): Promise<any[]> {
    const body: any = { ids, errorPolicy: "Omit" };
    const missing = this.missingFields.get(project) ?? new Set<string>();
    this.missingFields.set(project, missing);
    if (relations) body.$expand = "Relations";
    else body.fields = [...new Set(fields)].filter((f) => !missing.has(f.toLowerCase()));
    for (;;) {
      try {
        const r = await this.req("POST", `${this.p(project)}_apis/wit/workitemsbatch?${V}`, body);
        return (r.value ?? []).filter(Boolean);
      } catch (e) {
        // a field this project does not have: drop it and ask again; each round drops one field
        const f = missingFieldName((e as Error).message)?.toLowerCase();
        if (!f || !body.fields) throw e;
        const left = body.fields.filter((x: string) => x.toLowerCase() !== f);
        if (left.length === body.fields.length) throw e;
        missing.add(f);
        body.fields = left;
      }
    }
  }

  async item(project: string, id: number): Promise<WorkItem> {
    const raw = await this.req("GET", `${project ? this.p(project) : this.ctx.orgUrl}_apis/wit/workitems/${id}?$expand=all&${V}`);
    return this.normalize(project || String(raw?.fields?.["System.TeamProject"] ?? ""), raw);
  }

  async updates(project: string, id: number): Promise<Update[]> {
    const out: Update[] = [];
    for (let skip = 0; ; skip += 200) {
      const r = await this.req("GET", `${this.p(project)}_apis/wit/workItems/${id}/updates?$top=200&$skip=${skip}&${V}`);
      out.push(...r.value.map(normalizeUpdate));
      if (r.value.length < 200) break;
    }
    return out;
  }

  async comments(project: string, id: number): Promise<Comment[]> {
    const r = await this.req("GET", `${this.p(project)}_apis/wit/workItems/${id}/comments?$top=200&order=desc&${VP(4)}`);
    return (r.comments ?? []).map((c: any) => ({ id: c.id, text: c.text, createdBy: personOrBlank(c.createdBy), createdDate: c.createdDate, modifiedDate: c.modifiedDate }));
  }

  async addComment(project: string, id: number, html: string): Promise<Comment> {
    const c = await this.req("POST", `${this.p(project)}_apis/wit/workItems/${id}/comments?${VP(4)}`, { text: html });
    return { id: c.id, text: c.text, createdBy: personOrBlank(c.createdBy), createdDate: c.createdDate };
  }

  async update(project: string, id: number, ops: PatchOp[], opts: { rev?: number } = {}): Promise<WorkItem> {
    const body = opts.rev ? [{ op: "test", path: "/rev", value: opts.rev }, ...ops] : ops;
    const raw = await this.req("PATCH", `${this.p(project)}_apis/wit/workitems/${id}?$expand=relations&${V}`, body, "application/json-patch+json");
    return this.normalize(project, raw);
  }

  async create(project: string, type: string, ops: PatchOp[]): Promise<WorkItem> {
    const raw = await this.req("POST", `${this.p(project)}_apis/wit/workitems/$${enc(type)}?$expand=relations&${V}`, ops, "application/json-patch+json");
    // with the board fields too, so the new item shows in its board column at once
    return this.normalize(project, raw);
  }

  async deleteItem(project: string, id: number): Promise<void> {
    // without destroy=true it only goes to the Recycle Bin, so it can be restored
    await this.req("DELETE", `${this.p(project)}_apis/wit/workitems/${id}?${V}`);
  }

  async deletedItems(project: string): Promise<DeletedItem[]> {
    // the list gives ids only; who deleted them and when comes per 200 ids
    const r = await this.req("GET", `${this.p(project)}_apis/wit/recyclebin?${V}`);
    const ids: number[] = (r.value ?? []).map((x: any) => Number(x.id)).filter((x: number) => Number.isInteger(x) && x > 0);
    const out: DeletedItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const b = await this.req("GET", `${this.p(project)}_apis/wit/recyclebin?ids=${ids.slice(i, i + 200).join(",")}&${V}`);
      for (const d of b.value ?? []) {
        if (!d || !Number.isInteger(d.id) || (d.code && d.code !== 200)) continue;
        out.push({ id: d.id, title: String(d.name ?? ""), type: String(d.type ?? ""), deletedBy: person(d.deletedBy), deletedDate: String(d.deletedDate ?? "") });
      }
    }
    return out.sort((a, b) => b.deletedDate.localeCompare(a.deletedDate));
  }

  async deletedArea(project: string, id: number): Promise<string | undefined> {
    const r = await this.req("GET", `${this.p(project)}_apis/wit/recyclebin/${id}?${V}`);
    const a = r?.resource?.fields?.["System.AreaPath"];
    return typeof a === "string" ? a : undefined;
  }

  async restoreItem(project: string, id: number): Promise<void> {
    await this.req("PATCH", `${this.p(project)}_apis/wit/recyclebin/${id}?${V}`, { IsDeleted: false });
  }

  async reorder(project: string, team: string, ids: number[], previousId: number, nextId: number, parentId = 0): Promise<{ id: number; order: number }[]> {
    const r = await this.req("PATCH", `${this.pt(project, team)}_apis/work/workitemsorder?${VP(1)}`, { ids, previousId, nextId, parentId });
    return (r.value ?? []).map((x: any) => ({ id: x.id, order: x.order }));
  }

  // ---------- code ----------

  async repositories(project: string): Promise<Repository[]> {
    const r = await this.req("GET", `${this.p(project)}_apis/git/repositories?${V}`);
    return r.value.map((x: any) => ({ id: x.id, name: x.name, project: x.project?.name ?? project, defaultBranch: x.defaultBranch, isDisabled: x.isDisabled }));
  }

  async pullRequests(project: string, opts: { status: "active" | "completed" | "abandoned" | "all"; minTime?: string; top?: number; creatorId?: string }): Promise<PullRequest[]> {
    const top = opts.top ?? 500;
    const out: PullRequest[] = [];
    for (let skip = 0; out.length < top; skip += 200) {
      const qs = [`searchCriteria.status=${opts.status}`, `$top=${Math.min(200, top - out.length)}`, `$skip=${skip}`];
      if (opts.minTime) qs.push(`searchCriteria.minTime=${enc(opts.minTime)}`, `searchCriteria.queryTimeRangeType=${opts.status === "completed" || opts.status === "abandoned" ? "closed" : "created"}`);
      if (opts.creatorId) qs.push(`searchCriteria.creatorId=${enc(opts.creatorId)}`);
      const r = await this.req("GET", `${this.p(project)}_apis/git/pullrequests?${qs.join("&")}&${V}`);
      out.push(...r.value.map((x: any) => normalizePr(x, this.ctx.orgUrl)));
      if (r.value.length < 200) break;
    }
    return out;
  }

  async pullRequest(id: number): Promise<PullRequest | null> {
    try {
      const r = await this.req("GET", `${this.ctx.orgUrl}_apis/git/pullrequests/${id}?${V}`);
      return normalizePr(r, this.ctx.orgUrl);
    } catch (e) {
      if ((e as ApiError).status === 404) return null;
      throw e;
    }
  }

  async firstApproval(project: string, repoId: string, prId: number): Promise<string | undefined> {
    const r = await this.req("GET", `${this.p(project)}_apis/git/repositories/${enc(repoId)}/pullRequests/${prId}/threads?${V}`);
    let first: string | undefined;
    for (const t of r.value ?? []) {
      // a vote shows as a system thread: CodeReviewThreadType "VoteUpdate" with the vote in CodeReviewVoteResult
      const p = t.properties ?? {};
      if (p.CodeReviewThreadType?.$value !== "VoteUpdate" || Number(p.CodeReviewVoteResult?.$value) < 5) continue;
      const at = t.publishedDate ?? t.comments?.[0]?.publishedDate;
      if (at && (!first || at < first)) first = at;
    }
    return first;
  }

  async pullRequestWorkItems(project: string, repoId: string, prId: number): Promise<number[]> {
    const r = await this.req("GET", `${this.p(project)}_apis/git/repositories/${enc(repoId)}/pullRequests/${prId}/workitems?${V}`);
    return (r.value ?? []).map((w: any) => Number(w.id));
  }

  async branches(project: string, repoId: string): Promise<string[]> {
    const r = await this.req("GET", `${this.p(project)}_apis/git/repositories/${enc(repoId)}/refs?filter=heads/&$top=1000&${V}`);
    return (r.value ?? []).map((x: any) => String(x.name ?? "").replace(/^refs\/heads\//, "")).filter(Boolean);
  }

  // ---------- tags, people, permissions ----------

  async tags(project: string): Promise<Tag[]> {
    const r = await this.req("GET", `${this.p(project)}_apis/wit/tags?${VP(1)}`);
    return r.value.map((t: any) => ({ id: t.id, name: t.name }));
  }
  async renameTag(project: string, tagId: string, name: string): Promise<void> {
    await this.req("PATCH", `${this.p(project)}_apis/wit/tags/${enc(tagId)}?${VP(1)}`, { name });
  }
  async deleteTag(project: string, tagId: string): Promise<void> {
    await this.req("DELETE", `${this.p(project)}_apis/wit/tags/${enc(tagId)}?${VP(1)}`);
  }

  avatar(p: Person): Promise<string | null> {
    // the subject descriptor (aad.…, msa.…): from the person, else from the end of the picture link
    const descriptor = p.descriptor ?? /MemberAvatars\/([^/?#]+)/.exec(p.imageUrl ?? "")?.[1];
    const key = descriptor ?? p.imageUrl;
    if (!key) return Promise.resolve(null);
    if (!this.avatars.has(key)) {
      this.avatars.set(key, (async () => {
        // the Graph avatar API takes the extension's token (scope vso.graph); the picture link
        // (GraphProfile/MemberAvatars) only takes the browser's own sign-in and answers 401 to it
        if (descriptor) {
          let plain = descriptor;
          try { plain = decodeURIComponent(descriptor); } catch { /* a stray % in the link: use it as it is */ }
          const got = await this.graphAvatar(plain);
          if (got !== undefined) return got;
        }
        // the picture link answers 401 to the extension's token, so it is only a last try without a descriptor
        else if (p.imageUrl) {
          const got = await this.fetchAvatar(p.imageUrl);
          if (got) return got;
        }
        setTimeout(() => this.avatars.delete(key), 60_000); // a failure is kept for a minute, then tried again
        return null;
      })());
    }
    return this.avatars.get(key)!;
  }

  /** The picture from the Graph avatar API; null for a generated one (the initials stay), undefined when it could not be read. */
  private async graphAvatar(descriptor: string): Promise<string | null | undefined> {
    const url = `${serviceUrl(this.ctx.orgUrl, "vssps")}_apis/graph/Subjects/${enc(descriptor)}/avatars?size=small&format=png&${VP(1)}`;
    try {
      // with format=png the service may send the picture itself rather than JSON, so read the answer as it comes
      const res = await this.req<Response>("GET", url, undefined, undefined, true);
      const type = res.headers.get("content-type") ?? "";
      const blob = await res.blob();
      if (!blob.size) { console.warn("avatar: empty answer", url); return undefined; }
      if (/json/.test(type) || (await blob.slice(0, 1).text()) === "{") {
        const j = JSON.parse(await blob.text()) as { value?: string | number[]; isAutoGenerated?: boolean };
        if (j.isAutoGenerated) return null;
        if (typeof j.value === "string" && j.value) return `data:image/png;base64,${j.value}`;
        if (Array.isArray(j.value) && j.value.length) return URL.createObjectURL(new Blob([new Uint8Array(j.value)], { type: "image/png" }));
        console.warn("avatar: no picture in the answer", url, Object.keys(j));
        return undefined;
      }
      if (/html|text/.test(type)) { console.warn("avatar: not a picture", url, type); return undefined; }
      return URL.createObjectURL(blob.type.startsWith("image/") ? blob : new Blob([blob], { type: "image/png" }));
    } catch (e) {
      console.warn("avatar not loaded", url, e);
      return undefined;
    }
  }

  private async fetchAvatar(url: string): Promise<string | null> {
    try {
      const res = await this.req<Response>("GET", url, undefined, undefined, true);
      const blob = await res.blob();
      if (!blob.size) return null;
      // the avatar service answers JSON { imageData: "<base64 png>" }; older servers send the picture itself
      if (/json/.test(blob.type) || (await blob.slice(0, 1).text()) === "{") {
        const j = JSON.parse(await blob.text());
        return typeof j.imageData === "string" ? `data:image/png;base64,${j.imageData}` : null;
      }
      if (/html|text/.test(blob.type)) return null;
      return URL.createObjectURL(blob.type.startsWith("image/") ? blob : new Blob([blob], { type: "image/png" }));
    } catch (e) {
      console.debug("avatar not loaded", url, e);
      return null;
    }
  }

  // ---------- extension storage ----------

  private docsUrl(collection: string, scope: "shared" | "user", id?: string): string {
    if (!this.ctx.extensionId) throw new ApiError(0, "Extension storage is only available inside Azure DevOps");
    const [publisher, ext] = this.ctx.extensionId.split(".");
    const s = scope === "user" ? "User/Me" : "Default/Current";
    return `${serviceUrl(this.ctx.orgUrl, "extmgmt")}_apis/ExtensionManagement/InstalledExtensions/${enc(publisher)}/${enc(ext)}/Data/Scopes/${s}/Collections/${enc(collection)}/Documents${id ? "/" + enc(id) : ""}?${VP(1)}`;
  }

  /** Outside an installed extension (local testing) the documents stay in this browser. */
  private local = new LocalDocs("flowboards-dev");

  async docs(collection: string, scope: "shared" | "user"): Promise<ExtensionDoc[]> {
    if (!this.ctx.extensionId) return this.local.docs(collection, scope);
    try {
      const r = await this.req("GET", this.docsUrl(collection, scope));
      return Array.isArray(r) ? r : r?.value ?? [];
    } catch (e) {
      if ((e as ApiError).status === 404) return [];
      throw e;
    }
  }
  async getDoc(collection: string, id: string, scope: "shared" | "user"): Promise<ExtensionDoc | null> {
    if (!this.ctx.extensionId) return this.local.getDoc(collection, id, scope);
    try { return await this.req("GET", this.docsUrl(collection, scope, id)); } catch (e) {
      if ((e as ApiError).status === 404) return null;
      throw e;
    }
  }
  async setDoc(collection: string, doc: ExtensionDoc, scope: "shared" | "user"): Promise<ExtensionDoc> {
    if (!this.ctx.extensionId) return this.local.setDoc(collection, doc, scope);
    return this.req("PUT", this.docsUrl(collection, scope), { __etag: -1, ...doc });
  }
  async createDoc(collection: string, doc: ExtensionDoc, scope: "shared" | "user"): Promise<ExtensionDoc> {
    if (!this.ctx.extensionId) return this.local.createDoc(collection, doc, scope);
    // POST only creates: Azure DevOps answers 409 when a document with this id exists already
    const { __etag: _etag, ...body } = doc;
    return this.req("POST", this.docsUrl(collection, scope), body);
  }

  async deleteDoc(collection: string, id: string, scope: "shared" | "user"): Promise<void> {
    if (!this.ctx.extensionId) return this.local.deleteDoc(collection, id, scope);
    await this.req("DELETE", this.docsUrl(collection, scope, id)).catch((e) => { if ((e as ApiError).status !== 404) throw e; });
  }
}

/** An iteration path that starts with the project's name, whether Azure DevOps sent it with or without it (or with a leading backslash). */
export function iterPath(project: string, it: { path?: string; name?: string }): string {
  const path = String(it.path ?? "").replace(/^\\+/, "");
  if (!path) return `${project}\\${it.name}`;
  return path === project || path.startsWith(project + "\\") ? path : `${project}\\${path}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
