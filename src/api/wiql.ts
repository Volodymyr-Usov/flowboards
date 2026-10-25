// QuerySpec -> WIQL text. Pure; covered by test/wiql.test.ts.
import type { QuerySpec } from "./types.ts";

export const q = (s: string): string => "'" + s.replaceAll("'", "''") + "'";
const list = (xs: string[]): string => "(" + xs.map(q).join(", ") + ")";

/** Whole numbers only: a number that is not one (NaN) would break the query text. */
const numbers = (xs: number[]): number[] => xs.filter(Number.isFinite).map((n) => Math.trunc(n));

/** An empty list of ids, parents, types or states means "none of these": the query matches nothing. */
export function matchesNothing(spec: QuerySpec): boolean {
  return [spec.ids && numbers(spec.ids), spec.parents && numbers(spec.parents), spec.types, spec.states].some((l) => l !== undefined && l.length === 0);
}

export function toWiql(spec: QuerySpec, currentProject: string): string {
  const where: string[] = [];
  if (matchesNothing(spec)) where.push("[System.Id] < 0");
  if (spec.project !== "*") where.push(`[System.TeamProject] = ${q(spec.project ?? currentProject)}`);
  const ids = numbers(spec.ids ?? []);
  const parents = numbers(spec.parents ?? []);
  if (ids.length) where.push(`[System.Id] IN (${ids.join(", ")})`);
  if (parents.length) where.push(`[System.Parent] IN (${parents.join(", ")})`);
  if (spec.types?.length) where.push(`[System.WorkItemType] IN ${list(spec.types)}`);
  if (spec.areas?.length) {
    const parts = spec.areas.map((a) => `[System.AreaPath] ${a.includeChildren ? "UNDER" : "="} ${q(a.path)}`);
    where.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }
  if (spec.iterationUnder) where.push(`[System.IterationPath] UNDER ${q(spec.iterationUnder)}`);
  if (spec.states?.length) where.push(`[System.State] IN ${list(spec.states)}`);
  if (spec.notStates?.length) where.push(`[System.State] NOT IN ${list(spec.notStates)}`);
  if (spec.assignedTo) where.push(`[System.AssignedTo] = ${q(spec.assignedTo)}`);
  if (spec.tag) where.push(`[System.Tags] CONTAINS ${q(spec.tag)}`);
  if (spec.changedAfter) where.push(`[System.ChangedDate] >= ${q(spec.changedAfter)}`);
  if (spec.createdAfter) where.push(`[System.CreatedDate] >= ${q(spec.createdAfter)}`);
  if (spec.closedAfter) where.push(`[Microsoft.VSTS.Common.ClosedDate] >= ${q(spec.closedAfter)}`);
  if (spec.closedBefore) where.push(`[Microsoft.VSTS.Common.ClosedDate] < ${q(spec.closedBefore)}`);
  const order = {
    changed: "[System.ChangedDate] DESC",
    id: "[System.Id] ASC",
    closed: "[Microsoft.VSTS.Common.ClosedDate] DESC",
  }[spec.orderBy ?? "id"];
  return `SELECT [System.Id] FROM WorkItems${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY ${order}`;
}

/** WIQL compares dates by day unless asked for time precision. */
export function needsTimePrecision(spec: QuerySpec): boolean {
  return [spec.changedAfter, spec.createdAfter, spec.closedAfter, spec.closedBefore].some((d) => d?.includes("T"));
}
