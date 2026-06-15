/**
 * luau-types.ts
 *
 * The Luau type AST. Every type in lumine is one of these nodes — no strings.
 * This eliminates entire categories of bugs that existed when types were
 * manipulated as raw strings (> in ->, split(",") on nested parens, etc.).
 */

// ── Core AST ──────────────────────────────────────────────────────────────────

export type LuauType =
    | { kind: "primitive"; name: "number" | "string" | "boolean" | "buffer" | "any" | "never" | "nil" }
    | { kind: "void" }                              // () — empty tuple, function return
    | { kind: "optional"; inner: LuauType }         // T?
    | { kind: "union"; members: LuauType[] }        // A | B | C
    | { kind: "intersection"; members: LuauType[] } // A & B
    | { kind: "table"; fields: LuauField[]; indexer?: LuauIndexer }
    | { kind: "function"; params: LuauFnParam[]; returns: LuauType }
    | { kind: "reference"; name: string; args?: LuauType[] } // Name or Name<T, U>
    | { kind: "singleton_string"; value: string }   // "hello" (already quoted)
    | { kind: "singleton_number"; value: number }
    | { kind: "singleton_boolean"; value: boolean }
    | { kind: "tuple"; elements: LuauType[] }       // (T, U) multi-return
    | { kind: "keyof"; inner: LuauType };           // keyof<T>

export interface LuauField {
    name: string;
    type: LuauType;
    optional: boolean;
    isMethod: boolean; // inject self param when emitting as a type declaration
}

export interface LuauIndexer {
    key: LuauType;
    value: LuauType;
}

export interface LuauFnParam {
    name: string;
    type: LuauType;
    optional: boolean;
    rest: boolean;
}

// ── Constant singletons ───────────────────────────────────────────────────────

export const LuauAny: LuauType = { kind: "primitive", name: "any" };
export const LuauNever: LuauType = { kind: "primitive", name: "never" };
export const LuauNil: LuauType = { kind: "primitive", name: "nil" };
export const LuauVoid: LuauType = { kind: "void" };
export const LuauString: LuauType = { kind: "primitive", name: "string" };
export const LuauNumber: LuauType = { kind: "primitive", name: "number" };
export const LuauBoolean: LuauType = { kind: "primitive", name: "boolean" };

// ── Smart constructors ────────────────────────────────────────────────────────

export function mkOptional(inner: LuauType): LuauType {
    if (inner.kind === "optional") return inner;
    if (inner.kind === "primitive" && inner.name === "nil") return inner;
    return { kind: "optional", inner };
}

export function mkUnion(members: LuauType[]): LuauType {
    const flat: LuauType[] = [];
    for (const m of members) {
        if (m.kind === "union") flat.push(...m.members);
        else flat.push(m);
    }
    if (flat.length === 0) return LuauNever;
    if (flat.length === 1) return flat[0];
    return { kind: "union", members: flat };
}

export function mkIntersection(members: LuauType[]): LuauType {
    // Deduplicate by JSON identity
    const seen = new Set<string>();
    const deduped: LuauType[] = [];
    for (const m of members) {
        const key = JSON.stringify(m);
        if (!seen.has(key)) { seen.add(key); deduped.push(m); }
    }
    if (deduped.length === 0) return LuauAny;
    if (deduped.length === 1) return deduped[0];
    return { kind: "intersection", members: deduped };
}

export function mkRef(name: string, args?: LuauType[]): LuauType {
    return { kind: "reference", name, args: args?.length ? args : undefined };
}

// ── Printer ───────────────────────────────────────────────────────────────────

/**
 * Print a LuauType to a Luau type annotation string.
 *
 * @param inGenericArg  When true, void prints as "nil" (not "()") because
 *                      "()" is not valid as a generic type argument in Luau.
 */
export function printLuauType(t: LuauType, depth = 0, inGenericArg = false): string {
    if (depth > 30) return "any";

    switch (t.kind) {
        case "primitive": return t.name;

        case "void":
            return inGenericArg ? "nil" : "()";

        case "optional": {
            const inner = printLuauType(t.inner, depth + 1, inGenericArg);
            // Wrap unions so we get (A | B)? not A | B?
            return t.inner.kind === "union" ? `(${inner})?` : `${inner}?`;
        }

        case "union":
            return t.members.map(m => printLuauType(m, depth + 1, inGenericArg)).join(" | ");

        case "intersection":
            return t.members.map(m => printLuauType(m, depth + 1, inGenericArg)).join(" & ");

        case "table": {
            const parts: string[] = [];
            if (t.indexer) {
                parts.push(
                    `[${printLuauType(t.indexer.key, depth + 1, true)}]: ${printLuauType(t.indexer.value, depth + 1, true)}`
                );
            }
            for (const f of t.fields) {
                const opt = f.optional ? "?" : "";
                parts.push(`${f.name}: ${printLuauType(f.type, depth + 1, true)}${opt}`);
            }
            if (parts.length === 0) return "{}";
            return `{ ${parts.join(", ")} }`;
        }

        case "function": {
            const params = t.params.map(p => printFnParam(p, depth)).join(", ");
            const ret = t.returns.kind === "void"
                ? "()"
                : printLuauType(t.returns, depth + 1, false);
            return `(${params}) -> ${ret}`;
        }

        case "reference": {
            if (!t.args?.length) return t.name;
            const args = t.args.map(a => printLuauType(a, depth + 1, true)).join(", ");
            return `${t.name}<${args}>`;
        }

        case "singleton_string": return t.value;
        case "singleton_number": return String(t.value);
        case "singleton_boolean": return t.value ? "true" : "false";

        case "tuple":
            if (t.elements.length === 0) return "()";
            return `(${t.elements.map(e => printLuauType(e, depth + 1, false)).join(", ")})`;

        case "keyof":
            return `keyof<${printLuauType(t.inner, depth + 1, true)}>`;
    }
}

function printFnParam(p: LuauFnParam, depth: number): string {
    if (p.rest) return `...${printLuauType(p.type, depth + 1, true)}`;
    const opt = p.optional ? "?" : "";
    return `${p.name}: ${printLuauType(p.type, depth + 1, true)}${opt}`;
}

/** ": T" for return annotations, or "" for void. */
export function printReturn(t: LuauType): string {
    if (t.kind === "void") return "";
    return `: ${printLuauType(t, 0, false)}`;
}

/** "name: T" or "...: T" for parameter annotations. */
export function printParam(name: string, t: LuauType, optional: boolean, rest: boolean): string {
    if (rest) return `...: ${printLuauType(t, 0, true)}`;
    const opt = optional ? "?" : "";
    return `${name}: ${printLuauType(t, 0, false)}${opt}`;
}

/** True if any node in the tree references a _Lumine.X builtin. */
export function typeUsesBuiltins(t: LuauType): boolean {
    switch (t.kind) {
        case "reference":
            if (t.name.startsWith("_Lumine.")) return true;
            return t.args?.some(typeUsesBuiltins) ?? false;
        case "optional": return typeUsesBuiltins(t.inner);
        case "union":
        case "intersection": return t.members.some(typeUsesBuiltins);
        case "table":
            return t.fields.some(f => typeUsesBuiltins(f.type)) ||
                (t.indexer
                    ? typeUsesBuiltins(t.indexer.key) || typeUsesBuiltins(t.indexer.value)
                    : false);
        case "function":
            return t.params.some(p => typeUsesBuiltins(p.type)) || typeUsesBuiltins(t.returns);
        case "tuple": return t.elements.some(typeUsesBuiltins);
        case "keyof": return typeUsesBuiltins(t.inner);
        default: return false;
    }
}
