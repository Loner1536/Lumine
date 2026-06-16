// ═══════════════════════════════════════════════════════════════════
// lumine type mapping test — covers every case in the mapping table
// ═══════════════════════════════════════════════════════════════════

// ── Already working ──────────────────────────────────────────────────────────

// Primitives
export function prim_number(x: number): number {
    return x;
}
export function prim_string(x: string): string {
    return x;
}
export function prim_boolean(x: boolean): boolean {
    return x;
}
export function prim_buffer(x: buffer): buffer {
    return x;
}

// void
export function prim_void(): void { }

// undefined / null → nil
export function prim_undefined(): undefined {
    return undefined;
}
export function prim_null(): null {
    return undefined as never;
}

// any / never / unknown
export function prim_any(x: any): any {
    return x;
}
export function prim_unknown(x: unknown): unknown {
    return x;
}
export function prim_never(): never {
    throw "never";
}

// T | undefined → T?
export function opt_union(x: number | undefined): string | undefined {
    return undefined;
}

// A | B union
export function union_basic(x: string | number | boolean): string | number {
    return x as never;
}

// A & B intersection
export interface IA {
    a: number;
}
export interface IB {
    b: string;
}
export function intersect_basic(x: IA & IB): IA & IB {
    return x;
}

// T[] / Array<T>
export function array_basic(x: number[]): string[] {
    return [];
}
export function array_generic(x: Array<boolean>): Array<number> {
    return [];
}
export function array_nested(x: string[][]): number[][] {
    return [];
}

// Map<K, V> / Record<K, V>
export function map_basic(): Map<string, number> {
    return new Map();
}
export function record_basic(): Record<string, boolean> {
    return {};
}
export function map_nested(): Map<string, Map<number, boolean>> {
    return new Map();
}

// Set<T>
export function set_basic(): Set<string> {
    return new Set();
}
export function set_number(): Set<number> {
    return new Set();
}

// Function types (a: A) => B
export function fn_basic(cb: (x: number) => string): void { }
export function fn_void(cb: () => void): void { }
export function fn_multi(cb: (a: string, b: number) => boolean): void { }
export function fn_returns(): (x: number) => string {
    return (x) => "";
}
export function fn_higher(fn: (cb: (x: number) => void) => boolean): void { }

// param?: T optional
export function opt_param(a: string, b?: number, c?: boolean): void { }

// ...args: T[] rest
export function rest_string(...args: string[]): void { }
export function rest_number(...values: number[]): number {
    return 0;
}
export function rest_mixed(first: string, ...rest: number[]): void { }

// Generic<T>
export interface Container<T> {
    value: T;
    tag: string;
}
export function generic_basic<T>(x: T): T {
    return x;
}
export function generic_multi<T, U>(a: T, b: U): [T, U] {
    return [a, b];
}
export function generic_constrained<T extends string>(x: T): T {
    return x;
}

// String literal singleton
export function literal_string(x: "hello" | "world"): "hello" {
    return "hello";
}
export function literal_status(s: "pending" | "active" | "done"): void { }

// Boolean literal singleton
export function literal_bool(x: true | false): boolean {
    return x;
}
export function literal_true(x: true): void { }

// Index signatures
export function index_string(): { [key: string]: number } {
    return {};
}
export function index_number(): { [key: number]: string } {
    return {};
}

// Namespace types
export namespace Codec {
    export interface Reader<T> {
        read(buf: buffer, offset: number): T;
    }
    export interface Writer<T> {
        write(buf: buffer, offset: number, value: T): number;
    }
}
export function ns_reader<T>(r: Codec.Reader<T>): void { }
export function ns_writer<T>(w: Codec.Writer<T>): void { }
export function ns_both<T>(r: Codec.Reader<T>, w: Codec.Writer<T>): void { }

// ── Needs to be added ─────────────────────────────────────────────────────────

// LuaTuple<[T, U]> — roblox-ts multiple returns
export function tuple_pair(x: number): LuaTuple<[number, string]> {
    return [x, ""] as never;
}
export function tuple_triple(): LuaTuple<[Player, Vector3, boolean]> {
    return undefined as never;
}
export function tuple_optional(): LuaTuple<[string, number | undefined]> {
    return undefined as never;
}

// T extends X ? A : B → A & B intersection
export type ConditionalSimple<T> = T extends undefined ? { a: number } : { b: string };
export type ConditionalNested<T> = T extends string
    ? { kind: "str"; value: string }
    : T extends number
    ? { kind: "num"; value: number }
    : { kind: "other" };

// keyof T → keyof<T>
export function keyof_basic<T>(obj: T, key: keyof T): void { }
export function keyof_record(key: keyof Record<string, number>): void { }

// Readonly<T>
export function readonly_basic(x: Readonly<{ a: number; b: string }>): void { }
export function readonly_array(x: ReadonlyArray<number>): void { }
export function readonly_map(x: ReadonlyMap<string, number>): void { }
export function readonly_set(x: ReadonlySet<string>): void { }

// NonNullable<T>
export function nonnull_basic<T>(x: NonNullable<T>): T {
    return x as never;
}
// Required<T>
export interface Partial_User {
    name?: string;
    age?: number;
    active?: boolean;
}
export function required_basic(x: Required<Partial_User>): void { }

// Partial<T>
export interface Full_User {
    name: string;
    age: number;
    active: boolean;
}
export function partial_basic(x: Partial<Full_User>): void { }

// Promise<T> — pass through
export function promise_void(): Promise<void> {
    return new Promise((value) => { });
}
export function promise_string(): Promise<string> {
    return new Promise((value) => "");
}
export function promise_generic<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise(fn);
}

// RBXScriptSignal / RBXScriptConnection
export function rbx_signal(sig: RBXScriptSignal): RBXScriptConnection {
    return undefined as never;
}
export function rbx_connect(sig: RBXScriptSignal, fn: (x: string) => void): RBXScriptConnection {
    return undefined as never;
}

// Tuple (lossy)
export function tuple_basic(): [number, string, boolean] {
    return [0, "", true];
}
export function tuple_pair_two(a: number, b: string): [number, string] {
    return [a, b];
}

// ── Not representable → should emit any or strip ──────────────────────────────

// Mapped types → any
export type MappedPartial<T> = { [K in keyof T]?: T[K] };
export type MappedReadonly<T> = { readonly [K in keyof T]: T[K] };
export function mapped_partial<T>(x: MappedPartial<T>): void { }
export function mapped_readonly<T>(x: MappedReadonly<T>): void { }

// Template literal types → string
export type EventName = `on${string}`;
export type KeyPath = `${string}.${string}`;
export function template_event(name: EventName): void { }
export function template_path(path: KeyPath): void { }

// ReturnType / Parameters → any
export function higher_returntype<T extends (...args: any[]) => any>(fn: T): ReturnType<T> {
    return undefined as never;
}
export function higher_params<T extends (...args: any[]) => any>(fn: T): Parameters<T> {
    return undefined as never;
}

// Number literal types → fallback
export function num_literal(x: 0 | 1 | 2): number {
    return x;
}
export function num_port(port: 80 | 443 | 8080): void { }

// infer → any
export type Unpack<T> = T extends Array<infer U> ? U : never;
export function unpack_array<T>(arr: T[]): Unpack<T[]> {
    return undefined as never;
}

// Mapped type → type function
export type MappedToString<T extends Record<string, unknown>> = { [K in keyof T]: string };
export type MappedResult<T extends Record<string, unknown>> = {
    [K in keyof T]: T[K] extends Array<infer D> ? D : never;
};
export function mapped_to_string<T extends Record<string, unknown>>(x: MappedToString<T>): void {}
export function mapped_result<T extends Record<string, unknown>>(x: MappedResult<T>): void {}
