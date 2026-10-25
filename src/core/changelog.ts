// Every change this extension writes reports here (who, which item, before and after, worked or not).
// The Change log page was removed, so entries are no longer kept in storage: listeners (none today)
// can still follow them, and writes keep one place to report to if a log comes back.
export interface LogEntry {
  id: string;
  at: string;
  by: string;
  byName: string;
  itemId: number;
  itemTitle: string;
  itemType: string;
  /** a short sentence: "State: Active → Resolved" */
  action: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  ok: boolean;
  error?: string;
  /** rules skipped with "move anyway" */
  bypassed?: string[];
}

export class ChangeLog {
  private listeners = new Set<(e: LogEntry) => void>();

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async add(e: Omit<LogEntry, "id" | "at">): Promise<void> {
    const entry: LogEntry = { ...e, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() };
    for (const fn of this.listeners) {
      try { fn(entry); } catch (err) { console.warn(err); }
    }
  }
}
