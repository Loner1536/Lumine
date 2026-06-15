// Geometry types for dual-import test

export interface Circle {
    cx: number;
    cy: number;
    radius: number;
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Line {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export type Shape = Circle | Rect | Line;

export interface ShapeGroup<T extends Shape = Shape> {
    name: string;
    items: T[];
    visible: boolean;
}
