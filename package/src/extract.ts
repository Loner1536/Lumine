/**
 * extract.ts
 *
 * Converts TypeScript .d.ts AST nodes directly into LuauType objects.
 * No intermediate string representation — every type is an AST node from
 * the moment it leaves the TypeScript compiler.
 */
import ts from "typescript";
import { readFileSync } from "fs";
import type { TypeManifest, ParamInfo, FunctionSignature, TypeDecl } from "./types";
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

    // ── Mapped type → any ─────────────────────────────────────────────────────
    if (node.kind === ts.SyntaxKind.MappedType) return LuauAny;

    // ── Template literal → string ─────────────────────────────────────────────
    if (node.kind === ts.SyntaxKind.TemplateLiteralType) return LuauString;

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
    if (ts.isIndexedAccessTypeNode(node)) return LuauAny;

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

    // User-defined type — convert namespace dots to underscores
    const luauName = name.replace(/\./g, "_");
    const args = rawArgs.map((a) => (a.kind === "void" ? LuauNil : a));
    return args.length ? mkRef(luauName, args) : mkRef(luauName);
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
    if (ts.isStringLiteral(literal))
        return { kind: "singleton_string", value: `"${literal.text}"` };
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

// ── Main export ───────────────────────────────────────────────────────────────

export function extractManifest(dtsPath: string): TypeManifest {
    const content = readFileSync(dtsPath, "utf-8");
    const source = ts.createSourceFile(dtsPath, content, ts.ScriptTarget.ESNext, true);
    const manifest: TypeManifest = { functions: {}, types: {} };

    ts.forEachChild(source, (node) => {
        const ctx: Ctx = { source, depth: 0 };

        // ── Function declarations ─────────────────────────────────────────────
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.text;
            const { names: typeParams } = extractTypeParams(node, ctx);
            const params: ParamInfo[] = Array.from(node.parameters).map((p) => {
                const isRest = !!p.dotDotDotToken;
                const pType = p.type ? tsNodeToLuau(p.type, ctx) : LuauAny;
                return {
                    name: p.name
                        .getText(source)
                        .replace(/^\.\.\./, "")
                        .trim(),
                    type: isRest ? extractArrayElement(pType) : pType,
                    optional: !!p.questionToken,
                    rest: isRest,
                };
            });
            const returnType = tsNodeToLuau(node.type, ctx);
            manifest.functions[name] = { name, params, returnType, typeParams };
        }

        // ── Interface declarations ────────────────────────────────────────────
        if (ts.isInterfaceDeclaration(node)) {
            const name = node.name.text;
            const { names: typeParams, defaults: typeParamDefaults } = extractTypeParams(node, ctx);
            const fields = extractInterfaceMembers(node.members, source, ctx);
            manifest.types[name] = { name, typeParams, typeParamDefaults, body: { kind: "table", fields } };
        }

        // ── Type alias declarations ───────────────────────────────────────────
        if (ts.isTypeAliasDeclaration(node)) {
            const name = node.name.text;
            const { names: typeParams, defaults: typeParamDefaults } = extractTypeParams(node, ctx);
            const body = tsNodeToLuau(node.type, ctx);
            manifest.types[name] = { name, typeParams, typeParamDefaults, body };
        }

        // ── Namespace declarations: namespace Net { interface Foo {} } ─────────
        if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
            const nsName = node.name.text;
            const body = node.body;
            if (body && ts.isModuleBlock(body)) {
                ts.forEachChild(body, (child) => {
                    if (ts.isInterfaceDeclaration(child)) {
                        const childName = child.name.text;
                        const nsCtx: Ctx = { source, depth: 0 };
                        const { names: typeParams, defaults: typeParamDefaults } = extractTypeParams(child, nsCtx);
                        const fields = extractInterfaceMembers(child.members, source, nsCtx);
                        const luauName = `${nsName}_${childName}`;
                        const decl: TypeDecl = { name: luauName, typeParams, typeParamDefaults, body: { kind: "table", fields } };
                        // Register under both keys so lookups work either way
                        manifest.types[`${nsName}.${childName}`] = decl;
                        manifest.types[luauName] = decl;
                    }
                });
            }
        }
    });

    return manifest;
}
