import { existsSync, readFileSync } from "fs";
import { resolve, relative, dirname, basename } from "path";

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
	if (!rojoProjectPath || !existsSync(rojoProjectPath)) return null;

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

export function buildDirectRequire(resolution: RojoResolution): string {
	let path = `game:GetService("${resolution.service}")`;
	for (const seg of resolution.segments) {
		path += `:WaitForChild("${seg}")`;
	}
	return `require(${path})`;
}

/**
 * Build a require() using only relative script-tree navigation.
 * Used as a fallback when no .project.json exists.
 *
 * e.g. from  out/transport/queue.luau  →  out/type.luau
 *   script.Parent = transport folder
 *   .Parent       = out folder
 *   :WaitForChild("type")
 * → require(script.Parent.Parent:WaitForChild("type"))
 */
export function buildRelativeRequire(fromFilePath: string, toFilePath: string): string {
	const fromBase = basename(fromFilePath).replace(/\.luau?$/, "");
	const isInit = fromBase === "init" || fromBase === "index";

	const fromDir = dirname(fromFilePath);
	const rel = relative(fromDir, toFilePath)
		.replace(/\\/g, "/")
		.replace(/\.luau?$/, "");

	const parts = rel.split("/");
	// init.luau's `script` IS the folder; regular files need .Parent to reach their folder
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
