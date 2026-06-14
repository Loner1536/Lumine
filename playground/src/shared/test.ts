// ── Roblox type passthrough ───────────────────────────────────────────────────

export function teleportPlayer(player: Player, target: Vector3): void { }
export function applyTransform(part: BasePart, cf: CFrame, offset: Vector3): CFrame {
    return cf;
}
export function colorize(part: BasePart, color: Color3, brightness: number): void { }

// ── Primitives ────────────────────────────────────────────────────────────────

export function clamp(value: number, min: number, max: number): number {
    return value;
}
export function formatName(name: string, prefix: string): string {
    return name;
}
export function toggle(state: boolean): boolean {
    return !state;
}
export function writeBytes(buf: buffer, offset: number): buffer {
    return buf;
}

// ── Optional / nullable ───────────────────────────────────────────────────────

export function findPlayer(userId: number): Player | undefined {
    return undefined;
}
export function getTag(instance: Instance, key: string): string | undefined {
    return undefined;
}
export function resolveTarget(player: Player | undefined, fallback: Player): Player {
    return fallback;
}
export function maybeNumber(x: number | undefined): number | undefined {
    return undefined;
}

// ── Arrays ────────────────────────────────────────────────────────────────────

export function getPlayers(): Player[] {
    return [];
}
export function mapNumbers(values: number[]): number[] {
    return values;
}
export function zipNames(a: string[], b: string[]): string[][] {
    return [];
}
export function collectParts(model: Model): BasePart[] {
    return [];
}

// ── Map / Record / Set ────────────────────────────────────────────────────────

export function buildRegistry(): Map<string, Player> {
    return new Map();
}
export function scoreTable(): Record<string, number> {
    return {};
}
export function taggedPlayers(): Map<Player, string[]> {
    return new Map();
}
export function uniqueIds(): Set<number> {
    return new Set();
}
export function permissionMap(): Map<string, Set<string>> {
    return new Map();
}

// ── Tuples ────────────────────────────────────────────────────────────────────

export function splitHealth(health: number): [number, number] {
    return [health, 100];
}
export function playerWithScore(player: Player, score: number): [Player, number] {
    return [player, score];
}
export function tripleState(): [boolean, number, string] {
    return [true, 0, ""];
}

// ── Function types ────────────────────────────────────────────────────────────

export function onPlayerAdded(callback: (player: Player) => void): void { }
export function transform(value: number, fn: (x: number) => number): number {
    return 0;
}
export function createFilter(
    predicate: (player: Player, data: string) => boolean,
): (player: Player) => boolean {
    return () => false;
}
export function debounce(fn: () => void, delay: number): () => void {
    return fn;
}

// ── Intersection types ────────────────────────────────────────────────────────

export interface Named {
    name: string;
}
export interface Tagged {
    tag: string;
}
export interface Identified {
    id: number;
}

export function processEntity(entity: Named & Tagged): void { }
export function mergeEntities(
    a: Named & Identified,
    b: Tagged & Identified,
): Named & Tagged & Identified {
    return a as never;
}

// ── Union types (non-optional) ────────────────────────────────────────────────

export function damage(target: Player | BasePart, amount: number): void { }
export function sendMessage(channel: string | number, message: string): void { }
export function parseValue(raw: string | number | boolean): string {
    return "";
}

// ── User-defined interfaces ───────────────────────────────────────────────────

export interface Connection {
    disconnect(): void;
    readonly connected: boolean;
}

export interface Codec<T> {
    encode(value: T, buf: buffer, offset: number): number;
    decode(buf: buffer, offset: number): [T, number];
    readonly size: number | undefined;
}

export interface NetworkPacket {
    id: number;
    channel: string;
    payload: buffer;
    timestamp: number;
    sender: Player | undefined;
}

export interface PlayerState {
    player: Player;
    health: number;
    position: Vector3;
    connections: Connection[];
    metadata: Map<string, string>;
}

// ── Generics ──────────────────────────────────────────────────────────────────

export interface Pool<T> {
    acquire(): T | undefined;
    release(item: T): void;
    readonly size: number;
}

export interface Signal<T extends unknown[]> {
    connect(callback: (...args: T) => void): Connection;
    fire(...args: T): void;
    once(callback: (...args: T) => void): Connection;
}

export interface Repository<K, V> {
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    delete(key: K): boolean;
    keys(): K[];
}

export interface RepositoryNonMethod<K, V> {
    get: (key: K) => V | undefined;
    set: (key: K, value: V) => void;
    delete: (key: K) => boolean;
    keys: () => K[];
}

export type PacketStats = {
    sentBytes: {
        raw: number;
        overhead: number;
        total: number;

        totalRaw: number;
        totalOverhead: number;
        totalWire: number;
    };
    totalFires: number;
    firstSentAt: number;
    lastSentAt: number;

    // Receive
    receivedBytes: {
        raw: number;
        overhead: number;
        total: number;

        totalRaw: number;
        totalOverhead: number;
        totalWire: number;
    };
    totalReceived: number;
    firstReceivedAt: number;
    lastReceivedAt: number;

    // Bandwidth
    averageBytes: number;
    peakBytes: number;

    // Reliability
    totalDropped: number;
    dropRate: number;

    // Latency
    roundTripTime: number;
    lastRoundTripAt: number;
};

export type SendTarget = Player | Player[] | ["Except", Player | Player[]];

export type SendStats = {
    stats: (fn?: (stats: PacketStats | undefined) => void) => void;
};

export type ReceiveStats<T> = T extends undefined
    ? {
        stats: (
            fn?: (stats: PacketStats | undefined, player?: Player) => void,
        ) => RBXScriptConnection;
        Disconnect: () => void;
    }
    : {
        stats: (
            fn?: (data: T, stats: PacketStats | undefined, player?: Player) => void,
        ) => RBXScriptConnection;
        Disconnect: () => void;
    };

export type QueryRequest<Res> = Promise<Res> & {
    stats: (fn?: (stats: PacketStats | undefined) => void) => QueryRequest<Res>;
};

export type Query<Req, Res> = Req extends undefined
    ? {
        request: (target?: SendTarget) => QueryRequest<Res>;
        response: (fn: (player?: Player) => Res) => {
            stats: (
                fn?: (stats: PacketStats | undefined, player?: Player) => void,
            ) => RBXScriptConnection;
            Disconnect: () => void;
        };
    }
    : {
        request: (data: Req, target?: SendTarget) => QueryRequest<Res>;
        response: (fn: (data: Req, player?: Player) => Res) => {
            stats: (
                fn?: (data: Req, stats: PacketStats | undefined, player?: Player) => void,
            ) => RBXScriptConnection;
            Disconnect: () => void;
        };
    };

export type Packet<T> = T extends undefined
    ? {
        send: (target?: Player | Player[] | ["Except", Player | Player[]]) => SendStats;
        on: (fn: (player?: Player) => void) => ReceiveStats<T>;
        once: (fn: (player?: Player) => void) => ReceiveStats<T>;
    }
    : {
        send: (
            data: T,
            target?: Player | Player[] | ["Except", Player | Player[]],
        ) => SendStats;
        on: (fn: (data: T, player?: Player) => void) => ReceiveStats<T>;
        once: (fn: (data: T, player?: Player) => void) => ReceiveStats<T>;
    };

// ── Functions using user-defined types ────────────────────────────────────────

export function createCodec<T>(encoder: (v: T) => buffer, decoder: (b: buffer) => T): Codec<T> {
    return undefined!;
}
export function createPool<T>(factory: () => T, maxSize: number): Pool<T> {
    return undefined!;
}
export function connectSignal<T extends unknown[]>(
    signal: Signal<T>,
    handler: (...args: T) => void,
): Connection {
    return undefined!;
}
export function getPlayerState(
    player: Player,
    repo: Repository<Player, PlayerState>,
): PlayerState | undefined {
    return undefined;
}

// ── Namespace-style types (Namespace.Type pattern) ────────────────────────────

export namespace Net {
    export interface Packet {
        id: number;
        data: buffer;
    }
    export interface Handler {
        process(packet: Packet): void;
    }
}

export function dispatchPacket(packet: Net.Packet, handler: Net.Handler): void { }
export function createHandler(fn: (packet: Net.Packet) => void): Net.Handler {
    return undefined!;
}

// ── Rest parameters ───────────────────────────────────────────────────────────

export function logAll(...messages: string[]): void { }
export function sumAll(...values: number[]): number {
    return 0;
}
export function broadcastTo(message: string, ...players: Player[]): void { }

// ── Optional parameters ───────────────────────────────────────────────────────

export function connect(host: string, port?: number, timeout?: number): boolean {
    return false;
}
export function spawnNPC(position: Vector3, name?: string, health?: number): Model {
    return undefined!;
}

// ── Complex compound types ────────────────────────────────────────────────────

export function batchProcess(
    players: Player[],
    handler: (player: Player, index: number) => Promise<void>,
    options?: { timeout: number; retries: number },
): Promise<Map<Player, boolean>> {
    return undefined!;
}

export function createRouter<
    TRoutes extends Record<string, (player: Player, data: buffer) => void>,
>(routes: TRoutes): { dispatch(route: keyof TRoutes, player: Player, data: buffer): void } {
    return undefined!;
}

export function pipeline<T>(initial: T, ...transforms: Array<(value: T) => T>): T {
    return initial;
}
