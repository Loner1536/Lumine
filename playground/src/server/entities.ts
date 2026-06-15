import type { Player, Vec2 } from "@shared/types";

// Server-side entity types.
// References shared/ types (cross-folder) — Player, Vec2 come from shared/types.ts.

export interface ServerEntity {
    id: number;
    player: Player;
    position: Vec2;
    health: number;
}

export interface EntityManager {
    entities: ServerEntity[];
    maxEntities: number;
}

export function createEntity(id: number, player: Player, pos: Vec2): ServerEntity {
    return { id, player, position: pos, health: 100 };
}

export function getEntityHealth(e: ServerEntity): number {
    return e.health;
}

export function moveEntity(e: ServerEntity, pos: Vec2): ServerEntity {
    return { id: e.id, player: e.player, position: pos, health: e.health };
}
