// edge-cases-test.ts
// Covers: null unions, indexed access, typeof, negative literals,
// multiple generic defaults, Promise edges, `this` parameter

// ── null in unions → T? ───────────────────────────────────────────────────────

export function null_string(x: string | null): string | null {
    return x;
}

export function null_number(x: number | null): number | null {
    return x;
}

// null + undefined both → T?
export function null_and_undef(x: string | null | undefined): string | undefined {
    return x ?? undefined;
}

// ── Indexed access T[K] → any ─────────────────────────────────────────────────

export interface Record2 {
    name: string;
    count: number;
}

export function indexed_access<T extends Record2, K extends keyof T>(obj: T, key: K): T[K] {
    return obj[key];
}

// ── typeof in type position → any ────────────────────────────────────────────

function internalHelper(x: number): string {
    return `${x}`;
}

export function typeof_param(fn: typeof internalHelper): string {
    return fn(42);
}

export function typeof_return(x: number): typeof internalHelper {
    return internalHelper;
}

// ── Negative number literals → number ─────────────────────────────────────────

export function neg_literal(x: -1 | -2 | 0 | 1 | 2): number {
    return x;
}

export function neg_only(x: -3 | -2 | -1): number {
    return x;
}

// ── Multiple generic defaults ─────────────────────────────────────────────────

export interface Config<T = string, U = number> {
    primary: T;
    secondary: U;
    label: string;
}

// Bare Config — both T=string and U=number should be filled
export function use_config_bare(c: Config): string {
    return c.label;
}

// Config<boolean> — only U=number should be filled
export function use_config_one_arg(c: Config<boolean>): string {
    return c.label;
}

// Config<boolean, string> — no defaults needed
export function use_config_full(c: Config<boolean, string>): string {
    return c.label;
}

// Return type also needs defaults filled
export function make_config(): Config {
    return { primary: "hi", secondary: 0, label: "x" };
}

// ── Promise edge cases ────────────────────────────────────────────────────────

// Promise<null> → _Lumine.Promise<nil>
export function promise_null(): Promise<null> {
    return Promise.resolve(undefined as never);
}

// Promise<undefined> → _Lumine.Promise<nil>  (void path doesn't cover this)
export function promise_undef(): Promise<undefined> {
    return Promise.resolve(undefined);
}

// Promise<Promise<string>> → _Lumine.Promise<_Lumine.Promise<string>>
export function promise_nested(): Promise<Promise<string>> {
    return Promise.resolve(Promise.resolve("hi"));
}

// ── this parameter — should be skipped, not counted ──────────────────────────
// rbxtsc emits `this: void` for functions that must not be called as methods.
// The .d.ts includes `this: void` but the compiled .luau has no `this` param.
// Without a fix, lumine sees 2 params but Luau has 1 → annotation is skipped.

export function with_this(this: void, x: number): number {
    return x;
}

export function with_this_multi(this: void, a: string, b: number): string {
    return a;
}
