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
  lumine            Run once — annotate all .luau files in outDir
  lumine --watch    Watch mode — re-annotate on .luau changes (incremental)
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

function runInit() {
    const tsconfigPath = join(process.cwd(), "tsconfig.json");
    if (!existsSync(tsconfigPath)) { console.error("[lumine] error: tsconfig.json not found"); process.exit(1); }

    const raw = readFileSync(tsconfigPath, "utf-8");
    if (raw.includes('"declaration"')) {
        console.log('[lumine] tsconfig.json already has "declaration" set');
    } else {
        writeFileSync(
            tsconfigPath,
            raw.replace(/"compilerOptions"\s*:\s*\{/, `"compilerOptions": {\n        "declaration": true,`),
            "utf-8",
        );
        console.log('[lumine] added "declaration": true to tsconfig.json');
    }

    const luminePath = join(process.cwd(), "lumine.toml");
    if (!existsSync(luminePath)) {
        writeFileSync(luminePath, `includeDir = "out/include"\n`, "utf-8");
        console.log("[lumine] created lumine.toml");
    }

    console.log("\n[lumine] setup complete. Run your compiler then: lumine");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) printHelp();
else if (args.includes("--version") || args.includes("-v")) console.log(VERSION);
else if (args.includes("init")) runInit();
else if (args.includes("--watch") || args.includes("-w")) runWatch();
else if (args.includes("--dry-run")) runOnce(true);
else runOnce();
