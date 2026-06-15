import type { UIFrame, UIButton } from "./ui";
import type { Player } from "@shared/types";

// Store type — references UIFrame/UIButton from ui.ts (same-folder cross-file)
// and Player from shared/ (cross-folder).

export interface UIStore {
    frames: UIFrame[];
    buttons: UIButton[];
    localPlayer: Player;
}

export function getVisibleFrames(store: UIStore): UIFrame[] {
    return store.frames.filter((f) => f.visible);
}

export function getEnabledButtons(store: UIStore): UIButton[] {
    return store.buttons.filter((b) => b.enabled);
}

export function getPlayerName(store: UIStore): string {
    return store.localPlayer.name;
}
