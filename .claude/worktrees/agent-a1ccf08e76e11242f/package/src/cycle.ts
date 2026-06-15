/**
 * cycle.ts
 *
 * Detects circular type dependencies across .luau files and groups them
 * into shared modules to break cycles.
 */
import { createHash } from "crypto";
import { relative, dirname, join } from "path";
import type { TypeManifest, TypeDecl } from "./types";
import type { LuauType } from "./luau-types";

// ── Exported types ────────────────────────────────────────────────────────────

export interface ResolvedCycleGroup {
	sharedFilePath: string;
	participants: Set<string>;
	liftedTypeNames: Set<string>;
	entries: Array<{ from: string; decl: TypeDecl }>;
}

// ── Ref scanning ──────────────────────────────────────────────────────────────

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

function collectManifestRefs(manifest: TypeManifest): Set<string> {
	const refs = new Set<string>();
	for (const sig of Object.values(manifest.functions)) {
		sig.params.forEach((p) => collectRefsFromType(p.type, refs));
		collectRefsFromType(sig.returnType, refs);
	}
	for (const decl of Object.values(manifest.types)) {
		collectRefsFromType(decl.body, refs);
		for (const def of decl.typeParamDefaults) {
			if (def) collectRefsFromType(def, refs);
		}
	}
	return refs;
}

// ── Graph building ────────────────────────────────────────────────────────────

export function buildRequireGraph(
	manifests: Map<string, TypeManifest>,
	globalTypeOrigins: Map<string, string>,
): Map<string, Set<string>> {
	const graph = new Map<string, Set<string>>();

	for (const [luauPath, manifest] of manifests) {
		const deps = new Set<string>();
		const refs = collectManifestRefs(manifest);
		const ownTypes = new Set(Object.values(manifest.types).map((d) => d.name));

		for (const name of refs) {
			if (ownTypes.has(name)) continue;
			const origin = globalTypeOrigins.get(name);
			if (origin && origin !== luauPath) deps.add(origin);
		}

		graph.set(luauPath, deps);
	}

	return graph;
}

// ── Tarjan's SCC ──────────────────────────────────────────────────────────────

export function findSCCs(graph: Map<string, Set<string>>): string[][] {
	const index = new Map<string, number>();
	const lowlink = new Map<string, number>();
	const onStack = new Map<string, boolean>();
	const stack: string[] = [];
	const sccs: string[][] = [];
	let counter = 0;

	function strongconnect(v: string): void {
		index.set(v, counter);
		lowlink.set(v, counter);
		counter++;
		stack.push(v);
		onStack.set(v, true);

		for (const w of graph.get(v) ?? []) {
			if (!index.has(w)) {
				strongconnect(w);
				lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
			} else if (onStack.get(w)) {
				lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
			}
		}

		if (lowlink.get(v) === index.get(v)) {
			const scc: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				onStack.set(w, false);
				scc.push(w);
			} while (w !== v);
			if (scc.length > 1) sccs.push(scc);
		}
	}

	for (const v of graph.keys()) {
		if (!index.has(v)) strongconnect(v);
	}

	return sccs;
}

// ── LCA directory ─────────────────────────────────────────────────────────────

function lcaDir(paths: string[]): string {
	if (paths.length === 0) return "";
	const parts = paths.map((p) => dirname(p).split("/"));
	const first = parts[0];
	let len = first.length;
	for (let i = 1; i < parts.length; i++) {
		const p = parts[i];
		let j = 0;
		while (j < len && j < p.length && first[j] === p[j]) j++;
		len = j;
	}
	return first.slice(0, len).join("/") || "/";
}

function stableHash8(participants: string[]): string {
	const sorted = [...participants].sort();
	return createHash("sha1").update(sorted.join("|")).digest("hex").slice(0, 8);
}

// ── Full pipeline ─────────────────────────────────────────────────────────────

export function detectCycleGroups(
	manifests: Map<string, TypeManifest>,
	globalTypeOrigins: Map<string, string>,
	cwd: string,
): ResolvedCycleGroup[] {
	const graph = buildRequireGraph(manifests, globalTypeOrigins);
	const sccs = findSCCs(graph);
	const result: ResolvedCycleGroup[] = [];

	for (const scc of sccs) {
		const participants = new Set(scc);
		const hash8 = stableHash8(scc);
		const lca = lcaDir(scc);
		const sharedFilePath = join(lca, `_lumine_shared_${hash8}.luau`);

		const liftedTypeNames = new Set<string>();
		const entries: Array<{ from: string; decl: TypeDecl }> = [];
		const seenNames = new Set<string>();

		for (const filePath of scc) {
			const manifest = manifests.get(filePath);
			if (!manifest) continue;
			const fromRel = relative(cwd, filePath);

			for (const decl of Object.values(manifest.types)) {
				if (seenNames.has(decl.name)) continue;
				seenNames.add(decl.name);
				liftedTypeNames.add(decl.name);
				entries.push({ from: fromRel, decl });
			}
		}

		result.push({ sharedFilePath, participants, liftedTypeNames, entries });
	}

	return result;
}
