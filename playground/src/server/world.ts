import type { ServerEntity, EntityManager } from "./entities";
import type { Vec2 } from "@shared/types";

// World types — reference EntityManager from entities.ts (same-folder cross-file)
// and Vec2 from shared/ (cross-folder).

export interface WorldChunk {
    x: number;
    y: number;
    entities: ServerEntity[];
}

export interface GameWorld {
    chunks: WorldChunk[];
    manager: EntityManager;
    time: number;
}

export function getChunkAt(world: GameWorld, x: number, y: number): WorldChunk | undefined {
    return undefined as never;
}

export function getEntitiesNear(world: GameWorld, pos: Vec2, radius: number): ServerEntity[] {
    return [];
}

export function getManagerMax(world: GameWorld): number {
    return world.manager.maxEntities;
}
