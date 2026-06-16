/**
 * extract.ts
 *
 * Converts TypeScript .d.ts AST nodes directly into LuauType objects.
 * No intermediate string representation — every type is an AST node from
 * the moment it leaves the TypeScript compiler.
 */
import ts from "typescript";
import { readFileSync } from "fs";
import type { TypeManifest, FunctionSignature, TypeDecl } from "./types";
import {
    LuauAny,
    LuauNever,
    LuauNil,
    LuauVoid,
    LuauString,
    LuauNumber,
    LuauBoolean,
    mkOptional,
    mkUnion,
    mkIntersection,
    mkRef,
    type LuauType,
    type LuauField,
    type LuauFnParam,
    type LuauIndexer,
} from "./luau-types";
import { LUMINE_BUILTIN_NAMES } from "./builtins";

// ── Static lookup tables ──────────────────────────────────────────────────────

const PRIMITIVE_KEYWORD_MAP = new Map<ts.SyntaxKind, LuauType>([
    [ts.SyntaxKind.StringKeyword, LuauString],
    [ts.SyntaxKind.NumberKeyword, LuauNumber],
    [ts.SyntaxKind.BooleanKeyword, LuauBoolean],
    [ts.SyntaxKind.VoidKeyword, LuauVoid],
    [ts.SyntaxKind.AnyKeyword, LuauAny],
    [ts.SyntaxKind.UnknownKeyword, LuauAny],
    [ts.SyntaxKind.NeverKeyword, LuauNever],
    [ts.SyntaxKind.UndefinedKeyword, LuauNil],
    [ts.SyntaxKind.NullKeyword, LuauNil],
    [ts.SyntaxKind.ObjectKeyword, LuauAny],
    [ts.SyntaxKind.BigIntKeyword, LuauNumber],
    [ts.SyntaxKind.SymbolKeyword, LuauAny],
]);

const ROBLOX_TYPES = new Set([
    "Player",
    "Vector3",
    "Vector2",
    "CFrame",
    "Color3",
    "BrickColor",
    "Instance",
    "BasePart",
    "Part",
    "Model",
    "Humanoid",
    "HumanoidRootPart",
    "Animation",
    "AnimationTrack",
    "Animator",
    "Script",
    "LocalScript",
    "ModuleScript",
    "RemoteEvent",
    "RemoteFunction",
    "BindableEvent",
    "BindableFunction",
    "NumberValue",
    "StringValue",
    "BoolValue",
    "IntValue",
    "ObjectValue",
    "Folder",
    "Configuration",
    "Tool",
    "Backpack",
    "StarterPack",
    "Workspace",
    "ReplicatedStorage",
    "ServerStorage",
    "ServerScriptService",
    "SoundService",
    "TweenService",
    "RunService",
    "Players",
    "Teams",
    "UDim",
    "UDim2",
    "Rect",
    "Region3",
    "Ray",
    "Axes",
    "Faces",
    "TweenInfo",
    "NumberSequence",
    "ColorSequence",
    "NumberRange",
    "RBXScriptSignal",
    "RBXScriptConnection",
]);

const UNSUPPORTED_UTILITY = new Set([
    "ConstructorParameters",
    "InstanceType",
    "ThisType",
    "ThisParameterType",
    "OmitThisParameter",
    "Awaited",
    "NoInfer",
    "Extract",
    "Exclude",
    "OmitStrict",
]);

// ── Conversion context ────────────────────────────────────────────────────────

interface Ctx {
    source: ts.SourceFile;
    depth: number;
    /**
     * When inside a namespace block, the namespace name (e.g. "Packet").
     * Used to qualify bare sibling type references (e.g. `Builder` → `Packet_Builder`).
     */
    namespace?: string;
    /**
     * Type parameter names currently in scope (e.g. ["T", "TReq", "TRes"]).
     * These must NOT be prefixed with the namespace — they are generic variables.
     */
    typeParams?: Set<string>;
    /**
     * The set of type names declared directly inside the current namespace
     * (e.g. {"Entry", "PooledBuilder"} for namespace Queue).
     * Only names in this set get the namespace prefix applied.
     */
    nsSiblings?: Set<string>;
    /**
     * Map of `import * as Alias` aliases to their module specifier.
     * e.g. "Type" → "./namespace-test"
     * Used in convertTypeRef to strip the alias prefix from dotted type names
     * like `Type.Queue.Entry` → `Queue_Entry`, so cross-file requires fire correctly.
     */
    nsImportAliases?: Map<string, string>;
}

function deeper(ctx: Ctx): Ctx {
    return { ...ctx, depth: ctx.depth + 1 };
}

// ── Core recursive converter ──────────────────────────────────────────────────

function tsNodeToLuau(node: ts.TypeNode | undefined, ctx: Ctx): LuauType {
    if (!node) return LuauVoid;
    if (ctx.depth > 24) return LuauAny;
    const cx = deeper(ctx);

    // ── Primitive keywords ────────────────────────────────────────────────────
    const prim = PRIMITIVE_KEYWORD_MAP.get(node.kind);
    if (prim !== undefined) return prim;

    // ── Parenthesized: unwrap ─────────────────────────────────────────────────
    if (ts.isParenthesizedTypeNode(node)) return tsNodeToLuau(node.type, cx);

    // ── Union: A | B | C ──────────────────────────────────────────────────────
    if (ts.isUnionTypeNode(node)) return convertUnion(node.types, cx);

    // ── Intersection: A & B ───────────────────────────────────────────────────
    if (ts.isIntersectionTypeNode(node)) {
        return mkIntersection(Array.from(node.types).map((t) => tsNodeToLuau(t, cx)));
    }

    // ── Array: T[] ────────────────────────────────────────────────────────────
    if (ts.isArrayTypeNode(node)) {
        return {
            kind: "table",
            fields: [],
            indexer: { key: LuauNumber, value: tsNodeToLuau(node.elementType, cx) },
        };
    }

    // ── Tuple: [T, U, V] → lossy union of element types ──────────────────────
    if (ts.isTupleTypeNode(node)) {
        const elems = Array.from(node.elements).map((e) => {
            // Named tuple member: name: T
            if (ts.isNamedTupleMember(e)) return tsNodeToLuau(e.type, cx);
            // Rest: ...T
            if (ts.isRestTypeNode(e)) return tsNodeToLuau(e.type, cx);
            // Optional: T?
            if (ts.isOptionalTypeNode(e)) return mkOptional(tsNodeToLuau(e.type, cx));
            return tsNodeToLuau(e as ts.TypeNode, cx);
        });
        return mkUnion(elems);
    }

    // ── Function type: (params) => ReturnType ─────────────────────────────────
    if (ts.isFunctionTypeNode(node)) {
        return convertFunctionType(node.parameters, node.type, cx);
    }

    // ── Type literal: { a: T; b: U } ─────────────────────────────────────────
    if (ts.isTypeLiteralNode(node)) {
        return convertTypeLiteral(node.members, cx);
    }

    // ── Type reference: SomeName or SomeName<T, U> ───────────────────────────
    if (ts.isTypeReferenceNode(node)) {
        return convertTypeRef(node, cx);
    }

    // ── Literal type: "hello", true, 42 ──────────────────────────────────────
    if (ts.isLiteralTypeNode(node)) {
        return convertLiteral(node.literal);
    }

    // ── Conditional: T extends U ? A : B → A & B ─────────────────────────────
    if (ts.isConditionalTypeNode(node)) {
        if (containsInfer(node)) return LuauAny;
        return mkIntersection(flattenConditional(node, cx));
    }

    // ── Mapped type: {[K in keyof T]: Expr} → type function ─────────────────
    if (node.kind === ts.SyntaxKind.MappedType)
        return convertMappedType(node as ts.MappedTypeNode, cx);

    // ── Template literal → string or collapsed singleton ─────────────────────
    if (ts.isTemplateLiteralTypeNode(node)) return convertTemplateLiteral(node, cx);

    // ── typeof → any ─────────────────────────────────────────────────────────
    if (ts.isTypeQueryNode(node)) return LuauAny;

    // ── Type operator: keyof T, readonly T, unique symbol ────────────────────
    if (ts.isTypeOperatorNode(node)) {
        if (node.operator === ts.SyntaxKind.KeyOfKeyword) {
            return { kind: "keyof", inner: tsNodeToLuau(node.type, cx) };
        }
        return tsNodeToLuau(node.type, cx); // readonly / unique → unwrap
    }

    // ── Indexed access: T[K] → any ───────────────────────────────────────────
    if (ts.isIndexedAccessTypeNode(node)) {
        return {
            kind: "index",
            object: tsNodeToLuau(node.objectType, cx),
            key: tsNodeToLuau(node.indexType, cx),
        };
    }

    // ── Rest type: ...T ───────────────────────────────────────────────────────
    if (ts.isRestTypeNode(node)) return tsNodeToLuau(node.type, cx);

    // ── Optional type (tuple context): T? ────────────────────────────────────
    if (ts.isOptionalTypeNode(node)) return mkOptional(tsNodeToLuau(node.type, cx));

    // ── Infer → any ──────────────────────────────────────────────────────────
    if (ts.isInferTypeNode(node)) return LuauAny;

    // ── Import type → any ────────────────────────────────────────────────────
    if (ts.isImportTypeNode(node)) return LuauAny;

    return LuauAny; // unknown syntax kind
}

// ── Union conversion ──────────────────────────────────────────────────────────

function convertUnion(types: ts.NodeArray<ts.TypeNode>, ctx: Ctx): LuauType {
    const converted = Array.from(types).map((t) => tsNodeToLuau(t, ctx));

    // All number literals → number (Luau has no number singleton types)
    if (converted.every((t) => t.kind === "singleton_number")) return LuauNumber;

    // Separate nil (undefined / null) from real types
    const isNil = (t: LuauType) => t.kind === "primitive" && t.name === "nil";
    const hasNil = converted.some(isNil);
    const nonNil = converted.filter((t) => !isNil(t));

    if (nonNil.length === 0) return LuauNil;
    const base = nonNil.length === 1 ? nonNil[0] : mkUnion(nonNil);
    return hasNil ? mkOptional(base) : base;
}

// ── Type reference conversion ─────────────────────────────────────────────────

function convertTypeRef(node: ts.TypeReferenceNode, ctx: Ctx): LuauType {
    const name = node.typeName.getText(ctx.source);
    const rawArgs = node.typeArguments
        ? Array.from(node.typeArguments).map((a) => tsNodeToLuau(a, ctx))
        : [];

    switch (name) {
        // Arrays
        case "Array":
        case "ReadonlyArray":
            return {
                kind: "table",
                fields: [],
                indexer: { key: LuauNumber, value: rawArgs[0] ?? LuauAny },
            };

        // Maps
        case "Map":
        case "ReadonlyMap":
            return {
                kind: "table",
                fields: [],
                indexer: { key: rawArgs[0] ?? LuauAny, value: rawArgs[1] ?? LuauAny },
            };

        // Records
        case "Record":
            return {
                kind: "table",
                fields: [],
                indexer: { key: rawArgs[0] ?? LuauAny, value: rawArgs[1] ?? LuauAny },
            };

        // Sets
        case "Set":
        case "ReadonlySet":
            return {
                kind: "table",
                fields: [],
                indexer: { key: rawArgs[0] ?? LuauAny, value: LuauBoolean },
            };

        // Readonly<T> → strip (Luau has no readonly)
        case "Readonly":
            return rawArgs[0] ?? LuauAny;

        // NonNullable<T> → strip optional
        case "NonNullable": {
            const inner = rawArgs[0] ?? LuauAny;
            return inner.kind === "optional" ? inner.inner : inner;
        }

        // LuaTuple<[T, U]> → (T, U) multi-return
        case "LuaTuple": {
            if (node.typeArguments?.length) {
                const first = node.typeArguments[0];
                if (ts.isTupleTypeNode(first)) {
                    const elems = Array.from(first.elements).map((e) =>
                        tsNodeToLuau(ts.isNamedTupleMember(e) ? e.type : (e as ts.TypeNode), ctx),
                    );
                    return { kind: "tuple", elements: elems };
                }
            }
            return LuauAny;
        }

        // Promise<T> → _Lumine.Promise<T | nil>
        case "Promise": {
            const T = rawArgs[0] ?? LuauNil;
            // void in generic position → nil
            const luauT = T.kind === "void" ? LuauNil : T;
            return mkRef("_Lumine.Promise", [luauT]);
        }
    }

    // Lumine builtins (Partial, Required, Pick, Omit, …)
    if (LUMINE_BUILTIN_NAMES.has(name)) {
        const args = rawArgs.map((a) => (a.kind === "void" ? LuauNil : a));
        return mkRef(`_Lumine.${name}`, args);
    }

    // Unsupported TS utility types → any
    if (UNSUPPORTED_UTILITY.has(name)) return LuauAny;

    // Roblox built-in Instance types → pass through
    if (ROBLOX_TYPES.has(name)) {
        return rawArgs.length ? mkRef(name, rawArgs) : mkRef(name);
    }

    // User-defined type — convert namespace dots to underscores.
    // If the name contains a dot (e.g. `Codec.External`, `Packet.Definition`),
    // the replace handles it correctly regardless of context.
    // If the name is bare with no dot, we need to decide whether to qualify it:
    //   - Type parameters (T, TReq, etc.) → never qualify, pass through as-is
    //   - Sibling types within the same namespace (e.g. `Builder` inside `Packet`) → qualify
    //   - Everything else (top-level types like `Group`, `Connection`) → pass through
    const args = rawArgs.map((a) => (a.kind === "void" ? LuauNil : a));

    if (name.includes(".")) {
        // Check if the first segment is a `import * as Alias` alias.
        // e.g. `Type.Queue.Entry` where `Type` is `import * as Type from "./namespace-test"`.
        // In that case the alias is just an import indirection — strip it and convert
        // the remainder (`Queue.Entry` → `Queue_Entry`) so the name matches what the
        // target file's manifest registers and the cross-file require fires correctly.
        const firstDot = name.indexOf(".");
        const prefix = name.slice(0, firstDot);
        if (ctx.nsImportAliases?.has(prefix)) {
            const remainder = name.slice(firstDot + 1); // "Queue.Entry"
            const luauName = remainder.replace(/\./g, "_"); // "Queue_Entry"
            return args.length ? mkRef(luauName, args) : mkRef(luauName);
        }

        // True namespace dot (Ns.Type declared in this file) → flatten to underscore
        const luauName = name.replace(/\./g, "_");
        return args.length ? mkRef(luauName, args) : mkRef(luauName);
    }

    // Bare name: check if it's a type param in scope — if so, never prefix
    if (ctx.typeParams?.has(name)) {
        return args.length ? mkRef(name, args) : mkRef(name);
    }

    // Bare name: check if it's a sibling declared in the current namespace
    if (ctx.namespace && ctx.nsSiblings?.has(name)) {
        const luauName = `${ctx.namespace}_${name}`;
        return args.length ? mkRef(luauName, args) : mkRef(luauName);
    }

    // Top-level type or unknown — pass through as-is
    return args.length ? mkRef(name, args) : mkRef(name);
}

// ── Function type conversion ──────────────────────────────────────────────────

function convertFunctionType(
    params: ts.NodeArray<ts.ParameterDeclaration>,
    returnType: ts.TypeNode | undefined,
    ctx: Ctx,
): LuauType {
    const luauParams: LuauFnParam[] = Array.from(params).map((p) => {
        const isRest = !!p.dotDotDotToken;
        const pType = p.type ? tsNodeToLuau(p.type, ctx) : LuauAny;

        // Rest param: ...args: T[] → element type T (not array type {T})
        const resolvedType = isRest ? extractArrayElement(pType) : pType;

        return {
            name: p.name
                .getText(ctx.source)
                .replace(/^\.\.\./, "")
                .trim(),
            type: resolvedType,
            optional: !!p.questionToken,
            rest: isRest,
        };
    });

    const ret = returnType ? tsNodeToLuau(returnType, ctx) : LuauVoid;
    return { kind: "function", params: luauParams, returns: ret };
}

function toFunctionSignature(
    name: string,
    params: ts.NodeArray<ts.ParameterDeclaration>,
    returnType: ts.TypeNode | undefined,
    typeParams: string[],
    ctx: Ctx,
): FunctionSignature {
    const fnType = convertFunctionType(params, returnType, ctx);
    return {
        name,
        params: fnType.kind === "function" ? fnType.params : [],
        returnType: fnType.kind === "function" ? fnType.returns : LuauVoid,
        typeParams,
    };
}

/** Given an array table type {T} or {[number]: T}, extract T. Otherwise return as-is. */
function extractArrayElement(t: LuauType): LuauType {
    if (t.kind === "table" && t.indexer && t.fields.length === 0) return t.indexer.value;
    return t;
}

// ── Type literal conversion ───────────────────────────────────────────────────

function convertTypeLiteral(members: ts.NodeArray<ts.TypeElement>, ctx: Ctx): LuauType {
    const fields: LuauField[] = [];
    let indexer: LuauIndexer | undefined;

    for (const m of members) {
        if (ts.isPropertySignature(m) && m.name) {
            fields.push({
                name: m.name.getText(ctx.source),
                type: m.type ? tsNodeToLuau(m.type, ctx) : LuauAny,
                optional: !!m.questionToken,
                isMethod: false,
            });
        } else if (ts.isMethodSignature(m) && m.name) {
            const fnType = convertFunctionType(
                m.parameters,
                m.type as ts.TypeNode | undefined,
                ctx,
            );
            fields.push({
                name: m.name.getText(ctx.source),
                type: fnType,
                optional: !!m.questionToken,
                isMethod: true,
            });
        } else if (ts.isIndexSignatureDeclaration(m)) {
            const keyParam = m.parameters[0];
            indexer = {
                key: keyParam?.type ? tsNodeToLuau(keyParam.type, ctx) : LuauString,
                value: m.type ? tsNodeToLuau(m.type, ctx) : LuauAny,
            };
        }
    }

    return { kind: "table", fields, indexer };
}

// ── Literal type conversion ───────────────────────────────────────────────────

function convertLiteral(literal: ts.LiteralTypeNode["literal"]): LuauType {
    if (ts.isStringLiteral(literal) || literal.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)
        return { kind: "singleton_string", value: `"${(literal as ts.StringLiteralLike).text}"` };
    if (ts.isNumericLiteral(literal))
        return { kind: "singleton_number", value: Number(literal.text) };
    if (literal.kind === ts.SyntaxKind.TrueKeyword)
        return { kind: "singleton_boolean", value: true };
    if (literal.kind === ts.SyntaxKind.FalseKeyword)
        return { kind: "singleton_boolean", value: false };
    if (literal.kind === ts.SyntaxKind.NullKeyword) return LuauNil;
    if (ts.isPrefixUnaryExpression(literal) && literal.operator === ts.SyntaxKind.MinusToken) {
        const operand = literal.operand;
        if (ts.isNumericLiteral(operand))
            return { kind: "singleton_number", value: -Number(operand.text) };
    }
    return LuauAny;
}

// ── Conditional type helpers ──────────────────────────────────────────────────

function containsInfer(node: ts.Node): boolean {
    if (ts.isInferTypeNode(node)) return true;
    return !!ts.forEachChild(node, containsInfer);
}

function flattenConditional(node: ts.ConditionalTypeNode, ctx: Ctx): LuauType[] {
    const branches: LuauType[] = [];
    const add = (t: ts.TypeNode) => {
        if (ts.isConditionalTypeNode(t)) {
            branches.push(...flattenConditional(t, ctx));
        } else {
            branches.push(tsNodeToLuau(t, ctx));
        }
    };
    add(node.trueType);
    add(node.falseType);
    return branches;
}

// ── Mapped type conversion ────────────────────────────────────────────────────

/**
 * Convert a TypeScript MappedType node to a LuauType.
 *
 * Handles the pattern `{[K in keyof T]: Expr}` where `T` is a type parameter
 * in scope.  Returns `{ kind: "mapped" }` so the emitter can produce a proper
 * Luau `type function` declaration.
 *
 * `valueType` is null when the value expression cannot be expressed in the
 * Luau type-function API (e.g. conditional types with `infer`, or indexed
 * access `T[K]`).  The emitter then falls back to an identity mapping that
 * preserves the input property types.
 */
function convertMappedType(node: ts.MappedTypeNode, ctx: Ctx): LuauType {
    const constraint = node.typeParameter?.constraint;

    // Only handle {[K in keyof T]: ...}
    if (
        !constraint ||
        !ts.isTypeOperatorNode(constraint) ||
        constraint.operator !== ts.SyntaxKind.KeyOfKeyword ||
        !ts.isTypeReferenceNode(constraint.type)
    )
        return LuauAny;

    const iteratedName = constraint.type.getText(ctx.source);

    // Only produce a type function when iterating over a known type parameter.
    // For concrete types (e.g. {[K in keyof {x:string}]: …}) fall back to any.
    if (!ctx.typeParams?.has(iteratedName)) return LuauAny;

    const valueNode = node.type;
    let valueType: LuauType | null = null;

    if (valueNode && !containsInfer(valueNode) && !hasIndexedAccess(valueNode)) {
        // Value doesn't reference T[K] or contain infer — try a direct conversion.
        const keyParamName = node.typeParameter.name.text;
        const valueCtx: Ctx = {
            ...ctx,
            typeParams: new Set([...(ctx.typeParams ?? []), keyParamName]),
        };
        valueType = tsNodeToLuau(valueNode, valueCtx);
    }
    // Otherwise valueType stays null → emitter uses identity (prop.read / prop.write).

    const isReadonly = !!node.readonlyToken && node.readonlyToken.kind !== ts.SyntaxKind.MinusToken;
    const isOptional = !!node.questionToken && node.questionToken.kind !== ts.SyntaxKind.MinusToken;

    return {
        kind: "mapped",
        param: iteratedName,
        valueType,
        readonly: isReadonly,
        optional: isOptional,
    };
}

// ── Template literal type conversion ─────────────────────────────────────────

/**
 * Convert a TypeScript template literal type to a Luau type.
 * When all parts are concrete string literals, collapses eagerly to a singleton.
 * When any part is a type parameter or reference, falls back to `string` —
 * Luau type functions cannot defer execution over free generics.
 */
function convertTemplateLiteral(node: ts.TemplateLiteralTypeNode, ctx: Ctx): LuauType {
    const parts: LuauType[] = [];

    function pushLiteral(text: string): void {
        if (!text) return;
        // Escape backslashes and double-quotes for Luau string literals
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        parts.push({ kind: "singleton_string", value: `"${escaped}"` });
    }

    pushLiteral(node.head.text);
    for (const span of node.templateSpans) {
        parts.push(tsNodeToLuau(span.type, ctx));
        pushLiteral(span.literal.text);
    }

    if (parts.length === 0) return { kind: "singleton_string", value: '""' };
    if (parts.length === 1) return parts[0];

    // If any part is the primitive `string` type the whole chain evaluates to string
    if (parts.some((p) => p.kind === "primitive" && p.name === "string")) return LuauString;

    // Collapse eagerly when every part is a concrete string literal
    if (parts.every((p) => p.kind === "singleton_string")) {
        const combined = parts
            .map((p) => (p as { kind: "singleton_string"; value: string }).value.slice(1, -1))
            .join("");
        return { kind: "singleton_string", value: `"${combined}"` };
    }

    // Any non-singleton part (type param, primitive, reference) cannot be
    // concatenated at the type level in Luau — fall back to `string`.
    if (parts.some((p) => p.kind !== "singleton_string")) return LuauString;

    // Unreachable: the every-singleton case above already returned. Here for safety.
    return LuauString;
}

function hasIndexedAccess(node: ts.Node): boolean {
    if (ts.isIndexedAccessTypeNode(node)) return true;
    return !!ts.forEachChild(node, hasIndexedAccess);
}

// ── Type parameter extraction ─────────────────────────────────────────────────

function extractTypeParams(
    node: ts.DeclarationWithTypeParameters,
    ctx: Ctx,
): { names: string[]; defaults: (LuauType | undefined)[] } {
    const params = ts.getEffectiveTypeParameterDeclarations(node);
    if (!params || params.length === 0) return { names: [], defaults: [] };
    const names: string[] = [];
    const defaults: (LuauType | undefined)[] = [];
    for (const p of params) {
        names.push(p.name.text);
        defaults.push(p.default ? tsNodeToLuau(p.default as ts.TypeNode, ctx) : undefined);
    }
    return { names, defaults };
}

// ── Interface member extraction (for interfaces, not inline type literals) ────

function extractInterfaceMembers(
    members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
    source: ts.SourceFile,
    ctx: Ctx,
): LuauField[] {
    const fields: LuauField[] = [];
    for (const m of members) {
        if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
            if (!m.name) continue;
            const propType =
                "type" in m && m.type ? tsNodeToLuau(m.type as ts.TypeNode, ctx) : LuauAny;
            fields.push({
                name: m.name.getText(source),
                type: propType,
                optional: !!m.questionToken,
                isMethod: false,
            });
        } else if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
            if (!m.name) continue;
            const fnType = convertFunctionType(
                m.parameters,
                "type" in m ? (m.type as ts.TypeNode | undefined) : undefined,
                ctx,
            );
            fields.push({
                name: m.name.getText(source),
                type: fnType,
                optional: !!m.questionToken,
                isMethod: true,
            });
        }
    }
    return fields;
}

function extractClassMembers(
    node: ts.ClassDeclaration,
    source: ts.SourceFile,
    ctx: Ctx,
    classTypeParams: string[],
): LuauField[] {
    const fields: LuauField[] = [];

    for (const member of node.members) {
        const isPrivate =
            ts.canHaveModifiers(member) &&
            ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
        if (isPrivate) continue;

        if (ts.isPropertyDeclaration(member) && member.name) {
            const propType = member.type ? tsNodeToLuau(member.type, ctx) : LuauAny;
            fields.push({
                name: member.name.getText(source),
                type: propType,
                optional: !!member.questionToken,
                isMethod: false,
            });
        }

        if (ts.isMethodDeclaration(member) && member.name) {
            const { names: methodTypeParams } = extractTypeParams(member, ctx);
            if (methodTypeParams.length > 0) continue;

            const methodCtx: Ctx = {
                ...ctx,
                typeParams: new Set([...classTypeParams, ...methodTypeParams]),
            };
            fields.push({
                name: member.name.getText(source),
                type: convertFunctionType(
                    member.parameters,
                    member.type as ts.TypeNode | undefined,
                    methodCtx,
                ),
                optional: !!member.questionToken,
                isMethod: true,
            });
        }
    }

    return fields;
}

// ── Collect sibling type names from a namespace block ────────────────────────

/**
 * Walk a namespace's module block and collect the names of all type aliases
 * and interfaces declared directly inside it. Used to build `nsSiblings` so
 * that bare references like `Builder` inside namespace `Packet` are correctly
 * prefixed to `Packet_Builder`, while unrelated bare names (`Group`,
 * `Connection`, type params) are left alone.
 */
function collectNsSiblings(body: ts.ModuleBlock): Set<string> {
    const names = new Set<string>();
    ts.forEachChild(body, (child) => {
        if (ts.isTypeAliasDeclaration(child)) names.add(child.name.text);
        if (ts.isInterfaceDeclaration(child)) names.add(child.name.text);
    });
    return names;
}

// ── Collect namespace import aliases (`import * as X from "..."`) ─────────────

/**
 * Scan top-level import declarations for namespace imports (`import * as X`).
 * Returns a map of alias → module specifier, e.g. `"Type" → "./namespace-test"`.
 * These aliases are used in convertTypeRef to strip the import prefix from dotted
 * type names like `Type.Queue.Entry` → `Queue_Entry`, so that cross-file type
 * tracking in annotate.ts can match them against the correct origin manifest.
 */
function collectNsImportAliases(source: ts.SourceFile): Map<string, string> {
    const aliases = new Map<string, string>();
    ts.forEachChild(source, (node) => {
        if (!ts.isImportDeclaration(node)) return;
        const clause = node.importClause;
        if (!clause?.namedBindings) return;
        if (!ts.isNamespaceImport(clause.namedBindings)) return;
        const alias = clause.namedBindings.name.text;
        const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
        aliases.set(alias, specifier);
    });
    return aliases;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function extractManifest(dtsPath: string): TypeManifest {
    const content = readFileSync(dtsPath, "utf-8");
    const source = ts.createSourceFile(dtsPath, content, ts.ScriptTarget.ESNext, true);
    const manifest: TypeManifest = { functions: {}, types: {} };

    // Collect `import * as Alias` bindings so convertTypeRef can strip them.
    const nsImportAliases = collectNsImportAliases(source);

    ts.forEachChild(source, (node) => {
        const ctx: Ctx = { source, depth: 0, nsImportAliases };

        // ── Function declarations ─────────────────────────────────────────────
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.text;
            const { names: typeParams } = extractTypeParams(node, ctx);
            manifest.functions[name] = toFunctionSignature(
                name,
                node.parameters,
                node.type,
                typeParams,
                ctx,
            );
        }

        // ── Class declarations ────────────────────────────────────────────────
        if (ts.isClassDeclaration(node) && node.name) {
            const name = node.name.text;
            const { names: classTypeParams, defaults: typeParamDefaults } = extractTypeParams(
                node,
                ctx,
            );
            const classCtx: Ctx = {
                ...ctx,
                typeParams: new Set(classTypeParams),
            };

            manifest.types[name] = {
                name,
                typeParams: classTypeParams,
                typeParamDefaults,
                body: {
                    kind: "table",
                    fields: extractClassMembers(node, source, classCtx, classTypeParams),
                },
            };

            for (const member of node.members) {
                if (ts.isConstructorDeclaration(member)) {
                    const signatureName = `${name}:constructor`;
                    manifest.functions[signatureName] = toFunctionSignature(
                        signatureName,
                        member.parameters,
                        undefined,
                        classTypeParams,
                        classCtx,
                    );
                }

                if (ts.isMethodDeclaration(member) && member.name) {
                    const methodName = member.name.getText(source);
                    const { names: methodTypeParams } = extractTypeParams(member, classCtx);
                    const signatureName = `${name}:${methodName}`;
                    const signatureTypeParams = [...classTypeParams, ...methodTypeParams];
                    const methodCtx: Ctx = {
                        ...classCtx,
                        typeParams: new Set(signatureTypeParams),
                    };
                    manifest.functions[signatureName] = toFunctionSignature(
                        signatureName,
                        member.parameters,
                        member.type as ts.TypeNode | undefined,
                        signatureTypeParams,
                        methodCtx,
                    );
                }
            }
        }

        // ── Interface declarations ────────────────────────────────────────────
        if (ts.isInterfaceDeclaration(node)) {
            const name = node.name.text;
            const { names: typeParams, defaults: typeParamDefaults } = extractTypeParams(node, ctx);
            const fields = extractInterfaceMembers(node.members, source, ctx);
            manifest.types[name] = {
                name,
                typeParams,
                typeParamDefaults,
                body: { kind: "table", fields },
            };
        }

        // ── Type alias declarations ───────────────────────────────────────────
        if (ts.isTypeAliasDeclaration(node)) {
            const name = node.name.text;
            const { names: typeParams, defaults: typeParamDefaults } = extractTypeParams(node, ctx);
            // Include type params in ctx so the body can detect them (e.g. for mapped types).
            const typeCtx: Ctx = typeParams.length
                ? { ...ctx, typeParams: new Set(typeParams) }
                : ctx;
            const body = tsNodeToLuau(node.type, typeCtx);
            manifest.types[name] = { name, typeParams, typeParamDefaults, body };
        }

        // ── Namespace declarations: namespace Net { interface Foo {} } ─────────
        if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
            const nsName = node.name.text;
            const body = node.body;
            if (body && ts.isModuleBlock(body)) {
                // Pre-collect all sibling type names in this namespace so that bare
                // references inside member types can be correctly qualified.
                const nsSiblings = collectNsSiblings(body);

                ts.forEachChild(body, (child) => {
                    // 1. Process Interfaces inside namespaces
                    if (ts.isInterfaceDeclaration(child)) {
                        const childName = child.name.text;
                        const { names: typeParamNames, defaults: typeParamDefaults } =
                            extractTypeParams(child, { source, depth: 0, nsImportAliases });
                        const nsCtx: Ctx = {
                            source,
                            depth: 0,
                            namespace: nsName,
                            nsSiblings,
                            typeParams: new Set(typeParamNames),
                            nsImportAliases,
                        };
                        const fields = extractInterfaceMembers(child.members, source, nsCtx);
                        const luauName = `${nsName}_${childName}`;
                        const decl: TypeDecl = {
                            name: luauName,
                            typeParams: typeParamNames,
                            typeParamDefaults,
                            body: { kind: "table", fields },
                        };

                        manifest.types[`${nsName}.${childName}`] = decl;
                        manifest.types[luauName] = decl;
                    }

                    // 2. Process Type Aliases inside namespaces
                    if (ts.isTypeAliasDeclaration(child)) {
                        const childName = child.name.text;
                        const { names: typeParamNames, defaults: typeParamDefaults } =
                            extractTypeParams(child, { source, depth: 0, nsImportAliases });
                        const nsCtx: Ctx = {
                            source,
                            depth: 0,
                            namespace: nsName,
                            nsSiblings,
                            typeParams: new Set(typeParamNames),
                            nsImportAliases,
                        };
                        const body = tsNodeToLuau(child.type, nsCtx);
                        const luauName = `${nsName}_${childName}`;
                        const decl: TypeDecl = {
                            name: luauName,
                            typeParams: typeParamNames,
                            typeParamDefaults,
                            body,
                        };

                        manifest.types[`${nsName}.${childName}`] = decl;
                        manifest.types[luauName] = decl;
                    }
                });
            }
        }
    });

    return manifest;
}
