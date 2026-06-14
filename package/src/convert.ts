import { LUMINE_BUILTIN_NAMES } from "./builtins";

const PRIMITIVES = new Set([
    "number",
    "string",
    "boolean",
    "buffer",
    "void",
    "any",
    "never",
    "unknown",
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

function splitGenericArgs(inner: string): string[] {
    const args: string[] = [];
    let depth = 0,
        start = 0;
    for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (c === "<" || c === "(" || c === "{" || c === "[") depth++;
        else if (c === ">" || c === ")" || c === "}" || c === "]") depth--;
        else if (c === "," && depth === 0) {
            args.push(inner.slice(start, i).trim());
            start = i + 1;
        }
    }
    args.push(inner.slice(start).trim());
    return args;
}

function splitUnion(type: string): string[] {
    const parts: string[] = [];
    let depth = 0,
        start = 0;
    for (let i = 0; i < type.length; i++) {
        const c = type[i];
        if (c === "<" || c === "(" || c === "{" || c === "[") depth++;
        else if (c === ">" || c === ")" || c === "}" || c === "]") depth--;
        else if (c === "|" && depth === 0) {
            parts.push(type.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(type.slice(start).trim());
    return parts;
}

function splitIntersection(type: string): string[] {
    const parts: string[] = [];
    let depth = 0,
        start = 0;
    for (let i = 0; i < type.length; i++) {
        const c = type[i];
        if (c === "<" || c === "(" || c === "{" || c === "[") depth++;
        else if (c === ">" || c === ")" || c === "}" || c === "]") depth--;
        else if (c === "&" && depth === 0) {
            parts.push(type.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(type.slice(start).trim());
    return parts;
}

function parseFunctionType(tsType: string): { params: string; ret: string } | null {
    if (!tsType.startsWith("(")) return null;
    let depth = 0,
        closeIdx = -1;
    for (let i = 0; i < tsType.length; i++) {
        if (tsType[i] === "(") depth++;
        else if (tsType[i] === ")") {
            depth--;
            if (depth === 0) {
                closeIdx = i;
                break;
            }
        }
    }
    if (closeIdx === -1) return null;
    const rest = tsType.slice(closeIdx + 1).trimStart();
    if (!rest.startsWith("=>")) return null;
    return { params: tsType.slice(1, closeIdx), ret: rest.slice(2).trimStart() };
}

export function toUserTypeName(tsName: string): string {
    return tsName.replace(/\./g, "_");
}

// typeDefaults: typeName → array of default values for missing type args
// e.g. "Result" → [null, "string"] means Result<T> becomes Result<T, string>
export type TypeDefaultsMap = Map<string, (string | null)[]>;

export function convertType(
    tsType: string,
    knownTypes: Set<string> = new Set(),
    depth = 0,
    fb: Record<string, string> = {},
    typeAliases: Map<string, string> = new Map(),
    typeDefaults: TypeDefaultsMap = new Map(),
    // when true, void → nil instead of () (used inside generic args)
    voidAsNil = false,
): string {
    if (depth > 20) return "any";
    tsType = tsType.trim();

    if (typeAliases.has(tsType)) return typeAliases.get(tsType)!;

    if (tsType === "void") return voidAsNil ? "nil" : "()";
    if (tsType === "any" || tsType === "unknown") return "any";
    if (tsType === "never") return "never";
    if (tsType === "undefined" || tsType === "null") return "nil";
    if (PRIMITIVES.has(tsType)) return tsType;
    if (ROBLOX_TYPES.has(tsType)) return tsType;
    if (tsType in fb) return fb[tsType];
    if (/^-?\d+(\.\d+)?$/.test(tsType)) return "number";
    if (tsType.startsWith('"') || tsType.startsWith("'")) return tsType.replace(/'/g, '"');
    if (tsType === "true" || tsType === "false") return tsType;

    // Strip outer parens
    if (tsType.startsWith("(") && tsType.endsWith(")")) {
        const inner = tsType.slice(1, -1);
        let d = 0,
            valid = true;
        for (let i = 0; i < inner.length; i++) {
            if (inner[i] === "(") d++;
            else if (inner[i] === ")") {
                d--;
                if (d < 0) {
                    valid = false;
                    break;
                }
            }
        }
        if (valid && d === 0)
            return convertType(
                inner,
                knownTypes,
                depth + 1,
                fb,
                typeAliases,
                typeDefaults,
                voidAsNil,
            );
    }

    // LuaTuple<[T, U]> → (T, U)
    const luaTupleMatch = tsType.match(/^LuaTuple<\[(.+)\]>$/);
    if (luaTupleMatch) {
        const parts = splitGenericArgs(luaTupleMatch[1]).map((p) =>
            convertType(p.trim(), knownTypes, depth + 1, fb, typeAliases, typeDefaults, true),
        );
        return `(${parts.join(", ")})`;
    }

    // keyof T → keyof<T>
    if (tsType.startsWith("keyof ")) {
        return `keyof<${convertType(tsType.slice(6).trim(), knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}>`;
    }

    // Union
    const unionParts = splitUnion(tsType);
    if (unionParts.length > 1) {
        const withoutNil = unionParts.filter((p) => p !== "undefined" && p !== "null");
        const hasNil = withoutNil.length < unionParts.length;
        if (unionParts.every((p) => /^-?\d+(\.\d+)?$/.test(p.trim()))) return "number";
        if (withoutNil.length === 1) {
            return (
                convertType(
                    withoutNil[0],
                    knownTypes,
                    depth + 1,
                    fb,
                    typeAliases,
                    typeDefaults,
                    voidAsNil,
                ) + (hasNil ? "?" : "")
            );
        }
        const converted = withoutNil
            .map((p) =>
                convertType(p, knownTypes, depth + 1, fb, typeAliases, typeDefaults, voidAsNil),
            )
            .join(" | ");
        return hasNil ? `(${converted})?` : converted;
    }

    // Intersection
    const intersectionParts = splitIntersection(tsType);
    if (intersectionParts.length > 1) {
        return intersectionParts
            .map((p) =>
                convertType(p, knownTypes, depth + 1, fb, typeAliases, typeDefaults, voidAsNil),
            )
            .join(" & ");
    }

    const readonlyArrayMatch = tsType.match(/^ReadonlyArray<(.+)>$/);
    if (readonlyArrayMatch)
        return `{${convertType(readonlyArrayMatch[1], knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}}`;

    const arrayGeneric = tsType.match(/^Array<(.+)>$/);
    if (arrayGeneric)
        return `{${convertType(arrayGeneric[1], knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}}`;

    if (tsType.endsWith("[]"))
        return `{${convertType(tsType.slice(0, -2), knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}}`;

    const mapMatch = tsType.match(/^(?:Readonly)?Map<(.+)>$/);
    if (mapMatch) {
        const [k, v] = splitGenericArgs(mapMatch[1]);
        return `{[${convertType(k, knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}]: ${convertType(v, knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}}`;
    }

    const recordMatch = tsType.match(/^Record<(.+)>$/);
    if (recordMatch) {
        const [k, v] = splitGenericArgs(recordMatch[1]);
        return `{[${convertType(k, knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}]: ${convertType(v, knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}}`;
    }

    const setMatch = tsType.match(/^(?:Readonly)?Set<(.+)>$/);
    if (setMatch)
        return `{[${convertType(setMatch[1], knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}]: boolean}`;

    const readonlyMatch = tsType.match(/^Readonly<(.+)>$/);
    if (readonlyMatch)
        return convertType(
            readonlyMatch[1],
            knownTypes,
            depth + 1,
            fb,
            typeAliases,
            typeDefaults,
            voidAsNil,
        );

    const nonNullableMatch = tsType.match(/^NonNullable<(.+)>$/);
    if (nonNullableMatch) {
        const inner = convertType(
            nonNullableMatch[1],
            knownTypes,
            depth + 1,
            fb,
            typeAliases,
            typeDefaults,
            voidAsNil,
        );
        return inner.endsWith("?") ? inner.slice(0, -1) : inner;
    }

    const utilityMatch = tsType.match(/^(\w+)<(.+)>$/);
    if (utilityMatch && UNSUPPORTED_UTILITY.has(utilityMatch[1])) return "any";

    // Tuple [T, U, V] → {T | U | V}
    if (tsType.startsWith("[") && tsType.endsWith("]")) {
        const inner = tsType.slice(1, -1);
        const parts = splitGenericArgs(inner).map((p) =>
            convertType(
                p.replace(/^\w+\??\s*:\s*/, "").trim(),
                knownTypes,
                depth + 1,
                fb,
                typeAliases,
                typeDefaults,
                true,
            ),
        );
        return `{${parts.join(" | ")}}`;
    }

    // Function type
    const fnParts = parseFunctionType(tsType);
    if (fnParts) {
        const rawParams = fnParts.params.trim();
        const rawReturn = fnParts.ret.trim();
        const luauReturn =
            rawReturn === "void"
                ? "()"
                : convertType(
                    rawReturn,
                    knownTypes,
                    depth + 1,
                    fb,
                    typeAliases,
                    typeDefaults,
                    true,
                );
        if (!rawParams) return `() -> ${luauReturn}`;
        const params = splitGenericArgs(rawParams).map((p) => {
            const trimmed = p.trim();
            const isRest = trimmed.startsWith("...");
            const clean = trimmed.replace(/^\.\.\./, "");
            const colonIdx = clean.indexOf(":");
            if (colonIdx === -1)
                return convertType(
                    clean,
                    knownTypes,
                    depth + 1,
                    fb,
                    typeAliases,
                    typeDefaults,
                    true,
                );
            const pName = clean.slice(0, colonIdx).replace(/\?$/, "").trim();
            const pType = clean.slice(colonIdx + 1).trim();
            const isOpt = clean.slice(0, colonIdx).endsWith("?");
            const converted = isRest
                ? `...${convertType(pType.replace(/\[\]$/, ""), knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}`
                : convertType(pType, knownTypes, depth + 1, fb, typeAliases, typeDefaults, true) +
                (isOpt ? "?" : "");
            return `${pName}: ${converted}`;
        });
        return `(${params.join(", ")}) -> ${luauReturn}`;
    }

    // Inline object literal
    if (tsType.startsWith("{") && tsType.endsWith("}")) {
        const inner = tsType.slice(1, -1).trim();
        if (!inner) return "{}";
        const members = inner
            .split(/;\s*|\n\s*/)
            .filter(Boolean)
            .map((member) => {
                member = member.trim();
                const indexSigMatch = member.match(/^\[\w+\s*:\s*(\w[\w\d_]*)\s*\]\s*:\s*(.+)$/);
                if (indexSigMatch) {
                    return `[${convertType(indexSigMatch[1].trim(), knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}]: ${convertType(indexSigMatch[2].trim(), knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}`;
                }
                const colonIdx = member.indexOf(":");
                if (colonIdx === -1) return member;
                return `${member.slice(0, colonIdx).trim()}: ${convertType(member.slice(colonIdx + 1).trim(), knownTypes, depth + 1, fb, typeAliases, typeDefaults, true)}`;
            });
        return `{ ${members.join(", ")} }`;
    }

    // Generic: SomeType<T> or Namespace.Type<T>
    const genericMatch = tsType.match(/^([\w.]+)<(.+)>$/);
    if (genericMatch) {
        const baseName = genericMatch[1];
        const luauBaseName = toUserTypeName(baseName);
        const rawArgs = splitGenericArgs(genericMatch[2]);
        const convertedArgs = rawArgs.map((a) =>
            convertType(a, knownTypes, depth + 1, fb, typeAliases, typeDefaults, true),
        );

        // Fill in missing args using defaults
        const defaults = typeDefaults.get(baseName) ?? typeDefaults.get(luauBaseName) ?? [];
        const fullArgs = [...convertedArgs];
        for (let i = convertedArgs.length; i < defaults.length; i++) {
            const def = defaults[i];
            if (def !== null) {
                fullArgs.push(
                    convertType(def, knownTypes, depth + 1, fb, typeAliases, typeDefaults, true),
                );
            }
        }

        if (LUMINE_BUILTIN_NAMES.has(baseName))
            return `_Lumine.${baseName}<${fullArgs.join(", ")}>`;
        if (baseName in fb) return fb[baseName];
        if (typeAliases.has(baseName))
            return `${typeAliases.get(baseName)}<${fullArgs.join(", ")}>`;
        if (typeAliases.has(luauBaseName))
            return `${typeAliases.get(luauBaseName)}<${fullArgs.join(", ")}>`;
        if (knownTypes.has(baseName) || knownTypes.has(luauBaseName))
            return `${luauBaseName}<${fullArgs.join(", ")}>`;
        return `${luauBaseName}<${fullArgs.join(", ")}>`;
    }

    // Namespace.Type (no generics)
    if (tsType.includes(".")) {
        if (typeAliases.has(tsType)) return typeAliases.get(tsType)!;
        const luauName = toUserTypeName(tsType);
        if (typeAliases.has(luauName)) return typeAliases.get(luauName)!;
        return luauName;
    }

    if (LUMINE_BUILTIN_NAMES.has(tsType)) return `_Lumine.${tsType}`;
    if (knownTypes.has(tsType)) return tsType;
    if (typeAliases.has(tsType)) return typeAliases.get(tsType)!;

    return tsType;
}

export function convertParam(
    name: string,
    tsType: string,
    optional: boolean,
    rest: boolean,
    knownTypes: Set<string>,
    fb: Record<string, string> = {},
    typeAliases: Map<string, string> = new Map(),
    typeDefaults: TypeDefaultsMap = new Map(),
): string {
    let luauType: string;
    if (rest) {
        const arrayGeneric = tsType.match(/^Array<(.+)>$/);
        if (arrayGeneric) {
            luauType = `{${convertType(arrayGeneric[1], knownTypes, 0, fb, typeAliases, typeDefaults, true)}}`;
        } else if (tsType.endsWith("[]")) {
            luauType = `{${convertType(tsType.slice(0, -2), knownTypes, 0, fb, typeAliases, typeDefaults, true)}}`;
        } else {
            luauType = `{${convertType(tsType, knownTypes, 0, fb, typeAliases, typeDefaults, true)}}`;
        }
        return `...: ${luauType}`;
    }
    luauType = convertType(tsType, knownTypes, 0, fb, typeAliases, typeDefaults, false);
    if (optional && !luauType.endsWith("?")) luauType += "?";
    return `${name}: ${luauType}`;
}

export function convertReturn(
    tsType: string,
    knownTypes: Set<string>,
    fb: Record<string, string> = {},
    typeAliases: Map<string, string> = new Map(),
    typeDefaults: TypeDefaultsMap = new Map(),
): string {
    if (tsType === "void") return "";
    return `: ${convertType(tsType, knownTypes, 0, fb, typeAliases, typeDefaults, false)}`;
}
