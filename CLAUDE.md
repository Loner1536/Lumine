# Lumine — CLAUDE.md

Luau type annotation tool for roblox-ts compiled projects.
Reads TypeScript `.d.ts` files, converts types to Luau AST, inlines type
declarations into compiled `.luau` files, and writes `Lumine.lua` (utility
type functions) into the roblox-ts include folder.

## Repo layout

```
package/src/          ← lumine source (TypeScript, run directly by bun)
  luau-types.ts       ← LuauType AST + printer (printLuauType, printParam, printReturn)
  extract.ts          ← TypeScript AST → LuauType  (uses ts compiler API)
  emit.ts             ← LuauType → Luau source strings + Lumine.lua content
  annotate.ts         ← injects annotations + inline types into .luau files
  index.ts            ← CLI entry point (runOnce / runWatch / runInit)
  config.ts           ← loads tsconfig + lumine.toml
  rojo.ts             ← resolves file paths via rojo project JSON
  types.ts            ← TypeManifest, LumineConfig, AnnotationResult interfaces
  builtins.ts         ← LUMINE_BUILTIN_NAMES + LUMINE_BUILTIN_FUNCTIONS (Luau source)
  convert.ts          ← DEAD — delete this file

playground/src/       ← roblox-ts test project
  shared/test.ts      ← covers every type mapping case
playground/out/       ← rbxtsc + lumine output (gitignored, regenerated)
  src/shared/test.luau
  include/Lumine.lua  ← generated builtin types
```

## Architecture (critical — read before touching anything)

**No strings for types.** Every type goes through the `LuauType` AST:

```
TypeScript .d.ts
  → extract.ts (ts.TypeNode → LuauType)
  → annotate.ts (LuauType → printLuauType() → inject into .luau)
  → emit.ts (LuauType → export type declarations)
```

`convert.ts` is dead. Do not use or restore it.

**Inline type injection.** Types are injected directly into each `.luau` file
from its own `.d.ts` — no separate `__generated__/` folder. The sentinel
`-- [lumine types]` marks the injected block; `stripOldLumineBlock()` removes
it before re-injection so cross-file requires always stay current.

**Builtins live in `Lumine.lua`** next to `RuntimeLib.lua` and `Promise.lua`
in `out/include/`. Referenced as `_Lumine.Partial<T>`, `_Lumine.Promise<T>`.
The local var is always `local _Lumine = require(...)`.

## Test command

```bash
bunx pnpm --filter playground compile
cat playground/out/src/shared/test.luau
cat playground/out/include/Lumine.lua
```

Dev (watch mode):
```bash
bun run dev
```

## Key invariants — never break these

1. `printLuauType` is the ONLY place that converts `LuauType → string`.
   Nothing else should produce Luau type syntax.

2. `void` in generic arg position prints as `nil` (not `()`).
   `printLuauType(t, 0, true)` for generic args, `false` for returns.

3. Rest params: `...: T` (element type), never `...: {T}` (array type).
   `extractArrayElement()` in extract.ts strips the array wrapper.

4. `findSignatureEnd` does NOT track `<>` — the `>` in Luau's `->` arrow
   is not a bracket and would break depth tracking.

5. `splitParams` guards `>` when preceded by `-`: handles `->` in already-
   annotated params without breaking generic depth tracking.

6. Watch debounce is 800ms — gives rbxtsc time to finish all incremental
   writes before lumine re-annotates.

## LuauType AST quick ref

```typescript
// Primitives
LuauString / LuauNumber / LuauBoolean / LuauAny / LuauNever / LuauNil / LuauVoid

// Constructors
mkOptional(inner)           // T?
mkUnion([A, B])             // A | B
mkIntersection([A, B])      // A & B  (deduplicates by JSON)
mkRef("Name", [args])       // Name or Name<T, U>

// Table: { fields, indexer? }
// Function: { params: LuauFnParam[], returns: LuauType }
// Reference: { name, args? }
// Tuple: { elements }  → (T, U) multi-return

// Printer
printLuauType(t)                // default — void = ()
printLuauType(t, 0, true)       // in generic arg — void = nil
printReturn(t)                  // ": T" or "" for void
printParam(name, t, opt, rest)  // "name: T" or "...: T"
typeUsesBuiltins(t)             // true if any node is _Lumine.*
```

## Known type mappings

| TypeScript | Luau |
|---|---|
| `string \| undefined` | `string?` |
| `A \| B` | `A \| B` |
| `T extends X ? A : B` | `A & B` (intersection of branches) |
| `Array<T>` / `T[]` | `{T}` |
| `Map<K,V>` / `Record<K,V>` | `{[K]: V}` |
| `Set<T>` | `{[T]: boolean}` |
| `Readonly<T>` | `T` (stripped) |
| `LuaTuple<[T,U]>` | `(T, U)` multi-return |
| `Promise<void>` | `_Lumine.Promise<nil>` |
| `Partial<T>` | `_Lumine.Partial<T>` |
| `...args: T[]` | `...: T` (element type not array) |
| mapped type | `any` |
| template literal | `string` |
| `infer` | `any` |

## Common tasks

**Add a new builtin type (like a new utility)**
1. Add name to `LUMINE_BUILTIN_NAMES` in `builtins.ts`
2. Add Luau type function implementation to `LUMINE_BUILTIN_FUNCTIONS`
3. Handle the TS name in `convertTypeRef` in `extract.ts` → return `mkRef("_Lumine.Name", args)`

**Add a new Roblox Instance type**
Add to `ROBLOX_TYPES` set in `extract.ts`.

**Fix a type conversion bug**
All conversion is in `extract.ts` → `tsNodeToLuau()` and `convertTypeRef()`.
Check the specific `ts.SyntaxKind` and add/fix the case.

**Debug annotation output**
```bash
bunx pnpm --filter playground compile 2>&1 | head -20
cat playground/out/src/shared/test.luau | head -80
```
