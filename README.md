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

## Installation

### Via Rokit (recommended)

Add Lumine to your project's `rokit.toml`:

```toml
[tools]
lumine = "loner1536/lumine@0.1.9"
```

Then run:

```
rokit install
```

Rokit downloads the correct binary for your platform automatically. No Bun or Node.js required on the machine.

### Via pnpm / npm (roblox-ts workspace)

```
pnpm add -D lumine
```

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
lumine --verbose        Log each annotated file (also works with --watch)
lumine -v, --version    Print version
lumine -h, --help       Show help
```

---

## Type mappings

All mappings below are verified against actual compiler output (`playground/out/src/shared/test.luau`).

### Primitives

| TypeScript | Luau |
|---|---|
| `number` | `number` |
| `string` | `string` |
| `boolean` | `boolean` |
| `buffer` | `buffer` |
| `void` (return) | no annotation (bare `()`) |
| `undefined` / `null` | `nil` |
| `any` | `any` |
| `unknown` | `any` |
| `never` | `never` |

### Optional / nullable

| TypeScript | Luau |
|---|---|
| `T \| undefined` | `T?` |
| `T \| null` | `T?` |
| `T \| null \| undefined` | `T?` |
| `NonNullable<T>` | `T` (nil stripped) |

### Unions and intersections

| TypeScript | Luau |
|---|---|
| `A \| B \| C` | `A \| B \| C` |
| `A & B` | `A & B` |

### Collections

| TypeScript | Luau |
|---|---|
| `T[]` / `Array<T>` | `{[number]: T}` |
| `ReadonlyArray<T>` | `{[number]: T}` (Readonly stripped) |
| `Map<K, V>` / `Record<K, V>` | `{[K]: V}` |
| `ReadonlyMap<K, V>` | `{[K]: V}` (Readonly stripped) |
| `Set<T>` | `{[T]: boolean}` |
| `ReadonlySet<T>` | `{[T]: boolean}` (Readonly stripped) |
| `{ [key: string]: T }` index sig | `{[string]: T}` |
| `{ [key: number]: T }` index sig | `{[number]: T}` |

### Functions and parameters

| TypeScript | Luau |
|---|---|
| `(a: A, b: B) => C` | `(a: A, b: B) -> C` |
| `() => void` | `() -> ()` |
| `param?: T` optional param | `param: T?` |
| `...args: T[]` rest param | `...: T` (element type, not array) |

### Generics

| TypeScript | Luau |
|---|---|
| `<T>` / `<T, U>` | `<T>` / `<T, U>` (pass-through) |
| `<T extends string>` constraint | `<T>` (constraint stripped) |
| `keyof T` | `keyof<T>` |

### Literal types

| TypeScript | Luau |
|---|---|
| `"a" \| "b"` string singletons | `"a" \| "b"` |
| `true` / `false` boolean singletons | `true` / `false` |
| `0 \| 1 \| 2` number literals | `number` (collapse — no number singletons in Luau) |

### Object types and interfaces

| TypeScript | Luau |
|---|---|
| `interface Foo { a: number; b?: string }` | `export type Foo = { a: number, b: string? }` |
| `interface Foo<T> { value: T }` | `export type Foo<T> = { value: T }` |
| `Readonly<T>` | `T` (Readonly stripped, Luau has no equivalent) |
| `Namespace.Type<T>` | `Namespace_Type<T>` (underscore-joined, exported inline) |

### roblox-ts specific

| TypeScript | Luau |
|---|---|
| `LuaTuple<[T, U]>` | `(T, U)` multi-return |
| `LuaTuple<[T, U?]>` | `(T, U?)` multi-return with optional |
| `Promise<T>` | `_Lumine.Promise<T>` |
| `Promise<void>` | `_Lumine.Promise<nil>` |
| `Promise<null>` / `Promise<undefined>` | `_Lumine.Promise<nil>` |
| `Promise<Promise<T>>` | `_Lumine.Promise<_Lumine.Promise<T>>` |
| Roblox types (`RBXScriptSignal`, `Vector3`, `Player`, …) | passed through as-is |

### Utility types via `Lumine.lua`

These are implemented as [Luau type functions](https://luau.org/typefunction) in `Lumine.lua` and referenced as `_Lumine.*`:

| TypeScript | Luau |
|---|---|
| `Partial<T>` | `_Lumine.Partial<T>` |
| `Required<T>` | `_Lumine.Required<T>` |
| `Pick<T, K>` | `_Lumine.Pick<T, K>` |
| `Omit<T, K>` | `_Lumine.Omit<T, K>` |
| `ReturnType<T>` | `_Lumine.ReturnType<T>` |
| `Parameters<T>` | `_Lumine.Parameters<T>` |
| `Awaited<T>` | `_Lumine.Awaited<T>` |
| `Extract<T, U>` | `_Lumine.Extract<T, U>` |
| `Exclude<T, U>` | `_Lumine.Exclude<T, U>` |
| `NoInfer<T>` | `_Lumine.NoInfer<T>` (identity) |
| `Unpack<T>` (custom) | `_Lumine.Unpack<T>` |

### Approximate / lossy conversions

These are valid Luau but lose some TypeScript precision:

| TypeScript | Luau | Notes |
|---|---|---|
| `T extends X ? A : B` | `A & B` | All conditional branches intersected |
| `[A, B, C]` plain tuple | `A \| B \| C` | No tuple type in Luau; union of member types |

### Not representable (fallback to `any` or `string`)

| TypeScript | Luau | Notes |
|---|---|---|
| `{ [K in keyof T]?: T[K] }` mapped type | `any` | No mapped types in Luau |
| `` `on${string}` `` template literal | `string` | No template literal types in Luau |
| `T[K]` indexed access | `any` | Not supported |
| `typeof X` in type position | `any` | Not supported |
| `infer U` | `any` | No `infer` in Luau |

### Default type parameters

TypeScript default type params are filled in automatically. If `Result<T, E = string>` is declared and used as `Result<Player>`, Lumine emits `Result<Player, string>` — keeping Luau's type arity correct since Luau has no equivalent of default type params.

The `this: void` parameter emitted by rbxtsc is silently skipped and does not affect parameter matching.

---

## Builtin utility types (`Lumine.lua`)

Lumine writes `Lumine.lua` into your include folder next to `RuntimeLib.lua`. It implements utility types as [Luau type functions](https://luau.org/typefunction):

| Type | Behaviour |
|---|---|
| `_Lumine.Partial<T>` | Makes all table properties optional |
| `_Lumine.Required<T>` | Removes `nil` / optional from all properties |
| `_Lumine.Pick<T, K>` | Keeps only properties whose key is in `K` |
| `_Lumine.Omit<T, K>` | Drops all properties whose key is in `K` |
| `_Lumine.ReturnType<T>` | Extracts the return type of a function |
| `_Lumine.Parameters<T>` | Extracts function parameters as a table type |
| `_Lumine.Unpack<T>` | Extracts the element type of an array table |
| `_Lumine.Awaited<T>` | Unwraps `Promise<X>` to `X` via the `expect` method return type |
| `_Lumine.Extract<T, U>` | Keeps union members structurally assignable to `U` |
| `_Lumine.Exclude<T, U>` | Removes union members structurally assignable to `U` |
| `_Lumine.NoInfer<T>` | Identity — TypeScript inference hint, no Luau equivalent |
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
