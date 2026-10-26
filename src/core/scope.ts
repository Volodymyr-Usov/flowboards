// Whose work an item is: the team's own (in its area paths) or another team's that the workspace
// loaded too (parents of the team's items, or the whole project). Pure; covered by test/health.test.ts.
import { inTeamAreas } from "./model.ts";

/** Is the item in the team's area paths (with "and below" where the team includes children)? No areas set: every item counts. */
export function ofTeam(ws: { settings: { areas: { path: string; includeChildren: boolean }[] } }, item: { area: string }): boolean {
  return inTeamAreas(item.area, ws.settings.areas);
}
