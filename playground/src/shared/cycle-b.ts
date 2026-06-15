import type { NodeA } from "./cycle-a";

export interface NodeB {
    count: number;
    peer: NodeA | undefined;
    siblings: NodeB[];
}

export function makeNodeB(count: number): NodeB {
    return { count, peer: undefined, siblings: [] };
}

export function linkBtoA(b: NodeB, a: NodeA): NodeB {
    return { count: b.count, peer: a, siblings: b.siblings };
}

export function getPeerLabel(b: NodeB): string {
    return b.peer ? b.peer.label : "";
}
