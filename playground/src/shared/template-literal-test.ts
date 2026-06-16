// ═══════════════════════════════════════════════════════════════════
// Template literal type test — concrete implementations so the
// compiled Luau annotations are real and instantiatable by the
// new type solver via _Lumine.Concat chains.
//
// Type shapes emitted in _lumine_types.luau:
//   _Lumine.Concat<A, B>                  ← prefix/suffix
//   _Lumine.Concat<A, _Lumine.Concat<sep, B>>  ← two-part with sep
//   nested chains                         ← three-or-more parts
//   "literal"                             ← no-substitution collapse
//   string                                ← generic fallback
// ═══════════════════════════════════════════════════════════════════

// ── Two-part dot-separated event paths ───────────────────────────────────────

// → _Lumine.Concat<TModule, _Lumine.Concat<".", TEvent>>
export type DotPath<TModule extends string, TEvent extends string> =
    `${TModule}.${TEvent}`;

// ── Prefix-only templates ─────────────────────────────────────────────────────

// → _Lumine.Concat<"on", TName>
export type OnEvent<TName extends string> = `on${TName}`;

// → _Lumine.Concat<"before", TName>
export type BeforeHook<TName extends string> = `before${TName}`;

// → _Lumine.Concat<"after", TName>
export type AfterHook<TName extends string> = `after${TName}`;

// ── Suffix-only templates ─────────────────────────────────────────────────────

// → _Lumine.Concat<TName, "Changed">
export type Changed<TName extends string> = `${TName}Changed`;

// → _Lumine.Concat<TName, "Request">
export type Request<TName extends string> = `${TName}Request`;

// → _Lumine.Concat<TName, "Response">
export type Response<TName extends string> = `${TName}Response`;

// ── Non-dot separators ────────────────────────────────────────────────────────

// → _Lumine.Concat<TNs, _Lumine.Concat<":", TKey>>
export type NsKey<TNs extends string, TKey extends string> = `${TNs}:${TKey}`;

// → _Lumine.Concat<TRepo, _Lumine.Concat<"/", TFile>>
export type FilePath<TRepo extends string, TFile extends string> = `${TRepo}/${TFile}`;

// → _Lumine.Concat<TFrom, _Lumine.Concat<"->", TTo>>
export type Transition<TFrom extends string, TTo extends string> = `${TFrom}->${TTo}`;

// ── Three-part chains (deeper nesting) ───────────────────────────────────────

// → Concat<A, Concat<".", Concat<B, Concat<".", C>>>>
export type TriplePath<A extends string, B extends string, C extends string> =
    `${A}.${B}.${C}`;

// → Concat<Action, Concat<"_", Concat<Resource, Concat<"_", Scope>>>>
export type Permission<
    TAction extends string,
    TResource extends string,
    TScope extends string,
> = `${TAction}_${TResource}_${TScope}`;

// ── Literal with embedded generic (middle segment concrete) ───────────────────

// → Concat<TModule, Concat<".events.", TEvent>>
export type EventsPath<TModule extends string, TEvent extends string> =
    `${TModule}.events.${TEvent}`;

// ── No-substitution template literals → singleton string collapse ─────────────

export type PlayerJoin  = `player.join`;      // → "player.join"
export type PlayerLeave = `player.leave`;     // → "player.leave"
export type RootIndex   = `root/index`;       // → "root/index"
export type IdleToRun   = `idle->running`;    // → "idle->running"

// ── Generic fallback (primitive `string` → stays string) ─────────────────────

export type AnyDotPath  = `${string}.${string}`;  // → string
export type AnyOnEvent  = `on${string}`;           // → string

// ═══════════════════════════════════════════════════════════════════
// Concrete implementations — give lumine real annotatable signatures
// ═══════════════════════════════════════════════════════════════════

// ── Two-part builders ─────────────────────────────────────────────────────────

export function make_dot_path<M extends string, E extends string>(
    module: M,
    event: E,
): DotPath<M, E> {
    return `${module}.${event}`;
}

export function make_on_event<N extends string>(name: N): OnEvent<N> {
    return `on${name}`;
}

export function make_before<N extends string>(name: N): BeforeHook<N> {
    return `before${name}`;
}

export function make_after<N extends string>(name: N): AfterHook<N> {
    return `after${name}`;
}

export function make_changed<N extends string>(name: N): Changed<N> {
    return `${name}Changed`;
}

export function make_request<N extends string>(name: N): Request<N> {
    return `${name}Request`;
}

export function make_response<N extends string>(name: N): Response<N> {
    return `${name}Response`;
}

export function make_ns_key<NS extends string, K extends string>(
    ns: NS,
    key: K,
): NsKey<NS, K> {
    return `${ns}:${key}`;
}

export function make_file_path<R extends string, P extends string>(
    repo: R,
    file: P,
): FilePath<R, P> {
    return `${repo}/${file}`;
}

export function make_transition<F extends string, T extends string>(
    from: F,
    to: T,
): Transition<F, T> {
    return `${from}->${to}`;
}

// ── Three-part builders ───────────────────────────────────────────────────────

export function make_triple<A extends string, B extends string, C extends string>(
    a: A,
    b: B,
    c: C,
): TriplePath<A, B, C> {
    return `${a}.${b}.${c}`;
}

export function make_permission<
    TAction extends string,
    TResource extends string,
    TScope extends string,
>(action: TAction, resource: TResource, scope: TScope): Permission<TAction, TResource, TScope> {
    return `${action}_${resource}_${scope}`;
}

export function make_events_path<M extends string, E extends string>(
    module: M,
    event: E,
): EventsPath<M, E> {
    return `${module}.events.${event}`;
}

// ── Round-trips with concrete type args (verifies Concat instantiation) ───────

export function roundtrip_join(p: PlayerJoin): PlayerJoin { return p; }
export function roundtrip_leave(p: PlayerLeave): PlayerLeave { return p; }

export function roundtrip_dot_path(
    p: DotPath<"inventory", "updated">,
): DotPath<"inventory", "updated"> {
    return p;
}

export function roundtrip_ns_key(
    k: NsKey<"game", "start">,
): NsKey<"game", "start"> {
    return k;
}

export function roundtrip_triple(
    t: TriplePath<"a", "b", "c">,
): TriplePath<"a", "b", "c"> {
    return t;
}

export function roundtrip_permission(
    p: Permission<"read", "items", "admin">,
): Permission<"read", "items", "admin"> {
    return p;
}

export function roundtrip_transition(
    t: Transition<"idle", "running">,
): Transition<"idle", "running"> {
    return t;
}

// ── Hook lifecycle — build before/after pairs from the same name ──────────────

export function make_hook_pair<N extends string>(
    name: N,
): { before: BeforeHook<N>; after: AfterHook<N> } {
    return { before: `before${name}`, after: `after${name}` };
}

// ── Request/response pair ─────────────────────────────────────────────────────

export function make_rpc_pair<N extends string>(
    name: N,
): { request: Request<N>; response: Response<N> } {
    return { request: `${name}Request`, response: `${name}Response` };
}

// ── Compose: DotPath → EventsPath (shows nested template usage) ───────────────

export function dot_path_to_events_path<M extends string, E extends string>(
    module: M,
    event: E,
): EventsPath<M, E> {
    return make_events_path(module, event);
}
