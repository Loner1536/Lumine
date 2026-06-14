// Names of TypeScript utility types that lumine implements as Luau type functions.
// These get the lumine. prefix and are emitted in generated.types.luau.
export const LUMINE_BUILTIN_NAMES = new Set([
    "Partial",
    "Required",
    "Unpack",
    "ReturnType",
    "Pick",
    "Omit",
    "Parameters",
    "Promise", // roblox-ts Promise -- typed structural definition emitted in generated.types.luau
]);

// Luau type function implementations emitted at the top of generated.types.luau
export const LUMINE_BUILTIN_FUNCTIONS = `-- [lumine] utility type functions

-- Partial<T>: make all table properties optional
export type function Partial(T)
    if not T:is("table") then return T end
    local result = types.newtable(nil)
    for key, prop in T:properties() do
        if prop.read then
            result:setreadproperty(key, types.optional(prop.read))
        end
        if prop.write then
            result:setwriteproperty(key, types.optional(prop.write))
        end
    end
    return result
end

-- Required<T>: remove nil/optional from all table properties
export type function Required(T)
    if not T:is("table") then return T end
    local result = types.newtable(nil)
    for key, prop in T:properties() do
        local function stripNil(ty)
            if not ty then return nil end
            if not ty:is("union") then return ty end
            local keep = {}
            for _, component in ty:components() do
                if not component:is("nil") then
                    table.insert(keep, component)
                end
            end
            if #keep == 0 then return types.never end
            if #keep == 1 then return keep[1] end
            return types.unionof(table.unpack(keep))
        end
        local r = stripNil(prop.read)
        local w = stripNil(prop.write)
        if r then result:setreadproperty(key, r) end
        if w then result:setwriteproperty(key, w) end
    end
    return result
end

-- Unpack<T>: extract element type from an array table (handles union of tables)
export type function Unpack(T)
    if T:is("union") then
        local results = {}
        for _, component in T:components() do
            if component:is("table") then
                local idx = component:indexer()
                if idx then table.insert(results, idx.readresult) end
            end
        end
        if #results == 0 then return types.never end
        if #results == 1 then return results[1] end
        return types.unionof(table.unpack(results))
    end
    if not T:is("table") then return types.never end
    local indexer = T:indexer()
    if indexer then return indexer.readresult end
    return types.never
end

-- ReturnType<T>: extract the return type of a function
export type function ReturnType(T)
    if not T:is("function") then return types.never end
    local returns = T:returns()
    if returns.head and #returns.head > 0 then
        if #returns.head == 1 then return returns.head[1] end
        -- Multiple returns: union them (intersection of unrelated types = never)
        return types.unionof(table.unpack(returns.head))
    end
    if returns.tail then return returns.tail end
    return types.never
end

-- Parameters<T>: extract the parameters of a function as a table type
export type function Parameters(T)
    if not T:is("function") then return types.never end
    local params = T:parameters()
    local result = types.newtable(nil)
    result:setindexer(types.number, types.unknown)
    if params.head then
        for i, param in params.head do
            result:setproperty(types.singleton(i), param)
        end
    end
    return result
end

-- Pick<T, K>: keep only properties whose key is in the union K
export type function Pick(T, K)
    if not T:is("table") then return types.never end
    local result = types.newtable(nil)
    -- Collect allowed keys from K (may be a singleton or union of singletons)
    local allowed = {}
    if K:is("union") then
        for _, component in K:components() do
            if component:is("singleton") then
                allowed[component:value()] = true
            end
        end
    elseif K:is("singleton") then
        allowed[K:value()] = true
    end
    for key, prop in T:properties() do
        if key:is("singleton") and allowed[key:value()] then
            if prop.read then result:setreadproperty(key, prop.read) end
            if prop.write then result:setwriteproperty(key, prop.write) end
        end
    end
    return result
end

-- Omit<T, K>: keep all properties except those whose key is in K
export type function Omit(T, K)
    if not T:is("table") then return types.never end
    local result = types.newtable(nil)
    -- Collect excluded keys from K
    local excluded = {}
    if K:is("union") then
        for _, component in K:components() do
            if component:is("singleton") then
                excluded[component:value()] = true
            end
        end
    elseif K:is("singleton") then
        excluded[K:value()] = true
    end
    for key, prop in T:properties() do
        if not (key:is("singleton") and excluded[key:value()]) then
            if prop.read then result:setreadproperty(key, prop.read) end
            if prop.write then result:setwriteproperty(key, prop.write) end
        end
    end
    return result
end

-- Promise: structural type for the roblox-ts / evaera Promise runtime.
-- andThen/catch/etc return Promise<any> because Luau table types do not support
-- per-method generic parameters; callers that need exact types can cast locally.

export type PromiseStatus = "Started" | "Resolved" | "Rejected" | "Cancelled"

export type Promise<T> = {
    -- Chaining
    andThen: (self: Promise<T>, successHandler: (value: T) -> any, failureHandler: ((reason: any) -> any)?) -> Promise<any>,
    catch: (self: Promise<T>, failureHandler: (reason: any) -> any) -> Promise<any>,
    tap: (self: Promise<T>, tapHandler: (value: T) -> any) -> Promise<T>,
    tapCatch: (self: Promise<T>, tapHandler: (reason: any) -> any) -> Promise<T>,
    finally: (self: Promise<T>, finallyHandler: ((status: PromiseStatus) -> any)?) -> Promise<T>,
    andThenCall: (self: Promise<T>, callback: (...any) -> any, ...any) -> Promise<any>,
    andThenReturn: (self: Promise<T>, ...any) -> Promise<any>,
    finallyCall: (self: Promise<T>, callback: (...any) -> any, ...any) -> Promise<any>,
    finallyReturn: (self: Promise<T>, ...any) -> Promise<any>,
    -- Timing
    now: (self: Promise<T>, rejectionValue: any?) -> Promise<T>,
    timeout: (self: Promise<T>, seconds: number, rejectionValue: any?) -> Promise<T>,
    -- Yielding (these yield the current thread)
    await: (self: Promise<T>) -> (boolean, T),
    awaitStatus: (self: Promise<T>) -> (PromiseStatus, T),
    expect: (self: Promise<T>) -> T,
    -- Control
    cancel: (self: Promise<T>) -> (),
    -- Status queries
    getStatus: (self: Promise<T>) -> PromiseStatus,
    isPending: (self: Promise<T>) -> boolean,
    isResolved: (self: Promise<T>) -> boolean,
    isRejected: (self: Promise<T>) -> boolean,
    isCancelled: (self: Promise<T>) -> boolean,
}
`;
