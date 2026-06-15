// recursive-test.ts
// Tests single-file recursive and mutually-recursive types.
// All self-references go through table fields — valid Luau.

// ── Self-recursive ────────────────────────────────────────────────────────────

export interface BinaryTree<T> {
    value: T;
    left: BinaryTree<T> | undefined;
    right: BinaryTree<T> | undefined;
}

export interface LinkedList<T> {
    head: T;
    tail: LinkedList<T> | undefined;
}

// Multiple self-referencing fields
export interface Expr {
    kind: "num" | "add" | "mul" | "neg" | "let";
    value?: number;
    a?: Expr;
    b?: Expr;
    operand?: Expr;
    name?: string;
    binding?: Expr;
    body?: Expr;
}

// ── Mutually recursive in the same file ───────────────────────────────────────

export interface Directory {
    name: string;
    children: Array<Directory | File>;
}

export interface File {
    name: string;
    parent: Directory | undefined;
    size: number;
}

// ── Functions using recursive types ───────────────────────────────────────────

export function treeInsert<T>(node: BinaryTree<T> | undefined, value: T): BinaryTree<T> {
    return { value, left: undefined, right: undefined };
}

export function treeDepth<T>(node: BinaryTree<T> | undefined): number {
    const l = treeDepth(node?.left);
    const r = treeDepth(node?.right);
    return node ? 1 + (l > r ? l : r) : 0;
}

export function listPrepend<T>(list: LinkedList<T> | undefined, value: T): LinkedList<T> {
    return { head: value, tail: list };
}

export function listLength<T>(list: LinkedList<T> | undefined): number {
    return list ? 1 + listLength(list.tail) : 0;
}

export function evalExpr(e: Expr): number {
    return 0;
}

export function countFiles(dir: Directory): number {
    return 0;
}

export function findFile(dir: Directory, name: string): File | undefined {
    return undefined as never;
}
