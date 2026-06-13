//!optimize 2

// Package
import Typenet from "@rbxts/typenet";

// Shared
import Network from "@shared/network";

Typenet.start();

Network.Data.fire();
Network.Data.broadcast();

Network.Data.once((player) => print(player));
Network.Data.connect((player) => print(player));
