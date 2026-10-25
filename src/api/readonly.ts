// Read-only mode (?readonly): every call that changes something in Azure DevOps or in the extension's
// storage is refused here, whichever page asks, so looking at real data can never change it.
import type { Api } from "./api.ts";
import { ApiError } from "./types.ts";

export const WRITES = ["update", "create", "deleteItem", "restoreItem", "reorder", "addComment", "setDoc", "createDoc", "deleteDoc", "renameTag", "deleteTag",
  "setCapacity", "setTeamDaysOff", "setColumnLimit"] as const;

export function readOnlyApi(api: Api): Api {
  const blocked = new Set<string>(WRITES);
  return new Proxy(api, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && blocked.has(prop) && typeof v === "function") {
        return () => Promise.reject(new ApiError(403, "Read-only: nothing can be changed here."));
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
