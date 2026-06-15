import type { LuauType } from "./luau-types";

// ── Per-param / per-function info ─────────────────────────────────────────────

export interface ParamInfo {
    name: string;
    type: LuauType; // AST node — never a string
    optional: boolean;
    rest: boolean;
}

export interface FunctionSignature {
    name: string;
    params: ParamInfo[];
    returnType: LuauType;
    typeParams: string[];
}

// ── Type declarations (interfaces, aliases, namespaced types) ─────────────────

export interface TypeDecl {
    /** Luau-safe name: dots replaced with underscores (e.g. Net_Packet) */
    name: string;
    typeParams: string[];
    /** Parallel to typeParams — undefined means no default for that param */
    typeParamDefaults: (LuauType | undefined)[];
    body: LuauType;
}

// ── Per-file manifest ─────────────────────────────────────────────────────────

export interface TypeManifest {
    functions: Record<string, FunctionSignature>;
    /** key = qualified TS name or Luau name; value = the declaration */
    types: Record<string, TypeDecl>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface LumineConfig {
    outDir: string;
    rootDir: string;
    declaration: boolean;
    includeDir: string;
    rojoProject: string;
}

// ── Annotator result ──────────────────────────────────────────────────────────

export interface AnnotationResult {
    filePath: string;
    annotated: number;
    skipped: number;
    usesBuiltins: boolean;
}
