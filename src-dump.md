### package/src/annotate.ts
```ts
import { resolve } from "path";
import { randomUUID } from "crypto";
import type { TypeManifest, AnnotationResult } from "./types";
import { convertParam, convertReturn, type TypeDefaultsMap } from "./convert";
import { generateInlineTypeDecls } from "./emit";
import { resolveRojoPath, buildDirectRequire } from "./rojo";

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildKnownTypes(manifest: TypeManifest): Set<string> {
    const excluded = new Set(Object.keys(manifest.fallbackTypes));
    return new Set(Object.keys(manifest.types).filter((k) => !excluded.has(k)));
}

function buildTypeDefaults(manifest: TypeManifest): TypeDefaultsMap {
    const map: TypeDefaultsMap = new Map();
    for (const [key, decl] of Object.entries(manifest.types)) {
        if (decl.typeParamDefaults && decl.typeParamDefaults.some((d) => d !== null)) {
            map.set(key, decl.typeParamDefaults);
            map.set(decl.name, decl.typeParamDefaults);
        }
    }
    return map;
}

function buildLumineRequire(rojoProject: string, lumineFilePath: string, cwd: string): string {
    const resolution = resolveRojoPath(rojoProject, lumineFilePath, cwd);
    if (resolution) return `local _Lumine = ${buildDirectRequire(resolution)}`;
    return `local _Lumine = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("Lumine"))`;
}

function buildModuleRequire(rojoProject: string, sourceLuauPath: string, cwd: string): string {
    const resolution = resolveRojoPath(rojoProject, sourceLuauPath, cwd);
    if (resolution) return buildDirectRequire(resolution);
    return `require(script.Parent["${sourceLuauPath
            .split("/")
            .pop()
            ?.replace(/\.luau$/, "") ?? "Unknown"
        }"])`;
}

function findClosingParen(src: string, openIdx: number): number {
    let parenDepth = 0,
        braceDepth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === "{") braceDepth++;
        else if (c === "}") braceDepth--;
        else if (braceDepth === 0) {
            if (c === "(") parenDepth++;
            else if (c === ")") {
                parenDepth--;
                if (parenDepth === 0) return i;
            }
        }
    }
    return -1;
}

function findClosingAngle(src: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === "<") depth++;
        else if (src[i] === ">") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function findSignatureEnd(src: string, closeParen: number): number {
    let i = closeParen + 1;
    while (i < src.length && src[i] === " ") i++;
    if (i >= src.length || src[i] !== ":") return closeParen + 1;
    i++;
    while (i < src.length && src[i] === " ") i++;
    let depth = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === "\n" && depth === 0) break;
        i++;
    }
    return i;
}

function findFunctionSignature(src: string, fnName: string) {
    const esc = escapeRegExp(fnName);
    const re = new RegExp(`^([ \t]*)(?:local function ${esc}|local ${esc}\\s*=\\s*function)`, "m");
    const m = re.exec(src);
    if (!m) return null;
    const lineStart = m.index;
    const headerEnd = m.index + m[0].length;
    let i = headerEnd;
    if (src[i] === "<") {
        const c = findClosingAngle(src, i);
        if (c === -1) return null;
        i = c + 1;
    }
    if (src[i] !== "(") return null;
    const openParen = i;
    const closeParen = findClosingParen(src, openParen);
    if (closeParen === -1) return null;
    return {
        lineStart,
        headerEnd,
        openParen,
        closeParen,
        sigEnd: findSignatureEnd(src, closeParen),
    };
}

function splitParams(paramStr: string): string[] {
    if (!paramStr.trim()) return [];
    const parts: string[] = [];
    let depth = 0,
        start = 0;
    for (let i = 0; i < paramStr.length; i++) {
        const c = paramStr[i];
        if (c === "(" || c === "<" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === ">" && (i === 0 || paramStr[i - 1] !== "-")) depth--;
        else if (c === "," && depth === 0) {
            parts.push(paramStr.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(paramStr.slice(start).trim());
    return parts.filter(Boolean);
}

function bareParamName(p: string): string {
    if (p === "...") return "...";
    const isRest = p.startsWith("...");
    const stripped = isRest ? p.slice(3) : p;
    const colonIdx = stripped.indexOf(":");
    const name = (colonIdx === -1 ? stripped : stripped.slice(0, colonIdx)).trim();
    return isRest ? `...${name}` : name;
}

// Collect all type names referenced in signatures — both plain (Player) and namespace (Net.Channel → Net_Channel)
function collectReferencedTypeNames(manifest: TypeManifest): Set<string> {
    const refs = new Set<string>();
    const scan = (s: string) => {
        // Plain PascalCase identifiers
        for (const m of s.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) refs.add(m[1]);
        // Namespace.Type patterns → add as underscore form
        for (const m of s.matchAll(/\b([A-Z][A-Za-z0-9]*)\.([A-Z][A-Za-z0-9]*)\b/g)) {
            refs.add(`${m[1]}_${m[2]}`);
        }
    };
    for (const sig of Object.values(manifest.functions)) {
        for (const p of sig.params) scan(p.type);
        scan(sig.returnType);
    }
    return refs;
}

/**
 * Inject a block after the roblox-ts banner + all its leading requires
 * (local TS = require(...), local Packages = require(...), etc.), so the
 * lumine block lands right before the first non-require line of the file.
 * Falls back to prepend if no banner is found.
 */
function injectAtTop(result: string, block: string): string {
    // Find the end of the roblox-ts header region:
    //   -- Compiled with roblox-ts ...
    //   local X = require(...)   ← one or more of these
    //   <blank lines>
    // We want to insert AFTER all of that.
    const bannerMatch = /^-- Compiled with roblox-ts[^\n]*\n/m.exec(result);
    if (bannerMatch) {
        // Walk forward from end of banner, consuming `local X = require(...)` lines
        // and blank lines that roblox-ts emits before the actual code.
        let pos = bannerMatch.index + bannerMatch[0].length;
        const requireLineRe =
            /^local [A-Za-z_][A-Za-z0-9_]* = require\([^)]*(?:\([^)]*\)[^)]*)*\)\s*\n/;
        const blankLineRe = /^\s*\n/;
        while (pos < result.length) {
            const slice = result.slice(pos);
            const req = requireLineRe.exec(slice);
            if (req && req.index === 0) {
                pos += req[0].length;
                continue;
            }
            const blank = blankLineRe.exec(slice);
            if (blank && blank.index === 0) {
                pos += blank[0].length;
                continue;
            }
            break;
        }
        return result.slice(0, pos) + block + "\n" + result.slice(pos);
    }

    if (/((?:--!.*\n)+)/.test(result)) {
        return result.replace(/((?:--!.*\n)+)/, `$1${block}\n`);
    }
    if (/^local function /m.test(result)) {
        return result.replace(/^(local function )/m, `${block}\n$1`);
    }
    if (/^return /m.test(result)) {
        return result.replace(/^(return )/m, `${block}\n$1`);
    }
    return `${block}\n${result}`;
}

export function annotateFile(
    source: string,
    filePath: string,
    manifest: TypeManifest,
    rojoProject: string,
    lumineFilePath: string,
    cwd: string,
    globalTypeOrigins: Map<string, string> = new Map(),
    globalTypeDefaults: TypeDefaultsMap = new Map(),
): AnnotationResult & { source: string } {
    const knownTypes = buildKnownTypes(manifest);
    // Merge: local file's own defaults take precedence over global ones
    const localDefaults = buildTypeDefaults(manifest);
    const typeDefaults: TypeDefaultsMap = new Map([...globalTypeDefaults, ...localDefaults]);
    let annotated = 0;
    let skipped = 0;
    let usesBuiltins = false;
    let result = source;

    const filePathAbs = resolve(filePath);
    const ownTypeNames = new Set(Object.keys(manifest.types));
    const referenced = collectReferencedTypeNames(manifest);

    // UUID-suffixed local vars so re-runs and multi-file runs never collide.
    // e.g. _Types_a3f2b1c4 instead of _Types / _Types2 / _Types3
    const requireGroups = new Map<string, { localVar: string; typeNames: string[] }>();
    const typeAliases = new Map<string, string>();

    for (const name of referenced) {
        if (ownTypeNames.has(name)) continue;

        const origin = globalTypeOrigins.get(name);
        if (!origin || resolve(origin) === filePathAbs) continue;

        let group = requireGroups.get(origin);
        if (!group) {
            const uid = randomUUID().replace(/-/g, "").slice(0, 8);
            group = { localVar: `_Types_${uid}`, typeNames: [] };
            requireGroups.set(origin, group);
        }
        if (!group.typeNames.includes(name)) group.typeNames.push(name);
        typeAliases.set(name, `${group.localVar}.${name}`);
    }

    // ── Annotate function signatures ──────────────────────────────────────────
    for (const [fnName, sig] of Object.entries(manifest.functions)) {
        const loc = findFunctionSignature(result, fnName);
        if (!loc) {
            skipped++;
            continue;
        }

        const { lineStart, headerEnd, openParen, closeParen, sigEnd } = loc;
        const rawParams = splitParams(result.slice(openParen + 1, closeParen));
        const paramNames = rawParams.map(bareParamName);

        if (paramNames.length !== sig.params.length) {
            skipped++;
            continue;
        }

        const annotatedParams = sig.params.map((param, i) => {
            const rawName = paramNames[i] ?? param.name;
            const isRest = rawName.startsWith("...");
            const cleanName = rawName.replace(/^\.\.\./, "") || param.name;
            const luauParam = convertParam(
                cleanName,
                param.type,
                param.optional,
                param.rest || isRest,
                knownTypes,
                manifest.fallbackTypes,
                typeAliases,
                typeDefaults,
            );
            if (luauParam.includes("_Lumine.")) usesBuiltins = true;
            return luauParam;
        });

        const returnAnnotation = convertReturn(
            sig.returnType,
            knownTypes,
            manifest.fallbackTypes,
            typeAliases,
            typeDefaults,
        );
        if (returnAnnotation.includes("_Lumine.")) usesBuiltins = true;

        const typeParamStr = sig.typeParams.length ? `<${sig.typeParams.join(", ")}>` : "";
        let headerBase = result.slice(lineStart, headerEnd).trimEnd();
        if (headerBase.endsWith(">")) {
            const lastOpen = headerBase.lastIndexOf("<");
            if (lastOpen !== -1) headerBase = headerBase.slice(0, lastOpen).trimEnd();
        }

        result =
            result.slice(0, lineStart) +
            `${headerBase}${typeParamStr}(${annotatedParams.join(", ")})${returnAnnotation}` +
            result.slice(sigEnd);
        annotated++;
    }

    // ── Inject [lumine types] block ───────────────────────────────────────────
    // Everything goes here in one place, right after the roblox-ts banner:
    //   1. _Lumine require (always first, if needed)
    //   2. _Types_<uuid> requires (one per cross-file source)
    //   3. own inline type declarations
    //
    // The sentinel guards against double-injection on re-runs.
    const INLINE_SENTINEL = "-- [lumine types]";
    if (!result.includes(INLINE_SENTINEL)) {
        const ownDecls = generateInlineTypeDecls(manifest);
        const needsLumine = usesBuiltins && !result.includes("local _Lumine =");
        const hasAnything = needsLumine || requireGroups.size > 0 || ownDecls.length > 0;

        if (hasAnything) {
            const lines: string[] = [INLINE_SENTINEL];

            // ── 1. _Lumine ────────────────────────────────────────────────────
            if (needsLumine) {
                // roblox-ts may already have emitted `local Lumine = require(...)` on one line.
                // Use [^\n]+ to match the full line regardless of nested parens.
                const existingLumine = result.match(/^(local Lumine = [^\n]+)/m);
                if (existingLumine) {
                    // Alias the existing var — no second require needed
                    lines.push(`local _Lumine = Lumine`);
                } else {
                    lines.push(buildLumineRequire(rojoProject, lumineFilePath, cwd));
                }
            }

            // ── 2. _Types_<uuid> requires ─────────────────────────────────────
            for (const [sourcePath, group] of requireGroups) {
                lines.push(
                    `local ${group.localVar} = ${buildModuleRequire(rojoProject, sourcePath, cwd)}`,
                );
            }

            // Blank line separating requires from type decls
            if (needsLumine || requireGroups.size > 0) lines.push("");

            // ── 3. Own inline type declarations ───────────────────────────────
            if (ownDecls.length > 0) {
                lines.push(ownDecls);
                lines.push("");
            }

            const block = lines.join("\n");
            result = injectAtTop(result, block);
            annotated++;
        }
    } else if (usesBuiltins && !result.includes("local _Lumine =")) {
        // Sentinel already present (re-run) but _Lumine somehow missing — patch it in.
        const existingLumine = result.match(/^(local Lumine = [^\n]+)/m);
        const lumineeLine = existingLumine
            ? `local _Lumine = Lumine`
            : buildLumineRequire(rojoProject, lumineFilePath, cwd);
        result = result.replace(INLINE_SENTINEL, `${INLINE_SENTINEL}\n${lumineeLine}`);
    }

    return { filePath, annotated, skipped, usesBuiltins, source: result };
}
```

### package/src/builtins.ts
```ts
// Names of TypeScript utility types that lumine implements as Luau type functions.
// These get the lumine. prefix and are emitted in generated.types.luau.
export const LUMINE_BUILTIN_NAMES = new Set([
    "Partial",
    "Required",
    "Unpack",
    "ReturnType",
    "Pick",
    "Omit",
    "Parameters",
    "Promise", // roblox-ts Promise -- typed structural definition emitted in generated.types.luau
]);

// Luau type function implementations emitted at the top of generated.types.luau
export const LUMINE_BUILTIN_FUNCTIONS = `-- [lumine] utility type functions

-- Partial<T>: make all table properties optional
export type function Partial(T)
    if not T:is("table") then return T end
    local result = types.newtable(nil)
    for key, prop in T:properties() do
        if prop.read then
            result:setreadproperty(key, types.optional(prop.read))
        end
        if prop.write then
            result:setwriteproperty(key, types.optional(prop.write))
        end
    end
    return result
end

-- Required<T>: remove nil/optional from all table properties
export type function Required(T)
    if not T:is("table") then return T end
    local result = types.newtable(nil)
    for key, prop in T:properties() do
        local function stripNil(ty)
            if not ty then return nil end
            if not ty:is("union") then return ty end
            local keep = {}
            for _, component in ty:components() do
                if not component:is("nil") then
                    table.insert(keep, component)
                end
            end
            if #keep == 0 then return types.never end
            if #keep == 1 then return keep[1] end
            return types.unionof(table.unpack(keep))
        end
        local r = stripNil(prop.read)
        local w = stripNil(prop.write)
        if r then result:setreadproperty(key, r) end
        if w then result:setwriteproperty(key, w) end
    end
    return result
end

-- Unpack<T>: extract element type from an array table (handles union of tables)
export type function Unpack(T)
    if T:is("union") then
        local results = {}
        for _, component in T:components() do
            if component:is("table") then
                local idx = component:indexer()
                if idx then table.insert(results, idx.readresult) end
            end
        end
        if #results == 0 then return types.never end
        if #results == 1 then return results[1] end
        return types.unionof(table.unpack(results))
    end
    if not T:is("table") then return types.never end
    local indexer = T:indexer()
    if indexer then return indexer.readresult end
    return types.never
end

-- ReturnType<T>: extract the return type of a function
export type function ReturnType(T)
    if not T:is("function") then return types.never end
    local returns = T:returns()
    if returns.head and #returns.head > 0 then
        if #returns.head == 1 then return returns.head[1] end
        -- Multiple returns: union them (intersection of unrelated types = never)
        return types.unionof(table.unpack(returns.head))
    end
    if returns.tail then return returns.tail end
    return types.never
end

-- Parameters<T>: extract the parameters of a function as a table type
export type function Parameters(T)
    if not T:is("function") then return types.never end
    local params = T:parameters()
    local result = types.newtable(nil)
    result:setindexer(types.number, types.unknown)
    if params.head then
        for i, param in params.head do
            result:setproperty(types.singleton(i), param)
        end
    end
    return result
end

-- Pick<T, K>: keep only properties whose key is in the union K
export type function Pick(T, K)
    if not T:is("table") then return types.never end
    local result = types.newtable(nil)
    -- Collect allowed keys from K (may be a singleton or union of singletons)
    local allowed = {}
    if K:is("union") then
        for _, component in K:components() do
            if component:is("singleton") then
                allowed[component:value()] = true
            end
        end
    elseif K:is("singleton") then
        allowed[K:value()] = true
    end
    for key, prop in T:properties() do
        if key:is("singleton") and allowed[key:value()] then
            if prop.read then result:setreadproperty(key, prop.read) end
            if prop.write then result:setwriteproperty(key, prop.write) end
        end
    end
    return result
end

-- Omit<T, K>: keep all properties except those whose key is in K
export type function Omit(T, K)
    if not T:is("table") then return types.never end
    local result = types.newtable(nil)
    -- Collect excluded keys from K
    local excluded = {}
    if K:is("union") then
        for _, component in K:components() do
            if component:is("singleton") then
                excluded[component:value()] = true
            end
        end
    elseif K:is("singleton") then
        excluded[K:value()] = true
    end
    for key, prop in T:properties() do
        if not (key:is("singleton") and excluded[key:value()]) then
            if prop.read then result:setreadproperty(key, prop.read) end
            if prop.write then result:setwriteproperty(key, prop.write) end
        end
    end
    return result
end

-- Promise: structural type for the roblox-ts / evaera Promise runtime.
-- andThen/catch/etc return Promise<any> because Luau table types do not support
-- per-method generic parameters; callers that need exact types can cast locally.

export type PromiseStatus = "Started" | "Resolved" | "Rejected" | "Cancelled"

export type Promise<T> = {
    -- Chaining
    andThen: (self: Promise<T>, successHandler: (value: T) -> any, failureHandler: ((reason: any) -> any)?) -> Promise<any>,
    catch: (self: Promise<T>, failureHandler: (reason: any) -> any) -> Promise<any>,
    tap: (self: Promise<T>, tapHandler: (value: T) -> any) -> Promise<T>,
    tapCatch: (self: Promise<T>, tapHandler: (reason: any) -> any) -> Promise<T>,
    finally: (self: Promise<T>, finallyHandler: ((status: PromiseStatus) -> any)?) -> Promise<T>,
    andThenCall: (self: Promise<T>, callback: (...any) -> any, ...any) -> Promise<any>,
    andThenReturn: (self: Promise<T>, ...any) -> Promise<any>,
    finallyCall: (self: Promise<T>, callback: (...any) -> any, ...any) -> Promise<any>,
    finallyReturn: (self: Promise<T>, ...any) -> Promise<any>,
    -- Timing
    now: (self: Promise<T>, rejectionValue: any?) -> Promise<T>,
    timeout: (self: Promise<T>, seconds: number, rejectionValue: any?) -> Promise<T>,
    -- Yielding (these yield the current thread)
    await: (self: Promise<T>) -> (boolean, T),
    awaitStatus: (self: Promise<T>) -> (PromiseStatus, T),
    expect: (self: Promise<T>) -> T,
    -- Control
    cancel: (self: Promise<T>) -> (),
    -- Status queries
    getStatus: (self: Promise<T>) -> PromiseStatus,
    isPending: (self: Promise<T>) -> boolean,
    isResolved: (self: Promise<T>) -> boolean,
    isRejected: (self: Promise<T>) -> boolean,
    isCancelled: (self: Promise<T>) -> boolean,
}
`;
```

### package/src/config.ts
```ts
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type { LumineConfig } from "./types";

interface TsConfig {
    compilerOptions?: {
        outDir?: string;
        rootDir?: string;
        declaration?: boolean;
    };
}

interface LumineToml {
    includeDir?: string;
}

function parseTsConfig(cwd: string): TsConfig {
    const path = join(cwd, "tsconfig.json");
    if (!existsSync(path)) {
        console.error("[lumine] error: tsconfig.json not found");
        process.exit(1);
    }
    const raw = readFileSync(path, "utf-8");
    const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return JSON.parse(stripped) as TsConfig;
}

function parseLumineToml(cwd: string): LumineToml {
    const path = join(cwd, "lumine.toml");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const result: LumineToml = {};
    for (const line of raw.split("\n")) {
        const match = line.match(/^\s*(\w+)\s*=\s*"([^"]+)"/);
        if (match) {
            const [, key, value] = match;
            if (key === "includeDir") result.includeDir = value;
        }
    }
    return result;
}

function findRojoProject(cwd: string): string {
    for (const name of ["default.project.json"]) {
        const path = join(cwd, name);
        if (existsSync(path)) return path;
    }
    return join(cwd, "default.project.json");
}

export function loadConfig(cwd: string = process.cwd()): LumineConfig {
    const tsconfig = parseTsConfig(cwd);
    const lumine = parseLumineToml(cwd);
    const opts = tsconfig.compilerOptions ?? {};

    const outDir = resolve(cwd, opts.outDir ?? "out");
    const rootDir = resolve(cwd, opts.rootDir ?? "src");
    const declaration = opts.declaration ?? false;
    const rojoProject = findRojoProject(cwd);

    // includeDir: where Lumine.lua lives alongside RuntimeLib and Promise.
    // Default: sibling "include" folder next to outDir (roblox-ts convention:
    //   rbxtsc -o out  →  out/src/*.luau  +  out/include/RuntimeLib.lua)
    // Override in lumine.toml:  includeDir = "out/include"
    const includeDir = lumine.includeDir
        ? resolve(cwd, lumine.includeDir)
        : resolve(outDir, "..", "include");

    if (!declaration) {
        console.warn(
            `[lumine] warning: no "declaration": true in tsconfig.json\n` +
            `  running in fallback mode — some types will be inferred as any`,
        );
    }

    return { outDir, rootDir, declaration, includeDir, rojoProject };
}
```

### package/src/convert.ts
```ts
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
```

### package/src/emit.ts
```ts
import { randomUUID } from "crypto";
import type { TypeManifest, TypeDeclaration } from "./types";
import { convertType } from "./convert";
import { LUMINE_BUILTIN_FUNCTIONS } from "./builtins";

function selfName(decl: TypeDeclaration): string {
    if (decl.typeParams.length === 0) return decl.name;
    return `${decl.name}<${decl.typeParams.join(", ")}>`;
}

function emitMember(
    memberName: string,
    memberType: string,
    optional: boolean,
    isMethod: boolean,
    parentDecl: TypeDeclaration,
    knownTypes: Set<string>,
): string {
    const optSuffix = optional ? "?" : "";

    if (isMethod && memberType.includes("=>")) {
        const arrowIdx = memberType.lastIndexOf("=>");
        const rawParams = memberType.slice(1, memberType.lastIndexOf(")", arrowIdx)).trim();
        const rawRet = memberType.slice(arrowIdx + 2).trim();
        const self = `self: ${selfName(parentDecl)}`;
        const paramStr = rawParams
            ? rawParams
                .split(",")
                .map((p) => {
                    const trimmed = p
                        .trim()
                        .replace(/^\.\.\.[a-zA-Z_]+\??\s*:\s*/, "...")
                        .replace(/^\.\.\./, "");
                    const colonIdx = trimmed.indexOf(":");
                    if (colonIdx === -1) return convertType(trimmed, knownTypes);
                    return `${trimmed.slice(0, colonIdx).trim()}: ${convertType(trimmed.slice(colonIdx + 1).trim(), knownTypes)}`;
                })
                .join(", ")
            : "";
        const luauRet = rawRet === "void" ? "()" : convertType(rawRet, knownTypes);
        return `    ${memberName}: (${paramStr ? `${self}, ${paramStr}` : self}) -> ${luauRet}${optSuffix},`;
    }

    if (!isMethod && memberType.includes("=>")) {
        const arrowIdx = memberType.lastIndexOf("=>");
        const rawParams = memberType.slice(1, memberType.lastIndexOf(")", arrowIdx)).trim();
        const rawRet = memberType.slice(arrowIdx + 2).trim();
        const paramStr = rawParams
            ? rawParams
                .split(",")
                .map((p) => {
                    const trimmed = p.trim();
                    const colonIdx = trimmed.indexOf(":");
                    if (colonIdx === -1) return convertType(trimmed, knownTypes);
                    const pName = trimmed
                        .slice(0, colonIdx)
                        .replace(/^\.\.\./, "")
                        .replace(/\?$/, "")
                        .trim();
                    const pType = convertType(trimmed.slice(colonIdx + 1).trim(), knownTypes);
                    const isOpt = trimmed.slice(0, colonIdx).includes("?");
                    return `${pName}: ${pType}${isOpt ? "?" : ""}`;
                })
                .join(", ")
            : "";
        const luauRet = rawRet === "void" ? "()" : convertType(rawRet, knownTypes);
        return `    ${memberName}: (${paramStr}) -> ${luauRet}${optSuffix},`;
    }

    return `    ${memberName}: ${convertType(memberType, knownTypes)}${optSuffix},`;
}

function emitTypeDecl(decl: TypeDeclaration, knownTypes: Set<string>): string {
    const typeParams = decl.typeParams.length > 0 ? `<${decl.typeParams.join(", ")}>` : "";

    if (decl.kind === "conditional") {
        const branches = decl.branches ?? [decl.trueBranch ?? "any", decl.falseBranch ?? "any"];
        const converted = branches.map((b) => convertType(b, knownTypes)).join(" & ");
        return `export type ${decl.name}${typeParams} = ${converted}`;
    }

    if (decl.kind === "union" && decl.rawType) {
        const raw = decl.rawType;
        if ((raw.includes(" in ") && raw.includes("keyof")) || raw.match(/\[K in /)) {
            return `export type ${decl.name}${typeParams} = any -- [lumine] mapped type`;
        }
        if (raw.includes("`")) {
            return `export type ${decl.name}${typeParams} = string -- [lumine] template literal`;
        }
        return `export type ${decl.name}${typeParams} = ${convertType(raw, knownTypes)}`;
    }

    const lines = [`export type ${decl.name}${typeParams} = {`];
    for (const member of decl.members) {
        lines.push(
            emitMember(
                member.name,
                member.type,
                member.optional,
                member.isMethod,
                decl,
                knownTypes,
            ),
        );
    }
    lines.push("}");
    return lines.join("\n");
}

// ── Per-file inline type declarations (OWN types only) ────────────────────────
// Only emits types declared in THIS file's .d.ts. Cross-file types are handled
// via require() + re-export in annotate.ts, not by copying declarations.

export function generateInlineTypeDecls(manifest: TypeManifest): string {
    const knownTypes = new Set(Object.keys(manifest.types));
    const lines: string[] = [];

    for (const [name, fallback] of Object.entries(manifest.fallbackTypes)) {
        lines.push(`export type ${name} = ${fallback} -- [lumine] cannot represent in Luau`);
        lines.push("");
    }

    // Dedupe by decl.name — namespace types are registered under both
    // "Ns.Foo" (lookup) and "Ns_Foo" (canonical); only emit once.
    const seen = new Set<string>();
    for (const decl of Object.values(manifest.types)) {
        if (seen.has(decl.name)) continue;
        seen.add(decl.name);
        lines.push(emitTypeDecl(decl, knownTypes));
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

// ── Cross-file type re-exports ────────────────────────────────────────────────
// Groups cross-file types by their source .luau file. Returns a map of:
//   localVarName → { requirePath, typeNames[] }
// Each unique source file gets one `local X = require(...)` and one
// `export type T = X.T` per type.
//
// Uses UUID suffixes so local var names are stable across re-runs and
// never collide when multiple source files are involved.

export interface CrossFileGroup {
    /** The variable name to use: e.g. "_Types_a3f2b1c4" */
    localVar: string;
    /** Roblox require expression, e.g. require(game:GetService(...):WaitForChild(...)) */
    requireExpr: string;
    /** Luau type names to re-export from this module */
    typeNames: string[];
}

export function buildCrossFileGroups(
    referencedTypes: Map<string, string>, // typeName → source luauPath
    buildRequireExpr: (sourcePath: string) => string,
): CrossFileGroup[] {
    // Group type names by source path
    const bySource = new Map<string, string[]>();
    for (const [typeName, sourcePath] of referencedTypes) {
        const existing = bySource.get(sourcePath) ?? [];
        existing.push(typeName);
        bySource.set(sourcePath, existing);
    }

    const groups: CrossFileGroup[] = [];
    for (const [sourcePath, typeNames] of bySource) {
        const uid = randomUUID().replace(/-/g, "").slice(0, 8);
        groups.push({
            localVar: `_Types_${uid}`,
            requireExpr: buildRequireExpr(sourcePath),
            typeNames,
        });
    }
    return groups;
}

// ── Lumine.lua ────────────────────────────────────────────────────────────────

export function generateLumineFile(): string {
    return (
        "-- [lumine] built-in type library — do not edit, regenerated by lumine\n\n" +
        LUMINE_BUILTIN_FUNCTIONS +
        "\nreturn {}\n"
    );
}
```

### package/src/extract.ts
```ts
import ts from "typescript";
import { readFileSync } from "fs";
import type { TypeManifest, ParamInfo, InterfaceMember, TypeDeclaration } from "./types";

function typeText(node: ts.TypeNode | undefined, source: ts.SourceFile): string {
    if (!node) return "void";
    return node.getText(source).replace(/\s+/g, " ").trim();
}

function extractParams(
    params: ts.NodeArray<ts.ParameterDeclaration>,
    source: ts.SourceFile,
): ParamInfo[] {
    return Array.from(params).map((p) => ({
        name: p.name.getText(source),
        type: typeText(p.type, source),
        optional: !!p.questionToken,
        rest: !!p.dotDotDotToken,
    }));
}

function extractTypeParamNames(
    node: ts.DeclarationWithTypeParameters,
    source: ts.SourceFile,
): string[] {
    const params = ts.getEffectiveTypeParameterDeclarations(node);
    return params ? Array.from(params).map((p) => p.name.text) : [];
}

/** Extract type param names AND their defaults, e.g. <T, E = string> → names=["T","E"], defaults=[null,"string"] */
function extractTypeParams(
    node: ts.DeclarationWithTypeParameters,
    source: ts.SourceFile,
): { names: string[]; defaults: (string | null)[] } {
    const params = ts.getEffectiveTypeParameterDeclarations(node);
    if (!params || params.length === 0) return { names: [], defaults: [] };
    const names: string[] = [];
    const defaults: (string | null)[] = [];
    for (const p of params) {
        names.push(p.name.text);
        defaults.push(p.default ? typeText(p.default as ts.TypeNode, source) : null);
    }
    return { names, defaults };
}

function extractMembers(
    members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
    source: ts.SourceFile,
): InterfaceMember[] {
    const result: InterfaceMember[] = [];
    for (const member of members) {
        if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
            if (!member.name) continue;
            result.push({
                name: member.name.getText(source),
                type: typeText(member.type, source),
                optional: !!member.questionToken,
                isMethod: false,
            });
        } else if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
            if (!member.name) continue;
            const params = extractParams(member.parameters, source);
            const paramStr = params
                .map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}: ${p.type}`)
                .join(", ");
            const ret = member.type ? typeText(member.type as ts.TypeNode, source) : "void";
            result.push({
                name: member.name.getText(source),
                type: `(${paramStr}) => ${ret}`,
                optional: !!member.questionToken,
                isMethod: true,
            });
        }
    }
    return result;
}

function flattenConditional(node: ts.ConditionalTypeNode, source: ts.SourceFile): string[] {
    const branches: string[] = [];
    const addBranch = (typeNode: ts.TypeNode) => {
        if (ts.isConditionalTypeNode(typeNode)) {
            branches.push(...flattenConditional(typeNode, source));
        } else {
            branches.push(typeNode.getText(source).replace(/\s+/g, " ").trim());
        }
    };
    addBranch(node.trueType);
    addBranch(node.falseType);
    return branches;
}

function registerType(manifest: TypeManifest, key: string, decl: TypeDeclaration) {
    manifest.types[key] = decl;
}

export function extractManifest(dtsPath: string): TypeManifest {
    const content = readFileSync(dtsPath, "utf-8");
    const source = ts.createSourceFile(dtsPath, content, ts.ScriptTarget.ESNext, true);
    const manifest: TypeManifest = { functions: {}, types: {}, fallbackTypes: {} };

    ts.forEachChild(source, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.text;
            const params = extractParams(node.parameters, source);
            const returnType = typeText(node.type, source);
            const typeParams = extractTypeParamNames(node, source);
            manifest.functions[name] = { name, params, returnType, typeParams };
        }

        if (ts.isInterfaceDeclaration(node)) {
            const name = node.name.text;
            const { names, defaults } = extractTypeParams(node, source);
            registerType(manifest, name, {
                name,
                kind: "interface",
                members: extractMembers(node.members, source),
                typeParams: names,
                typeParamDefaults: defaults,
            });
        }

        if (ts.isTypeAliasDeclaration(node)) {
            const name = node.name.text;
            const { names, defaults } = extractTypeParams(node, source);
            const fullTypeText = node.type.getText(source);

            if (fullTypeText.includes("infer ")) {
                manifest.fallbackTypes[name] = "any";
                return;
            }
            if (node.type.kind === ts.SyntaxKind.MappedType) {
                manifest.fallbackTypes[name] = "any";
                return;
            }
            if (node.type.kind === ts.SyntaxKind.TemplateLiteralType) {
                manifest.fallbackTypes[name] = "string";
                return;
            }
            if (ts.isConditionalTypeNode(node.type)) {
                if (node.type.getText(source).includes("infer ")) {
                    manifest.fallbackTypes[name] = "any";
                    return;
                }
                registerType(manifest, name, {
                    name,
                    kind: "conditional",
                    members: [],
                    typeParams: names,
                    typeParamDefaults: defaults,
                    branches: flattenConditional(node.type, source),
                });
                return;
            }
            if (ts.isTypeLiteralNode(node.type)) {
                const members: InterfaceMember[] = [];
                for (const m of node.type.members) {
                    if (ts.isPropertySignature(m) && m.name) {
                        members.push({
                            name: m.name.getText(source),
                            type: typeText(m.type, source),
                            optional: !!m.questionToken,
                            isMethod: false,
                        });
                    } else if (ts.isMethodSignature(m) && m.name) {
                        const params = extractParams(m.parameters, source);
                        const paramStr = params
                            .map(
                                (p) =>
                                    `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}: ${p.type}`,
                            )
                            .join(", ");
                        const ret = m.type ? typeText(m.type as ts.TypeNode, source) : "void";
                        members.push({
                            name: m.name.getText(source),
                            type: `(${paramStr}) => ${ret}`,
                            optional: !!m.questionToken,
                            isMethod: true,
                        });
                    }
                }
                registerType(manifest, name, {
                    name,
                    kind: "type",
                    members,
                    typeParams: names,
                    typeParamDefaults: defaults,
                });
                return;
            }
            const rawType = node.type.getText(source).replace(/\s+/g, " ").trim();
            registerType(manifest, name, {
                name,
                kind: "union",
                members: [],
                typeParams: names,
                typeParamDefaults: defaults,
                rawType,
            });
        }

        // export declare namespace Net { interface Foo {} }
        if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
            const nsName = node.name.text;
            const body = node.body;
            if (body && ts.isModuleBlock(body)) {
                ts.forEachChild(body, (child) => {
                    if (ts.isInterfaceDeclaration(child)) {
                        const { names, defaults } = extractTypeParams(child, source);
                        const qualifiedKey = `${nsName}.${child.name.text}`;
                        const luauName = `${nsName}_${child.name.text}`;
                        const decl: TypeDeclaration = {
                            name: luauName,
                            kind: "interface",
                            members: extractMembers(child.members, source),
                            typeParams: names,
                            typeParamDefaults: defaults,
                        };
                        // Register under both keys so lookups work either way
                        manifest.types[qualifiedKey] = decl;
                        manifest.types[luauName] = decl;
                    }
                });
            }
        }
    });

    return manifest;
}
```

### package/src/index.ts
```ts
#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, relative } from "path";
import { loadConfig } from "./config";
import { extractManifest } from "./extract";
import { annotateFile } from "./annotate";
import { generateLumineFile } from "./emit";
import type { TypeManifest, AnnotationResult } from "./types";
import type { TypeDefaultsMap } from "./convert";

const VERSION = "0.1.0";

function printHelp() {
    console.log(`lumine v${VERSION}
Luau type annotation tool for compiled roblox-ts / rotor projects.

Usage:
  lumine            Run once — annotate all .luau files in outDir
  lumine --watch    Watch mode — re-annotate on .luau changes (incremental)
  lumine --dry-run  Show what would be annotated without writing
  lumine init       First-time setup
  lumine --version  Print version
  lumine --help     Show this help`);
}

function walkLuau(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) results.push(...walkLuau(full));
        else if (entry.endsWith(".luau")) results.push(full);
    }
    return results;
}

function dtsPathFor(luauPath: string): string {
    return luauPath.replace(/\.luau$/, ".d.ts");
}

function hashFile(filePath: string): string {
    if (!existsSync(filePath)) return "";
    return createHash("sha1").update(readFileSync(filePath)).digest("hex");
}

function hashString(s: string): string {
    return createHash("sha1").update(s).digest("hex");
}

// ── Cache types ───────────────────────────────────────────────────────────────

interface FileCache {
    contentHash: string;
    dtsHash: string;
    result: Omit<AnnotationResult, "filePath">;
}

interface ManifestCache {
    dtsHash: string;
    manifest: TypeManifest;
}

// ── Change detection ──────────────────────────────────────────────────────────

function hasChangedFiles(dir: string, knownHashes: Map<string, string>): boolean {
    if (!existsSync(dir)) return false;
    for (const path of walkLuau(dir)) {
        const current = hashFile(path);
        if (!knownHashes.has(path) || current !== knownHashes.get(path)) return true;
    }
    return false;
}

// ── Lumine.lua generation ─────────────────────────────────────────────────────

function ensureLumineFile(lumineFilePath: string, dryRun: boolean): void {
    const content = generateLumineFile();
    const onDiskHash = hashFile(lumineFilePath);
    if (hashString(content) === onDiskHash) return;

    if (!dryRun) {
        mkdirSync(require("path").dirname(lumineFilePath), { recursive: true });
        writeFileSync(lumineFilePath, content, "utf-8");
        console.log(`[lumine] wrote ${lumineFilePath}`);
    } else {
        console.log(`[lumine] would write ${lumineFilePath} (dry run)`);
    }
}

// ── Core run logic ────────────────────────────────────────────────────────────

interface RunContext {
    dryRun?: boolean;
    fileCache?: Map<string, FileCache>;
    manifestCache?: Map<string, ManifestCache>;
    diskHashes?: Map<string, string>;
}

async function run(ctx: RunContext = {}) {
    const cwd = process.cwd();
    const config = loadConfig(cwd);
    const { outDir, declaration, rojoProject, includeDir } = config;
    const { dryRun = false, fileCache, manifestCache, diskHashes } = ctx;
    const lumineFilePath = join(includeDir, "Lumine.lua");

    if (!existsSync(outDir)) {
        console.error(
            `[lumine] error: outDir "${outDir}" does not exist — run your compiler first`,
        );
        process.exit(1);
    }

    ensureLumineFile(lumineFilePath, dryRun);

    const luauFiles = walkLuau(outDir).filter((f) => f !== lumineFilePath);
    if (luauFiles.length === 0) {
        console.log("[lumine] no .luau files found");
        return;
    }

    // ── Phase 1: Extract manifests (with caching) ─────────────────────────────
    const manifests = new Map<string, TypeManifest>();
    let dtsChangedCount = 0;

    if (declaration) {
        for (const luauPath of luauFiles) {
            const dtsPath = dtsPathFor(luauPath);
            if (!existsSync(dtsPath)) continue;

            const dtsHash = hashFile(dtsPath);
            const cached = manifestCache?.get(luauPath);

            let manifest: TypeManifest;
            if (cached && cached.dtsHash === dtsHash) {
                manifest = cached.manifest;
            } else {
                manifest = extractManifest(dtsPath);
                dtsChangedCount++;
                manifestCache?.set(luauPath, { dtsHash, manifest });
            }

            manifests.set(luauPath, manifest);
        }
        if (dtsChangedCount > 0) {
            const dtsCached = manifests.size - dtsChangedCount;
            console.log(`[lumine] ${dtsChangedCount} .d.ts changed, ${dtsCached} cached`);
        }
    }

    // ── Build global type origin map ──────────────────────────────────────────
    // Maps each Luau type name → the .luau file that declares it.
    // Passed to annotateFile so cross-file references get a proper
    // require() + re-export instead of copying the declaration.
    const globalTypeOrigins = new Map<string, string>();
    for (const [luauPath, m] of manifests.entries()) {
        for (const decl of Object.values(m.types)) {
            globalTypeOrigins.set(decl.name, luauPath);
        }
    }

    // ── Build global type defaults map ────────────────────────────────────────
    // Aggregates typeParamDefaults across ALL manifests so cross-file generic
    // types like Result<T, E = string> get their defaults filled in everywhere.
    const globalTypeDefaults: TypeDefaultsMap = new Map();
    for (const m of manifests.values()) {
        for (const [key, decl] of Object.entries(m.types)) {
            if (decl.typeParamDefaults && decl.typeParamDefaults.some((d) => d !== null)) {
                globalTypeDefaults.set(key, decl.typeParamDefaults);
                globalTypeDefaults.set(decl.name, decl.typeParamDefaults);
            }
        }
    }

    // ── Phase 2: Annotate .luau files ────────────────────────────────────────
    let totalAnnotated = 0;
    let totalSkipped = 0;
    let filesProcessed = 0;
    let filesCached = 0;

    for (const luauPath of luauFiles) {
        const srcHash = hashFile(luauPath);
        const dtsHash = declaration ? hashFile(dtsPathFor(luauPath)) : "";
        const cached = fileCache?.get(luauPath);

        if (cached && cached.contentHash === srcHash && cached.dtsHash === dtsHash) {
            totalAnnotated += cached.result.annotated;
            totalSkipped += cached.result.skipped;
            filesCached++;
            continue;
        }

        const manifest = manifests.get(luauPath) ?? {
            functions: {},
            types: {},
            fallbackTypes: {},
        };
        const source = readFileSync(luauPath, "utf-8");
        const result = annotateFile(
            source,
            luauPath,
            manifest,
            rojoProject,
            lumineFilePath,
            cwd,
            globalTypeOrigins,
            globalTypeDefaults,
        );

        totalAnnotated += result.annotated;
        totalSkipped += result.skipped;
        filesProcessed++;

        const outputHash = result.annotated > 0 ? hashString(result.source) : srcHash;

        if (result.annotated > 0) {
            if (!dryRun) {
                writeFileSync(luauPath, result.source, "utf-8");
                diskHashes?.set(luauPath, outputHash);
            }
            console.log(
                `[lumine] ${relative(cwd, luauPath)} — ${result.annotated} annotated` +
                (result.skipped > 0 ? `, ${result.skipped} skipped` : ""),
            );
        } else {
            diskHashes?.set(luauPath, srcHash);
        }

        if (fileCache) {
            fileCache.set(luauPath, {
                contentHash: outputHash,
                dtsHash,
                result: {
                    annotated: result.annotated,
                    skipped: result.skipped,
                    usesBuiltins: result.usesBuiltins,
                },
            });
        }
    }

    const cacheMsg = filesCached > 0 ? `, ${filesCached} cached` : "";
    console.log(
        `\n[lumine] done — ${totalAnnotated} annotations` +
        `, ${filesProcessed} files processed` +
        cacheMsg +
        (dryRun ? " (dry run)" : ""),
    );
}

// ── Public entry points ───────────────────────────────────────────────────────

async function runOnce(dryRun = false) {
    await run({ dryRun });
}

async function runWatch() {
    const cwd = process.cwd();
    const config = loadConfig(cwd);
    const { outDir } = config;

    const fileCache = new Map<string, FileCache>();
    const manifestCache = new Map<string, ManifestCache>();
    const diskHashes = new Map<string, string>();

    console.log(`[lumine] watching ${outDir} for changes...`);

    // Run immediately on startup
    if (existsSync(outDir)) {
        await run({ fileCache, manifestCache, diskHashes });
    }

    let running = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = setInterval(() => {
        if (running) return;
        if (!hasChangedFiles(outDir, diskHashes)) return;
        if (debounceTimer) return;

        debounceTimer = setTimeout(async () => {
            if (running) return;
            running = true;
            console.log(`\n[lumine] change detected — re-annotating...`);
            try {
                await run({ fileCache, manifestCache, diskHashes });
            } finally {
                running = false;
                debounceTimer = null;
            }
        }, 150);
    }, 300);

    process.on("SIGINT", () => {
        clearInterval(poll);
        if (debounceTimer) clearTimeout(debounceTimer);
        console.log("\n[lumine] stopped.");
        process.exit(0);
    });
}
function runInit() {
    const tsconfigPath = join(process.cwd(), "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
        console.error("[lumine] error: tsconfig.json not found");
        process.exit(1);
    }

    const raw = readFileSync(tsconfigPath, "utf-8");
    if (raw.includes('"declaration"')) {
        console.log('[lumine] tsconfig.json already has "declaration" set');
    } else {
        const updated = raw.replace(
            /"compilerOptions"\s*:\s*\{/,
            `"compilerOptions": {\n        "declaration": true,`,
        );
        writeFileSync(tsconfigPath, updated, "utf-8");
        console.log('[lumine] added "declaration": true to tsconfig.json');
    }

    const luminePath = join(process.cwd(), "lumine.toml");
    if (!existsSync(luminePath)) {
        writeFileSync(luminePath, `includeDir = "out/include"\n`, "utf-8");
        console.log("[lumine] created lumine.toml");
    }

    console.log("\n[lumine] setup complete. Run your compiler then: lumine");
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
    printHelp();
} else if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
} else if (args.includes("init")) {
    runInit();
} else if (args.includes("--watch") || args.includes("-w")) {
    runWatch();
} else if (args.includes("--dry-run")) {
    runOnce(true);
} else {
    runOnce();
}
```

### package/src/rojo.ts
```ts
import { existsSync, readFileSync } from "fs";
import { resolve, relative } from "path";

interface RojoNode {
    $path?: string;
    $className?: string;
    [key: string]: unknown;
}

interface PathMapping {
    fsPath: string;
    service: string;
    segments: string[];
}

const ROBLOX_SERVICES = new Set([
    "Workspace",
    "Players",
    "Lighting",
    "ReplicatedFirst",
    "ReplicatedStorage",
    "ServerScriptService",
    "ServerStorage",
    "StarterGui",
    "StarterPack",
    "StarterPlayer",
    "SoundService",
    "Chat",
    "LocalizationService",
    "TestService",
    "HttpService",
    "RunService",
]);

function walkTree(node: RojoNode, path: string[], mappings: PathMapping[], cwd: string): void {
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("$") || typeof value !== "object" || value === null) continue;
        const child = value as RojoNode;
        const childPath = [...path, key];

        if (child.$path) {
            const fsPath = resolve(cwd, child.$path);
            const service = childPath.find((p) => ROBLOX_SERVICES.has(p)) ?? childPath[0];
            const serviceIdx = childPath.indexOf(service);
            const segments = childPath.slice(serviceIdx + 1);
            mappings.push({ fsPath, service, segments });
        }

        walkTree(child, childPath, mappings, cwd);
    }
}

export interface RojoResolution {
    service: string;
    segments: string[];
}

export function resolveRojoPath(
    rojoProjectPath: string,
    targetFilePath: string,
    cwd: string,
): RojoResolution | null {
    if (!existsSync(rojoProjectPath)) return null;

    let project: { tree: RojoNode };
    try {
        project = JSON.parse(readFileSync(rojoProjectPath, "utf-8"));
    } catch {
        return null;
    }

    const mappings: PathMapping[] = [];
    walkTree(project.tree, [], mappings, cwd);

    const targetAbs = resolve(cwd, targetFilePath);

    let best: PathMapping | null = null;
    let bestLen = 0;

    for (const mapping of mappings) {
        if (targetAbs.startsWith(mapping.fsPath) && mapping.fsPath.length > bestLen) {
            best = mapping;
            bestLen = mapping.fsPath.length;
        }
    }

    if (!best) return null;

    const rel = relative(best.fsPath, targetAbs)
        .replace(/\\/g, "/")
        .replace(/\.luau?$/, "");

    const relSegments = rel.split("/").filter(Boolean);

    return {
        service: best.service,
        segments: [...best.segments, ...relSegments],
    };
}

export function buildTsImport(resolution: RojoResolution): string {
    const args = resolution.segments.map((s) => `"${s}"`).join(", ");
    return `TS.import(script, game:GetService("${resolution.service}"), ${args})`;
}

// Always use WaitForChild — safer than dot notation for async instance loading,
// and matches the pattern rbxtsc itself uses for RuntimeLib and Promise.
export function buildDirectRequire(resolution: RojoResolution): string {
    let path = `game:GetService("${resolution.service}")`;
    for (const seg of resolution.segments) {
        path += `:WaitForChild("${seg}")`;
    }
    return `require(${path})`;
}
```

### package/src/types.ts
```ts
export interface ParamInfo {
    name: string;
    type: string;
    optional: boolean;
    rest: boolean;
}

export interface FunctionSignature {
    name: string;
    params: ParamInfo[];
    returnType: string;
    typeParams: string[];
}

export interface InterfaceMember {
    name: string;
    type: string;
    optional: boolean;
    isMethod: boolean;
}

export interface TypeDeclaration {
    name: string;
    kind: "interface" | "type" | "class" | "conditional" | "union";
    members: InterfaceMember[];
    typeParams: string[];
    /** Default values for type params, e.g. Result<T, E = string> → ["", "string"] */
    typeParamDefaults: (string | null)[];
    branches?: string[];
    trueBranch?: string;
    falseBranch?: string;
    rawType?: string;
}

export interface TypeManifest {
    functions: Record<string, FunctionSignature>;
    types: Record<string, TypeDeclaration>;
    fallbackTypes: Record<string, string>;
}

export interface LumineConfig {
    outDir: string;
    rootDir: string;
    declaration: boolean;
    includeDir: string;
    rojoProject: string;
}

export interface AnnotationResult {
    filePath: string;
    annotated: number;
    skipped: number;
    usesBuiltins: boolean;
}
```

