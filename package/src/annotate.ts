/**
 * annotate.ts
 */
import { resolve, dirname, join } from "path";
import { existsSync } from "fs";
import type { TypeManifest, TypeDecl, AnnotationResult } from "./types";
import { LuauAny, printReturn, printParam, typeUsesBuiltins, type LuauType } from "./luau-types";
import { resolveRojoPath, buildDirectRequire, buildRelativeRequire } from "./rojo";

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findClosingParen(src: string, openIdx: number): number {
    let parenDepth = 0,
        braceDepth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === "{") braceDepth++;
        else if (c === "}") braceDepth--;
        else if (braceDepth === 0) {
            if (c === "(") parenDepth++;
            else if (c === ")") {
                parenDepth--;
                if (parenDepth === 0) return i;
            }
        }
    }
    return -1;
}

function findClosingAngle(src: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === "<") depth++;
        else if (src[i] === ">") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function findSignatureEnd(src: string, closeParen: number): number {
    let i = closeParen + 1;
    while (i < src.length && src[i] === " ") i++;
    if (i >= src.length || src[i] !== ":") return closeParen + 1;
    i++;
    while (i < src.length && src[i] === " ") i++;
    let depth = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === "\n" && depth === 0) break;
        i++;
    }
    return i;
}

function findFunctionSignature(src: string, fnName: string) {
    const esc = escapeRegExp(fnName);
    const re = new RegExp(
        `^([ \t]*)(?:local function ${esc}|local ${esc}\\s*=\\s*function|function ${esc})`,
        "m",
    );
    const m = re.exec(src);
    if (!m) return null;
    const lineStart = m.index;
    const headerEnd = m.index + m[0].length;
    let i = headerEnd;
    if (src[i] === "<") {
        const c = findClosingAngle(src, i);
        if (c === -1) return null;
        i = c + 1;
    }
    if (src[i] !== "(") return null;
    const openParen = i;
    const closeParen = findClosingParen(src, openParen);
    if (closeParen === -1) return null;
    return {
        lineStart,
        headerEnd,
        openParen,
        closeParen,
        sigEnd: findSignatureEnd(src, closeParen),
    };
}

function splitParams(paramStr: string): string[] {
    if (!paramStr.trim()) return [];
    const parts: string[] = [];
    let depth = 0,
        start = 0;
    for (let i = 0; i < paramStr.length; i++) {
        const c = paramStr[i];
        if (c === "(" || c === "<" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === ">" && (i === 0 || paramStr[i - 1] !== "-")) depth--;
        else if (c === "," && depth === 0) {
            parts.push(paramStr.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(paramStr.slice(start).trim());
    return parts.filter(Boolean);
}

function bareParamName(p: string): string {
    if (p === "...") return "...";
    const isRest = p.startsWith("...");
    const stripped = isRest ? p.slice(3) : p;
    const colonIdx = stripped.indexOf(":");
    const name = (colonIdx === -1 ? stripped : stripped.slice(0, colonIdx)).trim();
    return isRest ? `...${name}` : name;
}

function collectReferencedTypeNames(manifest: TypeManifest): Set<string> {
    const refs = new Set<string>();
    const scanType = (t: LuauType) => {
        if (t.kind === "reference") {
            if (!t.name.startsWith("_Lumine.") && /^[A-Z]/.test(t.name)) refs.add(t.name);
            t.args?.forEach(scanType);
        } else if (t.kind === "optional") scanType(t.inner);
        else if (t.kind === "union" || t.kind === "intersection") t.members.forEach(scanType);
        else if (t.kind === "table") {
            t.fields.forEach((f) => scanType(f.type));
            if (t.indexer) {
                scanType(t.indexer.key);
                scanType(t.indexer.value);
            }
        } else if (t.kind === "function") {
            t.params.forEach((p) => scanType(p.type));
            scanType(t.returns);
        } else if (t.kind === "tuple") t.elements.forEach(scanType);
        else if (t.kind === "keyof") scanType(t.inner);
    };
    // Only scan function signatures — type declaration bodies are extracted to
    // _lumine_types.luau and are not present in the individual .luau file.
    for (const sig of Object.values(manifest.functions)) {
        sig.params.forEach((p) => scanType(p.type));
        scanType(sig.returnType);
    }
    return refs;
}

function buildLumineRequire(): string {
    return `local _Lumine = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("Lumine"))`;
}

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

function skipHeaderRegion(src: string, start: number): number {
    let pos = start;
    while (pos < src.length) {
        const slice = src.slice(pos);
        if (/^\s*\n/.test(slice)) {
            pos += slice.match(/^\s*\n/)![0].length;
            continue;
        }
        if (/^local\s+\w+\s*=\s*require\s*\(/.test(slice)) {
            let depth = 0,
                i = slice.indexOf("(");
            while (i < slice.length) {
                if (slice[i] === "(") depth++;
                else if (slice[i] === ")") {
                    depth--;
                    if (depth === 0) {
                        pos += i + 1;
                        break;
                    }
                }
                i++;
            }
            if (pos < src.length && src[pos] === "\n") pos++;
            continue;
        }
        break;
    }
    return pos;
}

function injectAtTop(src: string, block: string): string {
    let pos = 0;
    const headerMatch = src.match(/^-- Compiled with roblox-ts[^\n]*\n/);
    if (headerMatch) pos = headerMatch[0].length;
    pos = skipHeaderRegion(src, pos);
    return src.slice(0, pos) + block + "\n" + src.slice(pos);
}

function stripOldLumineBlock(src: string): string {
    const start = src.indexOf("-- [lumine types]");
    if (start === -1) return src;
    let i = start;
    while (i < src.length && src[i] !== "\n") i++;
    if (i < src.length) i++;
    let braceDepth = 0;
    while (i < src.length) {
        const lineStart = i;
        let lineEnd = src.indexOf("\n", i);
        if (lineEnd === -1) lineEnd = src.length;
        const line = src.slice(lineStart, lineEnd).trim();
        const wasInside = braceDepth > 0;
        for (const ch of line) {
            if (ch === "{") braceDepth++;
            else if (ch === "}") braceDepth--;
        }
        const isLumineContent =
            wasInside ||
            line === "" ||
            line.startsWith("local _Lumine") ||
            line.startsWith("local _Types") || // covers _Types, _Types2, _Types3 — no UUIDs
            line.startsWith("local Lumine =") ||
            line.startsWith("export type ") ||
            line.startsWith("-- [lumine]");
        if (!isLumineContent) break;
        i = lineEnd + 1;
    }
    return src.slice(0, start) + src.slice(i);
}

/**
 * Returns true if the file is effectively a types-only file:
 * only contains comments, whitespace, and `return nil` / `return {}`.
 * Used to detect files that lumine should stamp with a notice.
 */
function isTypesOnlyFile(src: string): boolean {
    const meaningful = src
        .split("\n")
        .map((l) => l.trim())
        .filter(
            (l) =>
                l.length > 0 &&
                !l.startsWith("--") &&
                l !== "return nil" &&
                l !== "return {}" &&
                l !== "return nil :: any",
        );
    return meaningful.length === 0;
}

function remapType(t: LuauType, aliases: Map<string, string>): LuauType {
    switch (t.kind) {
        case "reference": {
            const aliased = aliases.get(t.name);
            const name = aliased ?? t.name;
            const args = t.args?.map((a) => remapType(a, aliases));
            return { kind: "reference", name, args };
        }
        case "optional":
            return { kind: "optional", inner: remapType(t.inner, aliases) };
        case "union":
            return { kind: "union", members: t.members.map((m) => remapType(m, aliases)) };
        case "intersection":
            return { kind: "intersection", members: t.members.map((m) => remapType(m, aliases)) };
        case "table":
            return {
                kind: "table",
                fields: t.fields.map((f) => ({ ...f, type: remapType(f.type, aliases) })),
                indexer: t.indexer
                    ? {
                        key: remapType(t.indexer.key, aliases),
                        value: remapType(t.indexer.value, aliases),
                    }
                    : undefined,
            };
        case "function":
            return {
                kind: "function",
                params: t.params.map((p) => ({ ...p, type: remapType(p.type, aliases) })),
                returns: remapType(t.returns, aliases),
            };
        case "tuple":
            return { kind: "tuple", elements: t.elements.map((e) => remapType(e, aliases)) };
        case "keyof":
            return { kind: "keyof", inner: remapType(t.inner, aliases) };
        default:
            return t;
    }
}

function qualifyBareRefs(
    t: LuauType,
    qualifier: string,
    globalOrigins: Map<string, string>,
): LuauType {
    switch (t.kind) {
        case "reference": {
            const shouldQualify =
                !t.name.includes(".") && /^[A-Z]/.test(t.name) && globalOrigins.has(t.name);
            const name = shouldQualify ? `${qualifier}${t.name}` : t.name;
            const args = t.args?.map((a) => qualifyBareRefs(a, qualifier, globalOrigins));
            return { kind: "reference", name, args };
        }
        case "optional":
            return { kind: "optional", inner: qualifyBareRefs(t.inner, qualifier, globalOrigins) };
        case "union":
            return {
                kind: "union",
                members: t.members.map((m) => qualifyBareRefs(m, qualifier, globalOrigins)),
            };
        case "intersection":
            return {
                kind: "intersection",
                members: t.members.map((m) => qualifyBareRefs(m, qualifier, globalOrigins)),
            };
        case "table":
            return {
                kind: "table",
                fields: t.fields.map((f) => ({
                    ...f,
                    type: qualifyBareRefs(f.type, qualifier, globalOrigins),
                })),
                indexer: t.indexer
                    ? {
                        key: qualifyBareRefs(t.indexer.key, qualifier, globalOrigins),
                        value: qualifyBareRefs(t.indexer.value, qualifier, globalOrigins),
                    }
                    : undefined,
            };
        case "function":
            return {
                kind: "function",
                params: t.params.map((p) => ({
                    ...p,
                    type: qualifyBareRefs(p.type, qualifier, globalOrigins),
                })),
                returns: qualifyBareRefs(t.returns, qualifier, globalOrigins),
            };
        case "tuple":
            return {
                kind: "tuple",
                elements: t.elements.map((e) => qualifyBareRefs(e, qualifier, globalOrigins)),
            };
        case "keyof":
            return { kind: "keyof", inner: qualifyBareRefs(t.inner, qualifier, globalOrigins) };
        default:
            return t;
    }
}

function fillTypeParamDefaults(
    t: LuauType,
    globalDecls: Map<string, TypeDecl>,
    globalOrigins?: Map<string, string>,
    aliasMap?: Map<string, string>,
): LuauType {
    const fill = (u: LuauType) => fillTypeParamDefaults(u, globalDecls, globalOrigins, aliasMap);
    switch (t.kind) {
        case "reference": {
            const filledArgs = t.args?.map(fill);
            // t.name may be module-qualified ("_Types.Foo") after remapType — strip
            // the prefix to find the decl, which is keyed by bare exported name.
            const bareName = t.name.includes(".")
                ? t.name.slice(t.name.lastIndexOf(".") + 1)
                : t.name;
            const decl = globalDecls.get(bareName);
            if (decl && decl.typeParamDefaults.length > 0) {
                const extra: LuauType[] = [];
                const currentArgCount = filledArgs?.length ?? 0;
                for (let i = currentArgCount; i < decl.typeParamDefaults.length; i++) {
                    const rawDefault = decl.typeParamDefaults[i] ?? LuauAny;
                    // Run the default through the same alias map so bare refs like
                    // `Shape` become `_Types2.Shape` — matching how the rest of the
                    // type was already remapped before fillTypeParamDefaults was called.
                    extra.push(aliasMap ? remapType(rawDefault, aliasMap) : rawDefault);
                }
                return { kind: "reference", name: t.name, args: [...(filledArgs ?? []), ...extra] };
            }
            return { kind: "reference", name: t.name, args: filledArgs };
        }
        case "optional":
            return { kind: "optional", inner: fill(t.inner) };
        case "union":
            return { kind: "union", members: t.members.map(fill) };
        case "intersection":
            return { kind: "intersection", members: t.members.map(fill) };
        case "table":
            return {
                kind: "table",
                fields: t.fields.map((f) => ({ ...f, type: fill(f.type) })),
                indexer: t.indexer
                    ? { key: fill(t.indexer.key), value: fill(t.indexer.value) }
                    : undefined,
            };
        case "function":
            return {
                kind: "function",
                params: t.params.map((p) => ({ ...p, type: fill(p.type) })),
                returns: fill(t.returns),
            };
        case "tuple":
            return { kind: "tuple", elements: t.elements.map(fill) };
        case "keyof":
            return { kind: "keyof", inner: fill(t.inner) };
        default:
            return t;
    }
}

const INLINE_SENTINEL = "-- [lumine types]";
const TYPES_EXTRACTED_COMMENT = "-- [lumine] types extracted to _lumine_types.luau";

export function annotateFile(
    source: string,
    filePath: string,
    manifest: TypeManifest,
    rojoProject: string,
    cwd: string,
    globalTypeOrigins: Map<string, string> = new Map(),
    globalTypeDecls: Map<string, TypeDecl> = new Map(),
    /** Names of types that were extracted FROM this file into _lumine_types.luau */
    extractedFromThisFile: Set<string> = new Set(),
    /** originalName → exportedName for conflict-renamed types (file-specific + global fallback) */
    typeResolvedNames: Map<string, string> = new Map(),
): AnnotationResult & { source: string } {
    let annotated = 0;
    let skipped = 0;
    let usesBuiltins = false;
    let result = source;

    const filePathAbs = resolve(filePath);
    const fileDirAbs = dirname(filePathAbs);

    // ── Stamp types-only files ───────────────────────────────────────────────
    // If lumine extracted types from this file and it's now just comments+return,
    // stamp it with a notice so it's clear why the file has no type declarations.
    if (extractedFromThisFile.size > 0 && isTypesOnlyFile(result)) {
        const alreadyStamped = result.includes(TYPES_EXTRACTED_COMMENT);
        if (!alreadyStamped) {
            // Insert comment before the return statement
            result = result.replace(
                /^(return nil|return \{\}|return nil :: any)\s*$/m,
                `${TYPES_EXTRACTED_COMMENT}\nreturn nil`,
            );
            // If no return statement found, append at end
            if (!result.includes(TYPES_EXTRACTED_COMMENT)) {
                result = result.trimEnd() + `\n${TYPES_EXTRACTED_COMMENT}\nreturn nil\n`;
            }
        }
    }

    // ── Build require groups ─────────────────────────────────────────────────
    // globalTypeOrigins is the source of truth: after Phase 0 it maps every
    // type name (including types declared in THIS file) to its _lumine_types.luau.
    // We no longer skip "own" types — they are no longer defined locally; they
    // live in _lumine_types.luau and must be accessed via _Types.Name.
    const referenced = collectReferencedTypeNames(manifest);
    const requireGroups = new Map<string, { localVar: string }>();
    const typeAliasMap = new Map<string, string>();
    const sameDirTypesFile = join(fileDirAbs, "_lumine_types.luau");
    const sameDirTypesExists = existsSync(sameDirTypesFile);
    let crossDirCount = 0;

    for (const name of referenced) {
        // Resolve to the exported name — may differ if this type was renamed
        // to resolve a same-directory naming conflict.
        const exportedName = typeResolvedNames.get(name) ?? name;
        const originFile = globalTypeOrigins.get(exportedName);
        if (!originFile) continue;
        const originDir = dirname(resolve(originFile));

        if (originDir === fileDirAbs) {
            if (!sameDirTypesExists) continue;
            if (!requireGroups.has(fileDirAbs)) {
                requireGroups.set(fileDirAbs, { localVar: "_Types" });
            }
            typeAliasMap.set(name, `_Types.${exportedName}`);
        } else {
            if (!requireGroups.has(originDir)) {
                crossDirCount++;
                // _Types is reserved for same-dir; cross-dir start at _Types2
                requireGroups.set(originDir, { localVar: `_Types${crossDirCount + 1}` });
            }
            typeAliasMap.set(name, `${requireGroups.get(originDir)!.localVar}.${exportedName}`);
        }
    }

    // ── Annotate function signatures ─────────────────────────────────────────
    for (const [fnName, sig] of Object.entries(manifest.functions)) {
        const loc = findFunctionSignature(result, fnName);
        if (!loc) {
            skipped++;
            continue;
        }

        const { lineStart, headerEnd, openParen, closeParen, sigEnd } = loc;
        const rawParams = splitParams(result.slice(openParen + 1, closeParen));
        const paramNames = rawParams.map(bareParamName);

        if (paramNames.length !== sig.params.length) {
            skipped++;
            continue;
        }

        const annotatedParams = sig.params.map((param, i) => {
            const rawName = paramNames[i] ?? param.name;
            const isRest = rawName.startsWith("...");
            const cleanName = rawName.replace(/^\.\.\./, "") || param.name;
            const remapped = fillTypeParamDefaults(
                remapType(param.type, typeAliasMap),
                globalTypeDecls,
                globalTypeOrigins,
                typeAliasMap,
            );
            if (typeUsesBuiltins(remapped)) usesBuiltins = true;
            return printParam(cleanName, remapped, param.optional, param.rest || isRest);
        });

        const remappedReturn = fillTypeParamDefaults(
            remapType(sig.returnType, typeAliasMap),
            globalTypeDecls,
            globalTypeOrigins,
            typeAliasMap,
        );
        if (typeUsesBuiltins(remappedReturn)) usesBuiltins = true;
        const returnAnnotation = printReturn(remappedReturn);

        const typeParamStr = sig.typeParams.length ? `<${sig.typeParams.join(", ")}>` : "";
        let headerBase = result.slice(lineStart, headerEnd).trimEnd();
        if (headerBase.endsWith(">")) {
            const lastOpen = headerBase.lastIndexOf("<");
            if (lastOpen !== -1) headerBase = headerBase.slice(0, lastOpen).trimEnd();
        }

        result =
            result.slice(0, lineStart) +
            `${headerBase}${typeParamStr}(${annotatedParams.join(", ")})${returnAnnotation}` +
            result.slice(sigEnd);
        annotated++;
    }

    // ── Inject [lumine types] block ─────────────────────────────────────────
    result = stripOldLumineBlock(result);

    const needsLumine = usesBuiltins && !result.includes("local _Lumine =");
    const hasAnything = needsLumine || requireGroups.size > 0;

    if (hasAnything) {
        const lines: string[] = [INLINE_SENTINEL];

        if (needsLumine) {
            const existingLumine = result.match(/^local Lumine = [^\n]+/m);
            lines.push(existingLumine ? "local _Lumine = Lumine" : buildLumineRequire());
        }

        // Emit same-dir first (_Types), then cross-dir (_Types2, _Types3...)
        const sortedGroups = [...requireGroups.entries()].sort(([, a], [, b]) =>
            a.localVar.localeCompare(b.localVar),
        );
        for (const [originDir, group] of sortedGroups) {
            const originTypesFile = join(originDir, "_lumine_types.luau");
            lines.push(
                `local ${group.localVar} = ${buildModuleRequire(rojoProject, originTypesFile, filePath, cwd)}`,
            );
        }

        lines.push("");
        result = injectAtTop(result, lines.join("\n"));
    }

    return { filePath, annotated, skipped, usesBuiltins, source: result };
}
