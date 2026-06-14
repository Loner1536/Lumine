#!/usr/bin/env bun
import {
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    writeFileSync,
    readFileSync,
    watch,
} from "fs";
import { join, relative } from "path";
import { loadConfig } from "./config";
import { extractManifest } from "./extract";
import { annotateFile } from "./annotate";
import { generateTypesFile } from "./emit";
import type { TypeManifest } from "./types";

const VERSION = "0.1.0";

function printHelp() {
    console.log(`lumine v${VERSION}
Luau type annotation tool for compiled roblox-ts / rotor projects.

Usage:
  lumine            Run once — annotate all .luau files in outDir
  lumine --watch    Watch mode — re-annotate on .luau changes
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

async function runOnce(dryRun = false) {
    const config = loadConfig();
    const { outDir, declaration, typesOutput, rojoProject } = config;

    if (!existsSync(outDir)) {
        console.error(
            `[lumine] error: outDir "${outDir}" does not exist — run your compiler first`,
        );
        process.exit(1);
    }

    const luauFiles = walkLuau(outDir);
    if (luauFiles.length === 0) {
        console.log("[lumine] no .luau files found");
        return;
    }

    console.log(`[lumine] found ${luauFiles.length} .luau files`);

    // ── Phase 1: Extract manifests ─────────────────────────────────────────────
    const manifests = new Map<string, TypeManifest>();
    const allManifests: TypeManifest[] = [];

    if (declaration) {
        for (const luauPath of luauFiles) {
            const dtsPath = dtsPathFor(luauPath);
            if (!existsSync(dtsPath)) continue;
            const manifest = extractManifest(dtsPath);
            manifests.set(luauPath, manifest);
            allManifests.push(manifest);
        }
        console.log(`[lumine] extracted types from ${manifests.size} .d.ts files`);
    }

    // ── Phase 2: Emit generated.types.luau ────────────────────────────────────
    const typesFileContent = generateTypesFile(allManifests);
    const typesDir = join(outDir, typesOutput);
    const typesFilePath = join(typesDir, "generated.types.luau");

    if (typesFileContent && !dryRun) {
        mkdirSync(typesDir, { recursive: true });
        writeFileSync(typesFilePath, typesFileContent, "utf-8");
        console.log(`[lumine] wrote ${relative(process.cwd(), typesFilePath)}`);
    }

    // ── Phase 3: Annotate .luau files ─────────────────────────────────────────
    let totalAnnotated = 0;
    let totalSkipped = 0;

    for (const luauPath of luauFiles) {
        if (luauPath === typesFilePath) continue;

        const manifest = manifests.get(luauPath) ?? { functions: {}, types: {} };
        const source = readFileSync(luauPath, "utf-8");
        const result = annotateFile(source, luauPath, manifest, rojoProject, typesOutput);

        totalAnnotated += result.annotated;
        totalSkipped += result.skipped;

        if (result.annotated > 0) {
            if (!dryRun) writeFileSync(luauPath, result.source, "utf-8");
            console.log(
                `[lumine] ${relative(process.cwd(), luauPath)} — ${result.annotated} annotated` +
                (result.skipped > 0 ? `, ${result.skipped} skipped` : ""),
            );
        }
    }

    console.log(`\n[lumine] done — ${totalAnnotated} functions annotated, ${totalSkipped} skipped`);
    if (dryRun) console.log("[lumine] dry run — no files written");
}

async function runWatch() {
    const config = loadConfig();
    console.log(`[lumine] watching ${config.outDir} for changes...`);
    await runOnce();

    let debounce: ReturnType<typeof setTimeout> | null = null;

    watch(config.outDir, { recursive: true }, (_event, filename) => {
        if (!filename?.endsWith(".luau")) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(async () => {
            console.log(`\n[lumine] change detected — re-annotating...`);
            await runOnce();
        }, 150);
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
        writeFileSync(luminePath, `typesOutput = "shared/__generated__"\n`, "utf-8");
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
