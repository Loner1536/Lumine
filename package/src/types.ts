// ── Extracted from .d.ts ─────────────────────────────────────────────────────

export interface ParamInfo {
    name: string;
    type: string; // raw TypeScript type string
    optional: boolean;
    rest: boolean;
}

export interface FunctionSignature {
    name: string;
    params: ParamInfo[];
    returnType: string; // raw TypeScript type string
    typeParams: string[]; // e.g. ["T", "U extends unknown[]"]
}

export interface InterfaceMember {
    name: string;
    type: string;
    optional: boolean;
    isMethod: boolean; // true = MethodSignature (gets self), false = PropertySignature (no self)
}

export interface TypeDeclaration {
    name: string;
    kind: "interface" | "type" | "class" | "conditional" | "union";
    members: InterfaceMember[];
    typeParams: string[];
    // conditional types: both branches get intersected
    trueBranch?: string;
    falseBranch?: string;
    // union/other complex aliases: raw TS type string
    rawType?: string;
}

// Manifest emitted per .d.ts file
export interface TypeManifest {
    functions: Record<string, FunctionSignature>;
    types: Record<string, TypeDeclaration>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface LumineConfig {
    outDir: string; // from tsconfig compilerOptions.outDir
    rootDir: string; // from tsconfig compilerOptions.rootDir
    declaration: boolean; // from tsconfig compilerOptions.declaration
    typesOutput: string; // from lumine.toml or default
    rojoProject: string; // path to default.project.json
}

// ── Annotator ─────────────────────────────────────────────────────────────────

export interface AnnotationResult {
    filePath: string;
    annotated: number; // functions annotated
    skipped: number; // functions not found in manifest
    usesCustomTypes: boolean;
}
