// ── Cross-file type usage test ────────────────────────────────────────────────
// Functions here import types from types.ts. tsc resolves the imported types
// into the .d.ts, so lumine sees fully-resolved type strings in the manifest
// and inlines them into game.luau automatically.

import type { Vec2, Player, Result, Net, Status } from "../../../types";

// Basic cross-file param/return
export function getPosition(player: Player): Vec2 {
	return { x: 0, y: 0 };
}

export function getPlayer(userId: number): Result<Player, string> {
	return { ok: true, value: { userId, name: "unknown" } };
}

// Generic usage
export function wrap<T>(value: T): Result<T> {
	return { ok: true, value };
}

// Namespace type usage
export function sendPacket(channel: Net.Channel, packet: Net.Packet): void {
	channel.send(packet);
}

// Status enum-like union
export function setStatus(s: Status): void {}
export function getStatus(): Status {
	return "idle";
}

// Optional/nullable
export function findPlayer(name: string): Player | undefined {
	return undefined;
}
