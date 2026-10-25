// The extension's document storage, kept in this browser instead (demo and local testing).
// Like Azure DevOps: a save with an older version number (__etag) is refused, -1 overwrites,
// and createDoc refuses an id that exists.
import type { ExtensionDoc } from "./api.ts";
import { ApiError } from "./types.ts";

/** Documents the browser would not keep (storage blocked or full): held here, and they win over the stored copy. */
const memory = new Map<string, ExtensionDoc>();

export class LocalDocs {
  private prefix: string;
  constructor(prefix: string) { this.prefix = prefix; }

  private key(collection: string, scope: string, id = ""): string { return `${this.prefix}:${scope}:${collection}:${id}`; }

  async docs(collection: string, scope: string): Promise<ExtensionDoc[]> {
    const p = this.key(collection, scope);
    const found = new Map<string, ExtensionDoc>();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (!k.startsWith(p)) continue;
        // one damaged document is left out, the others still count
        try { found.set(k, JSON.parse(localStorage.getItem(k)!)); } catch { /* skipped */ }
      }
    } catch { /* storage blocked: only the ones held here */ }
    for (const [k, v] of memory) if (k.startsWith(p)) found.set(k, structuredClone(v));
    return [...found.values()];
  }
  async getDoc(collection: string, id: string, scope: string): Promise<ExtensionDoc | null> {
    const k = this.key(collection, scope, id);
    const held = memory.get(k);
    if (held) return structuredClone(held);
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  }
  async setDoc(collection: string, doc: ExtensionDoc, scope: string): Promise<ExtensionDoc> {
    const cur = await this.getDoc(collection, doc.id, scope);
    const curTag = Number(cur?.__etag) || 0;
    if (cur && doc.__etag != null && doc.__etag !== -1 && doc.__etag !== curTag) throw new ApiError(409, "Someone else saved this document first.");
    const saved = { ...doc, __etag: curTag + 1 };
    const k = this.key(collection, scope, doc.id);
    try { localStorage.setItem(k, JSON.stringify(saved)); memory.delete(k); } catch { memory.set(k, structuredClone(saved)); }
    return saved;
  }
  async createDoc(collection: string, doc: ExtensionDoc, scope: string): Promise<ExtensionDoc> {
    if (await this.getDoc(collection, doc.id, scope)) throw new ApiError(409, "A document with this id exists already.");
    return this.setDoc(collection, { ...doc, __etag: -1 }, scope);
  }
  async deleteDoc(collection: string, id: string, scope: string): Promise<void> {
    const k = this.key(collection, scope, id);
    memory.delete(k);
    try { localStorage.removeItem(k); } catch { /* blocked: nothing stored */ }
  }
}
