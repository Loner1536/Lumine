// Converts TypeScript type strings (from checker.typeToString()) to Luau type syntax.
// Input is always a resolved type string, not raw source text.

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
    "RbxScriptSignal",
    "RbxScriptConnection",
]);

// Depth-limited tokenizer for balanced angle brackets and parentheses
function splitGenericArgs(inner: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (c === "<" || c === "(" || c === "{") depth++;
        else if (c === ">" || c === ")" || c === "}") depth--;
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
    let depth = 0;
    let start = 0;
    for (let i = 0; i < type.length; i++) {
        const c = type[i];
        if (c === "<" || c === "(" || c === "{") depth++;
        else if (c === ">" || c === ")" || c === "}") depth--;
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
    let depth = 0;
    let start = 0;
    for (let i = 0; i < type.length; i++) {
        const c = type[i];
        if (c === "<" || c === "(" || c === "{") depth++;
        else if (c === ">" || c === ")" || c === "}") depth--;
        else if (c === "&" && depth === 0) {
            parts.push(type.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(type.slice(start).trim());
    return parts;
}

export function toUserTypeName(tsName: string): string {
    // Namespace.Type → Namespace_Type
    return tsName.replace(/\./g, "_");
}

export function isUserDefinedType(tsType: string, knownTypes: Set<string>): boolean {
    const base = tsType.replace(/<.*>/, "").trim();
    return knownTypes.has(base);
}

export function convertType(
    tsType: string,
    knownTypes: Set<string> = new Set(),
    depth = 0,
): string {
    if (depth > 20) return "any"; // guard against infinite recursion

    tsType = tsType.trim();

    // void → ()
    if (tsType === "void") return "()";

    // any / unknown / never
    if (tsType === "any" || tsType === "unknown") return "any";
    if (tsType === "never") return "never";

    // Primitives and Roblox types pass through
    if (PRIMITIVES.has(tsType) || ROBLOX_TYPES.has(tsType)) return tsType;

    // undefined / null → handled as optionals at param level, bare → nil
    if (tsType === "undefined" || tsType === "null") return "nil";

    // Strip outer parens
    if (tsType.startsWith("(") && tsType.endsWith(")")) {
        return convertType(tsType.slice(1, -1), knownTypes, depth + 1);
    }

    // T | undefined → T?  /  T | null → T?
    const unionParts = splitUnion(tsType);
    if (unionParts.length > 1) {
        const withoutNil = unionParts.filter((p) => p !== "undefined" && p !== "null");
        const hasNil = withoutNil.length < unionParts.length;
        if (withoutNil.length === 1) {
            return convertType(withoutNil[0], knownTypes, depth + 1) + (hasNil ? "?" : "");
        }
        const converted = withoutNil.map((p) => convertType(p, knownTypes, depth + 1)).join(" | ");
        return hasNil ? `(${converted})?` : converted;
    }

    // A & B intersection
    const intersectionParts = splitIntersection(tsType);
    if (intersectionParts.length > 1) {
        return intersectionParts.map((p) => convertType(p, knownTypes, depth + 1)).join(" & ");
    }

    // Array<T> or T[]
    const arrayGeneric = tsType.match(/^Array<(.+)>$/);
    if (arrayGeneric) return `{${convertType(arrayGeneric[1], knownTypes, depth + 1)}}`;
    if (tsType.endsWith("[]"))
        return `{${convertType(tsType.slice(0, -2), knownTypes, depth + 1)}}`;

    // ReadonlyArray<T>
    const readonlyArray = tsType.match(/^ReadonlyArray<(.+)>$/);
    if (readonlyArray) return `{${convertType(readonlyArray[1], knownTypes, depth + 1)}}`;

    // Map<K, V> or ReadonlyMap<K, V>
    const mapMatch = tsType.match(/^(?:Readonly)?Map<(.+)>$/);
    if (mapMatch) {
        const [k, v] = splitGenericArgs(mapMatch[1]);
        return `{[${convertType(k, knownTypes, depth + 1)}]: ${convertType(v, knownTypes, depth + 1)}}`;
    }

    // Record<K, V>
    const recordMatch = tsType.match(/^Record<(.+)>$/);
    if (recordMatch) {
        const [k, v] = splitGenericArgs(recordMatch[1]);
        return `{[${convertType(k, knownTypes, depth + 1)}]: ${convertType(v, knownTypes, depth + 1)}}`;
    }

    // Set<T>
    const setMatch = tsType.match(/^(?:Readonly)?Set<(.+)>$/);
    if (setMatch) return `{[${convertType(setMatch[1], knownTypes, depth + 1)}]: boolean}`;

    // Tuple [T, U, ...]
    if (tsType.startsWith("[") && tsType.endsWith("]")) {
        const inner = tsType.slice(1, -1);
        const parts = splitGenericArgs(inner).map((p) =>
            convertType(p.replace(/^\w+:\s*/, ""), knownTypes, depth + 1),
        );
        return `{${parts.join(" | ")}}`;
    }

    // Function type: (a: A, b: B) => C
    const fnMatch = tsType.match(/^\(([^)]*)\)\s*=>\s*(.+)$/);
    if (fnMatch) {
        const rawParams = fnMatch[1].trim();
        const rawReturn = fnMatch[2].trim();
        const luauReturn =
            rawReturn === "void" ? "()" : convertType(rawReturn, knownTypes, depth + 1);

        if (!rawParams) return `() -> ${luauReturn}`;

        const params = rawParams.split(",").map((p) => {
            const trimmed = p.trim();
            const colonIdx = trimmed.indexOf(":");
            if (colonIdx === -1) return convertType(trimmed, knownTypes, depth + 1);
            const paramName = trimmed
                .slice(0, colonIdx)
                .trim()
                .replace(/^\.\.\.|[?]$/g, "");
            const paramType = convertType(
                trimmed.slice(colonIdx + 1).trim(),
                knownTypes,
                depth + 1,
            );
            return `${paramName}: ${paramType}`;
        });

        return `(${params.join(", ")}) -> ${luauReturn}`;
    }

    // Generic: Namespace.Type<T> or Type<T>
    const genericMatch = tsType.match(/^([\w.]+)<(.+)>$/);
    if (genericMatch) {
        const base = toUserTypeName(genericMatch[1]);
        const args = splitGenericArgs(genericMatch[2]).map((a) =>
            convertType(a, knownTypes, depth + 1),
        );
        const prefix = knownTypes.has(genericMatch[1]) ? "__luauAnnotateTypes." : "";
        return `${prefix}${base}<${args.join(", ")}>`;
    }

    // Namespace.Type (no generics)
    if (tsType.includes(".")) {
        const luauName = toUserTypeName(tsType);
        if (knownTypes.has(tsType)) return `__luauAnnotateTypes.${luauName}`;
        return luauName;
    }

    // User-defined type
    if (knownTypes.has(tsType)) {
        return `__luauAnnotateTypes.${tsType}`;
    }

    // Inline object literal: { key: Type; key2: Type2 } → { key: Type, key2: Type2 }
    if (tsType.startsWith("{") && tsType.endsWith("}")) {
        const inner = tsType.slice(1, -1).trim();
        // Convert TS semicolon-separated members to Luau comma-separated
        const converted = inner
            .split(/;\s*/)
            .filter(Boolean)
            .map((member) => {
                const colonIdx = member.indexOf(":");
                if (colonIdx === -1) return member;
                const key = member.slice(0, colonIdx).trim();
                const val = convertType(member.slice(colonIdx + 1).trim(), knownTypes, depth + 1);
                return `${key}: ${val}`;
            })
            .join(", ");
        return `{ ${converted} }`;
    }

    // Fallback — pass through as-is
    return tsType;
}

export function convertParam(
    name: string,
    tsType: string,
    optional: boolean,
    rest: boolean,
    knownTypes: Set<string>,
): string {
    let luauType: string;
    if (rest) {
        // Strip outer Array<> or [] wrapper — rest params are already a collection
        const arrayGeneric = tsType.match(/^Array<(.+)>$/);
        if (arrayGeneric) {
            luauType = `{${convertType(arrayGeneric[1], knownTypes)}}`;
        } else if (tsType.endsWith("[]")) {
            luauType = `{${convertType(tsType.slice(0, -2), knownTypes)}}`;
        } else {
            luauType = `{${convertType(tsType, knownTypes)}}`;
        }
    } else {
        luauType = convertType(tsType, knownTypes);
        if (optional && !luauType.endsWith("?")) luauType += "?";
    }
    return `${name}: ${luauType}`;
}

export function convertReturn(tsType: string, knownTypes: Set<string>): string {
    if (tsType === "void") return "";
    return `: ${convertType(tsType, knownTypes)}`;
}
