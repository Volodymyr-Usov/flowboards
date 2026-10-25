// What every view gets: the data, the saved settings, and the shared actions.
// Type-only module: views import these types, never app/app.ts itself.
import type { Api } from "../api/api.ts";
import type { HostContext } from "../host/sdk.ts";
import type { Ai } from "../core/ai.ts";
import type { ChangeLog } from "../core/changelog.ts";
import type { Settings } from "../core/settings.ts";
import type { Workspace } from "../core/workspace.ts";
import type { Actions } from "../ui/actions.ts";
import type { StyleService } from "./style.ts";
import type { Sheet } from "../ui/xlsx.ts";

export interface App {
  api: Api;
  ws: Workspace;
  settings: Settings;
  log: ChangeLog;
  actions: Actions;
  ai: Ai;
  host: HostContext | null;
  /** open the details panel of a work item (on the right) */
  openItem(id: number): void;
  /** switch to another view; params end up in the view's `params` */
  navigate(view: string, params?: Record<string, string>): void;
  /** the details panel's item, when one is open */
  openId(): number | null;
  /** close the details panel */
  closeItem(): void;
  /** how the team works (Scrum, Kanban, Scrumban): sets the board's first layout and the tab order */
  style: StyleService;
}

export interface ViewHandle {
  /** items changed (poll, a write here or elsewhere); redraw what depends on them */
  update?(changed: Set<number>, why: string): void;
  /** the details panel opened or closed an item: highlight it */
  select?(id: number | null): void;
  unmount?(): void;
  /** what the top bar's Excel and Copy take from this page (null: nothing now); without it, every table shown */
  exportSheets?(): Sheet[] | null;
}

export interface View {
  id: string;
  title: string;
  /** the shorter name on the tab, when the title would take too much room */
  tab?: string;
  icon: string;
  group: "plan" | "measure" | "check";
  /** what this view shows and how to use it (the tab's tooltip) */
  about: string;
  mount(el: HTMLElement, app: App, params: Record<string, string>): ViewHandle | Promise<ViewHandle>;
}
