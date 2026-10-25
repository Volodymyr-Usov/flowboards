// Link a pull request to a work item from the dashboard. Azure DevOps keeps that link on the work item
// (an ArtifactLink relation naming the pull request), so it needs work item write only, not code write.
// It goes through the Writer like every other change: read-only mode, the revision check, the change
// log and error messages work the same; the message offers Undo.
import { prArtifactUrl, REL } from "../api/api.ts";
import type { PullRequest } from "../api/types.ts";
import type { App } from "../app/context.ts";
import { errorText, toast } from "../ui/kit.ts";

/** The artifact link of a pull request, or null when its project's id is not known. */
export function prLinkUrl(app: App, pr: PullRequest): string | null {
  const project = pr.repository.project || app.ws.project;
  const projectId = pr.repository.projectId || (project === app.ws.project ? app.ws.projectId : "");
  return projectId && pr.repository.id ? prArtifactUrl(projectId, pr.repository.id, pr.id) : null;
}

const sameUrl = (a: string, b: string): boolean => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();

/**
 * Add the pull request to a work item of the team. True when the item links to it afterwards.
 * `onUndone` runs after the message's Undo removed the link again.
 */
export async function linkPullRequest(app: App, itemId: number, pr: PullRequest, onUndone?: () => void): Promise<boolean> {
  if (app.actions.readOnly) { toast("Read-only: you cannot change work items here.", { kind: "error" }); return false; }
  const url = prLinkUrl(app, pr);
  if (!url) { toast(`Pull request !${pr.id} cannot be linked from here: its project is not known.`, { kind: "error" }); return false; }
  const ws = app.ws;
  try {
    await ws.withRelations([itemId]);
    const it = ws.get(itemId);
    if (!it) throw new Error(`Work item #${itemId} is not loaded.`);
    if ((it.relations ?? []).some((r) => r.rel === REL.artifact && sameUrl(r.url, url))) {
      toast(`#${itemId} is already linked to pull request !${pr.id}`);
      return true;
    }
    await app.actions.writer.patch(itemId,
      [{ op: "add", path: "/relations/-", value: { rel: REL.artifact, url, attributes: { name: "Pull Request" } } }],
      `Link added: pull request !${pr.id} ${pr.title}`, {}, { link: `Pull request ${pr.id}` });
    toast(`#${itemId} is now linked to pull request !${pr.id}`, {
      kind: "ok",
      undo: async () => { if (await unlinkPullRequest(app, itemId, url, pr)) onUndone?.(); },
    });
    return true;
  } catch (e) {
    toast(errorText(e), { kind: "error" });
    return false;
  }
}

/**
 * Take the pull request off a work item (the link only; the pull request is not changed). True when it is gone.
 * The message offers Undo, which links it again; `onRelinked` runs after that.
 */
export async function removePullRequestLink(app: App, itemId: number, pr: PullRequest, onRelinked?: () => void): Promise<boolean> {
  if (app.actions.readOnly) { toast("Read-only: you cannot change work items here.", { kind: "error" }); return false; }
  const url = prLinkUrl(app, pr);
  if (!url) { toast(`Pull request !${pr.id} cannot be unlinked from here: its project is not known.`, { kind: "error" }); return false; }
  try {
    await unlinkPullRequest(app, itemId, url, pr);
    toast(`#${itemId} is no longer linked to pull request !${pr.id}`, {
      kind: "ok",
      undo: async () => { if (await linkPullRequest(app, itemId, pr)) onRelinked?.(); },
    });
    return true;
  } catch (e) {
    toast(errorText(e), { kind: "error" });
    return false;
  }
}

/** Remove the link again (the Undo of linkPullRequest). True when it is gone. */
async function unlinkPullRequest(app: App, itemId: number, url: string, pr: PullRequest): Promise<boolean> {
  const ws = app.ws;
  await ws.withRelations([itemId]);
  const find = (): number => (ws.get(itemId)?.relations ?? []).findIndex((r) => r.rel === REL.artifact && sameUrl(r.url, url));
  let idx = find();
  // links not read yet, or changed meanwhile: read the item again once
  if (idx < 0) { await ws.refresh(itemId); idx = find(); }
  if (idx < 0) return true;
  await app.actions.writer.patch(itemId, [{ op: "remove", path: `/relations/${idx}` }],
    `Link removed: pull request !${pr.id} ${pr.title}`, { link: `Pull request ${pr.id}` }, {});
  await rereadLinks(app, itemId, url);
  return true;
}

/**
 * Read the item's links again after a link was removed. The saved copy comes without links when the last
 * one went, and the page would then keep the old ones; when the read fails, the removed link is taken out here.
 */
async function rereadLinks(app: App, itemId: number, url: string): Promise<void> {
  const ws = app.ws;
  const it = ws.get(itemId);
  if (!it) return;
  const before = it.relations;
  it.relations = undefined;
  await ws.withRelations([itemId]).catch(() => undefined);
  const cur = ws.get(itemId);
  if (!cur) return;
  if (!cur.relations) cur.relations = (before ?? []).filter((r) => !(r.rel === REL.artifact && sameUrl(r.url, url)));
  // the views draw the item again with its links as they are now
  ws.emit(new Set([itemId, ...(cur.parent ? [cur.parent] : [])]), "poll");
}
