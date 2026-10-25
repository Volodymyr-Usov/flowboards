// Delete a task (or any child) after asking: it goes to the Recycle Bin, with Undo. Used by the details panel and the Board's task lists.
import type { WorkItem } from "../api/types.ts";
import type { App } from "../app/context.ts";
import { h } from "./dom.ts";
import { confirm } from "./kit.ts";

export async function askDelete(app: App, k: WorkItem): Promise<boolean> {
  const ok = await confirm(`Delete ${k.type.toLowerCase()} #${k.id}?`,
    h("span", null, h("b", null, k.title), ` goes to the Recycle Bin. Undo, or Restore on the Recycle Bin page (bin icon in the tabs), brings it back.`), "Delete", true);
  return ok ? app.actions.deleteItem(k.id) : false;
}
