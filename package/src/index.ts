#!/usr/bin/env bun

import {
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    writeFileSync,
    readFileSync,
    renameSync,
} from "fs";
import { createHash } from "crypto";
import { join, relative, dirname, basename } from "path";
import { loadConfig } from "./config";
import { extractManifest } from "./extract";
import { annotateFile } from "./annotate";
import { generateLumineFile } from "./emit";
import { generateDirTypesModule } from "./dirs";
import type { TypeManifest, AnnotationResult, TypeDecl } from "./types";

const VERSION = "0.2.2";

function printHelp() {
    console.log(`lumine v${VERSION}
Luau type annotation tool for compiled roblox-ts / rotor projects.

Usage:
  lumine                      Run once — annotate all .luau files in outDir
  lumine -w, --watch          Watch mode — re-annotate on .luau changes
  lumine --dry-run            Show what would be annotated without writing
  lumine --verbose            Log each annotated file (also works with --watch)
  lumine -v, --version        Print version
  lumine -h, --help           Show this help`);
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

function walkDts(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) results.push(...walkDts(full));
        else if (entry.endsWith(".d.ts")) results.push(full);
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

// Atomic write: write to a temp file then rename so the target is never in a
// partially-written state. Preserves the original file's permission mode.
function safeWrite(filePath: string, content: string): void {
    let mode = 0o644;
    if (existsSync(filePath)) {
        try {
            mode = statSync(filePath).mode & 0o777;
        } catch {
            /* use default */
        }
    }
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, content, { encoding: "utf-8", mode });
    renameSync(tmp, filePath);
}

// Convert a kebab/snake_case luau filename stem to PascalCase for use as a
// conflict-resolution prefix. "player-controller" → "PlayerController".
function filePrefix(luauPath: string): string {
    return basename(luauPath, ".luau")
        .split(/[-_.]/)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("");
}

// ── Cache types ───────────────────────────────────────────────────────────────

interface FileCache {
    dtsHash: string;
    result: Omit<AnnotationResult, "filePath">;
}

interface ManifestCache {
    dtsHash: string;
    manifest: TypeManifest;
}

// ── Change detection ──────────────────────────────────────────────────────────

function hasDtsChanges(dir: string, knownMtimes: Map<string, number>): boolean {
    if (!existsSync(dir)) return false;
    const current = walkDts(dir);
    for (const path of current) {
        const mtime = statSync(path).mtimeMs;
        if (!knownMtimes.has(path) || mtime !== knownMtimes.get(path)) return true;
    }
    for (const path of knownMtimes.keys()) {
        if (!existsSync(path)) return true;
    }
    return false;
}

function snapshotDtsMtimes(dir: string): Map<string, number> {
    const map = new Map<string, number>();
    if (!existsSync(dir)) return map;
    for (const path of walkDts(dir)) {
        map.set(path, statSync(path).mtimeMs);
    }
    return map;
}

function hasLumineTypesDeleted(expectedTypesFiles: Set<string>): boolean {
    for (const typesFile of expectedTypesFiles) {
        if (!existsSync(typesFile)) return true;
    }
    return false;
}

// ── Lumine.lua generation ─────────────────────────────────────────────────────

function ensureLumineFile(lumineFilePath: string, dryRun: boolean, verbose: boolean): void {
    const content = generateLumineFile();
    if (hashString(content) === hashFile(lumineFilePath)) return;
    if (!dryRun) {
        mkdirSync(dirname(lumineFilePath), { recursive: true });
        safeWrite(lumineFilePath, content);
        if (verbose) console.log(`[lumine] wrote ${lumineFilePath}`);
    }
}

// ── Core run ──────────────────────────────────────────────────────────────────

interface RunContext {
    dryRun?: boolean;
    verbose?: boolean;
    fileCache?: Map<string, FileCache>;
    manifestCache?: Map<string, ManifestCache>;
}

async function run(ctx: RunContext = {}) {
    const cwd = process.cwd();
    const config = loadConfig(cwd);
    const { outDir, declaration, rojoProject, includeDir } = config;
    const { dryRun = false, verbose = false, fileCache, manifestCache } = ctx;
    const lumineFilePath = join(includeDir, "Lumine.lua");

    if (!existsSync(outDir)) {
        console.error(
            `[lumine] error: outDir "${outDir}" does not exist — run your compiler first`,
        );
        process.exit(1);
    }

    ensureLumineFile(lumineFilePath, dryRun, verbose);

    const luauFiles = walkLuau(outDir).filter(
        (f) => f !== lumineFilePath && basename(f) !== "_lumine_types.luau",
    );
    if (luauFiles.length === 0) {
        console.log("[lumine] no .luau files found");
        return { typesFiles: new Set<string>() };
    }

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
        if (verbose && dtsChangedCount > 0) {
            console.log(
                `[lumine] ${dtsChangedCount} .d.ts changed, ${manifests.size - dtsChangedCount} cached`,
            );
        }
    }

    // ── Build global type origin map (initial — source files) ────────────────
    const globalTypeOrigins = new Map<string, string>();
    const globalTypeDecls = new Map<string, TypeDecl>();
    for (const [luauPath, m] of manifests.entries()) {
        for (const decl of Object.values(m.types)) {
            if (!globalTypeOrigins.has(decl.name)) {
                globalTypeOrigins.set(decl.name, luauPath);
                globalTypeDecls.set(decl.name, decl);
            }
        }
    }

    // ── Phase 0: Generate per-directory _lumine_types.luau ───────────────────

    // Step A: Collect raw type declarations per directory (no dedup yet)
    const dirRawTypes = new Map<string, Array<{ from: string; decl: TypeDecl }>>();
    for (const [luauPath, manifest] of manifests.entries()) {
        const dir = dirname(luauPath);
        if (!dirRawTypes.has(dir)) dirRawTypes.set(dir, []);
        for (const decl of Object.values(manifest.types)) {
            dirRawTypes.get(dir)!.push({ from: luauPath, decl });
        }
    }

    // Step B: Detect cross-file naming conflicts and build per-file export maps.
    // Conflicting types get a PascalCase filename prefix: Entry → FileName_Entry.
    // fileExportNames: luauPath → Map<originalName, exportedName>
    const fileExportNames = new Map<string, Map<string, string>>();
    for (const [, rawTypes] of dirRawTypes) {
        const nameToFiles = new Map<string, Set<string>>();
        for (const { from, decl } of rawTypes) {
            if (!nameToFiles.has(decl.name)) nameToFiles.set(decl.name, new Set());
            nameToFiles.get(decl.name)!.add(from);
        }
        for (const [name, files] of nameToFiles) {
            if (files.size <= 1) continue;
            for (const filePath of files) {
                if (!fileExportNames.has(filePath)) fileExportNames.set(filePath, new Map());
                const prefix = filePrefix(filePath);
                fileExportNames.get(filePath)!.set(name, `${prefix}_${name}`);
                if (verbose) {
                    console.warn(
                        `[lumine] conflict: type "${name}" in ${relative(cwd, filePath)} ` +
                        `renamed to "${prefix}_${name}" in _lumine_types.luau`,
                    );
                }
            }
        }
    }

    // Global original→exported map (first-file-wins) used by files that
    // reference a conflicting type but don't declare it themselves.
    const globalOriginalToExported = new Map<string, string>();
    for (const [luauPath, fileMap] of fileExportNames) {
        for (const [orig, exported] of fileMap) {
            if (!globalOriginalToExported.has(orig)) {
                globalOriginalToExported.set(orig, exported);
                // Log the conflict (once, from the first owning file)
                if (!verbose) {
                    console.warn(
                        `[lumine] conflict: type "${orig}" appears in multiple files — ` +
                        `prefixed with source filename in _lumine_types.luau ` +
                        `(run --verbose to see all)`,
                    );
                }
            }
        }
    }

    // Step C: Build deduped dirEntries with renamed decl.name and originalName.
    const dirEntries = new Map<
        string,
        Array<{ from: string; decl: TypeDecl; originalName: string }>
    >();
    for (const [dir, rawTypes] of dirRawTypes) {
        const entries: Array<{ from: string; decl: TypeDecl; originalName: string }> = [];
        const seenExported = new Set<string>();
        for (const { from, decl } of rawTypes) {
            const fileMap = fileExportNames.get(from);
            const exportedName = fileMap?.get(decl.name) ?? decl.name;
            if (seenExported.has(exportedName)) continue;
            seenExported.add(exportedName);
            const renamedDecl = exportedName !== decl.name ? { ...decl, name: exportedName } : decl;
            entries.push({ from, decl: renamedDecl, originalName: decl.name });
        }
        dirEntries.set(dir, entries);
    }

    const typesFiles = new Set<string>();
    for (const [dirPath, entries] of dirEntries) {
        if (entries.length === 0) continue;
        const typesFilePath = join(dirPath, "_lumine_types.luau");
        typesFiles.add(typesFilePath);
        const content = generateDirTypesModule(
            dirPath,
            entries,
            globalTypeOrigins,
            rojoProject,
            cwd,
        );
        const contentHash = hashString(content);
        if (contentHash !== hashFile(typesFilePath)) {
            if (!dryRun) {
                mkdirSync(dirname(typesFilePath), { recursive: true });
                safeWrite(typesFilePath, content);
            }
            if (verbose) console.log(`[lumine] wrote ${relative(cwd, typesFilePath)}`);
        }
        // Update origins to point at _lumine_types.luau (keyed by exported name)
        for (const { decl } of entries) {
            globalTypeOrigins.set(decl.name, typesFilePath);
        }
        // Update globalTypeDecls with exported names so fillTypeParamDefaults works
        for (const { decl } of entries) {
            globalTypeDecls.set(decl.name, decl);
        }
    }

    // ── Build per-file type name resolution maps ──────────────────────────────
    // Each file gets a map: originalName → exportedName. Owning files get their
    // file-specific rename; all others get the global first-wins rename as fallback.
    const fileResolvedNames = new Map<string, Map<string, string>>();
    for (const luauPath of luauFiles) {
        const fileMap = fileExportNames.get(luauPath);
        if (!fileMap && globalOriginalToExported.size === 0) continue;
        const resolved = new Map(globalOriginalToExported);
        if (fileMap) {
            for (const [orig, exp] of fileMap) resolved.set(orig, exp);
        }
        fileResolvedNames.set(luauPath, resolved);
    }

    // ── Build extractedByFile map ─────────────────────────────────────────────
    // Maps each source .luau path → set of ORIGINAL type names extracted from it.
    const extractedByFile = new Map<string, Set<string>>();
    for (const [, entries] of dirEntries) {
        for (const { from, originalName } of entries) {
            let s = extractedByFile.get(from);
            if (!s) {
                s = new Set();
                extractedByFile.set(from, s);
            }
            s.add(originalName);
        }
    }

    // ── Phase 2: Annotate .luau files ────────────────────────────────────────
    let totalAnnotated = 0,
        totalSkipped = 0,
        filesProcessed = 0,
        filesCached = 0;

    for (const luauPath of luauFiles) {
        const dtsHash = declaration ? hashFile(dtsPathFor(luauPath)) : "";
        const cached = fileCache?.get(luauPath);

        if (cached && cached.dtsHash === dtsHash && dtsChangedCount === 0) {
            totalAnnotated += cached.result.annotated;
            totalSkipped += cached.result.skipped;
            filesCached++;
            continue;
        }

        const manifest = manifests.get(luauPath) ?? { functions: {}, types: {} };
        const source = readFileSync(luauPath, "utf-8");
        const result = annotateFile(
            source,
            luauPath,
            manifest,
            rojoProject,
            cwd,
            globalTypeOrigins,
            globalTypeDecls,
            extractedByFile.get(luauPath) ?? new Set(),
            fileResolvedNames.get(luauPath) ?? new Map(),
        );

        totalAnnotated += result.annotated;
        totalSkipped += result.skipped;
        filesProcessed++;

        const sourceChanged = result.source !== source;

        if (sourceChanged) {
            if (!dryRun) {
                safeWrite(luauPath, result.source);
            }
            if (verbose) {
                if (result.annotated > 0) {
                    console.log(
                        `[lumine] ${relative(cwd, luauPath)} — ${result.annotated} annotated` +
                        (result.skipped > 0 ? `, ${result.skipped} skipped` : ""),
                    );
                } else {
                    console.log(`[lumine] ${relative(cwd, luauPath)} — types injected`);
                }
            }
        }

        if (fileCache) {
            fileCache.set(luauPath, {
                dtsHash,
                result: {
                    annotated: result.annotated,
                    skipped: result.skipped,
                    usesBuiltins: result.usesBuiltins,
                },
            });
        }
    }

    const cacheMsg = filesCached > 0 ? `, ${filesCached} cached` : "";
    console.log(
        `[lumine] done — ${totalAnnotated} annotations, ${filesProcessed} files processed${cacheMsg}` +
        (dryRun ? " (dry run)" : ""),
    );

    return { typesFiles };
}

// ── Public entry points ───────────────────────────────────────────────────────

async function runOnce(dryRun = false, verbose = false) {
    await run({ dryRun, verbose });
}

async function runWatch(verbose = false) {
    const cwd = process.cwd();
    const { outDir } = loadConfig(cwd);

    const fileCache = new Map<string, FileCache>();
    const manifestCache = new Map<string, ManifestCache>();

    console.log(`[lumine] watching ${outDir} for changes...`);

    let expectedTypesFiles = new Set<string>();
    const initialResult = await run({ verbose, fileCache, manifestCache });
    if (initialResult) expectedTypesFiles = initialResult.typesFiles;
    let knownMtimes = snapshotDtsMtimes(outDir);

    let running = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = setInterval(() => {
        if (running) return;
        if (!hasDtsChanges(outDir, knownMtimes) && !hasLumineTypesDeleted(expectedTypesFiles)) return;
        if (debounceTimer) return;

        debounceTimer = setTimeout(async () => {
            if (running) return;
            running = true;
            knownMtimes = snapshotDtsMtimes(outDir);
            console.log(`[lumine] change detected — re-annotating...`);
            try {
                const result = await run({ verbose, fileCache, manifestCache });
                if (result) expectedTypesFiles = result.typesFiles;
            } finally {
                running = false;
                debounceTimer = null;
            }
        }, 800);
    }, 300);

    process.on("SIGINT", () => {
        clearInterval(poll);
        if (debounceTimer) clearTimeout(debounceTimer);
        console.log("[lumine] stopped.");
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
