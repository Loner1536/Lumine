// utility-types-test.ts
// Covers Pick, Omit (builtins), and unsupported utilities (→ any)

export interface UserProfile {
    id: number;
    name: string;
    email: string;
    age: number;
    active: boolean;
}

// ── Pick<T, K> ────────────────────────────────────────────────────────────────

export function pick_single(u: Pick<UserProfile, "name">): Pick<UserProfile, "name"> {
    return u;
}

export function pick_multi(u: Pick<UserProfile, "name" | "age">): Pick<UserProfile, "id" | "active"> {
    return { id: 0, active: true };
}

export function pick_return(): Pick<UserProfile, "name" | "email"> {
    return { name: "Alice", email: "alice@example.com" };
}

// ── Omit<T, K> ────────────────────────────────────────────────────────────────

export function omit_single(u: Omit<UserProfile, "email">): Omit<UserProfile, "email"> {
    return u;
}

export function omit_multi(u: Omit<UserProfile, "email" | "id">): void {
    return;
}

export function omit_return(): Omit<UserProfile, "id" | "email"> {
    return { name: "Bob", age: 30, active: true };
}

// ── Pick and Omit combined ────────────────────────────────────────────────────

export function pick_then_omit(u: Pick<UserProfile, "name" | "age" | "active">): Omit<UserProfile, "id" | "email"> {
    return u;
}

// ── Unsupported utilities → any ───────────────────────────────────────────────

// Awaited<T>
export function awaited_val<T>(x: Awaited<Promise<T>>): Awaited<T> {
    return x as never;
}

// Extract<T, U>
export function extract_strings(x: Extract<string | number | boolean, string>): void { }

// Exclude<T, U>
export function exclude_bool(x: Exclude<string | number | boolean, boolean>): void { }

// NoInfer<T>
export function no_infer_param<T>(value: T, fallback: NoInfer<T>): T {
    return value ?? fallback;
}
