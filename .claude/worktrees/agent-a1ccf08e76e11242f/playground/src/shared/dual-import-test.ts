// dual-import-test: imports types from two different folders
//   ./types     → shared/types.ts      (same shared/ folder)
//   ./models/shapes → shared/models/shapes.ts  (subfolder)

import type { Vec2, Player, Result, Status, Net } from "./types";
import type { Circle, Rect, Line, Shape, ShapeGroup } from "./models/shapes";

// ── types from ./types ────────────────────────────────────────────────────────

export function vec2_identity(v: Vec2): Vec2 {
    return v;
}

export function player_name(p: Player): string {
    return p.name;
}

export function result_ok<T>(value: T): Result<T> {
    return { ok: true, value };
}

export function result_err<T>(msg: string): Result<T> {
    return { ok: false, error: msg };
}

export function get_status(): Status {
    return "idle";
}

export function net_send(ch: Net.Channel, id: number, payload: unknown): void {
    ch.send({ id, payload });
}

// ── types from ./models/shapes ────────────────────────────────────────────────

export function circle_area(c: Circle): number {
    return c.radius * c.radius;
}

export function rect_perimeter(r: Rect): number {
    return 2 * (r.width + r.height);
}

export function line_dx(l: Line): number {
    return l.x2 - l.x1;
}

export function shape_group_visible<T extends Shape>(g: ShapeGroup<T>): boolean {
    return g.visible;
}

// ── cross-folder combinations ─────────────────────────────────────────────────

export function player_at(p: Player, pos: Vec2): Rect {
    return { x: pos.x, y: pos.y, width: 1, height: 2 };
}

export function result_shape(s: Shape): Result<Shape> {
    return { ok: true, value: s };
}

export function group_with_status(g: ShapeGroup, status: Status): boolean {
    return g.visible && status !== "stopped";
}

export function send_circle_packet(ch: Net.Channel, c: Circle): void {
    ch.send({ id: 1, payload: c });
}
