// Priority score, "weighted shortest job first": (business value + time criticality + risk reduction) / size.
// Pure: reads the process to see which of these fields exist, and an item's fields for the numbers.
import type { ProcessInfo, WorkItem } from "../api/types.ts";

export const BUSINESS_VALUE = "Microsoft.VSTS.Common.BusinessValue";
export const TIME_CRITICALITY = "Microsoft.VSTS.Common.TimeCriticality";
/** risk reduction / opportunity enablement: processes name it differently */
export const RISK_FIELDS = ["Microsoft.VSTS.Common.RiskReduction", "Microsoft.VSTS.Common.RROEValue", "Custom.RiskReduction", "Custom.RROEValue"];
export const SIZE_FIELDS = ["Microsoft.VSTS.Scheduling.Size", "Microsoft.VSTS.Scheduling.StoryPoints", "Microsoft.VSTS.Scheduling.Effort"];

export interface WsjfPart { label: string; field: string }
/** The fields one work item type uses for the score. */
export interface WsjfType { value: WsjfPart[]; size: WsjfPart }
export interface WsjfSetup {
  /** by work item type; a type that is missing has no score */
  types: Map<string, WsjfType>;
  /** every field to read with the items */
  fields: string[];
}
export interface WsjfScore {
  /** the type has fields for a score */
  applies: boolean;
  score?: number;
  /** parts with no value on this item (labels) */
  missing: string[];
  /** the formula with this item's numbers */
  how: string;
}

const LABELS: Record<string, string> = { [BUSINESS_VALUE]: "Business value", [TIME_CRITICALITY]: "Time criticality" };

/**
 * Which fields each type of the process has for the score. A type counts when it has a size field and at least
 * one of the value fields; value parts the type does not have are left out of its formula.
 * Types without a field list (unknown) are given every candidate field.
 */
export function wsjfSetup(p: ProcessInfo): WsjfSetup {
  const types = new Map<string, WsjfType>();
  const fields = new Set<string>();
  const levelTypes = new Set(p.levels.filter((l) => l.kind !== "task").flatMap((l) => l.types));
  for (const t of levelTypes) {
    const info = p.types[t];
    const has = (f: string): boolean => !info?.fields || info.fields.includes(f);
    const name = (f: string, fallback: string): string => info?.fieldNames?.[f] ? sentence(info.fieldNames[f]) : fallback;
    const value: WsjfPart[] = [];
    if (has(BUSINESS_VALUE)) value.push({ field: BUSINESS_VALUE, label: name(BUSINESS_VALUE, LABELS[BUSINESS_VALUE]) });
    if (has(TIME_CRITICALITY)) value.push({ field: TIME_CRITICALITY, label: name(TIME_CRITICALITY, LABELS[TIME_CRITICALITY]) });
    const risk = info?.fields ? RISK_FIELDS.find(has) : RISK_FIELDS[0];
    if (risk) value.push({ field: risk, label: name(risk, "Risk reduction") });
    // the process's own effort field first, then the usual size fields
    const sizeField = [p.fields.effort, ...SIZE_FIELDS].find((f) => !!f && has(f));
    if (!value.length || !sizeField) continue;
    const size = { field: sizeField, label: name(sizeField, "Size") };
    types.set(t, { value, size });
    for (const v of value) fields.add(v.field);
    fields.add(size.field);
  }
  return { types, fields: [...fields] };
}

/** "Business Value" -> "Business value" */
function sentence(s: string): string {
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : s;
}

function numberOf(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  // pick lists like "2 - Medium" count by their number
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

/** The score of one item: a number, or the parts that are missing. */
export function wsjfScore(w: WorkItem, setup: WsjfSetup): WsjfScore {
  const t = setup.types.get(w.type);
  if (!t) return { applies: false, missing: [], how: "" };
  const missing: string[] = [];
  let sum = 0;
  const shown: string[] = [];
  for (const part of t.value) {
    const n = numberOf(w.fields[part.field]);
    if (n == null) { missing.push(part.label); shown.push(`${part.label} ?`); continue; }
    sum += n;
    shown.push(`${part.label} ${n}`);
  }
  const size = numberOf(w.fields[t.size.field]);
  if (size == null) missing.push(t.size.label);
  else if (size <= 0) missing.push(`${t.size.label} above 0`);
  const how = `(${shown.join(" + ")}) / ${t.size.label} ${size ?? "?"}`;
  if (missing.length) return { applies: true, missing, how };
  return { applies: true, score: Math.round((sum / size!) * 10) / 10, missing, how };
}

/** Highest score first; items with no score last; ties keep the order they came in (Array.sort is stable). */
export function byScore(score: (w: WorkItem) => number | undefined): (a: WorkItem, b: WorkItem) => number {
  return (a, b) => {
    const x = score(a);
    const y = score(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;
  };
}
