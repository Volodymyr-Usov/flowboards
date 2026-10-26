// Raw Azure DevOps JSON -> the app's shapes. Pure functions, shared by the real client and the demo.
import type { Category, Person, ProcessInfo, PullRequest, Update, WorkItem } from "./types.ts";

/** Fields read for every work item. Process-specific fields (effort, order, ...) are added by the caller. */
export const BASE_FIELDS = [
  "System.Id", "System.Rev", "System.WorkItemType", "System.Title", "System.State", "System.Reason",
  "System.Parent", "System.TeamProject", "System.AreaPath", "System.IterationPath", "System.AssignedTo",
  "System.CreatedBy", "System.ChangedBy", "System.Tags", "System.CreatedDate", "System.ChangedDate",
  "System.BoardColumn", "System.BoardColumnDone", "System.BoardLane",
  "Microsoft.VSTS.Common.StateChangeDate", "Microsoft.VSTS.Common.ActivatedDate",
  "Microsoft.VSTS.Common.ResolvedDate", "Microsoft.VSTS.Common.ClosedDate", "Microsoft.VSTS.Common.ClosedBy",
  "Microsoft.VSTS.Common.Priority", "Microsoft.VSTS.Scheduling.StartDate", "Microsoft.VSTS.Scheduling.TargetDate",
  "Microsoft.VSTS.Scheduling.DueDate",
  "System.Description", "Microsoft.VSTS.Common.AcceptanceCriteria",
];

export function processFields(p: ProcessInfo): string[] {
  const f = p.fields;
  return [f.order, f.effort, f.remaining, f.completed, f.original, f.activity].filter(Boolean);
}

export function person(v: unknown): Person | undefined {
  if (!v) return undefined;
  if (typeof v === "string") {
    // "Name <name@x.com>" (older formats)
    const m = /^(.*?)\s*<([^>]+)>$/.exec(v);
    return m ? { displayName: m[1], uniqueName: m[2] } : { displayName: v, uniqueName: v };
  }
  const o = v as Record<string, any>;
  // a name that is not an account comes back as displayName "Name <email>" with no id
  const m = typeof o.displayName === "string" && !o.uniqueName ? /^(.*?)\s*<([^>]+)>$/.exec(o.displayName) : null;
  if (m) return { id: o.id ?? undefined, displayName: m[1], uniqueName: m[2] };
  return {
    id: o.id,
    displayName: o.displayName ?? o.name ?? o.uniqueName ?? "",
    uniqueName: o.uniqueName ?? o.principalName ?? o.mailAddress ?? o.displayName ?? "",
    imageUrl: o.imageUrl ?? o._links?.avatar?.href,
    descriptor: o.descriptor,
  };
}

/** Like `person`, but a missing one (a deleted account) comes back as a person with no name, so pages can always read a name. */
export function personOrBlank(v: unknown): Person {
  return person(v) ?? { displayName: "", uniqueName: "" };
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : v == null || v === "" ? undefined : Number(v);
  return n === undefined || Number.isNaN(n) ? undefined : n;
};
const str = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

export function splitTags(v: unknown): string[] {
  return typeof v === "string" && v.trim() ? v.split(";").map((t) => t.trim()).filter(Boolean) : [];
}

/** Category of a state of a type, from the process (Removed when unknown and named "Removed"). */
export function categoryOf(p: ProcessInfo | undefined, type: string, state: string): Category {
  const s = p?.types[type]?.states.find((x) => x.name === state);
  if (s) return s.category;
  if (/^(closed|done|completed)$/i.test(state)) return "Completed";
  if (/^removed$/i.test(state)) return "Removed";
  if (/^(resolved)$/i.test(state)) return "Resolved";
  if (/^(new|proposed|to do)$/i.test(state)) return "Proposed";
  return "InProgress";
}

export function normalizeItem(raw: any, p?: ProcessInfo, columnField?: string, doneField?: string, laneField?: string): WorkItem {
  const f: Record<string, unknown> = raw.fields ?? {};
  const type = String(f["System.WorkItemType"] ?? "");
  const state = String(f["System.State"] ?? "");
  const pf = p?.fields;
  const item: WorkItem = {
    id: raw.id,
    rev: raw.rev ?? (f["System.Rev"] as number) ?? 0,
    type,
    title: String(f["System.Title"] ?? ""),
    state,
    category: categoryOf(p, type, state),
    reason: str(f["System.Reason"]),
    parent: num(f["System.Parent"]),
    project: str(f["System.TeamProject"]),
    area: String(f["System.AreaPath"] ?? ""),
    iteration: String(f["System.IterationPath"] ?? ""),
    assignedTo: person(f["System.AssignedTo"]),
    createdBy: person(f["System.CreatedBy"]),
    changedBy: person(f["System.ChangedBy"]),
    closedBy: person(f["Microsoft.VSTS.Common.ClosedBy"]),
    tags: splitTags(f["System.Tags"]),
    order: pf ? num(f[pf.order]) : undefined,
    effort: pf ? num(f[pf.effort]) : undefined,
    remaining: pf ? num(f[pf.remaining]) : undefined,
    completedWork: pf ? num(f[pf.completed]) : undefined,
    originalEstimate: pf ? num(f[pf.original]) : undefined,
    priority: num(f["Microsoft.VSTS.Common.Priority"]),
    created: String(f["System.CreatedDate"] ?? ""),
    changed: String(f["System.ChangedDate"] ?? ""),
    stateChanged: str(f["Microsoft.VSTS.Common.StateChangeDate"]),
    activated: str(f["Microsoft.VSTS.Common.ActivatedDate"]),
    resolved: str(f["Microsoft.VSTS.Common.ResolvedDate"]),
    closed: str(f["Microsoft.VSTS.Common.ClosedDate"]),
    startDate: str(f["Microsoft.VSTS.Scheduling.StartDate"]),
    targetDate: str(f["Microsoft.VSTS.Scheduling.TargetDate"]),
    dueDate: str(f["Microsoft.VSTS.Scheduling.DueDate"]),
    boardColumn: str(columnField ? f[columnField] : f["System.BoardColumn"]),
    boardDone: Boolean(doneField ? f[doneField] : f["System.BoardColumnDone"]),
    boardLane: str(laneField ? f[laneField] : f["System.BoardLane"]),
    description: str(f["System.Description"]),
    acceptance: str(f["Microsoft.VSTS.Common.AcceptanceCriteria"]),
    fields: f,
  };
  if (raw.relations) item.relations = raw.relations.map((r: any) => ({ rel: r.rel, url: r.url, attributes: r.attributes ?? {} }));
  return item;
}

export function normalizeUpdate(u: any): Update {
  const changes = Object.entries(u.fields ?? {})
    .filter(([k]) => !["System.Rev", "System.AuthorizedDate", "System.RevisedDate", "System.ChangedDate", "System.Watermark",
      "System.AuthorizedAs", "System.PersonId", "System.ChangedBy"].includes(k))
    .map(([field, v]: [string, any]) => ({ field, oldValue: v?.oldValue, newValue: v?.newValue }));
  const by = person(u.revisedBy) ?? { displayName: "", uniqueName: "" };
  const date = (u.fields?.["System.ChangedDate"]?.newValue as string) ?? u.revisedDate;
  return {
    id: u.id, rev: u.rev, by, date, changes,
    relationsAdded: u.relations?.added?.map((r: any) => ({ rel: r.rel, url: r.url, attributes: r.attributes ?? {} })),
    relationsRemoved: u.relations?.removed?.map((r: any) => ({ rel: r.rel, url: r.url, attributes: r.attributes ?? {} })),
  };
}

export function normalizePr(raw: any, orgUrl: string): PullRequest {
  const repo = raw.repository ?? {};
  const project = repo.project?.name ?? "";
  return {
    id: raw.pullRequestId,
    title: raw.title ?? "",
    status: raw.isDraft && raw.status === "active" ? "draft" : raw.status,
    isDraft: Boolean(raw.isDraft),
    createdBy: person(raw.createdBy) ?? { displayName: "", uniqueName: "" },
    created: raw.creationDate,
    closed: raw.closedDate,
    repository: { id: repo.id, name: repo.name, project, projectId: repo.project?.id },
    sourceBranch: raw.sourceRefName?.replace(/^refs\/heads\//, ""),
    targetBranch: raw.targetRefName?.replace(/^refs\/heads\//, ""),
    mergeStatus: raw.mergeStatus,
    autoComplete: Boolean(raw.autoCompleteSetBy),
    reviewers: (raw.reviewers ?? []).map((r: any) => ({ person: personOrBlank(r), vote: r.vote ?? 0, isRequired: r.isRequired, isContainer: r.isContainer, hasDeclined: r.hasDeclined || undefined })),
    url: `${orgUrl}${encodeURIComponent(project)}/_git/${encodeURIComponent(repo.name ?? "")}/pullrequest/${raw.pullRequestId}`,
    workItemIds: raw.workItemRefs?.map((w: any) => Number(w.id)),
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}
