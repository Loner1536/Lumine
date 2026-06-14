# Lumine

Luau type annotation tool for [roblox-ts](https://roblox-ts.com/) compiled projects.

Lumine reads the `.d.ts` files emitted by `rbxtsc`, converts TypeScript types to Luau, and injects type annotations directly into your compiled `.luau` files — no separate generated folder, no manual maintenance.

```
TypeScript .d.ts  →  LuauType AST  →  inline annotations in .luau
```

---

## What it does

Say you have two TypeScript files:

**`shared/types.ts`**
```typescript
export interface Result<T, E = string> {
    ok: boolean;
    value?: T;
    error?: E;
}

export interface Player {
    userId: number;
    name: string;
    team?: string;
}
```

**`shared/game.ts`**
```typescript
import type { Player, Result } from "./types";

export function getPlayer(userId: number): Result<Player> { ... }
export function wrap<T>(value: T): Result<T> { ... }
```

Without Lumine, `rbxtsc` emits bare Luau with no type information:

```lua
-- game.luau (rbxtsc output, no types)
local function getPlayer(userId)
    ...
end
local function wrap(value)
    ...
end
```

After running `lumine`, the files are annotated in place:

**`types.luau`** — type declarations injected at the top:
```lua
-- [lumine types]
export type Result<T, E> = {
    ok: boolean,
    value: T?,
    error: E?,
}

export type Player = {
    userId: number,
    name: string,
    team: string?,
}
```

**`game.luau`** — function signatures annotated, cross-file require added:
```lua
-- [lumine types]
local _Types = require(...)  -- resolves to types.luau via Rojo

local function getPlayer(userId: number): _Types.Result<_Types.Player, string>
    ...
end
local function wrap<T>(value: T): _Types.Result<T, string>
    ...
end
```

Notice that `Result<Player>` (one type arg) becomes `Result<Player, string>` — Lumine fills in TypeScript's default type parameter `E = string` automatically, keeping Luau's arity correct.

Lumine also writes `Lumine.lua` into the roblox-ts include folder (alongside `RuntimeLib.lua`) containing Luau type function implementations for `Partial<T>`, `Required<T>`, `Promise<T>`, and other utility types.

---

## Setup

### 1. Enable declaration output in `tsconfig.json`

```json
{
  "compilerOptions": {
    "declaration": true
  }
}
```

### 2. (Optional) Configure `lumine.toml`

By default Lumine looks for `Lumine.lua` in `../include` relative to `outDir` (the roblox-ts convention). Override with:

```toml
includeDir = "out/include"
```

### 3. Add to your compile script

```json
{
  "scripts": {
    "compile": "rm -rf ./out && rbxtsc -p ./src -i ./out/include && lumine"
  }
}
```

---

## Usage

```
lumine                  Run once — annotate all .luau files in outDir
lumine -w, --watch      Watch mode — re-annotate on .luau changes (debounced 800ms)
lumine --dry-run        Show what would be annotated without writing
lumine -v, --version    Print version
lumine -h, --help       Show help
```

---

## Type mappings

| TypeScript | Luau |
|---|---|
| `string \| undefined` | `string?` |
| `A \| B` | `A \| B` |
| `A & B` | `A & B` |
| `Array<T>` / `T[]` | `{T}` |
| `Map<K, V>` / `Record<K, V>` | `{[K]: V}` |
| `Set<T>` | `{[T]: boolean}` |
| `Readonly<T>` | `T` (stripped) |
| `NonNullable<T>` | `T` (strips optional) |
| `Partial<T>` | `_Lumine.Partial<T>` |
| `Required<T>` | `_Lumine.Required<T>` |
| `ReturnType<T>` | `_Lumine.ReturnType<T>` |
| `Parameters<T>` | `_Lumine.Parameters<T>` |
| `Pick<T, K>` | `_Lumine.Pick<T, K>` |
| `Omit<T, K>` | `_Lumine.Omit<T, K>` |
| `Promise<void>` | `_Lumine.Promise<nil>` |
| `Promise<T>` | `_Lumine.Promise<T>` |
| `LuaTuple<[T, U]>` | `(T, U)` multi-return |
| `keyof T` | `keyof<T>` |
| `T extends X ? A : B` | `A & B` (intersection of branches) |
| `...args: T[]` | `...: T` (element type) |
| `"hello" \| "world"` | `"hello" \| "world"` (string singletons) |
| `true \| false` | `true \| false` (boolean singletons) |
| `0 \| 1 \| 2` | `number` (number literals collapse) |
| mapped type | `any` |
| template literal | `string` |
| `infer` | `any` |

### Default type parameters

TypeScript default type params are filled in automatically. If `Result<T, E = string>` is declared and used as `Result<Player>`, Lumine emits `Result<Player, string>` — keeping Luau's type arity correct since Luau has no equivalent of default type params.

---

## Builtin utility types (`Lumine.lua`)

Lumine writes `Lumine.lua` into your include folder. It implements utility types as [Luau type functions](https://luau.org/typefunction):

| Type | Behaviour |
|---|---|
| `_Lumine.Partial<T>` | Makes all table properties optional |
| `_Lumine.Required<T>` | Removes `nil` / optional from all properties |
| `_Lumine.Pick<T, K>` | Keeps only properties whose key is in `K` |
| `_Lumine.Omit<T, K>` | Drops properties whose key is in `K` |
| `_Lumine.ReturnType<T>` | Extracts the return type of a function |
| `_Lumine.Parameters<T>` | Extracts function parameters as a table type |
| `_Lumine.Unpack<T>` | Extracts the element type of an array table |
| `_Lumine.Promise<T>` | Structural type matching the roblox-ts Promise runtime |

---

## Cross-file types

When a function in `game.luau` uses a type declared in `types.luau`, Lumine:

1. Emits `export type Foo = ...` declarations into the file that owns them (`types.luau`).
2. Injects a `local _Types_xxx = require(...)` at the top of the referencing file.
3. Qualifies all cross-file type references: `Foo` → `_Types_xxx.Foo`.

Rojo path resolution is used for the require path when a `default.project.json` is present.

---

## Extending Lumine

### Add a new builtin utility type

1. Add the name to `LUMINE_BUILTIN_NAMES` in `package/src/builtins.ts`.
2. Add the Luau type function implementation to `LUMINE_BUILTIN_FUNCTIONS`.
3. Handle the TypeScript name in `convertTypeRef` in `package/src/extract.ts` → return `mkRef("_Lumine.Name", args)`.

### Add a new Roblox Instance type

Add the name to the `ROBLOX_TYPES` set in `package/src/extract.ts`.

### Fix a type conversion

All conversion logic lives in `package/src/extract.ts` → `tsNodeToLuau()` and `convertTypeRef()`. Find the relevant `ts.SyntaxKind` and add or fix the case.

---

## Architecture

```
package/src/
  index.ts        CLI entry + orchestration (runOnce / runWatch)
  config.ts       Loads tsconfig.json + lumine.toml
  extract.ts      TypeScript AST → LuauType  (the main conversion layer)
  luau-types.ts   LuauType AST nodes + printLuauType() printer
  emit.ts         LuauType → export type declarations + Lumine.lua content
  annotate.ts     Injects annotations and inline types into .luau files
  builtins.ts     LUMINE_BUILTIN_NAMES + LUMINE_BUILTIN_FUNCTIONS
  rojo.ts         Resolves file paths via Rojo project JSON
  types.ts        TypeManifest, LumineConfig, AnnotationResult interfaces
```

**Key invariant:** `printLuauType` in `luau-types.ts` is the only place that converts a `LuauType` to a string. No other code produces raw Luau type syntax.

Types flow one way:

```
.d.ts  →  extract.ts (ts.TypeNode → LuauType)
       →  annotate.ts (LuauType → printLuauType() → inject into .luau)
       →  emit.ts (LuauType → export type declarations)
```

The injected block is delimited by `-- [lumine types]` and is fully replaced on each run, so annotations stay current without stale state.
