import type { Vec2 } from "@shared/types";

// Client UI types — references Vec2 from shared/ (cross-folder).

export interface UIAnchor {
    position: Vec2;
    pivot: Vec2;
}

export interface UIFrame {
    anchor: UIAnchor;
    size: Vec2;
    visible: boolean;
}

export interface UIButton {
    frame: UIFrame;
    label: string;
    enabled: boolean;
}

export function getFrameCenter(f: UIFrame): Vec2 {
    return f.anchor.position;
}

export function isButtonVisible(b: UIButton): boolean {
    return b.frame.visible && b.enabled;
}

export function getButtonLabel(b: UIButton): string {
    return b.label;
}
