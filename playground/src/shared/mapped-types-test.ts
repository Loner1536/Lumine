// ═══════════════════════════════════════════════════════════════════
// Mapped type test — concrete implementations so the compiled Luau
// annotations are real and checkable, not just `undefined as never`.
//
// Every export type here lands in _lumine_types.luau as either:
//   _Lumine.MapProperties<T, V>         ← fixed value
//   _Lumine.MapPropertiesIdentity<T>    ← identity / conditional
// ═══════════════════════════════════════════════════════════════════

/** Shared concrete record used as T throughout these tests. */
export type BaseRecord = { name: string; count: number; active: boolean };

// ── Fixed value: every property maps to a concrete primitive ──────────────────

// → _Lumine.MapProperties<T, string>
export type Stringify<T extends Record<string, unknown>> = {
    [K in keyof T]: string;
};

// → _Lumine.MapProperties<T, number>
export type Numberify<T extends Record<string, unknown>> = {
    [K in keyof T]: number;
};

// → _Lumine.MapProperties<T, boolean>
export type Booleanify<T extends Record<string, unknown>> = {
    [K in keyof T]: boolean;
};

// ── Fixed union value ──────────────────────────────────────────────────────────

// → _Lumine.MapProperties<T, string | number>
export type StringOrNumber<T extends Record<string, unknown>> = {
    [K in keyof T]: string | number;
};

// → _Lumine.MapProperties<T, string?>
export type OptionalString<T extends Record<string, unknown>> = {
    [K in keyof T]: string | undefined;
};

// ── Type parameter as value ────────────────────────────────────────────────────

// → _Lumine.MapProperties<T, V>
export type Fill<T extends Record<string, unknown>, V> = {
    [K in keyof T]: V;
};

// ── Identity: T[K] cannot be expressed in Luau ────────────────────────────────

// → _Lumine.MapPropertiesIdentity<T>
export type Freeze<T extends Record<string, unknown>> = {
    readonly [K in keyof T]: T[K];
};

// → _Lumine.MapPropertiesIdentity<T>
export type Optionalize<T extends Record<string, unknown>> = {
    [K in keyof T]?: T[K];
};

// ── Conditional with infer → identity ─────────────────────────────────────────

// → _Lumine.MapPropertiesIdentity<T>
export type UnwrapArrays<T extends Record<string, unknown>> = {
    [K in keyof T]: T[K] extends Array<infer D> ? D : never;
};

// → _Lumine.MapPropertiesIdentity<T>
export type PickReturn<T extends Record<string, unknown>> = {
    [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never;
};

// ═══════════════════════════════════════════════════════════════════
// Concrete implementations — these give lumine real signatures to
// annotate, so the Luau output is verifiable.
// ═══════════════════════════════════════════════════════════════════

/** Convert every field to its string representation. */
export function stringify_record(x: BaseRecord): Stringify<BaseRecord> {
    return {
        name: x.name,
        count: `${x.count}`,
        active: `${x.active}`,
    };
}

/** Set every field to a constant number (e.g. a default ordinal). */
export function numberify_record(x: BaseRecord, defaultVal: number): Numberify<BaseRecord> {
    return {
        name: defaultVal,
        count: x.count,
        active: defaultVal,
    };
}

/** Produce a presence mask — true for every field. */
export function booleanify_record(x: BaseRecord): Booleanify<BaseRecord> {
    return {
        name: x.name !== "",
        count: x.count > 0,
        active: x.active,
    };
}

/** Replace every value with the same string | number. */
export function string_or_number_record(x: BaseRecord): StringOrNumber<BaseRecord> {
    return {
        name: x.name,
        count: x.count,
        active: x.active ? 1 : 0,
    };
}

/** Fill every property of T with a single value V. */
export function fill_record<V>(x: BaseRecord, v: V): Fill<BaseRecord, V> {
    return { name: v, count: v, active: v };
}

/** Return a readonly view — identity, just changes the type. */
export function freeze_record(x: BaseRecord): Freeze<BaseRecord> {
    return x;
}

/** Return the same object with all fields optional. */
export function optionalize_record(x: Partial<BaseRecord>): Optionalize<BaseRecord> {
    return x;
}

/** Round-trip a pre-built Stringify result to verify annotation. */
export function roundtrip_stringify(s: Stringify<BaseRecord>): Stringify<BaseRecord> {
    return s;
}

/** Round-trip a Fill result with an explicit second type param. */
export function roundtrip_fill(f: Fill<BaseRecord, number>): Fill<BaseRecord, number> {
    return f;
}
