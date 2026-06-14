// ── Shared type definitions ───────────────────────────────────────────────────
// These get emitted as inline `export type` declarations into types.luau
// by lumine. Files that import from here get the types resolved by tsc and
// inlined into their own .luau files too.

// Plain interfaces
export interface Vec2 {
    x: number;
    y: number;
}

export interface Player {
    userId: number;
    name: string;
    team?: string;
}

// Generic container
export interface Result<T, E = string> {
    ok: boolean;
    value?: T;
    error?: E;
}

// Namespace-style grouping (tests Namespace.Type → Namespace_Type rename)
export namespace Net {
    export interface Packet {
        id: number;
        payload: unknown;
    }
    export interface Channel {
        send: (packet: Net.Packet) => void;
        recv: () => Net.Packet | undefined;
    }
}

// Conditional types (emitted as A & B intersection in Luau)
export type MaybeVec<T> = T extends { x: number; y: number } ? Vec2 : { raw: T };

// Union alias
export type Status = "idle" | "running" | "stopped";

// Mapped type (→ any in Luau, can't represent)
export type Optional<T> = { [K in keyof T]?: T[K] };
