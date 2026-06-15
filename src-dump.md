### package/src/annotate.ts
```ts
/**
 * annotate.ts
 *
 * Reads compiled .luau files, finds function signatures, and rewrites them
 * with type annotations derived from the corresponding .d.ts manifests.
 * Also inlines type declarations and cross-file requires.
 *
 * Bug fixes in this version:
 *   #1  rest params now annotate as "...: T" not "...: {T}"  (in extract.ts)
 *   #2  method param splitting uses AST not split(",")        (in extract.ts)
 *   #3  watch double-run: handled in index.ts
 *   #4  annotated++ no longer inflated by type block injection
 *   #5  sentinel no longer permanently blocks cross-file updates
 *   #6  require-line detection is bracket-aware, not regex-fragile
 */
import { resolve } from "path";
import { randomUUID } from "crypto";
import type { TypeManifest, TypeDecl, AnnotationResult } from "./types";
import { LuauAny, printReturn, printParam, typeUsesBuiltins, type LuauType } from "./luau-types";
import { generateInlineTypeDecls } from "./emit";
import { resolveRojoPath, buildDirectRequire, buildRelativeRequire } from "./rojo";

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Signature finding (unchanged — still operates on Luau source strings) ─────

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
		// < > intentionally omitted — Luau's -> arrow contains > which is not a bracket
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

// ── Param splitting (bracket-aware, guards against -> arrows) ─────────────────

function splitParams(paramStr: string): string[] {
	if (!paramStr.trim()) return [];
	const parts: string[] = [];
	let depth = 0,
		start = 0;
	for (let i = 0; i < paramStr.length; i++) {
		const c = paramStr[i];
		if (c === "(" || c === "<" || c === "{" || c === "[") depth++;
		else if (c === ")" || c === "}" || c === "]") depth--;
		// Don't treat > in -> as a closing bracket
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

// ── Cross-file type tracking ──────────────────────────────────────────────────

/** Collect all Luau type names referenced in this manifest's function signatures. */
function collectReferencedTypeNames(manifest: TypeManifest): Set<string> {
	const refs = new Set<string>();
	const scanType = (t: LuauType) => {
		if (t.kind === "reference") {
			// Only user-defined names (PascalCase, not _Lumine.*)
			if (!t.name.startsWith("_Lumine.") && /^[A-Z]/.test(t.name)) refs.add(t.name);
			t.args?.forEach(scanType);
		} else if (t.kind === "optional") scanType(t.inner);
		else if (t.kind === "union" || t.kind === "intersection") t.members.forEach(scanType);
		else if (t.kind === "table") {
			t.fields.forEach((f) => scanType(f.type));
			if (t.indexer) {
				scanType(t.indexer.key);
				scanType(t.indexer.value);
			}
		} else if (t.kind === "function") {
			t.params.forEach((p) => scanType(p.type));
			scanType(t.returns);
		} else if (t.kind === "tuple") t.elements.forEach(scanType);
		else if (t.kind === "keyof") scanType(t.inner);
	};
	for (const sig of Object.values(manifest.functions)) {
		sig.params.forEach((p) => scanType(p.type));
		scanType(sig.returnType);
	}
	return refs;
}

// ── Require helpers ───────────────────────────────────────────────────────────

function buildLumineRequire(): string {
	// Hardcoded: Lumine.lua always lives in the standard rbxts_include location
	return `local _Lumine = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("Lumine"))`;
}

function buildModuleRequire(
	rojoProject: string,
	sourceLuauPath: string,
	currentFilePath: string, // ← new param
	cwd: string,
): string {
	const resolution = resolveRojoPath(rojoProject, sourceLuauPath, cwd);
	if (resolution) return buildDirectRequire(resolution);
	return buildRelativeRequire(currentFilePath, sourceLuauPath);
}

// ── Top-of-file injection (Bug #6: bracket-aware require scanning) ────────────

/**
 * Walk forward consuming `local X = require(...)` lines and blank lines.
 * Returns the position after the last consumed character.
 * Bracket-aware — handles deeply nested require paths like
 * require(game:GetService("X"):WaitForChild("Y"):WaitForChild("Z")).
 */
function skipHeaderRegion(src: string, start: number): number {
	let pos = start;
	while (pos < src.length) {
		const slice = src.slice(pos);

		// Blank line
		if (/^\s*\n/.test(slice)) {
			pos += slice.match(/^\s*\n/)![0].length;
			continue;
		}

		// `local X = require(` — scan for matching )
		const reqMatch = /^local [A-Za-z_][A-Za-z0-9_]* = require\(/.exec(slice);
		if (reqMatch) {
			let depth = 0,
				i = reqMatch[0].length - 1; // start at the (
			let found = false;
			for (; i < slice.length; i++) {
				if (slice[i] === "(") depth++;
				else if (slice[i] === ")") {
					depth--;
					if (depth === 0) {
						found = true;
						break;
					}
				}
			}
			if (found) {
				// consume to end of line
				let j = i + 1;
				while (j < slice.length && slice[j] === " ") j++;
				if (j < slice.length && slice[j] === "\n") j++;
				pos += j;
				continue;
			}
		}
		break;
	}
	return pos;
}

function injectAtTop(src: string, block: string): string {
	const banner = /^-- Compiled with roblox-ts[^\n]*\n/m.exec(src);
	if (banner) {
		const afterBanner = banner.index + banner[0].length;
		const insertAt = skipHeaderRegion(src, afterBanner);
		return src.slice(0, insertAt) + block + "\n" + src.slice(insertAt);
	}
	// --! lines (strict mode / luau flags)
	if (/^--!.*\n/m.test(src)) {
		return src.replace(/((?:^--!.*\n)+)/m, `$1${block}\n`);
	}
	return `${block}\n${src}`;
}

// ── Default type param filling ────────────────────────────────────────────────

/**
 * Walk a LuauType and fill in missing type arguments for references whose
 * declaration has TypeScript default type params (e.g. Result<T, E = string>
 * referenced as Result<Player> → Result<Player, string>).
 *
 * Looks up by base name after stripping any `_Types_xxx.` qualifier so this
 * works correctly on already-remapped cross-file references.
 */
function fillTypeParamDefaults(t: LuauType, globalDecls: Map<string, TypeDecl>): LuauType {
	switch (t.kind) {
		case "reference": {
			const filledArgs = t.args?.map((a) => fillTypeParamDefaults(a, globalDecls));
			// Strip module qualifier to get the bare type name for lookup
			const dot = t.name.lastIndexOf(".");
			const baseName = dot !== -1 ? t.name.slice(dot + 1) : t.name;
			const decl = globalDecls.get(baseName);
			if (decl && decl.typeParamDefaults.length > 0) {
				const provided = filledArgs?.length ?? 0;
				const needed = decl.typeParams.length;
				if (provided < needed) {
					const extra: LuauType[] = [];
					for (let i = provided; i < needed; i++) {
						extra.push(decl.typeParamDefaults[i] ?? LuauAny);
					}
					return {
						kind: "reference",
						name: t.name,
						args: [...(filledArgs ?? []), ...extra],
					};
				}
			}
			return { kind: "reference", name: t.name, args: filledArgs };
		}
		case "optional":
			return { kind: "optional", inner: fillTypeParamDefaults(t.inner, globalDecls) };
		case "union":
			return {
				kind: "union",
				members: t.members.map((m) => fillTypeParamDefaults(m, globalDecls)),
			};
		case "intersection":
			return {
				kind: "intersection",
				members: t.members.map((m) => fillTypeParamDefaults(m, globalDecls)),
			};
		case "table":
			return {
				kind: "table",
				fields: t.fields.map((f) => ({
					...f,
					type: fillTypeParamDefaults(f.type, globalDecls),
				})),
				indexer: t.indexer
					? {
							key: fillTypeParamDefaults(t.indexer.key, globalDecls),
							value: fillTypeParamDefaults(t.indexer.value, globalDecls),
						}
					: undefined,
			};
		case "function":
			return {
				kind: "function",
				params: t.params.map((p) => ({
					...p,
					type: fillTypeParamDefaults(p.type, globalDecls),
				})),
				returns: fillTypeParamDefaults(t.returns, globalDecls),
			};
		case "tuple":
			return {
				kind: "tuple",
				elements: t.elements.map((e) => fillTypeParamDefaults(e, globalDecls)),
			};
		case "keyof":
			return { kind: "keyof", inner: fillTypeParamDefaults(t.inner, globalDecls) };
		default:
			return t;
	}
}

// ── Main annotateFile ─────────────────────────────────────────────────────────

const INLINE_SENTINEL = "-- [lumine types]";

export function annotateFile(
	source: string,
	filePath: string,
	manifest: TypeManifest,
	rojoProject: string,
	lumineFilePath: string,
	cwd: string,
	globalTypeOrigins: Map<string, string> = new Map(),
	globalTypeDecls: Map<string, TypeDecl> = new Map(),
): AnnotationResult & { source: string } {
	const knownTypes = new Set(Object.keys(manifest.types));
	let annotated = 0;
	let skipped = 0;
	let usesBuiltins = false;
	let result = source;

	const filePathAbs = resolve(filePath);
	const ownTypeNames = new Set(Object.values(manifest.types).map((d) => d.name));

	// ── Build cross-file require groups ────────────────────────────────────────
	// Bug #5 fix: we ALWAYS recompute these from the current manifest, even
	// if the sentinel is present. The sentinel only guards against re-injecting
	// the WHOLE block; individual requires are re-evaluated each run.
	const referenced = collectReferencedTypeNames(manifest);
	const requireGroups = new Map<string, { localVar: string; typeNames: string[] }>();
	const typeAliasMap = new Map<string, string>(); // typeName → _Types_uuid.typeName

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
		typeAliasMap.set(name, `${group.localVar}.${name}`);
	}

	// ── Annotate function signatures ───────────────────────────────────────────
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

		// Build annotated parameter strings from AST types (no string conversion!)
		const annotatedParams = sig.params.map((param, i) => {
			const rawName = paramNames[i] ?? param.name;
			const isRest = rawName.startsWith("...");
			const cleanName = rawName.replace(/^\.\.\./, "") || param.name;

			// Remap cross-file references, then fill in any missing default type args
			const remapped = fillTypeParamDefaults(
				remapType(param.type, typeAliasMap),
				globalTypeDecls,
			);
			if (typeUsesBuiltins(remapped)) usesBuiltins = true;

			return printParam(cleanName, remapped, param.optional, param.rest || isRest);
		});

		const remappedReturn = fillTypeParamDefaults(
			remapType(sig.returnType, typeAliasMap),
			globalTypeDecls,
		);
		if (typeUsesBuiltins(remappedReturn)) usesBuiltins = true;
		const returnAnnotation = printReturn(remappedReturn);

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
		annotated++; // Bug #4 fix: only increment for actual function annotations
	}

	// ── Inject [lumine types] block ────────────────────────────────────────────
	// Bug #5 fix: remove old sentinel block entirely and re-inject fresh.
	// This means cross-file requires are always up to date.
	result = stripOldLumineBlock(result);

	const ownDecls = generateInlineTypeDecls(manifest);
	const needsLumine = usesBuiltins && !result.includes("local _Lumine =");
	const hasAnything = needsLumine || requireGroups.size > 0 || ownDecls.length > 0;

	if (hasAnything) {
		const lines: string[] = [INLINE_SENTINEL];

		if (needsLumine) {
			// Re-use an existing Lumine var if rbxtsc already emitted one
			const existingLumine = result.match(/^local Lumine = [^\n]+/m);
			lines.push(existingLumine ? "local _Lumine = Lumine" : buildLumineRequire());
		}

		for (const [sourcePath, group] of requireGroups) {
			lines.push(
				`local ${group.localVar} = ${buildModuleRequire(rojoProject, sourcePath, filePath, cwd)}`,
			);
		}

		if (needsLumine || requireGroups.size > 0) lines.push("");

		if (ownDecls.length > 0) {
			lines.push(ownDecls);
			lines.push("");
		}

		result = injectAtTop(result, lines.join("\n"));
		// Note: we do NOT increment `annotated` here (Bug #4 fix)
	}

	return { filePath, annotated, skipped, usesBuiltins, source: result };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Remove the entire [lumine types] block if present, so we can re-inject fresh. */
function stripOldLumineBlock(src: string): string {
	const start = src.indexOf("-- [lumine types]");
	if (start === -1) return src;

	let i = start;
	while (i < src.length && src[i] !== "\n") i++; // skip sentinel line
	if (i < src.length) i++; // skip the \n

	let braceDepth = 0;

	while (i < src.length) {
		const lineStart = i;
		let lineEnd = src.indexOf("\n", i);
		if (lineEnd === -1) lineEnd = src.length;
		const line = src.slice(lineStart, lineEnd).trim();

		const wasInside = braceDepth > 0;
		for (const ch of line) {
			if (ch === "{") braceDepth++;
			else if (ch === "}") braceDepth--;
		}

		// Lines inside a multi-line type body are always part of the lumine block,
		// even if they don't match any keyword (e.g. "    a: number,").
		const isLumineContent =
			wasInside ||
			line === "" ||
			line.startsWith("local _Lumine") ||
			line.startsWith("local _Types_") ||
			line.startsWith("local Lumine =") ||
			line.startsWith("export type ") ||
			line.startsWith("-- [lumine]");

		if (!isLumineContent) break;
		i = lineEnd + 1;
	}

	return src.slice(0, start) + src.slice(i);
}

/**
 * Walk a LuauType and replace any reference names that appear in the alias
 * map (cross-file types) with their qualified form (_Types_uuid.TypeName).
 */
function remapType(t: LuauType, aliases: Map<string, string>): LuauType {
	switch (t.kind) {
		case "reference": {
			const aliased = aliases.get(t.name);
			const name = aliased ?? t.name;
			const args = t.args?.map((a) => remapType(a, aliases));
			return { kind: "reference", name, args };
		}
		case "optional":
			return { kind: "optional", inner: remapType(t.inner, aliases) };
		case "union":
			return { kind: "union", members: t.members.map((m) => remapType(m, aliases)) };
		case "intersection":
			return { kind: "intersection", members: t.members.map((m) => remapType(m, aliases)) };
		case "table":
			return {
				kind: "table",
				fields: t.fields.map((f) => ({ ...f, type: remapType(f.type, aliases) })),
				indexer: t.indexer
					? {
							key: remapType(t.indexer.key, aliases),
							value: remapType(t.indexer.value, aliases),
						}
					: undefined,
			};
		case "function":
			return {
				kind: "function",
				params: t.params.map((p) => ({ ...p, type: remapType(p.type, aliases) })),
				returns: remapType(t.returns, aliases),
			};
		case "tuple":
			return { kind: "tuple", elements: t.elements.map((e) => remapType(e, aliases)) };
		case "keyof":
			return { kind: "keyof", inner: remapType(t.inner, aliases) };
		default:
			return t;
	}
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
/**
 * emit.ts
 *
 * Converts TypeManifest type declarations into Luau source strings for
 * inline injection into .luau files. Works entirely on LuauType AST nodes —
 * no string parsing, no regex, no split(",").
 *
 * Also owns the Lumine.lua builtin file generation.
 */
import type { TypeManifest, TypeDecl } from "./types";
import { printLuauType, mkRef, type LuauType, type LuauFnParam } from "./luau-types";
import { LUMINE_BUILTIN_FUNCTIONS } from "./builtins";

// ── Type declaration emitter ──────────────────────────────────────────────────

/**
 * Print a single type declaration as a Luau `export type` statement.
 * Interface table types with `isMethod` fields get `self` injected.
 */
function emitTypeDecl(decl: TypeDecl): string {
	const params = decl.typeParams.length ? `<${decl.typeParams.join(", ")}>` : "";
	const selfType = decl.typeParams.length
		? mkRef(
				decl.name,
				decl.typeParams.map((p) => mkRef(p)),
			)
		: mkRef(decl.name);

	const body = emitTypeBody(decl.body, selfType);
	return `export type ${decl.name}${params} = ${body}`;
}

/**
 * Recursively print a LuauType body. For table types, handles method members
 * by injecting `self: SelfType` as the first parameter — this cannot be done
 * inside printLuauType because only declaration-level tables have a self type.
 */
function emitTypeBody(t: LuauType, selfType: LuauType): string {
	if (t.kind !== "table") return printLuauType(t);

	const lines: string[] = [];

	if (t.indexer) {
		lines.push(
			`    [${printLuauType(t.indexer.key, 0, true)}]: ${printLuauType(t.indexer.value, 0, true)},`,
		);
	}

	for (const f of t.fields) {
		const opt = f.optional ? "?" : "";
		if (f.isMethod && f.type.kind === "function") {
			// Inject self as first param
			const selfParam: LuauFnParam = {
				name: "self",
				type: selfType,
				optional: false,
				rest: false,
			};
			const withSelf: LuauType = {
				kind: "function",
				params: [selfParam, ...f.type.params],
				returns: f.type.returns,
			};
			lines.push(`    ${f.name}: ${printLuauType(withSelf)}${opt},`);
		} else {
			lines.push(`    ${f.name}: ${printLuauType(f.type, 0, true)}${opt},`);
		}
	}

	if (lines.length === 0) return "{}";
	return `{\n${lines.join("\n")}\n}`;
}

// ── Per-file inline type declarations ────────────────────────────────────────

/**
 * Generate all `export type` declarations for types defined in this manifest.
 * Used to inline types directly into the corresponding .luau file.
 *
 * Deduplicates namespace types (registered under both "Ns.Foo" and "Ns_Foo").
 */
export function generateInlineTypeDecls(manifest: TypeManifest): string {
	const seen = new Set<string>();
	const lines: string[] = [];

	for (const decl of Object.values(manifest.types)) {
		if (seen.has(decl.name)) continue;
		seen.add(decl.name);
		lines.push(emitTypeDecl(decl));
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

// ── Lumine.lua builtin file ───────────────────────────────────────────────────

/**
 * Generate the full content of Lumine.lua — the file placed next to
 * RuntimeLib and Promise in the roblox-ts include folder.
 * Contains Luau type function implementations for Partial, Required, etc.
 * and the structural Promise<T> type.
 */
export function generateLumineFile(): string {
	return `-- [generated by lumine — do not edit]\n\n${LUMINE_BUILTIN_FUNCTIONS}\nreturn {}\n`;
}
```

### package/src/extract.ts
```ts
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
			const body = tsNodeToLuau(node.type, ctx);
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
```

### package/src/index.ts
```ts
#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, relative, dirname } from "path";
import { loadConfig } from "./config";
import { extractManifest } from "./extract";
import { annotateFile } from "./annotate";
import { generateLumineFile } from "./emit";
import type { TypeManifest, AnnotationResult } from "./types";

const VERSION = "0.1.0";

function printHelp() {
    console.log(`lumine v${VERSION}
Luau type annotation tool for compiled roblox-ts / rotor projects.

Usage:
  lumine               Run once — annotate all .luau files in outDir
  lumine -w, --watch   Watch mode — re-annotate on .luau changes
  lumine --dry-run     Show what would be annotated without writing
  lumine -v, --version Print version
  lumine -h, --help    Show this help`);
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
    if (hashString(content) === hashFile(lumineFilePath)) return;
    if (!dryRun) {
        mkdirSync(dirname(lumineFilePath), { recursive: true });
        writeFileSync(lumineFilePath, content, "utf-8");
        console.log(`[lumine] wrote ${lumineFilePath}`);
    }
}

// ── Core run ──────────────────────────────────────────────────────────────────

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
        console.error(`[lumine] error: outDir "${outDir}" does not exist — run your compiler first`);
        process.exit(1);
    }

    ensureLumineFile(lumineFilePath, dryRun);

    const luauFiles = walkLuau(outDir).filter(f => f !== lumineFilePath);
    if (luauFiles.length === 0) { console.log("[lumine] no .luau files found"); return; }

    // ── Phase 1: Extract manifests ────────────────────────────────────────────
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
            console.log(`[lumine] ${dtsChangedCount} .d.ts changed, ${manifests.size - dtsChangedCount} cached`);
        }
    }

    // ── Build global type origin map ──────────────────────────────────────────
    // Maps Luau type name → the .luau file that declares it, so cross-file
    // references can be handled with require() + re-export.
    const globalTypeOrigins = new Map<string, string>();
    const globalTypeDecls = new Map<string, import("./types").TypeDecl>();
    for (const [luauPath, m] of manifests.entries()) {
        for (const decl of Object.values(m.types)) {
            // Prefer first registration (own file wins)
            if (!globalTypeOrigins.has(decl.name)) {
                globalTypeOrigins.set(decl.name, luauPath);
                globalTypeDecls.set(decl.name, decl);
            }
        }
    }

    // ── Phase 2: Annotate .luau files ────────────────────────────────────────
    let totalAnnotated = 0, totalSkipped = 0, filesProcessed = 0, filesCached = 0;

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

        const manifest = manifests.get(luauPath) ?? { functions: {}, types: {} };
        const source = readFileSync(luauPath, "utf-8");
        const result = annotateFile(
            source, luauPath, manifest, rojoProject, lumineFilePath, cwd, globalTypeOrigins, globalTypeDecls,
        );

        totalAnnotated += result.annotated;
        totalSkipped += result.skipped;
        filesProcessed++;

        const sourceChanged = result.source !== source;
        const outputHash = sourceChanged ? hashString(result.source) : srcHash;

        if (sourceChanged) {
            if (!dryRun) {
                writeFileSync(luauPath, result.source, "utf-8");
                diskHashes?.set(luauPath, outputHash);
            }
            if (result.annotated > 0) {
                console.log(
                    `[lumine] ${relative(cwd, luauPath)} — ${result.annotated} annotated` +
                    (result.skipped > 0 ? `, ${result.skipped} skipped` : ""),
                );
            } else {
                console.log(`[lumine] ${relative(cwd, luauPath)} — types injected`);
            }
        } else {
            diskHashes?.set(luauPath, srcHash);
        }

        if (fileCache) {
            fileCache.set(luauPath, {
                contentHash: outputHash,
                dtsHash,
                result: { annotated: result.annotated, skipped: result.skipped, usesBuiltins: result.usesBuiltins },
            });
        }
    }

    const cacheMsg = filesCached > 0 ? `, ${filesCached} cached` : "";
    console.log(
        `\n[lumine] done — ${totalAnnotated} annotations, ${filesProcessed} files processed${cacheMsg}` +
        (dryRun ? " (dry run)" : ""),
    );
}

// ── Public entry points ───────────────────────────────────────────────────────

async function runOnce(dryRun = false) { await run({ dryRun }); }

async function runWatch() {
    const cwd = process.cwd();
    const { outDir } = loadConfig(cwd);

    const fileCache = new Map<string, FileCache>();
    const manifestCache = new Map<string, ManifestCache>();
    const diskHashes = new Map<string, string>();

    console.log(`[lumine] watching ${outDir} for changes...`);

    // Run once immediately so existing files are annotated on startup.
    // diskHashes is populated by this run, so only genuine rbxtsc output
    // (different content) triggers a second pass.
    if (existsSync(outDir)) {
        await run({ fileCache, manifestCache, diskHashes });
    }

    let running = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = setInterval(() => {
        if (running) return;
        if (!hasChangedFiles(outDir, diskHashes)) return;
        if (debounceTimer) return; // already scheduled — let it fire

        // 800ms quiet-period: rbxtsc writes multiple files incrementally;
        // firing after the first write would annotate a half-written output.
        // We don't reset the timer on subsequent writes — lumine fires once,
        // ~800ms after rbxtsc starts writing, regardless of how many files changed.
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
        }, 800);
    }, 300);

    process.on("SIGINT", () => {
        clearInterval(poll);
        if (debounceTimer) clearTimeout(debounceTimer);
        console.log("\n[lumine] stopped.");
        process.exit(0);
    });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) printHelp();
else if (args.includes("--version") || args.includes("-v")) console.log(VERSION);
else if (args.includes("--watch") || args.includes("-w")) runWatch();
else if (args.includes("--dry-run")) runOnce(true);
else runOnce();
```

### package/src/luau-types.ts
```ts
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
    rest: boolean; // true → emit as ...: T
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
    if (p.rest) return `...: ${printLuauType(p.type, depth + 1, true)}`;
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
```

### package/src/rojo.ts
```ts
import { resolve, relative, dirname, basename } from "path";
import { existsSync, readFileSync } from "fs";

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

/**
 * Build a require() using only relative script-tree navigation.
 * Used as a fallback when no .project.json exists.
 *
 * e.g. from  out/shared/Foo.luau
 *      to    out/net/Bar.luau
 * →  require(script.Parent.Parent.net.Bar)
 *
 * @param fromFilePath  absolute path of the file doing the requiring
 * @param toFilePath    absolute path of the module being required
 */
export function buildRelativeRequire(fromFilePath: string, toFilePath: string): string {
	const fromDir = dirname(fromFilePath);
	const fromBase = basename(fromFilePath)
		.replace(/\.luau?$/, "")
		.replace(/\.ts$/, "");
	const isInit = fromBase === "init" || fromBase === "index";

	const rel = relative(fromDir, toFilePath)
		.replace(/\\/g, "/")
		.replace(/\.luau?$/, "");

	const parts = rel.split("/");
	// init.luau's `script` IS the folder, so no initial .Parent needed
	let path = isInit ? "script" : "script.Parent";

	for (const part of parts) {
		if (part === "..") {
			path += ".Parent";
		} else {
			path += `:WaitForChild("${part}")`;
		}
	}

	return `require(${path})`;
}

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
import type { LuauType } from "./luau-types";

// ── Per-param / per-function info ─────────────────────────────────────────────

export interface ParamInfo {
    name: string;
    type: LuauType; // AST node — never a string
    optional: boolean;
    rest: boolean;
}

export interface FunctionSignature {
    name: string;
    params: ParamInfo[];
    returnType: LuauType;
    typeParams: string[];
}

// ── Type declarations (interfaces, aliases, namespaced types) ─────────────────

export interface TypeDecl {
    /** Luau-safe name: dots replaced with underscores (e.g. Net_Packet) */
    name: string;
    typeParams: string[];
    /** Parallel to typeParams — undefined means no default for that param */
    typeParamDefaults: (LuauType | undefined)[];
    body: LuauType;
}

// ── Per-file manifest ─────────────────────────────────────────────────────────

export interface TypeManifest {
    functions: Record<string, FunctionSignature>;
    /** key = qualified TS name or Luau name; value = the declaration */
    types: Record<string, TypeDecl>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface LumineConfig {
    outDir: string;
    rootDir: string;
    declaration: boolean;
    includeDir: string;
    rojoProject: string;
}

// ── Annotator result ──────────────────────────────────────────────────────────

export interface AnnotationResult {
    filePath: string;
    annotated: number;
    skipped: number;
    usesBuiltins: boolean;
}
```

