// Pull requests: open pull requests with age, reviewers and votes, who each one waits on, and
// recently completed and abandoned ones with time to merge. This project or every project.
// Each row shows the stories it is linked to (a linked task shows as its story); a row with no link
// suggests likely stories with a Link button; "Link…" finds any work item of the team, × takes a link off
// (both are work item changes with Undo). "New pull request" opens Azure DevOps's own create page.
import type { App, View } from "../app/context.ts";
import type { Person, PullRequest, Repository, WorkItem } from "../api/types.ts";
import { DAY, fmtDate, isClosed, levelOf, personKey } from "../core/model.ts";
import { prefs } from "../core/settings.ts";
import { h, icon, replace, svg } from "../ui/dom.ts";
import type { Child } from "../ui/dom.ts";
import { sortable } from "../ui/sortable.ts";
import { avatar, busy, empty, errorText, failed, help, popup, segmented, select, spinner, toast, typeMark } from "../ui/kit.ts";
import type { Candidate, LevelKind, StoryLink, StoryRef } from "./prlogic.ts";
import {
  ageLevel, daysBetween, fmtDuration, isAuthor, isNoAccess, isOpen, median, mergeStats, missingParents, namesText, needsReviewBy, newPrUrl, percentile,
  prCandidates, runLimited, shortName, shownPerson, sortKeyFor, storyLinks, VOTE_LABEL, voteKind, waitingOn, weeklyCounts, weeklyTimes, weekStart,
} from "./prlogic.ts";
import { pageBar } from "../ui/pagebar.ts";
import { matchItems } from "../ui/mentions.ts";
import { linkPullRequest, removePullRequestLink } from "./prlink.ts";
import { approvedAt, isTeamPr, readApprovals } from "../app/prtimes.ts";
import { timesChart } from "./prtimes.ts";

type Tab = "open" | "completed" | "abandoned";
type Scope = "project" | "all";
type SortKey = "age" | "title" | "author" | "repo" | "closed" | "merge";
interface Filters { repo: string; author: string; reviewer: string; group: string; needsMe: boolean; mine: boolean; quick: "" | "noReviewer" | "waiting" }
interface Sort { key: SortKey; dir: 1 | -1 }
const PREFS_KEY = "prs:view";

interface Load {
  prs: PullRequest[];
  done: number;
  total: number;
  loading: boolean;
  noAccess: string[];
  failed: string[];
  error?: unknown;
  at: number;
}

const RECENT_DAYS = 30;
const CACHE_MS = 60_000;
/** rows drawn at first, and added by each "Show more" */
const PAGE_ROWS = 150;

/** run `fn` once after a short pause, however often it is asked */
function debounceTimes(fn: () => void): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => { clearTimeout(t); t = setTimeout(fn, 250); };
}

/** Kept while the page is open: the last choices and what was read, so coming back is instant. */
const memo = {
  scope: "project" as Scope,
  /** whose pull requests: the team's members' (the default), or everyone's */
  who: "team" as "team" | "all",
  tab: "open" as Tab,
  loads: new Map<string, Load>(),
  /** work item ids linked to a pull request (by pull request id) */
  links: new Map<number, number[] | "loading" | "failed">(),
  /** linked work items (and the stories above linked tasks) that are not part of the team's loaded work */
  items: new Map<number, WorkItem>(),
  /** ids Azure DevOps did not give back (deleted, no access): not asked again */
  unreadable: new Set<number>(),
  repos: new Map<string, Repository[]>(),
  branches: new Map<string, string[]>(),
  listeners: new Set<() => void>(),
};

function notify(): void {
  for (const fn of memo.listeners) fn();
}

function loadKey(app: App, scope: Scope, tab: Tab): string {
  return `${app.api.ctx.orgUrl}|${scope === "all" ? "*" : app.ws.project}|${tab}`;
}

/** Read the pull requests of a tab, one project at a time (at most 4 at once) for the whole organization. */
function startLoad(app: App, scope: Scope, tab: Tab): Load {
  const key = loadKey(app, scope, tab);
  const st: Load = { prs: [], done: 0, total: 0, loading: true, noAccess: [], failed: [], at: Date.now() };
  memo.loads.set(key, st);
  const since = new Date(Date.now() - RECENT_DAYS * DAY).toISOString();
  const opts = tab === "open" ? { status: "active" as const, top: 1000 } : { status: tab, minTime: since, top: 1000 };
  const current = (): boolean => memo.loads.get(key) === st;
  void (async () => {
    try {
      const names = scope === "project" ? [app.ws.project] : (await app.api.projects()).map((p) => p.name);
      st.total = names.length;
      notify();
      const seen = new Set<number>();
      await runLimited(names, 4, (name) => app.api.pullRequests(name, opts), (done, name, res) => {
        if (!current()) return;
        st.done = done;
        if (res.value) {
          for (const pr of res.value) {
            if (seen.has(pr.id)) continue;
            if (tab !== "open" && pr.closed && Date.parse(pr.closed) < Date.parse(since)) continue;
            seen.add(pr.id);
            st.prs.push(pr);
          }
        } else if (scope === "project") st.error = res.error;
        else if (isNoAccess(res.error)) st.noAccess.push(name);
        else st.failed.push(`${name} (${errorText(res.error)})`);
        notify();
      }, () => !current());
    } catch (e) {
      st.error = e;
    }
    st.loading = false;
    st.at = Date.now();
    if (current()) notify();
  })();
  return st;
}

function getLoad(app: App, scope: Scope, tab: Tab, fresh = false): Load {
  const st = memo.loads.get(loadKey(app, scope, tab));
  // a failed load stays (and shows its error) until "Try again" or "Read again" asks for a fresh one
  if (st && !fresh && (st.loading || st.error || Date.now() - st.at < CACHE_MS)) return st;
  return startLoad(app, scope, tab);
}

// ---------- linked work items, read for the rows on screen ----------

const linkQueue: PullRequest[] = [];
const pump = { running: 0 };

const kindOf = (app: App) => (type: string): LevelKind | undefined => levelOf(app.ws.process, type)?.kind;
const known = (app: App, id: number): WorkItem | undefined => app.ws.get(id) ?? memo.items.get(id);

/**
 * Read work items that are neither loaded nor read before. Ids a successful read did not give back are not
 * asked again; a failed read throws, so the row shows a retry and nothing is marked unreadable.
 */
async function readItems(app: App, project: string, ids: number[]): Promise<void> {
  const need = [...new Set(ids)].filter((id) => !known(app, id) && !memo.unreadable.has(id));
  if (!need.length) return;
  for (const it of await app.api.items(project, need)) memo.items.set(it.id, it);
  for (const id of need) if (!known(app, id)) memo.unreadable.add(id);
}

/** The work items linked to a pull request, with what is needed to show them at the story level. */
async function readLinks(app: App, pr: PullRequest): Promise<number[]> {
  const project = pr.repository.project || app.ws.project;
  const ids = await app.api.pullRequestWorkItems(project, pr.repository.id, pr.id);
  await readItems(app, project, ids);
  const get = (id: number): WorkItem | undefined => known(app, id);
  for (let i = 0; i < 4; i++) {
    const miss = missingParents(ids, get, kindOf(app)).filter((id) => !memo.unreadable.has(id));
    if (!miss.length) break;
    await readItems(app, project, miss);
  }
  return ids;
}

function wantLinks(app: App, pr: PullRequest): void {
  if (memo.links.has(pr.id)) return;
  memo.links.set(pr.id, "loading");
  linkQueue.push(pr);
  pumpLinks(app);
}

/** At most 4 pull requests read at once; the rows that come into view join the queue. */
function pumpLinks(app: App): void {
  while (pump.running < 4 && linkQueue.length) {
    const pr = linkQueue.shift()!;
    pump.running++;
    readLinks(app, pr)
      .then((ids) => memo.links.set(pr.id, ids), () => memo.links.set(pr.id, "failed"))
      .finally(() => { pump.running--; pumpLinks(app); refill(pr.id); });
  }
}

/** Views on screen that want to hear when a pull request's work items arrive. */
const fillLinks = new Set<(prId: number) => void>();
const refill = (prId: number): void => fillLinks.forEach((fn) => fn(prId));

// ---------- repositories and branches, for "New pull request" ----------

async function reposOf(app: App, project: string): Promise<Repository[]> {
  let r = memo.repos.get(project);
  if (!r) { r = (await app.api.repositories(project)).filter((x) => !x.isDisabled).sort((a, b) => a.name.localeCompare(b.name)); memo.repos.set(project, r); }
  return r;
}

async function branchesOf(app: App, project: string, repoId: string): Promise<string[]> {
  let b = memo.branches.get(repoId);
  if (!b) { b = (await app.api.branches(project, repoId)).sort((x, y) => x.localeCompare(y)); memo.branches.set(repoId, b); }
  return b;
}

// ---------- view ----------

export const prsView: View = {
  id: "prs",
  title: "Pull requests",
  tab: "Pull",
  icon: "pr",
  group: "measure",
  about: "Open pull requests with age, reviewers and votes, who each one waits on, and what was completed or abandoned lately.",
  mount(el, app, params) {
    const me = app.api.ctx.me;
    if (params.tab === "open" || params.tab === "completed" || params.tab === "abandoned") memo.tab = params.tab;
    // filters and sort are kept in this browser, so a visit starts where the last one ended
    const kept = prefs.get<{ f?: Partial<Filters>; sort?: Partial<Sort>; project?: string }>(PREFS_KEY, {});
    const f: Filters = { repo: "", author: "", reviewer: "", group: "", needsMe: false, mine: false, quick: "", ...(kept.f ?? {}) };
    // repositories and groups belong to a project: the choice of another project would show nothing here
    if (kept.project !== app.ws.project) { f.repo = ""; f.group = ""; }
    const sort: Sort = { key: "age", dir: -1, ...(kept.sort ?? {}) };
    let keptJson = JSON.stringify({ f, sort });
    const keep = (): void => {
      const json = JSON.stringify({ f, sort });
      if (json !== keptJson) { keptJson = json; prefs.set(PREFS_KEY, { f, sort, project: app.ws.project }); }
    };
    memo.who = prefs.get<string>("prs:who", "team") === "all" ? "all" : "team";
    let alive = true;
    let lastDataSig = "";
    /** rows drawn now; another tab, scope, team choice, filter or search starts again from the first rows */
    let limit = PAGE_ROWS;
    let limitSig = "";
    /** the team's members: a pull request is the team's when one of them wrote it or is asked to review it (a group does not count) */
    const teamKeys = new Set(app.ws.teamMembers().map((p) => personKey(p)));
    const teamPr = (pr: PullRequest): boolean => isTeamPr(app, pr, teamKeys);

    // rows on screen: pull request id -> fill its work item cell and team badge
    const rowFill = new Map<number, () => void>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const pr = (e.target as HTMLElement & { _pr?: PullRequest })._pr;
        if (pr) wantLinks(app, pr);
      }
    }, { rootMargin: "200px" });
    const onLinks = (prId: number): void => { rowFill.get(prId)?.(); };
    fillLinks.add(onLinks);

    // ---- frame ----
    const scopeSeg = segmented<Scope>([
      { value: "project", label: "This project", title: `Pull requests of ${app.ws.project}` },
      { value: "all", label: "All projects", title: "Pull requests of every project of the organization (reads each project)" },
    ], memo.scope, (v) => { memo.scope = v; lastDataSig = ""; draw(); });
    const whoSeg = segmented<"team" | "all">([
      { value: "team", label: "My team", title: `Pull requests that a member of ${app.ws.team} wrote or was asked to review (who the members are: Settings > Team)` },
      { value: "all", label: "Everyone", title: "Every pull request, also those of people outside the team" },
    ], memo.who, (v) => { memo.who = v; prefs.set("prs:who", v); lastDataSig = ""; draw(); });
    const newBtn = h("button.btn.small", { title: `Create a pull request in a repository of ${app.ws.project}, on Azure DevOps's own page (new tab)`, onclick: (e: Event) => void openNewPr(e.currentTarget as HTMLButtonElement) }, icon("plus", 14), "New pull request");
    const tabSeg = segmented<Tab>([
      { value: "open", label: "Open", title: "Pull requests waiting to be completed" },
      { value: "completed", label: "Recently completed", title: `Pull requests completed in the last ${RECENT_DAYS} days` },
      { value: "abandoned", label: "Abandoned", title: `Pull requests abandoned in the last ${RECENT_DAYS} days` },
    ], memo.tab, (v) => { memo.tab = v; f.quick = ""; sort.key = v === "open" ? "age" : "closed"; sort.dir = -1; lastDataSig = ""; draw(); });
    const status = h("div.prs-status", { role: "status" });
    // the repository, author and reviewer filters, drawn again when the pull requests change
    const filterBar = h("span.prs-filters");
    const body = h("div.prs-body");
    const bar = pageBar(app, { search: {
      placeholder: "Search title, branch or number", title: "Show only pull requests whose title, branch, repository or number contains this text",
      label: "Search the pull requests", onChange: () => drawBody(),
    } });
    // what is chosen most comes first (it stays on the bar); what does not fit goes under ⋯ from the end
    bar.line2.append(tabSeg, ...(teamKeys.size ? [whoSeg] : []), filterBar, newBtn);
    bar.end.append(status);
    bar.line3.append(scopeSeg);
    el.append(bar.el, body);

    const load = (): Load => getLoad(app, memo.scope, memo.tab);

    /** Read the pull requests (and the chart's completed ones) and their linked work items again. */
    function readAgain(): void {
      getLoad(app, memo.scope, memo.tab, true);
      if (memo.tab !== "completed") getLoad(app, memo.scope, "completed", true);
      for (const [id, v] of memo.links) if (v !== "loading") memo.links.delete(id);
      memo.unreadable.clear();
      lastDataSig = "";
      draw();
    }

    // ---- filters ----
    const repoKey = (pr: PullRequest): string => pr.repository.id;
    const repoLabel = (pr: PullRequest): string => memo.scope === "all" ? `${pr.repository.project ?? ""} / ${pr.repository.name}` : pr.repository.name;

    function drawFilters(prs: PullRequest[]): void {
      const repos = new Map<string, string>();
      const authors = new Map<string, string>();
      const reviewers = new Map<string, string>();
      const groups = new Map<string, string>();
      for (const pr of prs) {
        repos.set(repoKey(pr), repoLabel(pr));
        authors.set(personKey(pr.createdBy), pr.createdBy.displayName);
        for (const r of pr.reviewers) {
          reviewers.set(personKey(r.person), shortName(r.person.displayName));
          if (r.isContainer) groups.set(personKey(r.person), shortName(r.person.displayName));
        }
      }
      const opts = (m: Map<string, string>, all: string, cur: string) => {
        if (cur && !m.has(cur)) m.set(cur, cur);
        return [{ value: "", label: all }, ...[...m].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))];
      };
      const chip = (label: string, on: boolean, title: string, set: (v: boolean) => void): HTMLElement => {
        const b = h("button.chip", { type: "button", "aria-pressed": String(on), title, onclick: () => { const v = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(v)); set(v); drawBody(); } }, label);
        return b;
      };
      replace(filterBar,
        select(opts(repos, "All repositories", f.repo), f.repo, (v) => { f.repo = v; drawBody(); }, { title: "Show one repository only", "aria-label": "Repository" }),
        select(opts(authors, "All authors", f.author), f.author, (v) => { f.author = v; drawBody(); }, { title: "Show pull requests by one author only", "aria-label": "Author" }),
        select(opts(reviewers, "All reviewers", f.reviewer), f.reviewer, (v) => { f.reviewer = v; drawBody(); }, { title: "Show pull requests where this person or group is a reviewer", "aria-label": "Reviewer" }),
        groups.size || f.group ? select(opts(groups, "All groups", f.group), f.group, (v) => { f.group = v; drawBody(); }, { title: "Show pull requests a group or team was asked to review (the chart on top follows too)", "aria-label": "Reviewer group" }) : null,
        memo.tab === "open" ? chip("Needs my review", f.needsMe, "Show pull requests where you are a reviewer and have not voted yet", (v) => { f.needsMe = v; }) : null,
        chip("Mine", f.mine, "Show the pull requests you created", (v) => { f.mine = v; }));
    }

    function filtered(prs: PullRequest[]): PullRequest[] {
      const q = bar.search.query();
      return prs.filter((pr) => {
        if (memo.who === "team" && !teamPr(pr)) return false;
        if (f.repo && repoKey(pr) !== f.repo) return false;
        if (f.author && personKey(pr.createdBy) !== f.author) return false;
        if (f.reviewer && !pr.reviewers.some((r) => personKey(r.person) === f.reviewer)) return false;
        if (f.group && !pr.reviewers.some((r) => r.isContainer && personKey(r.person) === f.group)) return false;
        if (f.needsMe && memo.tab === "open" && !needsReviewBy(pr, me)) return false;
        if (f.mine && !isAuthor(pr, me)) return false;
        if (q) {
          const hay = `${pr.id} !${pr.id} ${pr.title} ${pr.sourceBranch ?? ""} ${pr.targetBranch ?? ""} ${pr.repository.name} ${pr.repository.project ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    }

    // ---- drawing ----
    function draw(): void {
      if (!alive) return;
      const st = load();
      const sig = `${memo.scope}|${memo.tab}|${st.prs.length}|${st.loading}`;
      drawStatus(st);
      if (sig !== lastDataSig) { lastDataSig = sig; drawFilters(st.prs); }
      drawBody();
    }

    function drawStatus(st: Load): void {
      const parts: Child[] = [];
      if (st.loading) {
        parts.push(h("span.spin"), memo.scope === "all" && st.total
          ? `Reading pull requests: ${st.done} of ${st.total} projects…`
          : "Reading pull requests…");
      } else {
        const at = new Date(st.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        parts.push(h("button.btn.link.small.prs-reread", {
          type: "button", title: `Read at ${at}${memo.scope === "all" ? ` from ${st.total} projects` : ""}. Click to read the pull requests and their work items again now.`,
          onclick: () => readAgain(),
        }, icon("refresh", 12), `Read at ${at}${memo.scope === "all" ? ` from ${st.total} projects` : ""} · Read again`));
      }
      if (st.noAccess.length) parts.push(h("span.warn-text", { title: st.noAccess.join(", ") }, ` · No access to ${st.noAccess.length} project${st.noAccess.length === 1 ? "" : "s"}`));
      if (st.failed.length) parts.push(h("span.err", { title: st.failed.join("\n") }, ` · ${st.failed.length} project${st.failed.length === 1 ? "" : "s"} could not be read`));
      replace(status, parts);
    }

    function drawBody(): void {
      if (!alive) return;
      // a sort kept from another tab (Closed on the Open tab) is not shown by any title: use this tab's own
      const sortKey = sortKeyFor(memo.tab, sort.key) as SortKey;
      if (sortKey !== sort.key) { sort.key = sortKey; sort.dir = -1; }
      keep();
      io.disconnect();
      rowFill.clear();
      refs = null;
      const st = load();
      if (st.error && !st.prs.length) {
        body.replaceChildren(failed(st.error, () => { getLoad(app, memo.scope, memo.tab, true); lastDataSig = ""; draw(); }));
        return;
      }
      if (st.loading && !st.prs.length) { body.replaceChildren(spinner("Reading pull requests…")); return; }
      const tabPrs = memo.tab === "open" ? st.prs.filter(isOpen) : st.prs.filter((p) => p.status === memo.tab);
      const list = filtered(tabPrs);
      const sig = JSON.stringify([memo.tab, memo.scope, memo.who, f, bar.search.query()]);
      if (sig !== limitSig) { limitSig = sig; limit = PAGE_ROWS; }
      if (memo.tab === "open") drawOpen(list, tabPrs.length);
      else if (memo.tab === "completed") drawCompleted(list, tabPrs.length);
      else drawAbandoned(list, tabPrs.length);
      // the chart of waiting and merge times goes on top of every tab
      drawTimes();
      body.prepend(timesBox);
    }

    const noneText = (total: number): HTMLElement => total
      ? empty("Nothing matches", memo.who === "team" ? `No pull request of ${app.ws.team}'s members matches these filters. Choose “Everyone” to see the others.` : "No pull request matches these filters.")
      : empty(memo.tab === "open" ? "No open pull requests" : memo.tab === "completed" ? "Nothing completed lately" : "Nothing abandoned lately",
        memo.tab === "open" ? "There is no open pull request here." : `No pull request was ${memo.tab} in the last ${RECENT_DAYS} days.`);

    function tile(n: Child, label: string, title: string, opts: { level?: "ok" | "warn" | "bad"; quick?: typeof f.quick; extra?: Child } = {}): HTMLElement {
      const inner: Child[] = [h(`span.n${opts.level ? "." + opts.level : ""}`, null, n), h("span.l", null, label), opts.extra ?? null];
      if (!opts.quick) return h("div.card-box.stat.prs-tile", { title }, inner);
      const q = opts.quick;
      return h("button.card-box.stat.prs-tile.click", {
        type: "button", title: title + (f.quick === q ? " Click again to show all." : " Click to show only these."), "aria-pressed": String(f.quick === q),
        onclick: () => { f.quick = f.quick === q ? "" : q; drawBody(); },
      }, inner);
    }

    // header cell that sorts
    function th(label: string, key: SortKey | null, cls = ""): HTMLElement {
      if (!key) return h(`th${cls}`, null, label);
      const on = sort.key === key;
      return h(`th${cls}`, { "aria-sort": on ? (sort.dir === 1 ? "ascending" : "descending") : "none" },
        h("button.prs-sort", {
          type: "button", title: `Sort by ${label.toLowerCase()}`,
          onclick: () => { if (sort.key === key) sort.dir = sort.dir === 1 ? -1 : 1; else { sort.key = key; sort.dir = key === "age" || key === "closed" || key === "merge" ? -1 : 1; } drawBody(); },
        }, label, on ? (sort.dir === 1 ? " ▲" : " ▼") : ""));
    }

    function sorted(list: PullRequest[]): PullRequest[] {
      const val = (pr: PullRequest): number | string => {
        switch (sort.key) {
          case "title": return pr.title.toLowerCase();
          case "author": return pr.createdBy.displayName.toLowerCase();
          case "repo": return repoLabel(pr).toLowerCase();
          case "closed": return pr.closed ? Date.parse(pr.closed) : 0;
          case "merge": return pr.closed ? daysBetween(pr.created, pr.closed) : 0;
          default: return Date.now() - Date.parse(pr.created);
        }
      };
      return [...list].sort((a, b) => {
        const x = val(a), y = val(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.id - a.id;
      });
    }

    function more(total: number): HTMLElement | null {
      return total > limit ? h("div.prs-more", null,
        h("button.btn", { type: "button", title: `Show ${Math.min(PAGE_ROWS, total - limit)} more pull requests`, onclick: () => { limit += PAGE_ROWS; drawBody(); } }, `Show ${Math.min(PAGE_ROWS, total - limit)} more`),
        h("span.small.muted", null, `${limit} of ${total} shown`)) : null;
    }

    // ---- the chart on top: median wait for the first approval and time to merge, per week ----
    const timesBox = h("section.card-box.prs-times", { "aria-label": "Approval and merge times per week" });
    let timesBusy = false;
    const triedKeys = new Set<string>();

    function drawTimes(): void {
      const st = getLoad(app, memo.scope, "completed");
      const done = filtered(st.prs.filter((p) => p.status === "completed" && p.closed));
      const head = h("div.prs-times-head", null,
        h("h3.prs-h", null, "Waiting for approval and time to merge"),
        help(`Per week, by when the pull requests were completed (last ${RECENT_DAYS} days), following the filters above: the median (middle value) time from opened to the first approving vote, and from opened to merged. The Flow page shows the same for longer periods. First approvals are read once and kept in the team's storage.`),
        h("span.spacer"),
        h("span.prs-key.ap", null, h("i"), "Wait for first approval"),
        h("span.prs-key.mg", null, h("i"), "Time to merge"));
      if (st.loading && !st.prs.length) { timesBox.replaceChildren(head, h("p.small.muted", null, "Reading completed pull requests…")); return; }
      // the first approvals of the newest completed ones: from the team's storage, else read (one request each) and kept
      if (!timesBusy && done.some((pr) => approvedAt(app, pr) === undefined && !triedKeys.has(`${pr.repository.id}:${pr.id}`))) {
        timesBusy = true;
        // each pull request is tried once per visit of this page, so a read that fails is not repeated in a loop
        for (const pr of done) triedKeys.add(`${pr.repository.id}:${pr.id}`);
        void readApprovals(app, done, () => !alive, () => { if (alive) drawTimesSoon(); }).then(() => { timesBusy = false; if (alive) drawTimes(); }, () => { timesBusy = false; });
      }
      const weeks = Math.max(1, Math.ceil((weekStart(Date.now()) - weekStart(Date.now() - RECENT_DAYS * DAY)) / (7 * DAY)) + 1);
      const data = weeklyTimes(done.map((pr) => { const a = approvedAt(app, pr); return { created: pr.created, closed: pr.closed!, approved: a ? new Date(a).toISOString() : null }; }), weeks);
      const reading = done.filter((pr) => approvedAt(app, pr) === undefined).length;
      const note = reading && timesBusy ? h("p.small.muted", null, `Reading approvals: ${done.length - reading} of ${done.length}…`) : "";
      timesBox.replaceChildren(head, done.length ? timesChart(data) : h("p.small.muted", null, "No pull request was completed in these weeks."), note);
    }
    const drawTimesSoon = debounceTimes(() => drawTimes());

    // ---- an open pull request is reviewed, approved, completed or abandoned on Azure DevOps's own page:
    // the dashboard only reads code (no write permission), so it never changes a pull request ----
    function actionsCell(pr: PullRequest): HTMLElement {
      const waitsOnMe = needsReviewBy(pr, me);
      return h("td.prs-acts", { "data-xl-skip": "" }, h("div.prs-acts-in", null,
        h(`a.btn.small${waitsOnMe ? ".primary" : ""}`, {
          href: pr.url, target: "_blank", rel: "noopener",
          title: `${waitsOnMe ? "Your review is asked for. " : ""}Approve, complete or abandon it on Azure DevOps's own page (new tab). The dashboard only reads code, so it does not change pull requests.`,
        }, waitsOnMe ? "Review" : "Open", " ", icon("external", 12))));
    }

    // ---- open ----
    function drawOpen(list: PullRequest[], total: number): void {
      const now = Date.now();
      const ages = list.map((pr) => daysBetween(pr.created, undefined, now));
      const oldest = list.reduce<PullRequest | null>((a, pr) => !a || Date.parse(pr.created) < Date.parse(a.created) ? pr : a, null);
      const noReviewer = list.filter((pr) => !pr.reviewers.length);
      const waiting = list.filter((pr) => !pr.isDraft && waitingOn(pr).kind === "reviewers" && daysBetween(pr.created, undefined, now) > 2);
      const drafts = list.filter((pr) => pr.isDraft).length;
      const medAge = median(ages);
      const oldAge = oldest ? daysBetween(oldest.created, undefined, now) : NaN;
      const tiles = h("div.prs-tiles",
        null,
        tile(list.length, drafts ? `open (${drafts} draft${drafts === 1 ? "" : "s"})` : "open", "Open pull requests that match the filters"),
        tile(fmtDuration(medAge), "median age", "Half of the open pull requests are older than this", { level: Number.isFinite(medAge) ? ageLevel(medAge) : undefined }),
        tile(oldest ? fmtDuration(oldAge) : "–", "oldest", oldest ? `Oldest: !${oldest.id} ${oldest.title}` : "No open pull request",
          { level: oldest ? ageLevel(oldAge) : undefined, extra: oldest ? h("a.small.prs-oldest", { href: oldest.url, target: "_blank", rel: "noopener", title: "Open the oldest pull request in Azure DevOps (new tab)" }, `!${oldest.id} ${oldest.title}`) : null }),
        tile(noReviewer.length, "without a reviewer", "Pull requests nobody was asked to review", { level: noReviewer.length ? "warn" : undefined, quick: "noReviewer" }),
        tile(waiting.length, "waiting on reviewers > 2 days", "Open for more than 2 days and still waiting on reviewers to vote", { level: waiting.length ? "bad" : undefined, quick: "waiting" }));
      let rows = list;
      if (f.quick === "noReviewer") rows = noReviewer;
      else if (f.quick === "waiting") rows = waiting;
      if (!rows.length) { body.replaceChildren(tiles, noneText(total)); return; }
      const shown = sorted(rows).slice(0, limit);
      const table = h("table.data.prs-table", null,
        h("thead", null, h("tr", null,
          th("Pull request", "title"), th("Author", "author"), th("Age", "age", ".num"), h("th", null, "Reviewers"),
          h("th", null, "Waiting on ", help("The author, when a reviewer voted \"waiting\" or \"rejected\" or the merge has conflicts. Otherwise the required reviewers who have not voted; when nobody has approved yet, every reviewer who has not voted. Once approved, the author, to complete it.")),
          h("th", null, "Merge"), h("th", null, "Work items"), h("th", { "data-xl-skip": "" }, ""))),
        h("tbody", null, shown.map((pr) => openRow(pr, now))));
      replace(body, tiles, h("div.card-box.prs-tablebox", null, table), more(rows.length));
    }

    function titleCell(pr: PullRequest): { cell: HTMLElement; teamSlot: HTMLElement } {
      const teamSlot = h("span.prs-teamslot");
      const cell = h("td.prs-pr", null,
        h("div.prs-line", null,
          h("a.prs-title", { href: pr.url, target: "_blank", rel: "noopener", title: "Open this pull request in Azure DevOps (new tab)" }, h("span.mono.muted", null, `!${pr.id}`), " ", pr.title),
          pr.isDraft ? h("span.tag.prs-draft", { title: "Draft: not ready for review yet" }, "Draft") : null,
          teamSlot),
        h("div.prs-sub.small.muted", null,
          h("span", { title: memo.scope === "all" ? "Project / repository" : "Repository" }, repoLabel(pr)),
          pr.sourceBranch ? h("span.mono.prs-branch", { title: `Merges ${pr.sourceBranch} into ${pr.targetBranch ?? "?"}` }, `${pr.sourceBranch} → ${pr.targetBranch ?? "?"}`) : null));
      return { cell, teamSlot };
    }

    function person(p: Person): HTMLElement {
      return h("span.prs-person", null, avatar(app.api, p, 22), h("span.prs-name", null, p.displayName));
    }

    function reviewersCell(pr: PullRequest): HTMLElement {
      if (!pr.reviewers.length) return h("td", null, h("span.warn-text.small", { title: "Nobody was asked to review this pull request" }, "None"));
      const order = { rejected: 0, waiting: 1, approved: 2, suggestions: 3, none: 4 };
      const revs = [...pr.reviewers].map((r) => ({ ...r, person: shownPerson(r.person) }))
        .sort((a, b) => order[voteKind(a.vote)] - order[voteKind(b.vote)] || Number(Boolean(b.isRequired)) - Number(Boolean(a.isRequired)));
      const names = revs.map((r) => `${r.person.displayName}${r.isRequired ? " (required)" : ""}: ${VOTE_LABEL[voteKind(r.vote)]}`).join("; ");
      return h("td", null, h("div.prs-revs", { "data-xl": names }, revs.map((r) => {
        const k = voteKind(r.vote);
        const title = `${r.person.displayName}${r.isContainer ? " (group)" : ""}${r.isRequired ? " (required)" : ""}: ${VOTE_LABEL[k]}`;
        return h(`span.prs-rev${r.isRequired ? ".req" : ""}`, { title },
          avatar(app.api, r.person, 24, { title }),
          k === "none" ? null : h(`span.prs-vote.${k}`, { "aria-hidden": "true" }, k === "approved" || k === "suggestions" ? "✓" : k === "waiting" ? "!" : "✕"));
      })));
    }

    function waitingCell(pr: PullRequest): HTMLElement {
      if (pr.isDraft) return h("td", null, h("span.prs-wait.small.muted", { title: "A draft: the author is still working on it" }, avatar(app.api, pr.createdBy, 20), "Author (draft)"));
      const w = waitingOn(pr);
      if (w.kind === "author") {
        const who = pr.createdBy.displayName;
        const [text, title] = w.why === "complete" ? ["Author (to complete)", `Approved: waiting for ${who} to complete it`]
          : w.why === "conflicts" ? ["Author (conflicts)", `The merge ${pr.mergeStatus === "failure" ? "failed" : "has conflicts"}: waiting for ${who} to fix the branch`]
          : ["Author", `A reviewer asked ${who} for changes`];
        return h("td", null, h(`span.prs-wait${w.why === "complete" ? ".done" : ".author"}`, { title }, avatar(app.api, pr.createdBy, 20), text));
      }
      if (w.kind === "reviewers") {
        const people = w.people.map(shownPerson);
        const names = people.map((p) => p.displayName);
        return h("td", null, h("span.prs-wait", { title: `Waiting for a vote from ${names.join(", ")}` }, people.slice(0, 3).map((p) => avatar(app.api, p, 20)),
          h("span.small", null, namesText(names))));
      }
      return h("td", null, h("span.warn-text.small", { title: "Nobody was asked to review this pull request" }, "No reviewer"));
    }

    function mergeCell(pr: PullRequest): HTMLElement {
      const m: Record<string, [string, string, string]> = {
        succeeded: ["Can merge", "ok", "No conflicts with the target branch"],
        conflicts: ["Conflicts", "err", "The branch has merge conflicts with the target"],
        rejectedByPolicy: ["Blocked", "err", "A branch policy blocks the merge"],
        failure: ["Failed", "err", "The test merge failed"],
        queued: ["Checking", "muted", "Azure DevOps is checking whether it can merge"],
      };
      const x = m[pr.mergeStatus ?? ""] ?? ["–", "muted", "Merge status not known yet"];
      return h("td.prs-merge", null, h(`span.small.${x[1]}`, { title: x[2] }, x[0]));
    }

    // ---- linked work items and suggestions ----

    /** The team's stories (requirement level), for title matches; made once per drawing. */
    let refs: StoryRef[] | null = null;
    const storyRefs = (): StoryRef[] => (refs ??= app.ws.ofLevel(app.ws.requirementLevel()).map((w) => ({ id: w.id, title: w.title, open: !isClosed(w) })));

    /** A mentioned number as a story of the team the pull request can be linked to (a task gives its story). */
    const resolveStory = (id: number): { story: number; task?: number } | undefined => {
      const it = app.ws.get(id);
      const kind = it && kindOf(app)(it.type);
      if (!it || !kind) return undefined;
      if (kind === "requirement") return { story: id };
      if (kind !== "task") return undefined;
      const s = storyLinks([id], (x) => app.ws.get(x), kindOf(app))[0];
      return s && s.id !== id && app.ws.items.has(s.id) ? { story: s.id, task: id } : undefined;
    };

    function itemAnchor(pr: PullRequest, id: number, tip: string, content: Child): HTMLElement {
      const inTeam = app.ws.items.has(id);
      return h(`a.prs-wid${inTeam ? "" : ".ext"}`, {
        href: inTeam ? app.ws.itemUrl(id) : app.api.itemUrl(pr.repository.project || app.ws.project, id), target: "_blank", rel: "noopener",
        title: `${tip}\nClick to see the details; Ctrl+click opens it in Azure DevOps.${inTeam ? "" : " It is not part of this team's work."}`,
        onclick: (e: MouseEvent) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); app.openItem(id); } },
      }, content);
    }

    function storyLine(pr: PullRequest, s: StoryLink): HTMLElement {
      const w = known(app, s.id);
      const tasks = s.via.map((t) => `#${t}`).join(", ");
      const viaText = s.via.length ? `${s.direct ? "also " : ""}via task${s.via.length === 1 ? "" : "s"} ${tasks}` : "";
      const tip = `#${s.id}${w ? ` ${w.title} (${w.type}, ${w.state})` : ""}${viaText ? `. Linked ${viaText}.` : ""}`;
      const ro = app.actions.readOnly;
      return h("div.prs-wl", null,
        itemAnchor(pr, s.id, tip, [w ? typeMark(app.ws, w.type) : null, h("span.mono", null, `#${s.id}`), w ? h("span.prs-wtitle", null, w.title) : null]),
        viaText ? h("span.prs-via.small.muted", { title: `The pull request is linked to ${s.via.length === 1 ? "a task" : "tasks"} of this story (${tasks})` }, viaText) : null,
        // only a link on the item itself, of the team's work, can be taken off here
        s.direct && !ro && app.ws.items.has(s.id) ? h("button.icon-btn.small.prs-unlink", {
          type: "button", title: `Take pull request !${pr.id} off #${s.id} (only the link goes; Undo puts it back)`, "aria-label": `Unlink #${s.id}`,
          onclick: (e: Event) => void busy(e.currentTarget as HTMLButtonElement, async () => {
            if (await removePullRequestLink(app, s.id, pr, () => linkedNow(pr, s.id, true))) linkedNow(pr, s.id, false);
          }),
        }, icon("close", 11)) : null);
    }

    /** The pull request's linked ids after a link was added or taken off here. */
    function linkedNow(pr: PullRequest, id: number, on: boolean): void {
      const cur = memo.links.get(pr.id);
      const rest = Array.isArray(cur) ? cur.filter((x) => x !== id) : [];
      memo.links.set(pr.id, on ? [...rest, id] : rest);
      refill(pr.id);
    }

    /** Link the pull request to any work item of the team: search by number or title words. */
    function linkSearch(anchor: HTMLElement, pr: PullRequest): void {
      const cur = memo.links.get(pr.id);
      const linked = new Set(Array.isArray(cur) ? cur : []);
      const reqTypes = new Set(app.ws.requirementLevel().types);
      const rank = (w: WorkItem): number => (isClosed(w) ? 2 : 0) + (reqTypes.has(w.type) ? 0 : 1);
      const items = [...app.ws.items.values()].filter((w) => !linked.has(w.id)).sort((a, b) => rank(a) - rank(b) || b.id - a.id)
        .map((w) => ({ id: w.id, title: w.title, type: w.type }));
      const likely = pr.status === "abandoned" ? [] : prCandidates(pr, storyRefs(), resolveStory).map((c) => c.id).filter((id) => !linked.has(id));
      const input = h("input.input", { type: "search", placeholder: "Number or words of the title", "aria-label": "Find a work item to link" });
      const list = h("div.pick-list", { role: "listbox" });
      let close = (): void => {};
      const pick = async (id: number): Promise<void> => {
        close();
        if (await linkPullRequest(app, id, pr, () => linkedNow(pr, id, false))) linkedNow(pr, id, true);
      };
      const draw = (): void => {
        const q = input.value.trim();
        const hits = q ? matchItems(items, q, 30) : [...likely.map((id) => items.find((i) => i.id === id)).filter((x) => !!x), ...items.filter((i) => !likely.includes(i.id))].slice(0, 30);
        list.replaceChildren(...hits.map((i) => h("button.pick-item", { type: "button", title: `Link pull request !${pr.id} to #${i.id}`, onclick: () => void pick(i.id) },
          typeMark(app.ws, i.type), h("span.mono.muted", null, `#${i.id}`), h("span", null, i.title), likely.includes(i.id) && !q ? h("small", null, "likely") : null)));
        if (!hits.length) list.append(h("div.muted.pad", null, q ? "Nothing of this team's work matches" : "Nothing to link"));
      };
      input.addEventListener("input", draw);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); list.querySelector<HTMLElement>(".pick-item")?.click(); } });
      draw();
      close = popup(anchor, h("div.picker.wide.prs-linkpick", null,
        h("div.small.muted", null, `Link !${pr.id} to a work item of ${app.ws.team} (the link is added on the work item)`), input, list));
      input.focus();
    }

    function linkMore(pr: PullRequest): HTMLElement | null {
      if (app.actions.readOnly) return null;
      return h("button.btn.link.small.prs-linkmore", {
        type: "button", title: `Link pull request !${pr.id} to a work item: search by number or title`,
        onclick: (e: Event) => linkSearch(e.currentTarget as HTMLElement, pr),
      }, icon("link", 11), "Link…");
    }

    function candidateLine(pr: PullRequest, c: Candidate): HTMLElement {
      const w = app.ws.get(c.id)!;
      const ro = app.actions.readOnly;
      const why = c.words?.length ? `Words in both titles: ${c.words.join(", ")}` : `The pull request's ${c.reason}`;
      return h("div.prs-cand", null,
        itemAnchor(pr, c.id, `#${c.id} ${w.title} (${w.type}, ${w.state})`, [typeMark(app.ws, w.type), h("span.mono", null, `#${c.id}`), h("span.prs-wtitle", null, w.title)]),
        h("span.prs-why.small.muted", { title: why }, c.reason),
        h("button.btn.small.prs-linkbtn", {
          type: "button", disabled: ro,
          title: ro ? "Read-only: links cannot be added here" : `Link pull request !${pr.id} to #${c.id} (the link is added on the work item, as Azure DevOps does)`,
          onclick: (e: Event) => void busy(e.currentTarget as HTMLButtonElement, async () => {
            if (await linkPullRequest(app, c.id, pr, () => linkedNow(pr, c.id, false))) linkedNow(pr, c.id, true);
          }),
        }, icon("link", 12), "Link"));
    }

    function candidatesBox(pr: PullRequest): HTMLElement {
      if (pr.status === "abandoned") return h("span.faint.small", { title: "No work item is linked to this pull request" }, "–");
      const cands = prCandidates(pr, storyRefs(), resolveStory);
      if (!cands.length) return h("span.small.muted", { title: "No work item is linked, and no story of this team looks like a match: no story number in the branch, title or description, and no story with a similar title" }, "Not linked");
      return h("div.prs-cands", null,
        h("div.prs-cands-head.small", { title: "No work item is linked. These stories of the team look likely: a story number in the branch, title or description, or a similar title." }, "Not linked. Maybe:"),
        cands.map((c) => candidateLine(pr, c)));
    }

    function workItemsCell(pr: PullRequest, teamSlot: HTMLElement, row: HTMLElement): HTMLElement {
      const cell = h("td.prs-wi");
      const fill = (): void => {
        const v = memo.links.get(pr.id);
        delete cell.dataset.xl;
        if (v === undefined || v === "loading") { cell.replaceChildren(h("span.faint.small", { title: "Reading linked work items…" }, "…")); return; }
        if (v === "failed") {
          // a short note with a retry: the read is asked again on click
          cell.replaceChildren(h("span.small.muted", { title: "Could not read the linked work items" }, "Not read. ",
            h("button.btn.link.small", { title: "Read the linked work items again", onclick: () => { memo.links.delete(pr.id); wantLinks(app, pr); fill(); } }, "Try again")));
          return;
        }
        if (!v.length) { teamSlot.replaceChildren(); cell.replaceChildren(candidatesBox(pr), linkMore(pr) ?? ""); cell.dataset.xl = ""; return; }
        const stories = storyLinks(v, (id) => known(app, id), kindOf(app));
        const MAX = 4;
        cell.replaceChildren(h("div.prs-wis", null,
          stories.slice(0, MAX).map((s) => storyLine(pr, s)),
          stories.length > MAX ? h("span.small.muted", { title: stories.slice(MAX).map((s) => `#${s.id}`).join(", ") }, `+${stories.length - MAX} more`) : null,
          linkMore(pr)));
        cell.dataset.xl = stories.map((s) => {
          const w = known(app, s.id);
          return `#${s.id}${w ? " " + w.title : ""}${s.via.length ? ` (via task ${s.via.map((t) => "#" + t).join(", ")})` : ""}`;
        }).join("; ");
        const team = v.some((id) => app.ws.items.has(id)) || stories.some((s) => app.ws.items.has(s.id));
        teamSlot.replaceChildren(team ? h("span.tag.prs-team", { title: `Linked to work of ${app.ws.team}` }, "Team") : "");
      };
      fill();
      rowFill.set(pr.id, fill);
      if (!memo.links.has(pr.id)) {
        (row as HTMLElement & { _pr?: PullRequest })._pr = pr;
        io.observe(row);
      }
      return cell;
    }

    // ---- new pull request: Azure DevOps's own create page ----

    async function openNewPr(anchor: HTMLButtonElement): Promise<void> {
      const project = app.ws.project;
      const repos = await busy(anchor, () => reposOf(app, project));
      if (!repos || !alive || !anchor.isConnected) return;
      if (!repos.length) { toast(`${project} has no repository.`); return; }
      // the repository picked in the filter, else the one with the most pull requests here
      const count = new Map<string, number>();
      for (const pr of load().prs) count.set(pr.repository.id, (count.get(pr.repository.id) ?? 0) + 1);
      const st = {
        repo: repos.find((r) => r.id === f.repo) ?? [...repos].sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0))[0],
        source: "", target: "",
      };
      const listId = `prs-branches-${Date.now().toString(36)}`;
      const go = h("a.btn.primary", { target: "_blank", rel: "noopener", title: "Open Azure DevOps's page to create the pull request (new tab)", onclick: () => close() }, icon("external", 14), "Open create page");
      const upd = (): void => { go.setAttribute("href", newPrUrl(app.api.ctx.orgUrl, project, st.repo.name, st.source || undefined, st.target || undefined)); };
      const list = h("datalist", { id: listId });
      const src = h("input.input", {
        list: listId, placeholder: "Pick on the next page", spellcheck: "false", autocomplete: "off", "aria-label": "From branch",
        title: "The branch with the changes. Type to search; leave empty to pick it on Azure DevOps's page.",
        oninput: () => { st.source = src.value.trim(); upd(); },
      });
      const into = h("select.input", { "aria-label": "Into branch", title: "The branch the changes go into", onchange: () => { st.target = into.value; upd(); } });
      const branchNote = h("span.small.muted");
      const drawBranches = async (): Promise<void> => {
        const repo = st.repo;
        const def = (repo.defaultBranch ?? "").replace(/^refs\/heads\//, "");
        st.target = def;
        into.replaceChildren(h("option", { value: def, selected: true }, def ? `${def} (default)` : "The default branch"));
        list.replaceChildren();
        branchNote.textContent = "Reading branches…";
        upd();
        try {
          const names = await branchesOf(app, project, repo.id);
          if (st.repo !== repo) return;
          list.replaceChildren(...names.map((n) => h("option", { value: n })));
          const all = def && !names.includes(def) ? [def, ...names] : names;
          if (all.length) into.replaceChildren(...all.map((n) => h("option", { value: n, selected: n === def }, n === def ? `${n} (default)` : n)));
          branchNote.textContent = `${names.length} branch${names.length === 1 ? "" : "es"}`;
        } catch (e) {
          if (st.repo === repo) branchNote.textContent = `Branches not read: ${errorText(e)}`;
        }
      };
      const repoSel = select(repos.map((r) => ({ value: r.id, label: r.name })), st.repo.id, (v) => { st.repo = repos.find((r) => r.id === v) ?? st.repo; void drawBranches(); },
        { title: "The repository of the new pull request", "aria-label": "Repository" });
      const field = (label: string, ...ctl: Child[]): HTMLElement => h("label.prs-new-field", null, h("span", null, label), ...ctl);
      const box = h("div.prs-new", null,
        h("h3", null, "New pull request"),
        field(`Repository in ${project}`, repoSel),
        field("From branch", src, list),
        field("Into branch", into, branchNote),
        h("p.small.muted", null, "Azure DevOps opens its own page in a new tab and the pull request is made there. Link it to a story there, or here afterwards."),
        h("div.prs-new-foot", null, go));
      const close = popup(anchor, box, { align: "right" });
      void drawBranches();
    }

    function openRow(pr: PullRequest, now: number): HTMLElement {
      const row = h("tr");
      const { cell, teamSlot } = titleCell(pr);
      const age = daysBetween(pr.created, undefined, now);
      row.append(
        cell,
        h("td", null, person(pr.createdBy)),
        h("td.num", null, h(`span.prs-age.${ageLevel(age)}`, { title: `Opened ${fmtDate(pr.created)} (${fmtDuration(age)} ago)` }, fmtDuration(age))),
        reviewersCell(pr),
        waitingCell(pr),
        mergeCell(pr),
        workItemsCell(pr, teamSlot, row),
        actionsCell(pr));
      return row;
    }

    // ---- completed ----
    function drawCompleted(list: PullRequest[], total: number): void {
      const ttm = (pr: PullRequest): number => daysBetween(pr.created, pr.closed ?? pr.created);
      const times = list.map(ttm);
      const now = Date.now();
      const weeks = Math.max(1, Math.ceil((weekStart(now) - weekStart(now - RECENT_DAYS * DAY)) / (7 * DAY)) + 1);
      const perWeek = weeklyCounts(list.map((pr) => pr.closed ?? pr.created), weeks, now);
      const perRepo = mergeStats(list, repoLabel, ttm);
      const tiles = h("div.prs-tiles", null,
        tile(list.length, `completed in ${RECENT_DAYS} days`, `Pull requests completed in the last ${RECENT_DAYS} days that match the filters`),
        tile(fmtDuration(median(times)), "median time to merge", "Half of the pull requests were completed faster than this (from opened to completed)"),
        tile(fmtDuration(percentile(times, 85)), "85% merged within", "85 of 100 pull requests were completed faster than this"),
        h("div.card-box.prs-chartbox", { title: "Pull requests completed per week (weeks start on Monday)" }, h("div.small.muted", null, "Completed per week"), weekChart(perWeek)));
      if (!list.length) { body.replaceChildren(tiles, noneText(total)); return; }
      const repoTable = sortable(h("table.data.prs-repos", null,
        h("thead", null, h("tr", null, h("th", null, memo.scope === "all" ? "Project / repository" : "Repository"), h("th.num", null, "Completed"), h("th.num", null, "Median"), h("th.num", null, "85%"))),
        h("tbody", null, perRepo.map((r) => h("tr", null,
          h("td", null, r.key), h("td.num", null, r.count),
          h("td.num", { "data-sort": String(r.median), title: "Median time from opened to completed" }, fmtDuration(r.median)),
          h("td.num", { "data-sort": String(r.p85), title: "85 of 100 were completed within this time" }, fmtDuration(r.p85)))))));
      const shown = sorted(list).slice(0, limit);
      const table = h("table.data.prs-table", null,
        h("thead", null, h("tr", null, th("Pull request", "title"), th("Author", "author"), th("Completed", "closed"), th("Time to merge", "merge", ".num"), h("th", null, "Reviewers"), h("th", null, "Work items"))),
        h("tbody", null, shown.map((pr) => {
          const row = h("tr");
          const { cell, teamSlot } = titleCell(pr);
          const d = ttm(pr);
          row.append(cell, h("td", null, person(pr.createdBy)),
            h("td.small", { title: pr.closed ? new Date(pr.closed).toLocaleString() : "" }, fmtDate(pr.closed, { day: "numeric", month: "short" })),
            h("td.num", null, h(`span.prs-age.${ageLevel(d)}`, { title: `Opened ${fmtDate(pr.created)}, completed ${fmtDate(pr.closed)}` }, fmtDuration(d))),
            reviewersCell(pr), workItemsCell(pr, teamSlot, row));
          return row;
        })));
      replace(body, tiles,
        h("div.prs-split", null,
          h("div.card-box.prs-tablebox", null, h("h3.prs-h", null, "Time to merge by repository"), repoTable),
          h("div.card-box.prs-tablebox", null, table)),
        more(list.length));
    }

    function weekChart(weeks: { start: number; count: number }[]): SVGElement {
      const W = 280, H = 96, top = 14, bottom = 18;
      const max = Math.max(1, ...weeks.map((w) => w.count));
      const bw = W / weeks.length;
      const s = svg("svg", { class: "prs-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Completed pull requests per week" });
      weeks.forEach((w, i) => {
        const hgt = (H - top - bottom) * w.count / max;
        const x = i * bw + bw * 0.18;
        const label = new Date(w.start).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
        const g = svg("g", null,
          svg("title", null, `Week of ${label}: ${w.count} completed`),
          svg("rect", { class: "prs-bar", x, y: H - bottom - hgt, width: bw * 0.64, height: Math.max(hgt, w.count ? 1 : 0), rx: 2 }),
          svg("text", { class: "prs-val", x: x + bw * 0.32, y: H - bottom - hgt - 3, "text-anchor": "middle" }, String(w.count)),
          svg("text", { class: "prs-axis", x: x + bw * 0.32, y: H - 4, "text-anchor": "middle" }, label));
        s.append(g);
      });
      s.append(svg("line", { class: "prs-base", x1: 0, x2: W, y1: H - bottom + 0.5, y2: H - bottom + 0.5 }));
      return s;
    }

    // ---- abandoned ----
    function drawAbandoned(list: PullRequest[], total: number): void {
      const tiles = h("div.prs-tiles", null,
        tile(list.length, `abandoned in ${RECENT_DAYS} days`, `Pull requests abandoned in the last ${RECENT_DAYS} days that match the filters`),
        tile(fmtDuration(median(list.map((pr) => daysBetween(pr.created, pr.closed ?? pr.created)))), "median time open", "Half of them were open for less than this before they were abandoned"));
      if (!list.length) { body.replaceChildren(tiles, noneText(total)); return; }
      const shown = sorted(list).slice(0, limit);
      const table = h("table.data.prs-table", null,
        h("thead", null, h("tr", null, th("Pull request", "title"), th("Author", "author"), th("Abandoned", "closed"), th("Open for", "merge", ".num"), h("th", null, "Reviewers"), h("th", null, "Work items"))),
        h("tbody", null, shown.map((pr) => {
          const row = h("tr");
          const { cell, teamSlot } = titleCell(pr);
          row.append(cell, h("td", null, person(pr.createdBy)),
            h("td.small", { title: pr.closed ? new Date(pr.closed).toLocaleString() : "" }, fmtDate(pr.closed, { day: "numeric", month: "short" })),
            h("td.num.small", { title: `Opened ${fmtDate(pr.created)}` }, fmtDuration(daysBetween(pr.created, pr.closed ?? pr.created))),
            reviewersCell(pr), workItemsCell(pr, teamSlot, row));
          return row;
        })));
      replace(body, tiles, h("div.card-box.prs-tablebox", null, table), more(list.length));
    }

    let raf = 0;
    const schedule = (): void => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    memo.listeners.add(schedule);
    draw();
    // no polling here: every minute, a read older than 10 minutes starts again by itself
    const timer = setInterval(() => {
      const st = memo.loads.get(loadKey(app, memo.scope, memo.tab));
      if (document.visibilityState === "visible" && st && !st.loading && !st.error && Date.now() - st.at >= CACHE_MS) draw();
    }, 60_000);
    // back to this browser tab after more than a minute: read again
    const onVisible = (): void => {
      const st = memo.loads.get(loadKey(app, memo.scope, memo.tab));
      if (document.visibilityState === "visible" && st && !st.loading && Date.now() - st.at > CACHE_MS) readAgain();
    };
    document.addEventListener("visibilitychange", onVisible);

    return {
      update() { drawBody(); },
      unmount() {
        alive = false;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
        memo.listeners.delete(schedule);
        fillLinks.delete(onLinks);
        io.disconnect();
        if (raf) cancelAnimationFrame(raf);
      },
    };
  },
};
