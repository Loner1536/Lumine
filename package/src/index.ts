#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, relative, dirname, resolve } from "path";
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
  lumine               Run once — annotate all .luau files in outDir
  lumine -w, --watch   Watch mode — re-annotate on .luau changes
  lumine --dry-run     Show what would be annotated without writing
  lumine --verbose     Show per-file annotation logs
  lumine -v, --version Print version
  lumine -h, --help    Show this help`);
}

const VENDOR_DIR_NAMES = new Set(["_Index", "include", "node_modules", "packages", "Packages", "rbxts_include"]);

function isInsidePath(path: string, parent: string): boolean {
    const rel = relative(parent, path);
    return rel !== "" && !rel.startsWith("..");
}

function walkLuau(dir: string, ignoredDirs: Set<string> = new Set()): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            const resolved = resolve(full);
            if (VENDOR_DIR_NAMES.has(entry) || ignoredDirs.has(resolved)) continue;
            results.push(...walkLuau(full, ignoredDirs));
        }
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

function hasChangedFiles(
    dir: string,
    knownHashes: Map<string, string>,
    ignoredDirs: Set<string> = new Set(),
): boolean {
    if (!existsSync(dir)) return false;
    for (const path of walkLuau(dir, ignoredDirs)) {
        const current = hashFile(path);
        if (!knownHashes.has(path) || current !== knownHashes.get(path)) return true;
    }
    return false;
}

function getIgnoredDirs(outDir: string, includeDir: string): Set<string> {
    const ignored = new Set<string>();
    const resolvedOutDir = resolve(outDir);
    const resolvedIncludeDir = resolve(includeDir);
    if (isInsidePath(resolvedIncludeDir, resolvedOutDir)) ignored.add(resolvedIncludeDir);
    return ignored;
}

// ── Lumine.lua generation ─────────────────────────────────────────────────────

function ensureLumineFile(
    lumineFilePath: string,
    dryRun: boolean,
    log: (...args: Parameters<typeof console.log>) => void,
): void {
    const content = generateLumineFile();
    if (hashString(content) === hashFile(lumineFilePath)) return;
    if (!dryRun) {
        mkdirSync(dirname(lumineFilePath), { recursive: true });
        writeFileSync(lumineFilePath, content, "utf-8");
        log(`[lumine] wrote ${lumineFilePath}`);
    }
}

// ── Core run ──────────────────────────────────────────────────────────────────

interface RunContext {
    dryRun?: boolean;
    verbose?: boolean;
    fileCache?: Map<string, FileCache>;
    manifestCache?: Map<string, ManifestCache>;
    diskHashes?: Map<string, string>;
}

async function run(ctx: RunContext = {}) {
    const cwd = process.cwd();
    const config = loadConfig(cwd);
    const { outDir, declaration, rojoProject, includeDir } = config;
    const { dryRun = false, verbose = false, fileCache, manifestCache, diskHashes } = ctx;
    const lumineFilePath = join(includeDir, "Lumine.lua");
    const ignoredDirs = getIgnoredDirs(outDir, includeDir);
    const log = (...args: Parameters<typeof console.log>) => { if (verbose) console.log(...args); };

    if (!existsSync(outDir)) {
        console.error(`[lumine] error: outDir "${outDir}" does not exist — run your compiler first`);
        process.exit(1);
    }

    ensureLumineFile(lumineFilePath, dryRun, log);

    const luauFiles = walkLuau(outDir, ignoredDirs).filter(f => f !== lumineFilePath);
    if (luauFiles.length === 0) { log("[lumine] no .luau files found"); return; }

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
            log(`[lumine] ${dtsChangedCount} .d.ts changed, ${manifests.size - dtsChangedCount} cached`);
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
                log(
                    `[lumine] ${relative(cwd, luauPath)} — ${result.annotated} annotated` +
                    (result.skipped > 0 ? `, ${result.skipped} skipped` : ""),
                );
            } else {
                log(`[lumine] ${relative(cwd, luauPath)} — types injected`);
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

async function runOnce(dryRun = false, verbose = false) { await run({ dryRun, verbose }); }

async function runWatch(verbose = false) {
    const cwd = process.cwd();
    const { outDir, includeDir } = loadConfig(cwd);
    const ignoredDirs = getIgnoredDirs(outDir, includeDir);

    const fileCache = new Map<string, FileCache>();
    const manifestCache = new Map<string, ManifestCache>();
    const diskHashes = new Map<string, string>();

    console.log(`[lumine] watching ${outDir} for changes...`);

    // Initial pass: annotate everything rbxtsc has already compiled so we're
    // in sync from the start. run() populates diskHashes for each file it
    // touches, so the poll below only fires on genuinely new rbxtsc writes.
    // If outDir doesn't exist yet (rbxtsc hasn't done its first build), skip —
    // the poll will catch the first batch of files once they appear.
    if (existsSync(outDir)) {
        await run({ fileCache, manifestCache, diskHashes, verbose });
    }

    let running = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = setInterval(() => {
        if (running) return;
        if (!hasChangedFiles(outDir, diskHashes, ignoredDirs)) return;
        if (debounceTimer) return; // already scheduled — let it fire

        // 800ms quiet-period: rbxtsc writes multiple files incrementally;
        // firing after the first write would annotate a half-written output.
        debounceTimer = setTimeout(async () => {
            if (running) return;
            running = true;
            console.log(`\n[lumine] change detected — re-annotating...`);
            try {
                await run({ fileCache, manifestCache, diskHashes, verbose });
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

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
if (args.includes("--help") || args.includes("-h")) printHelp();
else if (args.includes("--version") || args.includes("-v")) console.log(VERSION);
else if (args.includes("--watch") || args.includes("-w")) runWatch(verbose);
else if (args.includes("--dry-run")) runOnce(true, verbose);
else runOnce(false, verbose);
