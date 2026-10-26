// Every call the app makes to Azure DevOps. Two implementations: api/rest.ts (the real service,
// with the signed-in person's token) and api/demo.ts (made-up data in memory, for trying the
// extension without Azure DevOps). Views use only this interface.
import type { BoardInfo, Capacity, Comment, DeletedItem, Iteration, PatchOp, Person, ProcessInfo, Project, PullRequest, QuerySpec, Relation, Repository, Tag, Team, TeamSettings, Update, WorkItem } from "./types.ts";

export interface ApiContext {
  orgName: string;
  /** e.g. https://dev.azure.com/contoso/ */
  orgUrl: string;
  me: Person;
  demo: boolean;
  /** "publisher.extension" when running inside Azure DevOps */
  extensionId?: string;
}

export interface ExtensionDoc { id: string; __etag?: number; [k: string]: unknown }

/** Ids a query found; `truncated` when Azure DevOps sent as many as it sends at most (more may exist). */
export type QueryIds = number[] & { truncated?: boolean };

export interface Api {
  ctx: ApiContext;

  // organization, projects and teams
  projects(): Promise<Project[]>;
  /** mine: only the teams the signed-in person is a member of */
  teams(project: string, opts?: { mine?: boolean }): Promise<Team[]>;
  teamMembers(project: string, team: string): Promise<Person[]>;
  teamSettings(project: string, team: string): Promise<TeamSettings>;
  iterations(project: string, team: string): Promise<Iteration[]>;
  process(project: string, team: string): Promise<ProcessInfo>;
  board(project: string, team: string, levelName: string): Promise<BoardInfo | null>;
  /** change the most cards a board column should hold (0 = no limit); everything else on the board stays */
  setColumnLimit(project: string, team: string, boardName: string, column: string, limit: number): Promise<void>;
  capacity(project: string, team: string, iterationId: string): Promise<Capacity>;
  /** replace the team's days off in a sprint */
  setTeamDaysOff(project: string, team: string, iterationId: string, daysOff: { start: string; end: string }[]): Promise<void>;
  setCapacity(project: string, team: string, iterationId: string, memberId: string,
    body: { activities: { name: string; capacityPerDay: number }[]; daysOff: { start: string; end: string }[] }): Promise<void>;

  // work items
  query(project: string, spec: QuerySpec): Promise<QueryIds>;
  /** heard when a query without its own `top` came back cut at the limit of Azure DevOps */
  onQueryCut?: ((spec: QuerySpec) => void) | undefined;
  /** fields: extra reference names to read besides the standard ones */
  items(project: string, ids: number[], opts?: { fields?: string[]; relations?: boolean }): Promise<WorkItem[]>;
  /** one item read in full (with links); project "" reads it from whatever project it is in */
  item(project: string, id: number): Promise<WorkItem>;
  updates(project: string, id: number): Promise<Update[]>;
  /** Some fields of these items as they were at a moment (items that did not exist yet are left out). */
  fieldsAsOf(project: string, ids: number[], fields: string[], asOf: string): Promise<Map<number, Record<string, unknown>>>;
  /** Every revision of an item with its fields, oldest first, dated by System.ChangedDate. */
  revisions(project: string, id: number): Promise<{ changed: string; fields: Record<string, unknown> }[]>;
  comments(project: string, id: number): Promise<Comment[]>;
  addComment(project: string, id: number, html: string): Promise<Comment>;
  /** rev: refuse with ApiError(412) when the item changed since that revision */
  update(project: string, id: number, ops: PatchOp[], opts?: { rev?: number }): Promise<WorkItem>;
  create(project: string, type: string, ops: PatchOp[]): Promise<WorkItem>;
  /** Delete a work item: it goes to the project's Recycle Bin (not destroyed). */
  deleteItem(project: string, id: number): Promise<void>;
  /** The project's Recycle Bin: deleted work items, newest first. */
  deletedItems(project: string): Promise<DeletedItem[]>;
  /** The area path a deleted work item had (the list does not carry it): one call per item; undefined when it cannot be read. */
  deletedArea(project: string, id: number): Promise<string | undefined>;
  /** Bring a deleted work item back from the Recycle Bin. */
  restoreItem(project: string, id: number): Promise<void>;
  /** move ids between previousId and nextId in the team's backlog order (0 = none) */
  reorder(project: string, team: string, ids: number[], previousId: number, nextId: number, parentId?: number): Promise<{ id: number; order: number }[]>;
  fieldValues?(project: string, field: string): Promise<string[]>;

  // code
  repositories(project: string): Promise<Repository[]>;
  pullRequests(project: string, opts: { status: "active" | "completed" | "abandoned" | "all"; minTime?: string; top?: number; creatorId?: string }): Promise<PullRequest[]>;
  pullRequest(id: number): Promise<PullRequest | null>;
  /** When the pull request got its first approving vote (from its vote history), if it got one. */
  firstApproval(project: string, repoId: string, prId: number): Promise<string | undefined>;
  pullRequestWorkItems(project: string, repoId: string, prId: number): Promise<number[]>;
  /** branch names of a repository ("main", "feature/x"), without "refs/heads/" */
  branches(project: string, repoId: string): Promise<string[]>;

  // tags and people
  tags(project: string): Promise<Tag[]>;
  renameTag(project: string, tagId: string, name: string): Promise<void>;
  deleteTag(project: string, tagId: string): Promise<void>;
  /** Avatar picture of a person as an object URL (the image needs the token), or null. */
  avatar(person: Person): Promise<string | null>;

  // the extension's own storage in Azure DevOps (settings, rules, team documents)
  docs(collection: string, scope: "shared" | "user"): Promise<ExtensionDoc[]>;
  getDoc(collection: string, id: string, scope: "shared" | "user"): Promise<ExtensionDoc | null>;
  setDoc(collection: string, doc: ExtensionDoc, scope: "shared" | "user"): Promise<ExtensionDoc>;
  /** create a document only when none has this id yet; refused with ApiError(409) when one exists */
  createDoc(collection: string, doc: ExtensionDoc, scope: "shared" | "user"): Promise<ExtensionDoc>;
  deleteDoc(collection: string, id: string, scope: "shared" | "user"): Promise<void>;

  /** Web address of a work item in Azure DevOps. */
  itemUrl(project: string, id: number): string;
}

export type { Relation };

/** Relation names Azure DevOps uses. */
export const REL = {
  parent: "System.LinkTypes.Hierarchy-Reverse",
  child: "System.LinkTypes.Hierarchy-Forward",
  predecessor: "System.LinkTypes.Dependency-Reverse",
  successor: "System.LinkTypes.Dependency-Forward",
  related: "System.LinkTypes.Related",
  artifact: "ArtifactLink",
  hyperlink: "Hyperlink",
} as const;

/** The work item id at the end of a relation url, or 0 for links to other things. */
export function relId(r: Relation): number {
  const m = /\/workItems\/(\d+)$/i.exec(r.url);
  return m ? Number(m[1]) : 0;
}

/** The artifact link of a pull request, as a work item's ArtifactLink relation names it. */
export function prArtifactUrl(projectId: string, repoId: string, prId: number): string {
  return `vstfs:///Git/PullRequestId/${encodeURIComponent(`${projectId}/${repoId}/${prId}`)}`;
}

/** "vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}" -> its parts */
export function prFromArtifact(url: string): { projectId: string; repoId: string; prId: number } | null {
  const m = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/i.exec(url);
  if (!m) return null;
  let text: string;
  // a damaged link (a lone "%") is not a pull request, and must not break the page
  try { text = decodeURIComponent(m[1]); } catch { return null; }
  const [projectId, repoId, prId] = text.split("/");
  return prId && /^\d+$/.test(prId) ? { projectId, repoId, prId: Number(prId) } : null;
}
