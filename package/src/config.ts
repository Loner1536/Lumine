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
    typesOutput?: string;
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
            if (key === "typesOutput") result.typesOutput = value;
        }
    }
    return result;
}

function findRojoProject(cwd: string): string {
    const candidates = ["default.project.json", "*.project.json"];
    for (const name of candidates) {
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
    const typesOutput = lumine.typesOutput ?? "shared/__generated__";
    const rojoProject = findRojoProject(cwd);

    if (!declaration) {
        console.warn(
            `[lumine] warning: no .d.ts files found\n` +
            `  add "declaration": true to tsconfig.json for full type coverage\n` +
            `  running in fallback mode — some types will be inferred as any`,
        );
    }

    return { outDir, rootDir, declaration, typesOutput, rojoProject };
}
