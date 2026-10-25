// The few Node test APIs the tests use, so the type check works without downloading Node's types.
declare module "node:test" {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
  export function test(name: string, options: { skip?: boolean | string }, fn: () => unknown | Promise<unknown>): void;
  export function before(fn: () => unknown | Promise<unknown>): void;
  export function describe(name: string, fn: () => void): void;
  export const it: typeof test;
}
declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, re: RegExp, message?: string): void;
    doesNotMatch(value: string, re: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    rejects(p: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: string): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
declare module "node:child_process" {
  export function execFileSync(file: string, args?: readonly string[], options?: { encoding?: "utf8"; timeout?: number }): string;
}
declare module "node:assert" {
  import assert from "node:assert/strict";
  export default assert;
}

/** the process environment */
declare const process: { env: Record<string, string | undefined> };
