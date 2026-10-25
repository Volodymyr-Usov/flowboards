// The team's working style for this page: read the team's choice once, guess from the team's work
// when nobody chose, and save a change (the team's, or your own).
import type { Api } from "../api/api.ts";
import type { ChangeLog } from "../core/changelog.ts";
import { isOpen } from "../core/model.ts";
import type { Settings } from "../core/settings.ts";
import type { Workspace } from "../core/workspace.ts";
import type { StyleSource, TeamStyleDoc, WorkStyle } from "../core/workstyle.ts";
import { detectStyle, resolveStyle, styleLabel, TeamStyleStore } from "../core/workstyle.ts";

export class StyleService {
  private ws: Workspace;
  private settings: Settings;
  private log: ChangeLog;
  private api: Api;
  private store: TeamStyleStore;
  /** the team's saved choice, once read */
  team: TeamStyleDoc | null = null;
  /** the team's choice could not be read: changing it would overwrite one we did not see */
  teamReadFailed = false;
  private listeners = new Set<() => void>();
  private last = "";

  constructor(api: Api, ws: Workspace, settings: Settings, log: ChangeLog) {
    this.api = api;
    this.ws = ws;
    this.settings = settings;
    this.log = log;
    this.store = new TeamStyleStore(api, ws.project, ws.team);
  }

  private get key(): string { return `${this.ws.project}/${this.ws.team}`; }

  async load(): Promise<void> {
    try {
      this.team = await this.store.get();
      this.teamReadFailed = false;
    } catch (e) {
      console.warn("Team working style not read", e);
      this.teamReadFailed = true;
    }
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tell the listeners when the style that applies changed (also after the team's work loaded: the guess may change). */
  changed(): void {
    const now = JSON.stringify(this.current());
    if (now === this.last) return;
    this.last = now;
    for (const f of this.listeners) { try { f(); } catch (e) { console.warn(e); } }
  }

  detected(): { style: WorkStyle; why: string } {
    const req = this.ws.loadedAt ? this.ws.requirementLevel() : undefined;
    return detectStyle({
      iterations: this.ws.iterations,
      backlogPath: this.ws.settings?.backlogIteration ?? this.ws.project,
      open: req ? this.ws.ofLevel(req).filter(isOpen) : [],
    });
  }

  mine(): WorkStyle | undefined { return this.settings.user.styles?.[this.key]; }

  current(): { style: WorkStyle; source: StyleSource } {
    return resolveStyle(this.mine(), this.team, this.detected().style);
  }

  /** The team's style, for everyone in the team; null goes back to the guess. */
  async setTeam(style: WorkStyle | null): Promise<void> {
    if (this.teamReadFailed) throw new Error("The team's working style could not be read, so it is not changed now. Reload and try again.");
    const before = this.team?.style;
    if (style) this.team = await this.store.set(style, this.api.ctx.me.uniqueName, this.api.ctx.me.displayName);
    else { await this.store.remove(); this.team = null; }
    const name = (s: WorkStyle | undefined): string => (s ? styleLabel(s) : `not set (guess: ${styleLabel(this.detected().style)})`);
    void this.log.add({
      by: this.api.ctx.me.uniqueName, byName: this.api.ctx.me.displayName, itemId: 0, itemTitle: `${this.ws.team}: working style`, itemType: "",
      action: `Working style: ${name(before)} → ${name(style ?? undefined)}`, before: {}, after: {}, ok: true,
    });
    this.changed();
  }

  /** Your own style for this team (other people keep the team's); null follows the team again. */
  async setMine(style: WorkStyle | null): Promise<void> {
    const styles = { ...(this.settings.user.styles ?? {}) };
    if (style) styles[this.key] = style; else delete styles[this.key];
    await this.settings.saveUser({ styles });
    this.changed();
  }
}
