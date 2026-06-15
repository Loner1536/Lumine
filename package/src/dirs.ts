/**
 * dirs.ts
 *
 * Per-directory type aggregation.  For each output directory that contains
 * typed .luau files, generates a single `_lumine_types.luau` that re-declares
 * every exported type from every file in that directory.
 *
 * Types within the same directory reference each other by bare name (they all
 * live in the same file, so Luau resolves them locally — no require needed).
 * Types from other directories are accessed via `local _Types_xxx = require(…)`
 * pointing at that directory's own `_lumine_types.luau`.
 *
 * This cleanly breaks every cross-file require cycle: `_lumine_types.luau`
 * never requires any individual source file from its own directory.
 */
import { createHash } from "crypto";
import { join, relative, dirname, basename } from "path";
import type { TypeDecl } from "./types";
import { mkRef, type LuauType } from "./luau-types";
import { isBarelyRecursive, emitTypeBody } from "./emit";
import { resolveRojoPath, buildDirectRequire, buildRelativeRequire } from "./rojo";

// ── LuauType ref scanner ──────────────────────────────────────────────────────

function collectRefs(t: LuauType, out: Set<string>): void {
	switch (t.kind) {
		case "reference":
			if (!t.name.startsWith("_Lumine.") && /^[A-Z]/.test(t.name)) out.add(t.name);
			t.args?.forEach((a) => collectRefs(a, out));
			break;
		case "optional": collectRefs(t.inner, out); break;
		case "union":
		case "intersection": t.members.forEach((m) => collectRefs(m, out)); break;
		case "table":
			t.fields.forEach((f) => collectRefs(f.type, out));
			if (t.indexer) { collectRefs(t.indexer.key, out); collectRefs(t.indexer.value, out); }
			break;
		case "function":
			t.params.forEach((p) => collectRefs(p.type, out));
			collectRefs(t.returns, out);
			break;
		case "tuple": t.elements.forEach((e) => collectRefs(e, out)); break;
		case "keyof": collectRefs(t.inner, out); break;
	}
}

// ── LuauType ref remapper ─────────────────────────────────────────────────────

function remapRefs(t: LuauType, aliases: Map<string, string>): LuauType {
	switch (t.kind) {
		case "reference": {
			const aliased = aliases.get(t.name);
			const name = aliased ?? t.name;
			const args = t.args?.map((a) => remapRefs(a, aliases));
			return { kind: "reference", name, args };
		}
		case "optional": return { kind: "optional", inner: remapRefs(t.inner, aliases) };
		case "union": return { kind: "union", members: t.members.map((m) => remapRefs(m, aliases)) };
		case "intersection": return { kind: "intersection", members: t.members.map((m) => remapRefs(m, aliases)) };
		case "table": return {
			kind: "table",
			fields: t.fields.map((f) => ({ ...f, type: remapRefs(f.type, aliases) })),
			indexer: t.indexer ? { key: remapRefs(t.indexer.key, aliases), value: remapRefs(t.indexer.value, aliases) } : undefined,
		};
		case "function": return {
			kind: "function",
			params: t.params.map((p) => ({ ...p, type: remapRefs(p.type, aliases) })),
			returns: remapRefs(t.returns, aliases),
		};
		case "tuple": return { kind: "tuple", elements: t.elements.map((e) => remapRefs(e, aliases)) };
		case "keyof": return { kind: "keyof", inner: remapRefs(t.inner, aliases) };
		default: return t;
	}
}

// ── Module require builder ────────────────────────────────────────────────────

function buildModuleRequire(
	rojoProject: string,
	sourcePath: string,
	currentFilePath: string,
	cwd: string,
): string {
	const resolution = resolveRojoPath(rojoProject, sourcePath, cwd);
	if (resolution) return buildDirectRequire(resolution);
	return buildRelativeRequire(currentFilePath, sourcePath);
}

// ── Per-directory type module generator ──────────────────────────────────────

export interface DirEntry {
	from: string;         // absolute path of the source .luau file
	decl: TypeDecl;       // decl.name = exported name (may be Prefix_Name for conflicts)
	originalName: string; // original TS type name before any conflict renaming
}

/**
 * Generate the content of `_lumine_types.luau` for one directory.
 *
 * `dirPath`          — absolute path of the directory
 * `entries`          — all (file, typeDecl) pairs whose source file lives in dirPath
 * `globalTypeOrigins`— maps typeName → source .luau file (pre-update, still pointing at source files)
 * `rojoProject`      — absolute path to rojo project JSON
 * `cwd`              — process cwd (for relative path display)
 */
export function generateDirTypesModule(
	dirPath: string,
	entries: DirEntry[],
	globalTypeOrigins: Map<string, string>,
	rojoProject: string,
	cwd: string,
): string {
	const dirTypeNames = new Set(entries.map((e) => e.decl.name));
	const typesFilePath = join(dirPath, "_lumine_types.luau");

	// ── Scan all type bodies for external refs ────────────────────────────────
	const allRefs = new Set<string>();
	for (const { decl } of entries) {
		collectRefs(decl.body, allRefs);
		for (const def of decl.typeParamDefaults) {
			if (def) collectRefs(def, allRefs);
		}
	}

	// ── Group external deps by their source directory ─────────────────────────
	// (external = referenced but not declared in this directory)
	const requireGroups = new Map<string, { localVar: string }>();
	const aliasMap = new Map<string, string>();

	// Same-dir conflict renames: originalName → exportedName for types that were
	// renamed due to naming conflicts. Applied before cross-dir lookups so that
	// body references like { item: Entry } become { item: FileName_Entry }.
	for (const { decl, originalName } of entries) {
		if (originalName !== decl.name) {
			aliasMap.set(originalName, decl.name);
		}
	}

	for (const name of allRefs) {
		if (dirTypeNames.has(name)) continue;
		// Check if the ref matches an original (pre-rename) name — handled above
		if (aliasMap.has(name)) continue;
		const originFile = globalTypeOrigins.get(name);
		if (!originFile) continue;
		const originDir = dirname(originFile);
		if (originDir === dirPath) continue;

		let group = requireGroups.get(originDir);
		if (!group) {
			const uid = createHash("sha1").update(originDir).digest("hex").slice(0, 8);
			group = { localVar: `_Types_${uid}` };
			requireGroups.set(originDir, group);
		}
		aliasMap.set(name, `${group.localVar}.${name}`);
	}

	// ── Build output ──────────────────────────────────────────────────────────
	const lines: string[] = [];
	lines.push(`-- [lumine dir types] ${relative(cwd, dirPath)}/`);
	lines.push("");

	for (const [extDirPath, group] of requireGroups) {
		const extTypesFile = join(extDirPath, "_lumine_types.luau");
		lines.push(`local ${group.localVar} = ${buildModuleRequire(rojoProject, extTypesFile, typesFilePath, cwd)}`);
	}
	if (requireGroups.size > 0) lines.push("");

	// Group entries by source file for readable section headers
	const byFile = new Map<string, DirEntry[]>();
	for (const entry of entries) {
		let arr = byFile.get(entry.from);
		if (!arr) { arr = []; byFile.set(entry.from, arr); }
		arr.push(entry);
	}

	for (const [fromPath, fileEntries] of byFile) {
		lines.push(`-- ${basename(fromPath)}`);
		const seen = new Set<string>();
		for (const { decl } of fileEntries) {
			if (seen.has(decl.name)) continue;
			seen.add(decl.name);

			const params = decl.typeParams.length ? `<${decl.typeParams.join(", ")}>` : "";

			if (isBarelyRecursive(decl.name, decl.body)) {
				lines.push(`export type ${decl.name}${params} = any -- ⚠ bare recursive type`);
				lines.push("");
				continue;
			}

			const remapped = remapRefs(decl.body, aliasMap);
			const selfType = decl.typeParams.length
				? mkRef(decl.name, decl.typeParams.map((p) => mkRef(p)))
				: mkRef(decl.name);
			lines.push(`export type ${decl.name}${params} = ${emitTypeBody(remapped, selfType)}`);
			lines.push("");
		}
	}

	lines.push("return {}");
	lines.push("");

	return lines.join("\n");
}
