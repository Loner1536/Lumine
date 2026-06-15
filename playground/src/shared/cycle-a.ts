// cycle-a.ts + cycle-b.ts together form a cross-file type dependency cycle.
// NodeA (here) references NodeB (cycle-b.ts), and vice versa.
// Lumine should detect this and lift both types into a shared module.
import type { NodeB } from "./cycle-b";

export interface NodeA {
    label: string;
    peer: NodeB | undefined;
    children: NodeA[];
}

export function makeNodeA(label: string): NodeA {
    return { label, peer: undefined, children: [] };
}

export function linkAtoB(a: NodeA, b: NodeB): NodeA {
    return { label: a.label, peer: b, children: a.children };
}

export function getPeerCount(a: NodeA): number {
    return a.peer ? a.peer.count : 0;
}
