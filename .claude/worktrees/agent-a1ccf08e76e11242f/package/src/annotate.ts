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
	const re = new RegExp(
		`^([ \t]*)(?:local function ${esc}|local ${esc}\\s*=\\s*function|function ${esc})`,
		"m",
	);
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
	for (const decl of Object.values(manifest.types)) {
		scanType(decl.body);
		for (const typeParamDefault of decl.typeParamDefaults) {
			if (typeParamDefault) scanType(typeParamDefault);
		}
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
	currentFilePath: string,
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
function fillTypeParamDefaults(
	t: LuauType,
	globalDecls: Map<string, TypeDecl>,
	globalOrigins?: Map<string, string>,
): LuauType {
	switch (t.kind) {
		case "reference": {
			const filledArgs = t.args?.map((a) => fillTypeParamDefaults(a, globalDecls, globalOrigins));
			// Strip module qualifier to get the bare type name for lookup
			const dot = t.name.lastIndexOf(".");
			const baseName = dot !== -1 ? t.name.slice(dot + 1) : t.name;
			// The qualifier prefix of this reference (e.g. "_Types_9aa91235.")
			const qualifier = dot !== -1 ? t.name.slice(0, dot + 1) : "";
			const decl = globalDecls.get(baseName);
			if (decl && decl.typeParamDefaults.length > 0) {
				const provided = filledArgs?.length ?? 0;
				const needed = decl.typeParams.length;
				if (provided < needed) {
					const extra: LuauType[] = [];
					for (let i = provided; i < needed; i++) {
						const rawDefault = decl.typeParamDefaults[i] ?? LuauAny;
						// Defaults are stored as bare refs from the origin file — when the
						// parent type is a cross-file qualified ref, apply the same qualifier
						// to any bare external names in the default so they resolve correctly.
						extra.push(
							qualifier && globalOrigins
								? qualifyBareRefs(rawDefault, qualifier, globalOrigins)
								: rawDefault,
						);
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
			return {
				kind: "optional",
				inner: fillTypeParamDefaults(t.inner, globalDecls, globalOrigins),
			};
		case "union":
			return {
				kind: "union",
				members: t.members.map((m) => fillTypeParamDefaults(m, globalDecls, globalOrigins)),
			};
		case "intersection":
			return {
				kind: "intersection",
				members: t.members.map((m) => fillTypeParamDefaults(m, globalDecls, globalOrigins)),
			};
		case "table":
			return {
				kind: "table",
				fields: t.fields.map((f) => ({
					...f,
					type: fillTypeParamDefaults(f.type, globalDecls, globalOrigins),
				})),
				indexer: t.indexer
					? {
							key: fillTypeParamDefaults(t.indexer.key, globalDecls, globalOrigins),
							value: fillTypeParamDefaults(t.indexer.value, globalDecls, globalOrigins),
						}
					: undefined,
			};
		case "function":
			return {
				kind: "function",
				params: t.params.map((p) => ({
					...p,
					type: fillTypeParamDefaults(p.type, globalDecls, globalOrigins),
				})),
				returns: fillTypeParamDefaults(t.returns, globalDecls, globalOrigins),
			};
		case "tuple":
			return {
				kind: "tuple",
				elements: t.elements.map((e) => fillTypeParamDefaults(e, globalDecls, globalOrigins)),
			};
		case "keyof":
			return {
				kind: "keyof",
				inner: fillTypeParamDefaults(t.inner, globalDecls, globalOrigins),
			};
		default:
			return t;
	}
}

function remapTypeDecls(
	manifest: TypeManifest,
	aliases: Map<string, string>,
	globalDecls: Map<string, TypeDecl>,
): TypeManifest {
	const types: TypeManifest["types"] = {};

	for (const [key, decl] of Object.entries(manifest.types)) {
		types[key] = {
			...decl,
			typeParamDefaults: decl.typeParamDefaults.map((typeParamDefault) =>
				typeParamDefault
					? fillTypeParamDefaults(remapType(typeParamDefault, aliases), globalDecls)
					: undefined,
			),
			body: fillTypeParamDefaults(remapType(decl.body, aliases), globalDecls),
		};
	}

	return {
		...manifest,
		types,
	};
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
	liftedTypeNames?: Set<string>,
): AnnotationResult & { source: string } {
	const knownTypes = new Set(Object.keys(manifest.types));
	let annotated = 0;
	let skipped = 0;
	let usesBuiltins = false;
	let result = source;

	const filePathAbs = resolve(filePath);
	const liftedSet = liftedTypeNames ?? new Set<string>();
	const ownTypeNames = new Set(
		Object.values(manifest.types).map((d) => d.name).filter((n) => !liftedSet.has(n)),
	);

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
				globalTypeOrigins,
			);
			if (typeUsesBuiltins(remapped)) usesBuiltins = true;

			return printParam(cleanName, remapped, param.optional, param.rest || isRest);
		});

		const remappedReturn = fillTypeParamDefaults(
			remapType(sig.returnType, typeAliasMap),
			globalTypeDecls,
			globalTypeOrigins,
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

	const ownDecls = generateInlineTypeDecls(
		remapTypeDecls(manifest, typeAliasMap, globalTypeDecls),
		liftedTypeNames,
	);
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
			line.startsWith("local _Shared_") ||
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

/**
 * Walk a LuauType and prefix any bare PascalCase reference names that exist in
 * globalOrigins with the given qualifier (e.g. "_Types_9aa91235.").
 *
 * Used to fix up default type arguments that were stored as bare names from
 * their origin file but need module qualification in the consumer file.
 * Only qualifies names that are known external types (present in globalOrigins)
 * so generic type params (T, K, V) are left untouched.
 */
function qualifyBareRefs(t: LuauType, qualifier: string, globalOrigins: Map<string, string>): LuauType {
	switch (t.kind) {
		case "reference": {
			const shouldQualify =
				!t.name.includes(".") && /^[A-Z]/.test(t.name) && globalOrigins.has(t.name);
			const name = shouldQualify ? `${qualifier}${t.name}` : t.name;
			const args = t.args?.map((a) => qualifyBareRefs(a, qualifier, globalOrigins));
			return { kind: "reference", name, args };
		}
		case "optional":
			return { kind: "optional", inner: qualifyBareRefs(t.inner, qualifier, globalOrigins) };
		case "union":
			return {
				kind: "union",
				members: t.members.map((m) => qualifyBareRefs(m, qualifier, globalOrigins)),
			};
		case "intersection":
			return {
				kind: "intersection",
				members: t.members.map((m) => qualifyBareRefs(m, qualifier, globalOrigins)),
			};
		case "table":
			return {
				kind: "table",
				fields: t.fields.map((f) => ({
					...f,
					type: qualifyBareRefs(f.type, qualifier, globalOrigins),
				})),
				indexer: t.indexer
					? {
							key: qualifyBareRefs(t.indexer.key, qualifier, globalOrigins),
							value: qualifyBareRefs(t.indexer.value, qualifier, globalOrigins),
						}
					: undefined,
			};
		case "function":
			return {
				kind: "function",
				params: t.params.map((p) => ({ ...p, type: qualifyBareRefs(p.type, qualifier, globalOrigins) })),
				returns: qualifyBareRefs(t.returns, qualifier, globalOrigins),
			};
		case "tuple":
			return {
				kind: "tuple",
				elements: t.elements.map((e) => qualifyBareRefs(e, qualifier, globalOrigins)),
			};
		case "keyof":
			return { kind: "keyof", inner: qualifyBareRefs(t.inner, qualifier, globalOrigins) };
		default:
			return t;
	}
}
