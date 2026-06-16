import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
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

interface RojoNode {
	$path?: string;
	[key: string]: unknown;
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

/**
 * rbxtsc's include path (-i flag) is independent of tsconfig's outDir, so it
 * can't be derived from outDir alone. The rojo project file is the one place
 * that records where the include folder actually lives on disk — walk its
 * tree and find the $path whose target already contains RuntimeLib.lua
 * (always emitted by rbxtsc into the real include dir).
 */
function findIncludeDirFromRojo(rojoProjectPath: string): string | null {
	if (!rojoProjectPath || !existsSync(rojoProjectPath)) return null;

	let project: { tree?: RojoNode };
	try {
		project = JSON.parse(readFileSync(rojoProjectPath, "utf-8"));
	} catch {
		return null;
	}
	if (!project.tree) return null;

	const projectDir = dirname(rojoProjectPath);

	function walk(node: RojoNode): string | null {
		for (const [key, value] of Object.entries(node)) {
			if (key.startsWith("$") || typeof value !== "object" || value === null) continue;
			const child = value as RojoNode;
			if (child.$path) {
				const fsPath = resolve(projectDir, child.$path);
				if (existsSync(join(fsPath, "RuntimeLib.lua"))) return fsPath;
			}
			const found = walk(child);
			if (found) return found;
		}
		return null;
	}

	return walk(project.tree);
}

function findRojoProject(cwd: string): string {
	const defaultPath = join(cwd, "default.project.json");
	if (existsSync(defaultPath)) return defaultPath;

	try {
		const found = readdirSync(cwd).find(
			(f) => f.endsWith(".project.json") && f !== "default.project.json",
		);
		if (found) return join(cwd, found);
	} catch {
		/* ignore */
	}

	return "";
}

export function loadConfig(cwd: string = process.cwd()): LumineConfig {
	const tsconfig = parseTsConfig(cwd);
	const lumine = parseLumineToml(cwd);
	const opts = tsconfig.compilerOptions ?? {};

	const outDir = resolve(cwd, opts.outDir ?? "out");
	const rootDir = resolve(cwd, opts.rootDir ?? "src");
	const declaration = opts.declaration ?? false;
	const rojoProject = findRojoProject(cwd);

	const includeDir = lumine.includeDir
		? resolve(cwd, lumine.includeDir)
		: findIncludeDirFromRojo(rojoProject) ?? resolve(outDir, "..", "include");

	if (!declaration) {
		console.warn(
			`[lumine] warning: no "declaration": true in tsconfig.json\n` +
				`  running in fallback mode — some types will be inferred as any`,
		);
	}

	return { outDir, rootDir, declaration, includeDir, rojoProject };
}
