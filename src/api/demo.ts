// Demo data: a made-up organization that answers the same calls as Azure DevOps, in memory.
// Used when the page runs outside Azure DevOps (for example the public demo page) and by tests.
// Dates are made relative to today, so the demo always looks current. Writes change the memory only.
import type { Api, ApiContext, ExtensionDoc } from "./api.ts";
import { prArtifactUrl, prFromArtifact, REL } from "./api.ts";
import { LocalDocs } from "./localdocs.ts";
import { BASE_FIELDS, normalizeItem, normalizePr, normalizeUpdate, person, processFields } from "./normalize.ts";
import { ApiError } from "./types.ts";
import type {
  BoardInfo, Capacity, Comment, DeletedItem, Iteration, PatchOp, Person, ProcessInfo, Project, PullRequest,
  QuerySpec, Repository, Tag, Team, TeamSettings, Update, WorkItem,
} from "./types.ts";
import { matchesNothing } from "./wiql.ts";
import { valueAt } from "../core/history.ts";

const DAY = 86_400_000;
const COLUMN_FIELD = "WEF_DEMO_Kanban.Column";
const DONE_FIELD = "WEF_DEMO_Kanban.Column.Done";
const LANE_FIELD = "WEF_DEMO_Kanban.Lane";

/** Same numbers on every load: a small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE: Person[] = [
  ["Ava Martins", "ava.martins"], ["Ben Okafor", "ben.okafor"], ["Chloe Park", "chloe.park"], ["Diego Alvarez", "diego.alvarez"],
  ["Emma Novak", "emma.novak"], ["Farid Haddad", "farid.haddad"], ["Grace Liu", "grace.liu"], ["Hugo Berg", "hugo.berg"],
].map(([displayName, u], i) => ({ id: `demo-person-${i + 1}`, displayName, uniqueName: `${u}@fabrikam.example`, descriptor: `aad.demo${i + 1}` }));

const STATE_COLORS: Record<string, string> = { New: "#b2b2b2", Active: "#007acc", Resolved: "#ff9d00", Closed: "#339933", Removed: "#ffffff" };

const ALL = ["Epic", "Feature", "User Story", "Bug", "Task"];
const DEMO_FIELDS: [string, string, string[]][] = [
  ["System.Title", "Title", ALL], ["System.State", "State", ALL], ["System.AssignedTo", "Assigned To", ALL],
  ["System.Description", "Description", ["Epic", "Feature", "User Story", "Task"]], ["System.Tags", "Tags", ALL],
  ["System.IterationPath", "Iteration Path", ALL], ["System.AreaPath", "Area Path", ALL],
  ["Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance Criteria", ["Epic", "Feature", "User Story", "Bug"]],
  ["Microsoft.VSTS.Common.Priority", "Priority", ALL], ["Microsoft.VSTS.Common.ValueArea", "Value Area", ["Epic", "Feature", "User Story", "Bug"]],
  ["Microsoft.VSTS.Common.Risk", "Risk", ["Epic", "Feature", "User Story"]], ["Microsoft.VSTS.Common.BusinessValue", "Business Value", ["Epic", "Feature"]],
  ["Microsoft.VSTS.Common.TimeCriticality", "Time Criticality", ["Epic", "Feature"]], ["Microsoft.VSTS.Common.RiskReduction", "Risk Reduction", ["Epic", "Feature"]],
  ["Microsoft.VSTS.Scheduling.StoryPoints", "Story Points", ["User Story", "Bug"]], ["Microsoft.VSTS.Scheduling.Effort", "Effort", ["Epic", "Feature"]],
  ["Microsoft.VSTS.Scheduling.StartDate", "Start Date", ["Epic", "Feature"]], ["Microsoft.VSTS.Scheduling.TargetDate", "Target Date", ["Epic", "Feature"]],
  ["Microsoft.VSTS.Scheduling.OriginalEstimate", "Original Estimate", ["Task"]], ["Microsoft.VSTS.Scheduling.RemainingWork", "Remaining Work", ["Task", "Bug"]],
  ["Microsoft.VSTS.Scheduling.CompletedWork", "Completed Work", ["Task", "Bug"]], ["Microsoft.VSTS.Common.Activity", "Activity", ["Task"]],
  ["Microsoft.VSTS.TCM.ReproSteps", "Repro Steps", ["Bug"]], ["Microsoft.VSTS.Common.Severity", "Severity", ["Bug"]],
  ["Microsoft.VSTS.Build.FoundIn", "Found In", ["Bug"]], ["Microsoft.VSTS.Build.IntegrationBuild", "Integrated in Build", ["User Story", "Bug", "Task"]],
  ["Custom.ReleaseNote", "Release Note", ["User Story", "Bug", "Feature"]],
];

export const DEMO_PROCESS: ProcessInfo = {
  levels: [
    { id: "Microsoft.EpicCategory", name: "Epics", kind: "portfolio", rank: 0, types: ["Epic"], defaultType: "Epic", color: "#ff7b00" },
    { id: "Microsoft.FeatureCategory", name: "Features", kind: "portfolio", rank: 1, types: ["Feature"], defaultType: "Feature", color: "#773b93" },
    { id: "Microsoft.RequirementCategory", name: "Stories", kind: "requirement", rank: 2, types: ["User Story", "Bug"], defaultType: "User Story", color: "#009ccc" },
    { id: "Microsoft.TaskCategory", name: "Tasks", kind: "task", rank: 3, types: ["Task"], defaultType: "Task", color: "#f2cb1d" },
  ],
  types: Object.fromEntries([
    ["Epic", "#ff7b00", ["New", "Active", "Resolved", "Closed", "Removed"]],
    ["Feature", "#773b93", ["New", "Active", "Resolved", "Closed", "Removed"]],
    ["User Story", "#009ccc", ["New", "Active", "Resolved", "Closed", "Removed"]],
    ["Bug", "#cc293d", ["New", "Active", "Resolved", "Closed"]],
    ["Task", "#f2cb1d", ["New", "Active", "Closed", "Removed"]],
  ].map(([name, color, states]) => [name as string, {
    name: name as string, color: color as string,
    fields: DEMO_FIELDS.filter(([, , types]) => types.includes(name as string)).map(([ref]) => ref),
    fieldNames: Object.fromEntries(DEMO_FIELDS.filter(([, , types]) => types.includes(name as string)).map(([ref, label]) => [ref, label])),
    states: (states as string[]).map((s) => ({
      name: s, color: STATE_COLORS[s],
      category: ({ New: "Proposed", Active: "InProgress", Resolved: "Resolved", Closed: "Completed", Removed: "Removed" } as const)[s as "New"],
    })),
  }])),
  fields: {
    order: "Microsoft.VSTS.Common.StackRank", effort: "Microsoft.VSTS.Scheduling.StoryPoints",
    remaining: "Microsoft.VSTS.Scheduling.RemainingWork", activity: "Microsoft.VSTS.Common.Activity",
    completed: "Microsoft.VSTS.Scheduling.CompletedWork", original: "Microsoft.VSTS.Scheduling.OriginalEstimate",
  },
  bugsBehavior: "asRequirements",
};

const PLAN: [string, string, string[]][] = [
  ["Self-service onboarding", "Pillar:Growth", ["Sign-up wizard", "Identity verification", "Welcome emails", "Onboarding analytics"]],
  ["Payments platform v2", "Pillar:Platform", ["Card tokenization", "Refund automation", "Multi-currency pricing", "Payment retries"]],
  ["Observability and reliability", "Pillar:Reliability", ["Service level objectives", "Distributed tracing", "On-call runbooks"]],
  ["Mobile app relaunch", "Pillar:Growth", ["Offline mode", "Push notifications", "Accessibility pass"]],
  ["Cost and security hygiene", "Pillar:Platform", ["Secrets rotation", "Right-size clusters"]],
];

const VERBS = ["Add", "Build", "Design", "Validate", "Migrate", "Document", "Automate", "Improve", "Fix", "Measure", "Review", "Remove"];
const THINGS = ["form validation", "error states", "API endpoint", "database schema", "feature flag", "dashboard tiles", "retry policy",
  "audit events", "email template", "load test", "health probe", "unit tests", "rate limits", "admin screen", "export to CSV",
  "consent banner", "webhook handler", "search index", "caching layer", "alert rules"];
const TASKS = ["Write code", "Write tests", "Code review", "Update docs", "Deploy to staging", "Verify in production", "Design review"];
const TAGS = ["Security", "Tech debt", "Customer request", "Quick win", "Compliance", "Performance"];

interface RawItem { id: number; rev: number; fields: Record<string, any>; relations: { rel: string; url: string; attributes: Record<string, unknown> }[]; updates: any[]; comments: Comment[] }

/** Groups that review pull requests in the demo (isContainer, as Azure DevOps marks teams and groups). */
const DEMO_GROUPS = [
  { id: "group-phoenix", displayName: "[Fabrikam Online]\\Phoenix Team", uniqueName: "vstfs:///Classification/TeamProject/demo-project\\Phoenix Team", isContainer: true },
  { id: "group-payments", displayName: "[Fabrikam Online]\\Payments reviewers", uniqueName: "vstfs:///Classification/TeamProject/demo-project\\Payments reviewers", isContainer: true },
];

export class DemoApi implements Api {
  ctx: ApiContext;
  private store = new Map<number, RawItem>();
  /** deleted items, as in the Recycle Bin */
  private bin = new Map<number, RawItem>();
  private binInfo = new Map<number, { by: Person; date: string }>();
  private prs: any[] = [];
  private iters: Iteration[] = [];
  private nextId = 1;
  private now = Date.now();
  private latency: number;

  constructor(opts: { latencyMs?: number } = {}) {
    this.latency = opts.latencyMs ?? 120;
    this.ctx = { orgName: "fabrikam-demo", orgUrl: "https://dev.azure.com/fabrikam-demo/", me: PEOPLE[0], demo: true };
    this.generate();
    // a few old finished tasks were deleted, so the Recycle Bin has something to show
    const done = [...this.store.values()].filter((i) => i.fields["System.WorkItemType"] === "Task" && i.fields["System.State"] === "Closed").slice(-3);
    done.forEach((it, i) => {
      this.store.delete(it.id);
      this.bin.set(it.id, it);
      this.binInfo.set(it.id, { by: PEOPLE[(i * 3 + 1) % PEOPLE.length], date: this.iso((i * 4 + 2) * DAY) });
    });
  }

  private wait<T>(v: T): Promise<T> {
    return new Promise((r) => setTimeout(() => r(structuredClone(v)), this.latency * (0.5 + Math.random())));
  }

  // ---------- data generation ----------

  private iso(msAgo: number): string { return new Date(this.now - msAgo).toISOString(); }

  private generate(): void {
    const r = rng(20261021);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
    const monday = new Date(this.now);
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const sprint0 = monday.getTime() - 10 * 14 * DAY; // ten sprints back
    for (let i = 0; i < 15; i++) {
      const start = sprint0 + i * 14 * DAY;
      const finish = start + 11 * DAY; // Monday to Friday of the next week
      const tf = finish < this.now - DAY ? "past" : start > this.now ? "future" : "current";
      this.iters.push({ id: `demo-iter-${i + 31}`, name: `Sprint ${i + 31}`, path: `Fabrikam Online\\Sprint ${i + 31}`, start: new Date(start).toISOString(), finish: new Date(finish).toISOString(), timeFrame: tf });
    }
    const iterAt = (t: number): string => (this.iters.find((it) => t <= Date.parse(it.finish!) + 2 * DAY) ?? this.iters[this.iters.length - 1]).path;
    const current = this.iters.find((i) => i.timeFrame === "current")!;
    let rank = 1000;
    const area = "Fabrikam Online\\Phoenix";

    const add = (type: string, title: string, f: Record<string, any>, parent?: number): RawItem => {
      const id = this.nextId++;
      const fields: Record<string, any> = {
        "System.Id": id, "System.WorkItemType": type, "System.Title": title, "System.TeamProject": "Fabrikam Online",
        "System.AreaPath": area, "System.IterationPath": "Fabrikam Online", "Microsoft.VSTS.Common.StackRank": (rank += 1000),
        ...f,
      };
      if (parent) fields["System.Parent"] = parent;
      const item: RawItem = { id, rev: 1, fields, relations: [], updates: [], comments: [] };
      if (parent) {
        item.relations.push({ rel: REL.parent, url: this.wiUrl(parent), attributes: { isLocked: false, name: "Parent" } });
        this.store.get(parent)?.relations.push({ rel: REL.child, url: this.wiUrl(id), attributes: { isLocked: false, name: "Child" } });
      }
      this.store.set(id, item);
      return item;
    };

    const lifecycle = (state: string, ageDays: number): Record<string, any> => {
      const created = this.now - ageDays * DAY;
      const f: Record<string, any> = { "System.State": state, "System.CreatedDate": this.iso(ageDays * DAY), "System.CreatedBy": pick(PEOPLE) };
      let changed = created;
      if (state !== "New") {
        const act = created + (0.15 + r() * 0.4) * ageDays * DAY;
        f["Microsoft.VSTS.Common.ActivatedDate"] = new Date(act).toISOString();
        changed = act;
        if (state === "Resolved" || state === "Closed") {
          const res = act + (0.3 + r() * 0.5) * (this.now - act);
          f["Microsoft.VSTS.Common.ResolvedDate"] = new Date(res).toISOString();
          changed = res;
          if (state === "Closed") {
            const cl = res + r() * Math.min(5 * DAY, this.now - res);
            f["Microsoft.VSTS.Common.ClosedDate"] = new Date(cl).toISOString();
            f["Microsoft.VSTS.Common.ClosedBy"] = pick(PEOPLE);
            changed = cl;
          }
        }
      }
      f["Microsoft.VSTS.Common.StateChangeDate"] = new Date(changed).toISOString();
      f["System.ChangedDate"] = new Date(Math.min(this.now - 3600_000, changed + r() * 3 * DAY)).toISOString();
      f["System.ChangedBy"] = pick(PEOPLE);
      return f;
    };

    const column = (state: string, hasSpec: boolean): string => ({ New: hasSpec ? "Ready" : "New", Active: "Active", Resolved: "Review", Closed: "Closed", Removed: "New" } as Record<string, string>)[state];
    const html = (s: string): string => `<div>${s}</div>`;

    PLAN.forEach(([epicTitle, pillar, features], ei) => {
      const epicAge = 200 + ei * 25;
      const epicState = ei === 4 ? "New" : ei === 2 ? "Active" : "Active";
      const epic = add("Epic", epicTitle, {
        ...lifecycle(epicState, epicAge), "System.Tags": pillar, "System.AssignedTo": PEOPLE[ei % PEOPLE.length],
        "System.Description": html(`Outcome: ${epicTitle.toLowerCase()} for every customer segment.`),
        "Microsoft.VSTS.Scheduling.StartDate": this.iso((60 - ei * 25) * DAY),
        "Microsoft.VSTS.Scheduling.TargetDate": this.iso(-(40 + ei * 30) * DAY),
        "Microsoft.VSTS.Scheduling.Effort": 40 + ei * 10,
      });
      features.forEach((ft, fi) => {
        const fAge = 60 + Math.floor(r() * 120);
        const fState = fi === 0 && ei < 2 ? "Closed" : fi === features.length - 1 && ei > 2 ? "New" : r() < 0.15 ? "Resolved" : "Active";
        const startAgo = (40 - fi * 20 - ei * 6) * DAY;
        const feat = add("Feature", ft, {
          ...lifecycle(fState, fAge), "System.AssignedTo": pick(PEOPLE),
          "System.Description": r() < 0.85 ? html(`Deliver ${ft.toLowerCase()} so that customers can finish the job without help.`) : undefined,
          "Microsoft.VSTS.Common.AcceptanceCriteria": r() < 0.6 ? html("Works on web and mobile; measured in the product dashboard.") : undefined,
          "Microsoft.VSTS.Scheduling.StartDate": this.iso(startAgo),
          "Microsoft.VSTS.Scheduling.TargetDate": this.iso(startAgo - (35 + Math.floor(r() * 50)) * DAY),
          "Microsoft.VSTS.Scheduling.Effort": 8 + Math.floor(r() * 20),
          "System.IterationPath": "Fabrikam Online",
        }, epic.id);
        const n = fState === "New" ? 2 + Math.floor(r() * 3) : 4 + Math.floor(r() * 6);
        for (let si = 0; si < n; si++) {
          let state: string;
          const x = r();
          if (fState === "Closed") state = "Closed";
          else if (fState === "New") state = "New";
          else state = x < 0.32 ? "Closed" : x < 0.42 ? "Resolved" : x < 0.66 ? "Active" : "New";
          const age = state === "Closed" ? 15 + Math.floor(r() * 170) : state === "New" ? 2 + Math.floor(r() * 120) : 6 + Math.floor(r() * 60);
          const hasDesc = r() < 0.8;
          const hasAc = hasDesc && r() < 0.75;
          const lf = lifecycle(state, age);
          const closedAt = lf["Microsoft.VSTS.Common.ClosedDate"] ? Date.parse(lf["Microsoft.VSTS.Common.ClosedDate"]) : 0;
          const iter = state === "Closed" ? iterAt(closedAt) : state === "New" ? (r() < 0.4 ? this.iters[11 + Math.floor(r() * 3)].path : "Fabrikam Online") : current.path;
          const owner = r() < 0.86 ? pick(PEOPLE) : undefined;
          const isBug = r() < 0.08;
          const title = isBug ? `${pick(THINGS)} fails when ${pick(["the session expires", "two tabs are open", "the network is slow", "the list is empty"])}` : `${pick(VERBS)} ${pick(THINGS)} for ${ft.toLowerCase()}`;
          const story = add(isBug ? "Bug" : "User Story", title.charAt(0).toUpperCase() + title.slice(1), {
            ...lf, "System.AssignedTo": owner, "System.IterationPath": iter,
            "System.Tags": r() < 0.35 ? [pick(TAGS), ...(r() < 0.3 ? [pick(TAGS)] : [])].filter((v, i, a) => a.indexOf(v) === i).join("; ") : undefined,
            "System.Description": hasDesc ? html(`As a customer I want ${title.toLowerCase()} so that the ${ft.toLowerCase()} flow is smoother.`) : undefined,
            "Microsoft.VSTS.Common.AcceptanceCriteria": hasAc ? html("<ul><li>Given the happy path, it works.</li><li>Errors are shown in plain words.</li></ul>") : undefined,
            // a third of the stories not started yet wait for an estimate (planning poker)
            "Microsoft.VSTS.Scheduling.StoryPoints": state === "New" && r() < 0.35 ? undefined : [1, 2, 3, 5, 8, 13][Math.floor(r() * 6)],
            "Microsoft.VSTS.Common.Priority": 1 + Math.floor(r() * 3),
            [COLUMN_FIELD]: column(state, hasDesc && hasAc), [DONE_FIELD]: false,
            "System.BoardColumn": column(state, hasDesc && hasAc), "System.BoardColumnDone": false,
          }, feat.id);
          const nTasks = state === "New" ? (r() < 0.5 ? 0 : 1 + Math.floor(r() * 2)) : 1 + Math.floor(r() * 5);
          const tasks: RawItem[] = [];
          for (let ti = 0; ti < nTasks; ti++) {
            const tState = state === "Closed" || state === "Resolved" ? "Closed" : state === "New" ? "New" : r() < 0.45 ? "Closed" : r() < 0.6 ? "Active" : "New";
            const est = [2, 3, 4, 6, 8][Math.floor(r() * 5)];
            tasks.push(add("Task", TASKS[ti % TASKS.length], {
              ...lifecycle(tState, Math.max(1, age - 2)), "System.AssignedTo": owner ?? pick(PEOPLE), "System.IterationPath": iter,
              "Microsoft.VSTS.Scheduling.OriginalEstimate": est,
              "Microsoft.VSTS.Scheduling.RemainingWork": tState === "Closed" ? 0 : tState === "Active" ? Math.ceil(est / 2) : est,
              "Microsoft.VSTS.Scheduling.CompletedWork": tState === "Closed" ? est : tState === "Active" ? Math.floor(est / 2) : 0,
              "Microsoft.VSTS.Common.Activity": ti % 3 === 1 ? "Testing" : ti % 3 === 2 ? "Documentation" : "Development",
            }, story.id));
          }
          if (state !== "New" && r() < 0.7) {
            const repo = ["web-app", "payments-service", "mobile-app"][ei % 3];
            const nPr = 1 + (r() < 0.3 ? 1 : 0);
            // the first pull request is linked to the story and its first task, a second one only to the last task
            for (let k = 0; k < nPr; k++) this.addPr(r, story, repo, state, owner ?? pick(PEOPLE), k === 0 ? [story, ...tasks.slice(0, 1)] : tasks.slice(-1));
          }
          if (r() < 0.4) story.comments.push({ id: 1, text: "<div>Talked with the customer; scope stays as written.</div>", createdBy: pick(PEOPLE), createdDate: this.iso(age * DAY * 0.5) });
        }
      });
    });
    // a few stories without a Feature, and one removed item that must never show
    for (let i = 0; i < 3; i++) {
      add("User Story", ["Investigate slow login on Mondays", "Spike: evaluate feature-flag vendors", "Clean up unused storage accounts"][i], {
        ...lifecycle(i === 0 ? "Active" : "New", 10 + i * 9), "System.AssignedTo": i === 1 ? undefined : PEOPLE[i + 3],
        "System.IterationPath": i === 0 ? current.path : "Fabrikam Online", [COLUMN_FIELD]: i === 0 ? "Active" : "New", "System.BoardColumn": i === 0 ? "Active" : "New",
        "Microsoft.VSTS.Scheduling.StoryPoints": 3, "System.Tags": i === 2 ? "Tech debt" : undefined,
      });
    }
    add("User Story", "Old duplicate story", { ...lifecycle("Removed", 40), "System.State": "Removed" });

    // dependencies between Features and between stories, always forward so there is no cycle
    const feats = [...this.store.values()].filter((i) => i.fields["System.WorkItemType"] === "Feature");
    const pairs: [number, number][] = [[0, 3], [1, 4], [4, 7], [2, 9], [5, 10], [8, 12], [3, 11], [9, 15]];
    for (const [a, b] of pairs) if (feats[a] && feats[b]) this.link(feats[a].id, feats[b].id);
    const stories = [...this.store.values()].filter((i) => i.fields["System.WorkItemType"] === "User Story" && i.fields["System.State"] !== "Closed");
    for (let k = 0; k + 7 < stories.length && k < 40; k += 7) this.link(stories[k].id, stories[k + 7].id);

    this.addUnlinkedPrs();

    // history: one update per change the lifecycle implies
    for (const it of this.store.values()) this.makeHistory(it);
    this.extraProjects(r);
    this.platformTeam();
  }

  /**
   * The second team of the project (Platform Team): an Epic and three Features with dates, and dependencies
   * with Phoenix Features, one of them a conflict. Also priority score numbers on Epics and Features.
   * Its own random numbers, made after everything else, so the data above stays the same.
   */
  private platformTeam(): void {
    const r = rng(7);
    const added: RawItem[] = [];
    const add = (type: string, title: string, startIn: number, days: number, parent?: number): RawItem => {
      const id = this.nextId++;
      const it: RawItem = {
        id, rev: 1, relations: [], updates: [], comments: [], fields: {
          "System.Id": id, "System.WorkItemType": type, "System.Title": title, "System.TeamProject": "Fabrikam Online",
          "System.AreaPath": "Fabrikam Online\\Platform", "System.IterationPath": "Fabrikam Online", "System.State": "Active",
          "System.CreatedDate": this.iso(90 * DAY), "System.ChangedDate": this.iso(5 * DAY), "System.CreatedBy": PEOPLE[7], "System.ChangedBy": PEOPLE[7],
          "Microsoft.VSTS.Common.ActivatedDate": this.iso(60 * DAY), "Microsoft.VSTS.Common.StateChangeDate": this.iso(60 * DAY),
          "System.AssignedTo": PEOPLE[5 + (id % 3)], "Microsoft.VSTS.Common.StackRank": 500000 + id * 1000,
          "Microsoft.VSTS.Scheduling.StartDate": this.iso(-startIn * DAY), "Microsoft.VSTS.Scheduling.TargetDate": this.iso(-(startIn + days) * DAY),
        },
      };
      if (parent) {
        it.fields["System.Parent"] = parent;
        it.relations.push({ rel: REL.parent, url: this.wiUrl(parent), attributes: { isLocked: false, name: "Parent" } });
        this.store.get(parent)?.relations.push({ rel: REL.child, url: this.wiUrl(id), attributes: { isLocked: false, name: "Child" } });
      }
      this.store.set(id, it);
      added.push(it);
      return it;
    };
    const epic = add("Epic", "Shared platform services", -30, 150);
    const gateway = add("Feature", "API gateway", -20, 50, epic.id);
    const identity = add("Feature", "Identity service", 0, 45, epic.id);
    const events = add("Feature", "Event bus", 40, 60, epic.id);
    const phoenix = (title: string): RawItem | undefined => [...this.store.values()].find((i) => i.fields["System.WorkItemType"] === "Feature" && i.fields["System.Title"] === title);
    const verify = phoenix("Identity verification");
    const refunds = phoenix("Refund automation");
    // Phoenix's identity check waits for the identity service (which ends later: a conflict)
    if (verify) this.link(identity.id, verify.id);
    if (refunds) this.link(gateway.id, refunds.id);
    if (refunds) this.link(refunds.id, events.id);
    for (const it of added) this.makeHistory(it);
    // priority score numbers: some left empty, as in real backlogs
    const fib = [1, 2, 3, 5, 8, 13, 20];
    for (const it of this.store.values()) {
      const type = it.fields["System.WorkItemType"];
      if (type !== "Epic" && type !== "Feature") continue;
      if (it.fields["Microsoft.VSTS.Scheduling.Effort"] == null) it.fields["Microsoft.VSTS.Scheduling.Effort"] = 5 + Math.floor(r() * 20);
      if (r() < 0.85) it.fields["Microsoft.VSTS.Common.BusinessValue"] = fib[Math.floor(r() * fib.length)];
      if (r() < 0.85) it.fields["Microsoft.VSTS.Common.TimeCriticality"] = fib[Math.floor(r() * fib.length)];
      if (r() < 0.75) it.fields["Microsoft.VSTS.Common.RiskReduction"] = fib[Math.floor(r() * fib.length)];
    }
  }

  private link(pred: number, succ: number): void {
    this.store.get(pred)!.relations.push({ rel: REL.successor, url: this.wiUrl(succ), attributes: { name: "Successor" } });
    this.store.get(succ)!.relations.push({ rel: REL.predecessor, url: this.wiUrl(pred), attributes: { name: "Predecessor" } });
  }

  /** A pull request of a story, linked to the given items (the story, and sometimes its tasks). */
  private addPr(r: () => number, story: RawItem, repo: string, state: string, author: Person, linked: RawItem[] = [story]): void {
    const id = 400 + this.prs.length;
    const created = Date.parse(story.fields["Microsoft.VSTS.Common.ActivatedDate"] ?? story.fields["System.CreatedDate"]) + r() * 3 * DAY;
    const done = state === "Closed" || (state === "Resolved" && r() < 0.8);
    const status = done ? "completed" : r() < 0.1 ? "abandoned" : "active";
    const reviewers = PEOPLE.filter((p) => p.uniqueName !== author.uniqueName).filter(() => r() < 0.3).slice(0, 3)
      .map((p) => ({ ...p, vote: done ? 10 : [0, 0, 5, -5, 10][Math.floor(r() * 5)], isRequired: r() < 0.3 }));
    // a team or group asked to review, as Azure DevOps adds by branch policy
    const group = DEMO_GROUPS[Math.floor(r() * DEMO_GROUPS.length)];
    if (r() < 0.6) reviewers.push({ ...group, vote: 0, isRequired: r() < 0.5 } as typeof reviewers[number]);
    this.prs.push({
      pullRequestId: id, title: `${story.fields["System.Title"]}`.slice(0, 80), status, isDraft: status === "active" && r() < 0.2,
      createdBy: author, creationDate: new Date(Math.min(created, this.now - 3600_000)).toISOString(),
      closedDate: status !== "active" ? new Date(Math.min(created + (1 + r() * 4) * DAY, this.now - 600_000)).toISOString() : undefined,
      repository: { id: `repo-${repo}`, name: repo, project: { name: "Fabrikam Online", id: "demo-project" } },
      sourceRefName: `refs/heads/feature/${story.id}`, targetRefName: "refs/heads/main", mergeStatus: "succeeded",
      reviewers, workItemRefs: linked.map((x) => ({ id: String(x.id) })),
    });
    for (const x of linked) x.relations.push({ rel: REL.artifact, url: prArtifactUrl("demo-project", `repo-${repo}`, id), attributes: { name: "Pull Request" } });
  }

  /**
   * Pull requests nobody linked to a work item, whose branch, title or description points at a story,
   * so the Pull requests page has something to suggest. One points at nothing.
   */
  private addUnlinkedPrs(): void {
    const r = rng(4242);
    const all = [...this.store.values()];
    const open = all.filter((i) => i.fields["System.WorkItemType"] === "User Story" && i.id >= 10 && (i.fields["System.State"] === "Active" || i.fields["System.State"] === "New"));
    const withTask = open.find((s) => all.some((t) => t.fields["System.WorkItemType"] === "Task" && t.fields["System.Parent"] === s.id));
    const task = withTask && all.find((t) => t.fields["System.WorkItemType"] === "Task" && t.fields["System.Parent"] === withTask.id);
    const pickStory = (k: number): RawItem => open[Math.min(open.length - 1, k * 7)];
    const words = (s: RawItem): string => String(s.fields["System.Title"]).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const titleOf = (s: RawItem): string => String(s.fields["System.Title"]);
    const t4 = titleOf(pickStory(4)).split(" ");
    const list: { title: string; branch: string; repo: string; description?: string; status?: string; ageDays: number }[] = [
      { title: "Rework the request validation", branch: `feature/${pickStory(1).id}-${words(pickStory(1)).slice(0, 24).replace(/-+$/, "")}`, repo: "web-app", ageDays: 2 },
      { title: `AB#${pickStory(2).id} Small fixes after review`, branch: "users/ann/quick-fixes", repo: "payments-service", ageDays: 4 },
      ...(task ? [{ title: "Add missing tests", branch: `bugfix/${task.id}-tests`, repo: "mobile-app", ageDays: 1 }] : []),
      // the words of a story's title in another order: found by title words
      { title: `${t4.slice(1).join(" ")}: ${t4[0].toLowerCase()} it`, branch: "feature/improvements", repo: "web-app", ageDays: 6 },
      { title: "Bump dependencies", branch: "chore/deps", repo: "infrastructure", ageDays: 3 },
      { title: "Tidy up logging", branch: "chore/logging", repo: "payments-service", description: `Part of #${pickStory(5).id}. Less noise in the logs.`, status: "completed", ageDays: 5 },
    ];
    for (const x of list) {
      const id = 400 + this.prs.length;
      const author = PEOPLE[id % PEOPLE.length];
      const created = this.now - x.ageDays * DAY - r() * 6 * 3600_000;
      const reviewers = PEOPLE.filter((p) => p.uniqueName !== author.uniqueName).filter(() => r() < 0.25).slice(0, 2).map((p) => ({ ...p, vote: 0, isRequired: false }));
      this.prs.push({
        pullRequestId: id, title: x.title, description: x.description, status: x.status ?? "active", isDraft: false,
        createdBy: author, creationDate: new Date(created).toISOString(),
        closedDate: x.status === "completed" ? new Date(Math.min(created + DAY, this.now - 600_000)).toISOString() : undefined,
        repository: { id: `repo-${x.repo}`, name: x.repo, project: { name: "Fabrikam Online", id: "demo-project" } },
        sourceRefName: `refs/heads/${x.branch}`, targetRefName: "refs/heads/main", mergeStatus: "succeeded",
        reviewers, workItemRefs: [],
      });
    }
  }

  private makeHistory(it: RawItem): void {
    const f = it.fields;
    const isTask = f["System.WorkItemType"] === "Task";
    if (isTask) delete f["Microsoft.VSTS.Common.ResolvedDate"]; // tasks go from Active straight to Closed
    const steps: [string | undefined, string, string][] = [
      [f["System.CreatedDate"], "New", ""],
      [f["Microsoft.VSTS.Common.ActivatedDate"], "Active", "New"],
      [f["Microsoft.VSTS.Common.ResolvedDate"], "Resolved", "Active"],
      [f["Microsoft.VSTS.Common.ClosedDate"], "Closed", isTask ? "Active" : "Resolved"],
    ];
    let rev = 0;
    let lastCol = "New";
    for (const [date, to, from] of steps) {
      if (!date) continue;
      rev++;
      const fields: Record<string, any> = { "System.State": { oldValue: from || undefined, newValue: to }, "System.ChangedDate": { newValue: date } };
      if (rev === 1) {
        fields["System.Title"] = { newValue: f["System.Title"] };
        if (f["System.AssignedTo"]) fields["System.AssignedTo"] = { newValue: f["System.AssignedTo"] };
        if (f[COLUMN_FIELD]) fields[COLUMN_FIELD] = { newValue: "New" };
        lastCol = "New";
      } else if (f[COLUMN_FIELD]) {
        const next = to === "Active" ? "Active" : to === "Resolved" ? "Review" : "Closed";
        fields[COLUMN_FIELD] = { oldValue: lastCol, newValue: next };
        lastCol = next;
      }
      it.updates.push({ id: rev, rev, revisedBy: f["System.ChangedBy"] ?? PEOPLE[0], revisedDate: date, fields });
      // a story moves from New to Ready on the board before work starts (the column only, not the state)
      if (rev === 1 && f[COLUMN_FIELD] && (f[COLUMN_FIELD] === "Ready" || f["Microsoft.VSTS.Common.ActivatedDate"])) {
        const from = Date.parse(date);
        const until = f["Microsoft.VSTS.Common.ActivatedDate"] ? Date.parse(f["Microsoft.VSTS.Common.ActivatedDate"]) : this.now;
        const at = new Date(from + 0.3 * Math.max(0, until - from)).toISOString();
        rev++;
        lastCol = "Ready";
        it.updates.push({ id: rev, rev, revisedBy: f["System.ChangedBy"] ?? PEOPLE[0], revisedDate: at, fields: { [COLUMN_FIELD]: { oldValue: "New", newValue: "Ready" }, "System.ChangedDate": { newValue: at } } });
      }
    }
    it.rev = Math.max(1, rev);
    f["System.Rev"] = it.rev;
  }

  private extraProjects(r: () => number): void {
    const defs: [string, string, number][] = [["Fabrikam Mobile", "Fabrikam Mobile\\Apps", 34], ["Contoso Data", "Contoso Data\\Pipelines", 22]];
    for (const [project, area, n] of defs) {
      for (let i = 0; i < n; i++) {
        const id = this.nextId++;
        const age = Math.floor(r() * 90);
        const state = r() < 0.4 ? "Closed" : r() < 0.6 ? "Active" : "New";
        const closed = state === "Closed" ? this.iso(Math.floor(r() * age) * DAY) : undefined;
        this.store.set(id, {
          id, rev: 1, relations: [], updates: [], comments: [], fields: {
            "System.Id": id, "System.WorkItemType": "User Story", "System.Title": `${VERBS[i % VERBS.length]} ${THINGS[i % THINGS.length]}`,
            "System.TeamProject": project, "System.AreaPath": area, "System.IterationPath": project, "System.State": state,
            "System.CreatedDate": this.iso(age * DAY), "System.ChangedDate": this.iso(Math.floor(r() * age) * DAY),
            "Microsoft.VSTS.Common.ClosedDate": closed, "System.AssignedTo": PEOPLE[i % PEOPLE.length],
          },
        });
      }
    }
  }

  private wiUrl(id: number): string { return `${this.ctx.orgUrl}_apis/wit/workItems/${id}`; }

  // ---------- Api ----------

  itemUrl(project: string, id: number): string { return `${this.ctx.orgUrl}${encodeURIComponent(project)}/_workitems/edit/${id}`; }

  projects(): Promise<Project[]> {
    return this.wait([
      { id: "demo-project", name: "Fabrikam Online", description: "Demo project with made-up data", lastUpdateTime: this.iso(2 * 3600_000) },
      { id: "demo-mobile", name: "Fabrikam Mobile", description: "Second demo project", lastUpdateTime: this.iso(3 * DAY) },
      { id: "demo-data", name: "Contoso Data", description: "Third demo project", lastUpdateTime: this.iso(12 * DAY) },
      { id: "demo-archive", name: "Legacy Archive", description: "No activity", lastUpdateTime: this.iso(400 * DAY) },
    ]);
  }

  teams(project: string, opts: { mine?: boolean } = {}): Promise<Team[]> {
    const name = { "Fabrikam Online": ["Phoenix Team", "Platform Team"], "Fabrikam Mobile": ["Mobile Team"], "Contoso Data": ["Data Team"] }[project] ?? [`${project} Team`];
    const about: Record<string, string> = { "Phoenix Team": "Checkout, payments and identity", "Platform Team": "Shared services: gateway, identity, events" };
    // the demo person is a member of the first team of each project
    const list = opts.mine ? name.slice(0, 1) : name;
    return this.wait(list.map((n, i) => ({ id: `team-${project}-${i}`, name: n, description: about[n], projectName: project })));
  }

  teamMembers(): Promise<Person[]> { return this.wait(PEOPLE); }

  teamSettings(project: string, team: string): Promise<TeamSettings> {
    const area = project === "Fabrikam Online" ? (team === "Platform Team" ? "Fabrikam Online\\Platform" : "Fabrikam Online\\Phoenix")
      : project === "Fabrikam Mobile" ? "Fabrikam Mobile\\Apps" : project === "Contoso Data" ? "Contoso Data\\Pipelines" : project;
    return this.wait({
      backlogIteration: project, defaultIteration: undefined, bugsBehavior: "asRequirements",
      workingDays: [1, 2, 3, 4, 5], areas: [{ path: area, includeChildren: true }], defaultArea: area,
    });
  }

  iterations(project: string): Promise<Iteration[]> {
    return this.wait(project === "Fabrikam Online" ? this.iters : this.iters.map((i) => ({ ...i, path: i.path.replace("Fabrikam Online", project) })));
  }

  process(): Promise<ProcessInfo> { return this.wait(DEMO_PROCESS); }

  private limitEdits = new Map<string, number>();

  setColumnLimit(_p: string, _t: string, _board: string, column: string, limit: number): Promise<void> {
    this.limitEdits.set(column, limit);
    return this.wait(undefined);
  }

  board(_p: string, _t: string, level: string): Promise<BoardInfo | null> {
    if (level !== "Stories") return this.wait(null);
    const col = (name: string, state: string, type: BoardInfo["columns"][0]["columnType"], limit = 0) => ({
      id: "col-" + name, name, itemLimit: this.limitEdits.get(name) ?? limit, isSplit: false, columnType: type,
      stateMappings: { "User Story": state, Bug: state === "Resolved" ? "Resolved" : state },
    });
    return this.wait({
      name: "Stories",
      columns: [col("New", "New", "incoming"), col("Ready", "New", "inProgress", 12), col("Active", "Active", "inProgress", 10), col("Review", "Resolved", "inProgress", 6), col("Closed", "Closed", "outgoing")],
      columnField: COLUMN_FIELD, doneField: DONE_FIELD, rowField: LANE_FIELD, rows: [""],
    });
  }

  /** capacity changed in this browser tab, per sprint (the generated one is used until then) */
  private capacityEdits = new Map<string, Capacity>();

  capacity(_p: string, _t: string, iterationId: string): Promise<Capacity> {
    const edited = this.capacityEdits.get(iterationId);
    if (edited) return this.wait(edited);
    const n = Number(iterationId.replace(/\D/g, "")) || 0;
    const it = this.iters.find((i) => i.id === iterationId);
    const start = it?.start ? Date.parse(it.start) : this.now;
    return this.wait({
      members: PEOPLE.map((p, i) => ({
        person: p,
        activities: [{ name: i % 4 === 3 ? "Testing" : "Development", capacityPerDay: i === 6 ? 3 : 6 }],
        daysOff: (i + n) % 5 === 0 ? [{ start: new Date(start + 2 * DAY).toISOString(), end: new Date(start + 3 * DAY).toISOString() }] : [],
      })),
      teamDaysOff: [],
    });
  }

  async setCapacity(p: string, t: string, iterationId: string, memberId: string, body: { activities: { name: string; capacityPerDay: number }[]; daysOff: { start: string; end: string }[] }): Promise<void> {
    const cap = structuredClone(await this.capacity(p, t, iterationId));
    const m = cap.members.find((x) => x.person.id === memberId);
    if (m) { m.activities = body.activities; m.daysOff = body.daysOff; }
    else { const person = PEOPLE.find((x) => x.id === memberId); if (person) cap.members.push({ person, ...body }); }
    this.capacityEdits.set(iterationId, cap);
  }

  async setTeamDaysOff(p: string, t: string, iterationId: string, daysOff: { start: string; end: string }[]): Promise<void> {
    const cap = structuredClone(await this.capacity(p, t, iterationId));
    cap.teamDaysOff = daysOff;
    this.capacityEdits.set(iterationId, cap);
  }

  // ---------- work items ----------

  private matches(it: RawItem, spec: QuerySpec, project: string): boolean {
    const f = it.fields;
    if (spec.project !== "*" && f["System.TeamProject"] !== (spec.project ?? project)) return false;
    if (spec.ids && !spec.ids.includes(it.id)) return false;
    if (spec.parents && !spec.parents.includes(Number(f["System.Parent"]))) return false;
    if (spec.types && !spec.types.includes(f["System.WorkItemType"])) return false;
    if (spec.areas?.length && !spec.areas.some((a) => f["System.AreaPath"] === a.path || (a.includeChildren && String(f["System.AreaPath"]).startsWith(a.path + "\\")))) return false;
    if (spec.iterationUnder && !(f["System.IterationPath"] === spec.iterationUnder || String(f["System.IterationPath"]).startsWith(spec.iterationUnder + "\\"))) return false;
    if (spec.states && !spec.states.includes(f["System.State"])) return false;
    if (spec.notStates && spec.notStates.includes(f["System.State"])) return false;
    if (spec.assignedTo) {
      const a = f["System.AssignedTo"];
      if (!a || (a.uniqueName !== spec.assignedTo && a.displayName !== spec.assignedTo)) return false;
    }
    if (spec.tag && !String(f["System.Tags"] ?? "").split(";").map((t) => t.trim().toLowerCase()).includes(spec.tag.toLowerCase())) return false;
    const after = (field: string, d?: string) => !d || (f[field] && Date.parse(f[field]) >= Date.parse(d));
    if (!after("System.ChangedDate", spec.changedAfter)) return false;
    if (!after("System.CreatedDate", spec.createdAfter)) return false;
    if (!after("Microsoft.VSTS.Common.ClosedDate", spec.closedAfter)) return false;
    if (spec.closedBefore && !(f["Microsoft.VSTS.Common.ClosedDate"] && Date.parse(f["Microsoft.VSTS.Common.ClosedDate"]) < Date.parse(spec.closedBefore))) return false;
    return true;
  }

  query(project: string, spec: QuerySpec): Promise<number[]> {
    if (matchesNothing(spec)) return this.wait([]);
    let list = [...this.store.values()].filter((it) => this.matches(it, spec, project));
    if (spec.orderBy === "changed") list.sort((a, b) => Date.parse(b.fields["System.ChangedDate"]) - Date.parse(a.fields["System.ChangedDate"]));
    else if (spec.orderBy === "closed") list.sort((a, b) => Date.parse(b.fields["Microsoft.VSTS.Common.ClosedDate"] ?? 0) - Date.parse(a.fields["Microsoft.VSTS.Common.ClosedDate"] ?? 0));
    if (list.length > (spec.top ?? 20000)) list = list.slice(0, spec.top ?? 20000);
    return this.wait(list.map((i) => i.id));
  }

  /** An item as Azure DevOps sends it: every field with a value, or only these fields (`only`). */
  private out(it: RawItem, relations: boolean, only?: string[]): WorkItem {
    let fields: Record<string, any> = { ...it.fields, "System.Rev": it.rev };
    if (only) fields = Object.fromEntries(only.filter((f) => fields[f] != null).map((f) => [f, fields[f]]));
    const raw = { id: it.id, rev: it.rev, fields, relations: relations ? it.relations : undefined };
    const item = normalizeItem(structuredClone(raw), DEMO_PROCESS, COLUMN_FIELD, DONE_FIELD, LANE_FIELD);
    if (only) item.fieldsRead = only;
    return item;
  }

  items(_p: string, ids: number[], opts: { fields?: string[]; relations?: boolean } = {}): Promise<WorkItem[]> {
    // like Azure DevOps: a read with links has every field, a list read only the fields asked for
    const only = opts.relations ? undefined
      : [...new Set([...BASE_FIELDS, ...processFields(DEMO_PROCESS), COLUMN_FIELD, DONE_FIELD, LANE_FIELD, ...(opts.fields ?? [])])];
    return this.wait(ids.map((id) => this.store.get(id)).filter((x): x is RawItem => Boolean(x)).map((it) => this.out(it, Boolean(opts.relations), only)));
  }

  item(_p: string, id: number): Promise<WorkItem> {
    const it = this.store.get(id);
    if (!it) return Promise.reject(new ApiError(404, `Work item ${id} does not exist`));
    return this.wait(this.out(it, true));
  }

  fieldsAsOf(_p: string, ids: number[], fields: string[], asOf: string): Promise<Map<number, Record<string, unknown>>> {
    const t = Date.parse(asOf);
    const out = new Map<number, Record<string, unknown>>();
    for (const id of ids) {
      const it = this.store.get(id);
      if (!it || Date.parse(String(it.fields["System.CreatedDate"] ?? "")) > t) continue;
      const ups = (it.updates ?? []).map(normalizeUpdate);
      out.set(id, Object.fromEntries(fields.map((f) => [f, valueAt(ups, f, it.fields[f], t)])));
    }
    return this.wait(out);
  }

  revisions(_p: string, id: number): Promise<{ changed: string; fields: Record<string, unknown> }[]> {
    const it = this.store.get(id);
    if (!it) return this.wait([]);
    const ups = (it.updates ?? []).map(normalizeUpdate);
    const at = (t: number): Record<string, unknown> => Object.fromEntries(Object.keys(it.fields).map((f) => [f, valueAt(ups, f, it.fields[f], t)]));
    return this.wait(ups.map((u) => ({ changed: u.date, fields: { ...at(Date.parse(u.date)), "System.ChangedDate": u.date } })));
  }

  updates(_p: string, id: number): Promise<Update[]> {
    return this.wait((this.store.get(id)?.updates ?? []).map(normalizeUpdate));
  }

  comments(_p: string, id: number): Promise<Comment[]> {
    return this.wait([...(this.store.get(id)?.comments ?? [])].reverse());
  }

  addComment(_p: string, id: number, html: string): Promise<Comment> {
    const it = this.store.get(id);
    if (!it) return Promise.reject(new ApiError(404, "No such work item"));
    const c: Comment = { id: it.comments.length + 1, text: html, createdBy: this.ctx.me, createdDate: new Date().toISOString() };
    it.comments.push(c);
    return this.wait(c);
  }

  private apply(it: RawItem, ops: PatchOp[]): Record<string, any> {
    const changes: Record<string, any> = {};
    for (const op of ops) {
      if (op.op === "test") continue;
      if (op.path.startsWith("/fields/")) {
        const field = op.path.slice(8);
        const old = it.fields[field];
        let value: any = op.op === "remove" ? undefined : op.value;
        if (field === "System.AssignedTo" && typeof value === "string") value = PEOPLE.find((p) => p.uniqueName === value || p.displayName === value) ?? person(value);
        it.fields[field] = value;
        changes[field] = { oldValue: old, newValue: value };
        if (field === "System.State") {
          const now = new Date().toISOString();
          it.fields["Microsoft.VSTS.Common.StateChangeDate"] = now;
          const cat = DEMO_PROCESS.types[it.fields["System.WorkItemType"]]?.states.find((s) => s.name === value)?.category;
          if (cat === "InProgress" && !it.fields["Microsoft.VSTS.Common.ActivatedDate"]) it.fields["Microsoft.VSTS.Common.ActivatedDate"] = now;
          if (cat === "Completed") { it.fields["Microsoft.VSTS.Common.ClosedDate"] = now; it.fields["Microsoft.VSTS.Common.ClosedBy"] = this.ctx.me; }
          else delete it.fields["Microsoft.VSTS.Common.ClosedDate"];
          if (cat === "Proposed") delete it.fields["Microsoft.VSTS.Common.ActivatedDate"];
          // keep the board column in step with the state, as Azure DevOps does
          const col = { New: "New", Active: "Active", Resolved: "Review", Closed: "Closed" }[String(value)];
          if (col && !ops.some((o) => o.path === `/fields/${COLUMN_FIELD}`)) {
            const cur = it.fields[COLUMN_FIELD];
            const fits = (cur === "Ready" && value === "New") || cur === col;
            if (!fits) { it.fields[COLUMN_FIELD] = col; it.fields["System.BoardColumn"] = col; }
          }
        }
        if (field === COLUMN_FIELD) it.fields["System.BoardColumn"] = value;
      } else if (op.path === "/relations/-" && op.value) {
        const rel = op.value as { rel: string; url: string; attributes?: Record<string, unknown> };
        it.relations.push({ rel: rel.rel, url: rel.url, attributes: rel.attributes ?? {} });
        const target = /\/workItems\/(\d+)$/i.exec(rel.url);
        if (target) {
          const other = this.store.get(Number(target[1]));
          const reverse: Record<string, string> = { [REL.parent]: REL.child, [REL.child]: REL.parent, [REL.predecessor]: REL.successor, [REL.successor]: REL.predecessor, [REL.related]: REL.related };
          if (other && reverse[rel.rel]) other.relations.push({ rel: reverse[rel.rel], url: this.wiUrl(it.id), attributes: {} });
          if (rel.rel === REL.parent) it.fields["System.Parent"] = Number(target[1]);
          if (rel.rel === REL.child && other) other.fields["System.Parent"] = it.id;
        }
        changes.__relAdded = [...(changes.__relAdded ?? []), rel];
      } else if (/^\/relations\/\d+$/.test(op.path) && op.op === "remove") {
        const idx = Number(op.path.split("/")[2]);
        const rel = it.relations[idx];
        if (!rel) throw new ApiError(400, "No relation at " + idx);
        it.relations.splice(idx, 1);
        const target = /\/workItems\/(\d+)$/i.exec(rel.url);
        if (target) {
          const other = this.store.get(Number(target[1]));
          if (other) other.relations = other.relations.filter((x) => !x.url.endsWith(`/workItems/${it.id}`) || x.rel === rel.rel);
          if (rel.rel === REL.parent) delete it.fields["System.Parent"];
          if (rel.rel === REL.child && other) delete other.fields["System.Parent"];
        }
        changes.__relRemoved = [...(changes.__relRemoved ?? []), rel];
      }
    }
    return changes;
  }

  update(_p: string, id: number, ops: PatchOp[], opts: { rev?: number } = {}): Promise<WorkItem> {
    const it = this.store.get(id);
    if (!it) return Promise.reject(new ApiError(404, `Work item ${id} does not exist`));
    if (opts.rev && opts.rev !== it.rev) return Promise.reject(new ApiError(412, `Work item ${id} was changed by someone else (revision ${it.rev}, you had ${opts.rev}).`));
    if (ops.some((o) => o.path === "/fields/System.State" && o.value === "Removed")) {
      // allowed in Azure DevOps too; the demo keeps it
    }
    const changes = this.apply(it, ops);
    it.rev++;
    it.fields["System.Rev"] = it.rev;
    it.fields["System.ChangedDate"] = new Date().toISOString();
    it.fields["System.ChangedBy"] = this.ctx.me;
    const { __relAdded, __relRemoved, ...fieldChanges } = changes;
    it.updates.push({ id: it.updates.length + 1, rev: it.rev, revisedBy: this.ctx.me, revisedDate: it.fields["System.ChangedDate"], fields: fieldChanges, relations: { added: __relAdded, removed: __relRemoved } });
    return this.wait(this.out(it, true));
  }

  create(project: string, type: string, ops: PatchOp[]): Promise<WorkItem> {
    const id = this.nextId++;
    const it: RawItem = {
      id, rev: 0, relations: [], updates: [], comments: [],
      fields: {
        "System.Id": id, "System.WorkItemType": type, "System.TeamProject": project, "System.State": DEMO_PROCESS.types[type]?.states[0]?.name ?? "New",
        "System.AreaPath": project, "System.IterationPath": project, "System.CreatedDate": new Date().toISOString(), "System.CreatedBy": this.ctx.me,
        "Microsoft.VSTS.Common.StackRank": Math.max(...[...this.store.values()].map((i) => Number(i.fields["Microsoft.VSTS.Common.StackRank"] ?? 0))) + 1000,
        [COLUMN_FIELD]: "New", "System.BoardColumn": "New",
      },
    };
    this.store.set(id, it);
    this.apply(it, ops);
    it.rev = 1;
    it.fields["System.ChangedDate"] = it.fields["System.CreatedDate"];
    it.fields["System.ChangedBy"] = this.ctx.me;
    it.fields["Microsoft.VSTS.Common.StateChangeDate"] = it.fields["System.CreatedDate"];
    it.updates.push({ id: 1, rev: 1, revisedBy: this.ctx.me, revisedDate: it.fields["System.CreatedDate"], fields: { "System.State": { newValue: it.fields["System.State"] }, "System.Title": { newValue: it.fields["System.Title"] } } });
    return this.wait(this.out(it, true));
  }

  deleteItem(_p: string, id: number): Promise<void> {
    const it = this.store.get(id);
    if (!it) return Promise.reject(new ApiError(404, `Work item ${id} does not exist`));
    this.store.delete(id);
    this.bin.set(id, it);
    this.binInfo.set(id, { by: this.ctx.me, date: new Date().toISOString() });
    return this.wait(undefined);
  }

  deletedItems(_p: string): Promise<DeletedItem[]> {
    const list = [...this.bin.values()].map((it) => ({
      id: it.id, title: String(it.fields["System.Title"] ?? ""), type: String(it.fields["System.WorkItemType"] ?? ""),
      deletedBy: this.binInfo.get(it.id)?.by, deletedDate: this.binInfo.get(it.id)?.date ?? "",
    }));
    return this.wait(list.sort((a, b) => b.deletedDate.localeCompare(a.deletedDate)));
  }

  deletedArea(_p: string, id: number): Promise<string | undefined> {
    const a = this.bin.get(id)?.fields["System.AreaPath"];
    return this.wait(typeof a === "string" ? a : undefined);
  }

  restoreItem(_p: string, id: number): Promise<void> {
    const it = this.bin.get(id);
    if (!it) return Promise.reject(new ApiError(404, `Work item ${id} is not in the Recycle Bin`));
    this.bin.delete(id);
    this.binInfo.delete(id);
    it.rev++;
    it.fields["System.Rev"] = it.rev;
    it.fields["System.ChangedDate"] = new Date().toISOString();
    this.store.set(id, it);
    return this.wait(undefined);
  }

  /** Like Azure DevOps: the new order is a change of the item (a new revision in its history). */
  reorder(_p: string, _t: string, ids: number[], previousId: number, nextId: number): Promise<{ id: number; order: number }[]> {
    const ord = (id: number): number | undefined => (id ? Number(this.store.get(id)?.fields["Microsoft.VSTS.Common.StackRank"]) : undefined);
    const lo = ord(previousId);
    const hi = ord(nextId);
    const out: { id: number; order: number }[] = [];
    ids.forEach((id, i) => {
      const step = (i + 1) / (ids.length + 1);
      const v = lo != null && hi != null ? lo + (hi - lo) * step : lo != null ? lo + 10 * (i + 1) : hi != null ? hi - 10 * (ids.length - i) : 1000;
      const it = this.store.get(id);
      if (it) {
        const old = it.fields["Microsoft.VSTS.Common.StackRank"];
        it.fields["Microsoft.VSTS.Common.StackRank"] = v;
        it.rev++;
        it.fields["System.Rev"] = it.rev;
        it.fields["System.ChangedDate"] = new Date().toISOString();
        it.fields["System.ChangedBy"] = this.ctx.me;
        it.updates.push({ id: it.updates.length + 1, rev: it.rev, revisedBy: this.ctx.me, revisedDate: it.fields["System.ChangedDate"], fields: { "Microsoft.VSTS.Common.StackRank": { oldValue: old, newValue: v } } });
      }
      out.push({ id, order: v });
    });
    return this.wait(out);
  }

  // ---------- code ----------

  repositories(project: string): Promise<Repository[]> {
    return this.wait(project === "Fabrikam Online" ? ["web-app", "payments-service", "mobile-app", "infrastructure"].map((n) => ({ id: "repo-" + n, name: n, project, defaultBranch: "refs/heads/main" })) : [{ id: "repo-" + project, name: project.toLowerCase().replace(/\s/g, "-"), project }]);
  }

  pullRequests(project: string, opts: { status: "active" | "completed" | "abandoned" | "all"; minTime?: string; top?: number; creatorId?: string }): Promise<PullRequest[]> {
    if (project !== "Fabrikam Online") return this.wait([]);
    const list = this.prs.filter((p) => (opts.status === "all" || p.status === opts.status)
      && (!opts.minTime || Date.parse(p.closedDate ?? p.creationDate) >= Date.parse(opts.minTime))
      && (!opts.creatorId || p.createdBy.id === opts.creatorId));
    return this.wait(list.slice(0, opts.top ?? 500).map((p) => normalizePr(p, this.ctx.orgUrl)));
  }

  pullRequest(id: number): Promise<PullRequest | null> {
    const p = this.prs.find((x) => x.pullRequestId === id);
    return this.wait(p ? normalizePr(p, this.ctx.orgUrl) : null);
  }

  firstApproval(_p: string, _r: string, prId: number): Promise<string | undefined> {
    // made-up but steady: approved some hours after opening, for the ones that got approved
    const p = this.prs.find((x) => x.pullRequestId === prId);
    if (!p || !p.reviewers.some((r: any) => r.vote >= 5)) return this.wait(undefined);
    const hours = 2 + ((prId * 2654435761) >>> 0) % 70;
    const end = Date.parse(p.closedDate ?? new Date().toISOString());
    return this.wait(new Date(Math.min(end, Date.parse(p.creationDate) + hours * 3600_000)).toISOString());
  }

  pullRequestWorkItems(_p: string, repoId: string, prId: number): Promise<number[]> {
    // as in Azure DevOps: the work items whose links name this pull request
    const ids: number[] = [];
    for (const it of this.store.values()) {
      if (it.relations.some((rel) => { const a = prFromArtifact(rel.url); return a?.prId === prId && a.repoId === repoId; })) ids.push(it.id);
    }
    return this.wait(ids);
  }

  branches(_p: string, repoId: string): Promise<string[]> {
    const names = new Set(["main", "develop"]);
    for (const p of this.prs) if (p.repository.id === repoId) names.add(String(p.sourceRefName).replace(/^refs\/heads\//, ""));
    return this.wait([...names].sort());
  }

  // ---------- tags, people, permissions ----------

  tags(project: string): Promise<Tag[]> {
    const names = new Set<string>();
    for (const it of this.store.values()) if (it.fields["System.TeamProject"] === project) for (const t of String(it.fields["System.Tags"] ?? "").split(";")) if (t.trim()) names.add(t.trim());
    names.add("security"); names.add("Perfomance"); names.add("Old-release-2023");
    return this.wait([...names].sort().map((n) => ({ id: "tag-" + n, name: n })));
  }
  async renameTag(project: string, tagId: string, name: string): Promise<void> {
    const old = tagId.replace(/^tag-/, "");
    for (const it of this.store.values()) {
      if (it.fields["System.TeamProject"] !== project) continue;
      const tags = String(it.fields["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean);
      if (tags.includes(old)) it.fields["System.Tags"] = tags.map((t) => (t === old ? name : t)).join("; ");
    }
    await this.wait(null);
  }
  async deleteTag(): Promise<void> { await this.wait(null); }

  avatar(): Promise<string | null> { return Promise.resolve(null); }

  // ---------- extension storage: this browser only ----------

  private local = new LocalDocs("flowboards-demo");
  docs(collection: string, scope: "shared" | "user"): Promise<ExtensionDoc[]> { return this.local.docs(collection, scope); }
  getDoc(collection: string, id: string, scope: "shared" | "user"): Promise<ExtensionDoc | null> { return this.local.getDoc(collection, id, scope); }
  setDoc(collection: string, doc: ExtensionDoc, scope: "shared" | "user"): Promise<ExtensionDoc> { return this.local.setDoc(collection, doc, scope); }
  createDoc(collection: string, doc: ExtensionDoc, scope: "shared" | "user"): Promise<ExtensionDoc> { return this.local.createDoc(collection, doc, scope); }

  deleteDoc(collection: string, id: string, scope: "shared" | "user"): Promise<void> { return this.local.deleteDoc(collection, id, scope); }
}

export const DEMO = { project: "Fabrikam Online", team: "Phoenix Team", people: PEOPLE };
