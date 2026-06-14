import { readFileSync } from "fs";
import type { TypeManifest, AnnotationResult } from "./types";
import { convertParam, convertReturn } from "./convert";

const LOCAL_FN_RE = /^(\s*)local function (\w+)\(([^)]*)\)/gm;
const LOCAL_FN_ASSIGN_RE = /^(\s*)local (\w+) = function\(([^)]*)\)/gm;

function buildKnownTypes(manifest: TypeManifest): Set<string> {
    return new Set(Object.keys(manifest.types));
}

function annotateSignature(
    paramStr: string,
    fnName: string,
    manifest: TypeManifest,
    knownTypes: Set<string>,
): { annotated: string; usesCustomTypes: boolean } | null {
    const sig = manifest.functions[fnName];
    if (!sig) return null;

    const rawParams = paramStr
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

    if (rawParams.length !== sig.params.length) return null;

    let usesCustomTypes = false;
    const annotatedParams = sig.params.map((param, i) => {
        const luauParam = convertParam(
            rawParams[i] ?? param.name,
            param.type,
            param.optional,
            param.rest,
            knownTypes,
        );
        if (luauParam.includes("__luauAnnotateTypes.")) usesCustomTypes = true;
        return luauParam;
    });

    const returnAnnotation = convertReturn(sig.returnType, knownTypes);
    if (returnAnnotation.includes("__luauAnnotateTypes.")) usesCustomTypes = true;

    return {
        annotated: `(${annotatedParams.join(", ")})${returnAnnotation}`,
        usesCustomTypes,
    };
}

function buildRequireInjection(typesOutputPath: string): string {
    return `local __luauAnnotateTypes = require(game:GetService("ReplicatedStorage").${typesOutputPath.replace(/\//g, ".")})`;
}

export function annotateFile(
    source: string,
    filePath: string,
    manifest: TypeManifest,
    rojoProject: string,
    typesOutput: string,
): AnnotationResult & { source: string } {
    const knownTypes = buildKnownTypes(manifest);
    let annotated = 0;
    let skipped = 0;
    let usesCustomTypes = false;

    let result = source.replace(LOCAL_FN_RE, (match, indent, name, params) => {
        const res = annotateSignature(params, name, manifest, knownTypes);
        if (!res) {
            skipped++;
            return match;
        }
        if (res.usesCustomTypes) usesCustomTypes = true;
        annotated++;
        const typeParams = manifest.functions[name]?.typeParams ?? [];
        const typeParamStr = typeParams.length ? `<${typeParams.join(", ")}>` : "";
        return `${indent}local function ${name}${typeParamStr}${res.annotated}`;
    });

    result = result.replace(LOCAL_FN_ASSIGN_RE, (match, indent, name, params) => {
        const res = annotateSignature(params, name, manifest, knownTypes);
        if (!res) {
            skipped++;
            return match;
        }
        if (res.usesCustomTypes) usesCustomTypes = true;
        annotated++;
        const typeParams = manifest.functions[name]?.typeParams ?? [];
        const typeParamStr = typeParams.length ? `<${typeParams.join(", ")}>` : "";
        return `${indent}local ${name} = function${typeParamStr}${res.annotated}`;
    });

    if (usesCustomTypes && !result.includes("__luauAnnotateTypes")) {
        const requireLine = buildRequireInjection(typesOutput);
        result = result.replace(/((?:--!.*\n)+)/, `$1${requireLine}\n`);
        if (!result.includes(requireLine)) {
            result = `${requireLine}\n${result}`;
        }
    }

    return { filePath, annotated, skipped, usesCustomTypes, source: result };
}
