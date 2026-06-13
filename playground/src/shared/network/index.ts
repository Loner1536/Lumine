//!native

// Package
import { Channel, packet } from "@rbxts/typenet";

const Network = Channel("Player", {
    Data: packet(),
});

export default Network;
