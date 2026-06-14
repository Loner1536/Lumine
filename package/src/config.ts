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
