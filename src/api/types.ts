// The shapes every part of the app shares, independent of where the data comes from
// (Azure DevOps, or the demo data used outside Azure DevOps). See api/api.ts for the calls.

/** Azure DevOps state categories: every state of every work item type belongs to one. */
export type Category = "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed";

export interface Person {
  id?: string;
  displayName: string;
  uniqueName: string;
  imageUrl?: string;
  descriptor?: string;
}

export interface StateInfo { name: string; category: Category; color: string }

export interface TypeInfo {
  name: string;
  color: string;
  icon?: string;
  states: StateInfo[];
  /** fields on this type, reference names */
  fields?: string[];
  /** display names of those fields, by reference name */
  fieldNames?: Record<string, string>;
}

/**
 * A backlog level of the team's process, top to bottom: portfolio levels (Epics, Features),
 * the requirement level (User Stories, Product Backlog Items, Requirements, Issues) and tasks.
 */
export interface Level {
  id: string;
  name: string;
  kind: "portfolio" | "requirement" | "task";
  /** 0 = top level */
  rank: number;
  types: string[];
  defaultType: string;
  color?: string;
}

export interface ProcessInfo {
  levels: Level[];
  types: Record<string, TypeInfo>;
  /** reference names of the fields the process uses for these jobs */
  fields: { order: string; effort: string; remaining: string; activity: string; completed: string; original: string };
  bugsBehavior: "asRequirements" | "asTasks" | "off";
}

export interface Project { id: string; name: string; description?: string; lastUpdateTime?: string; visibility?: string }
export interface Team { id: string; name: string; description?: string; projectId?: string; projectName?: string }

export interface TeamSettings {
  backlogIteration?: string;
  defaultIteration?: string;
  bugsBehavior: ProcessInfo["bugsBehavior"];
  workingDays: number[]; // 0 = Sunday
  areas: { path: string; includeChildren: boolean }[];
  defaultArea?: string;
}

export interface Iteration {
  id: string;
  name: string;
  path: string;
  start?: string;
  finish?: string;
  timeFrame?: "past" | "current" | "future";
}

export interface BoardColumn {
  id: string;
  name: string;
  itemLimit: number;
  /** work item type -> state */
  stateMappings: Record<string, string>;
  isSplit: boolean;
  columnType: "incoming" | "inProgress" | "outgoing";
}

export interface BoardInfo {
  name: string;
  columns: BoardColumn[];
  columnField?: string;
  doneField?: string;
  rowField?: string;
  rows: string[];
}

export interface Relation { rel: string; url: string; attributes: Record<string, unknown> }

export interface WorkItem {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  category: Category;
  reason?: string;
  parent?: number;
  project?: string;
  area: string;
  iteration: string;
  assignedTo?: Person;
  createdBy?: Person;
  changedBy?: Person;
  closedBy?: Person;
  tags: string[];
  order?: number;
  effort?: number;
  remaining?: number;
  completedWork?: number;
  originalEstimate?: number;
  priority?: number;
  created: string;
  changed: string;
  stateChanged?: string;
  activated?: string;
  resolved?: string;
  closed?: string;
  startDate?: string;
  targetDate?: string;
  dueDate?: string;
  boardColumn?: string;
  boardDone?: boolean;
  boardLane?: string;
  description?: string;
  acceptance?: string;
  /** extra fields read but not mapped above */
  fields: Record<string, unknown>;
  relations?: Relation[];
  /**
   * The field list this copy was read with (a list read asks only for some fields, and Azure DevOps
   * leaves out empty ones). Not set: read in full, so every field with a value is here.
   */
  fieldsRead?: readonly string[];
  /**
   * Some values here are only what this page expects (after a priority change, or a refused save):
   * the next read from Azure DevOps replaces this copy, whatever its revision.
   */
  stale?: boolean;
}


/** A structured query; the Azure DevOps client turns it into WIQL, the demo filters its data with it. */
export interface QuerySpec {
  /** "*" = every project of the organization; default: the current project */
  project?: string;
  types?: string[];
  ids?: number[];
  /** items whose parent is one of these */
  parents?: number[];
  areas?: { path: string; includeChildren: boolean }[];
  iterationUnder?: string;
  /** state names (use statesOf(process, categories) to turn categories into names) */
  states?: string[];
  notStates?: string[];
  assignedTo?: string;
  tag?: string;
  /** ISO dates; with a time part the comparison is to the second */
  changedAfter?: string;
  createdAfter?: string;
  closedAfter?: string;
  closedBefore?: string;
  orderBy?: "changed" | "id" | "closed";
  /** ISO moment: the items that matched then (WIQL ASOF), e.g. tasks that were in a sprint on a past day */
  asOf?: string;
  /** at most this many ids (Azure DevOps answers at most 20,000) */
  top?: number;
}

export interface PatchOp { op: "add" | "replace" | "remove" | "test"; path: string; value?: unknown }

export interface Comment { id: number; text: string; createdBy: Person; createdDate: string; modifiedDate?: string }

export interface FieldChange { field: string; oldValue?: unknown; newValue?: unknown }
export interface Update {
  id: number;
  rev: number;
  by: Person;
  date: string;
  changes: FieldChange[];
  relationsAdded?: Relation[];
  relationsRemoved?: Relation[];
}

export type PrStatus = "active" | "completed" | "abandoned" | "draft";
export interface PullRequest {
  id: number;
  title: string;
  status: PrStatus;
  isDraft: boolean;
  createdBy: Person;
  created: string;
  closed?: string;
  repository: { id: string; name: string; project?: string; /** the project's id, for links to the pull request */ projectId?: string };
  sourceBranch?: string;
  targetBranch?: string;
  mergeStatus?: string;
  /** someone set it to complete on its own once the policies (build, checks) pass */
  autoComplete?: boolean;
  /** hasDeclined: the reviewer declined to review */
  reviewers: { person: Person; vote: number; isRequired?: boolean; isContainer?: boolean; hasDeclined?: boolean }[];
  url: string;
  workItemIds?: number[];
  /** the text the author wrote (Azure DevOps may cut it short in lists) */
  description?: string;
}


export interface Repository { id: string; name: string; project: string; defaultBranch?: string; isDisabled?: boolean }

export interface CapacityMember {
  person: Person;
  activities: { name: string; capacityPerDay: number }[];
  daysOff: { start: string; end: string }[];
}
export interface Capacity { members: CapacityMember[]; teamDaysOff: { start: string; end: string }[] }

export interface Tag { id: string; name: string }

/** A work item in the project's Recycle Bin. */
export interface DeletedItem { id: number; title: string; type: string; deletedBy?: Person; deletedDate: string }


/** A thrown API error. status 412 = the item changed since it was read. */
export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
