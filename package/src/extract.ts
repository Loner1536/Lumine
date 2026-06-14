import ts from "typescript";
import { readFileSync } from "fs";
import type { TypeManifest, ParamInfo, InterfaceMember } from "./types";

function typeText(node: ts.TypeNode | undefined, source: ts.SourceFile): string {
    if (!node) return "void";
    return node.getText(source).trim();
}

function extractParams(
    params: ts.NodeArray<ts.ParameterDeclaration>,
    source: ts.SourceFile,
): ParamInfo[] {
    return Array.from(params).map((p) => ({
        name: p.name.getText(source),
        type: typeText(p.type, source),
        optional: !!p.questionToken,
        rest: !!p.dotDotDotToken,
    }));
}

function extractTypeParamNames(
    node: ts.DeclarationWithTypeParameters,
    source: ts.SourceFile,
): string[] {
    const params = ts.getEffectiveTypeParameterDeclarations(node);
    return params ? Array.from(params).map((p) => p.name.text) : [];
}

function extractMembers(
    members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
    source: ts.SourceFile,
): InterfaceMember[] {
    const result: InterfaceMember[] = [];
    for (const member of members) {
        if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
            if (!member.name) continue;
            result.push({
                name: member.name.getText(source),
                type: typeText(member.type, source),
                optional: !!member.questionToken,
                isMethod: false,
            });
        } else if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
            if (!member.name) continue;
            const params = extractParams(member.parameters, source);
            const paramStr = params
                .map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}: ${p.type}`)
                .join(", ");
            const ret = member.type ? typeText(member.type as ts.TypeNode, source) : "void";
            result.push({
                name: member.name.getText(source),
                type: `(${paramStr}) => ${ret}`,
                optional: !!member.questionToken,
                isMethod: true,
            });
        }
    }
    return result;
}

export function extractManifest(dtsPath: string): TypeManifest {
    const content = readFileSync(dtsPath, "utf-8");
    const source = ts.createSourceFile(dtsPath, content, ts.ScriptTarget.ESNext, true);
    const manifest: TypeManifest = { functions: {}, types: {} };

    ts.forEachChild(source, (node) => {
        // export declare function foo(...)
        if (ts.isFunctionDeclaration(node) && node.name) {
            const name = node.name.text;
            const params = extractParams(node.parameters, source);
            const returnType = typeText(node.type, source);
            const typeParams = extractTypeParamNames(node, source);
            manifest.functions[name] = { name, params, returnType, typeParams };
        }

        // export declare interface Foo { ... }
        if (ts.isInterfaceDeclaration(node)) {
            const name = node.name.text;
            manifest.types[name] = {
                name,
                kind: "interface",
                members: extractMembers(node.members, source),
                typeParams: extractTypeParamNames(node, source),
            };
        }

        // export declare type Foo = ...
        if (ts.isTypeAliasDeclaration(node)) {
            const name = node.name.text;
            const typeParams = extractTypeParamNames(node, source);

            // Conditional type: T extends X ? A : B → intersect both branches
            if (ts.isConditionalTypeNode(node.type)) {
                const trueBranch = node.type.trueType.getText(source).replace(/\s+/g, " ").trim();
                const falseBranch = node.type.falseType.getText(source).replace(/\s+/g, " ").trim();
                manifest.types[name] = {
                    name,
                    kind: "conditional",
                    members: [],
                    typeParams,
                    trueBranch,
                    falseBranch,
                };
                return;
            }

            // Object type literal: { key: Type }
            if (ts.isTypeLiteralNode(node.type)) {
                const members: InterfaceMember[] = [];
                for (const m of node.type.members) {
                    if (ts.isPropertySignature(m) && m.name) {
                        members.push({
                            name: m.name.getText(source),
                            type: typeText(m.type, source),
                            optional: !!m.questionToken,
                            isMethod: false,
                        });
                    } else if (ts.isMethodSignature(m) && m.name) {
                        const params = extractParams(m.parameters, source);
                        const paramStr = params
                            .map(
                                (p) =>
                                    `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}: ${p.type}`,
                            )
                            .join(", ");
                        const ret = m.type ? typeText(m.type as ts.TypeNode, source) : "void";
                        members.push({
                            name: m.name.getText(source),
                            type: `(${paramStr}) => ${ret}`,
                            optional: !!m.questionToken,
                            isMethod: true,
                        });
                    }
                }
                manifest.types[name] = { name, kind: "type", members, typeParams };
                return;
            }

            // Union, intersection, tuple, or other complex alias → store raw TS string
            const rawType = node.type.getText(source).replace(/\s+/g, " ").trim();
            manifest.types[name] = { name, kind: "union", members: [], typeParams, rawType };
        }

        // export declare namespace Net { interface Foo {} }
        if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
            const nsName = node.name.text;
            const body = node.body;
            if (body && ts.isModuleBlock(body)) {
                ts.forEachChild(body, (child) => {
                    if (ts.isInterfaceDeclaration(child)) {
                        const qualifiedKey = `${nsName}.${child.name.text}`;
                        const luauName = `${nsName}_${child.name.text}`;
                        manifest.types[qualifiedKey] = {
                            name: luauName,
                            kind: "interface",
                            members: extractMembers(child.members, source),
                            typeParams: extractTypeParamNames(child, source),
                        };
                    }
                });
            }
        }
    });

    return manifest;
}
