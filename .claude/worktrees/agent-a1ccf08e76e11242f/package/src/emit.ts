/**
 * emit.ts
 *
 * Converts TypeManifest type declarations into Luau source strings for
 * inline injection into .luau files. Works entirely on LuauType AST nodes —
 * no string parsing, no regex, no split(",").
 *
 * Also owns the Lumine.lua builtin file generation.
 */
import { createHash } from "crypto";
import { relative } from "path";
import type { TypeManifest, TypeDecl } from "./types";
import { printLuauType, mkRef, type LuauType, type LuauFnParam } from "./luau-types";
import { LUMINE_BUILTIN_FUNCTIONS } from "./builtins";
import { resolveRojoPath, buildDirectRequire, buildRelativeRequire } from "./rojo";

// ── Bare recursive type guard ─────────────────────────────────────────────────

/** True if typeName can be reached from body through only union/intersection/optional nodes. */
export function isBarelyRecursive(typeName: string, body: LuauType): boolean {
	switch (body.kind) {
		case "reference":
			return body.name === typeName && !body.args?.length;
		case "union":
		case "intersection":
			return body.members.some((m) => isBarelyRecursive(typeName, m));
		case "optional":
			return isBarelyRecursive(typeName, body.inner);
		default:
			return false;
	}
}

// ── Type declaration emitter ──────────────────────────────────────────────────

/**
 * Print a single type declaration as a Luau `export type` statement.
 * Interface table types with `isMethod` fields get `self` injected.
 */
export function emitTypeDecl(decl: TypeDecl): string {
	const params = decl.typeParams.length ? `<${decl.typeParams.join(", ")}>` : "";

	if (isBarelyRecursive(decl.name, decl.body)) {
		return `export type ${decl.name}${params} = any -- ⚠ bare recursive type`;
	}

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
export function generateInlineTypeDecls(manifest: TypeManifest, liftedTypeNames?: Set<string>): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	const lifted = liftedTypeNames ?? new Set<string>();

	for (const decl of Object.values(manifest.types)) {
		if (seen.has(decl.name)) continue;
		if (lifted.has(decl.name)) continue;
		seen.add(decl.name);
		lines.push(emitTypeDecl(decl));
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

// ── Ref scanning for a single LuauType ───────────────────────────────────────

function collectRefsFromType(t: LuauType, out: Set<string>): void {
	switch (t.kind) {
		case "reference":
			if (!t.name.startsWith("_Lumine.") && /^[A-Z]/.test(t.name)) out.add(t.name);
			t.args?.forEach((a) => collectRefsFromType(a, out));
			break;
		case "optional":
			collectRefsFromType(t.inner, out);
			break;
		case "union":
		case "intersection":
			t.members.forEach((m) => collectRefsFromType(m, out));
			break;
		case "table":
			t.fields.forEach((f) => collectRefsFromType(f.type, out));
			if (t.indexer) {
				collectRefsFromType(t.indexer.key, out);
				collectRefsFromType(t.indexer.value, out);
			}
			break;
		case "function":
			t.params.forEach((p) => collectRefsFromType(p.type, out));
			collectRefsFromType(t.returns, out);
			break;
		case "tuple":
			t.elements.forEach((e) => collectRefsFromType(e, out));
			break;
		case "keyof":
			collectRefsFromType(t.inner, out);
			break;
	}
}

// ── LuauType tree remapper ────────────────────────────────────────────────────

function remapRefs(t: LuauType, aliases: Map<string, string>): LuauType {
	switch (t.kind) {
		case "reference": {
			const aliased = aliases.get(t.name);
			const name = aliased ?? t.name;
			const args = t.args?.map((a) => remapRefs(a, aliases));
			return { kind: "reference", name, args };
		}
		case "optional":
			return { kind: "optional", inner: remapRefs(t.inner, aliases) };
		case "union":
			return { kind: "union", members: t.members.map((m) => remapRefs(m, aliases)) };
		case "intersection":
			return { kind: "intersection", members: t.members.map((m) => remapRefs(m, aliases)) };
		case "table":
			return {
				kind: "table",
				fields: t.fields.map((f) => ({ ...f, type: remapRefs(f.type, aliases) })),
				indexer: t.indexer
					? {
							key: remapRefs(t.indexer.key, aliases),
							value: remapRefs(t.indexer.value, aliases),
						}
					: undefined,
			};
		case "function":
			return {
				kind: "function",
				params: t.params.map((p) => ({ ...p, type: remapRefs(p.type, aliases) })),
				returns: remapRefs(t.returns, aliases),
			};
		case "tuple":
			return { kind: "tuple", elements: t.elements.map((e) => remapRefs(e, aliases)) };
		case "keyof":
			return { kind: "keyof", inner: remapRefs(t.inner, aliases) };
		default:
			return t;
	}
}

// ── Shared module generator ───────────────────────────────────────────────────

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

function stableHash8(participants: string[]): string {
	const sorted = [...participants].sort();
	return createHash("sha1").update(sorted.join("|")).digest("hex").slice(0, 8);
}

export function generateSharedModule(
	group: import("./cycle").ResolvedCycleGroup,
	globalTypeOrigins: Map<string, string>,
	rojoProject: string,
	cwd: string,
): string {
	const hash8 = stableHash8([...group.participants]);
	const sharedFile = group.sharedFilePath;

	// Collect all refs across all lifted type bodies
	const allRefs = new Set<string>();
	for (const { decl } of group.entries) {
		collectRefsFromType(decl.body, allRefs);
		for (const def of decl.typeParamDefaults) {
			if (def) collectRefsFromType(def, allRefs);
		}
	}

	// External deps: refs not in the shared module itself
	const externalDeps = new Set<string>();
	for (const name of allRefs) {
		if (!group.liftedTypeNames.has(name)) {
			const origin = globalTypeOrigins.get(name);
			if (origin) externalDeps.add(name);
		}
	}

	// Group external deps by origin file
	const requireGroups = new Map<string, { localVar: string; names: string[] }>();
	const aliasMap = new Map<string, string>();

	for (const name of externalDeps) {
		const origin = globalTypeOrigins.get(name);
		if (!origin) continue;
		let group2 = requireGroups.get(origin);
		if (!group2) {
			const uid = createHash("sha1").update(origin).digest("hex").slice(0, 8);
			group2 = { localVar: `_Types_${uid}`, names: [] };
			requireGroups.set(origin, group2);
		}
		if (!group2.names.includes(name)) group2.names.push(name);
		aliasMap.set(name, `${group2.localVar}.${name}`);
	}

	const lines: string[] = [];

	// Header
	lines.push(`-- [lumine shared types]`);
	lines.push(`-- participants:`);
	for (const p of group.participants) {
		lines.push(`--   ${relative(cwd, p)}`);
	}
	lines.push("");

	// Require lines for external deps
	for (const [sourcePath, grp] of requireGroups) {
		lines.push(
			`local ${grp.localVar} = ${buildModuleRequire(rojoProject, sourcePath, sharedFile, cwd)}`,
		);
	}
	if (requireGroups.size > 0) lines.push("");

	// Group entries by source file
	const byFile = new Map<string, Array<{ decl: TypeDecl }>>();
	for (const entry of group.entries) {
		let arr = byFile.get(entry.from);
		if (!arr) { arr = []; byFile.set(entry.from, arr); }
		arr.push({ decl: entry.decl });
	}

	for (const [fromPath, entries] of byFile) {
		lines.push(`-- ── from ${fromPath} ──`);
		const seen = new Set<string>();
		for (const { decl } of entries) {
			if (seen.has(decl.name)) continue;
			seen.add(decl.name);

			const params = decl.typeParams.length ? `<${decl.typeParams.join(", ")}>` : "";

			if (isBarelyRecursive(decl.name, decl.body)) {
				lines.push(`export type ${decl.name}${params} = any -- ⚠ bare recursive type`);
				lines.push("");
				continue;
			}

			const remappedBody = remapRefs(decl.body, aliasMap);
			const selfType = decl.typeParams.length
				? mkRef(decl.name, decl.typeParams.map((p) => mkRef(p)))
				: mkRef(decl.name);
			const bodyStr = emitTypeBody(remappedBody, selfType);
			lines.push(`export type ${decl.name}${params} = ${bodyStr}`);
			lines.push("");
		}
	}

	lines.push("return {}");
	lines.push("");

	return lines.join("\n");
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
