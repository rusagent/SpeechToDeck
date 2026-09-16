/**
 * SteamHookRegistry — sole owner of every installed Steam hook (spec §16).
 *
 * Install preconditions (§104): the property must exist, be a callable data
 * property and be writable/configurable; a target+property pair may only be
 * wrapped once by this plugin at a time. Restore semantics (§16): a function
 * is restored only when the currently installed function is still the wrapper
 * owned by this plugin — later modifications by other plugins are never
 * overwritten. Cleanup is idempotent.
 */

import type { Disposable } from "../../shared/Disposable";

export interface InstalledHook extends Disposable {
    readonly target: object;
    readonly property: string;
}

/** Receives the original function and returns the §15-conformant wrapper. */
export type HookWrapperFactory = (
    original: (...args: unknown[]) => unknown,
) => (...args: unknown[]) => unknown;

interface ActiveInstall {
    readonly holder: object;
    readonly property: string;
    readonly wrapper: (...args: unknown[]) => unknown;
    readonly originalDescriptor: PropertyDescriptor;
    readonly hook: InstalledHookImpl;
}

class InstalledHookImpl implements InstalledHook {
    private disposed = false;

    constructor(
        readonly target: object,
        readonly property: string,
        private readonly release: (hook: InstalledHookImpl) => void,
    ) {}

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.release(this);
    }
}

function findPropertyDescriptor(
    target: object,
    property: string,
): { holder: object; descriptor: PropertyDescriptor } | null {
    let cursor: object | null = target;
    while (cursor !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(cursor, property);
        if (descriptor !== undefined) {
            return { holder: cursor, descriptor };
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    return null;
}

export class SteamHookRegistry {
    private readonly active = new Map<object, Map<string, ActiveInstall>>();

    /**
     * Wraps `target[property]` with `wrapperFactory(original)`. Returns `null`
     * (installs nothing) when any §104 precondition fails or this plugin
     * already owns a wrapper for the same property.
     */
    install(
        target: object,
        property: string,
        wrapperFactory: HookWrapperFactory,
    ): InstalledHook | null {
        const found = findPropertyDescriptor(target, property);
        if (found === null) {
            return null;
        }
        const { holder, descriptor } = found;
        if (typeof descriptor.value !== "function" || descriptor.get !== undefined) {
            return null;
        }
        if (descriptor.writable === false || descriptor.configurable === false) {
            return null; // do not mutate structures we cannot cleanly restore (§104)
        }
        if (this.active.get(holder)?.has(property) === true) {
            return null; // plugin not already patched? — refuses a second wrap (§104)
        }

        const original = descriptor.value as (...args: unknown[]) => unknown;
        const wrapper = wrapperFactory(original);
        const hook = new InstalledHookImpl(target, property, (owned) => this.release(owned));
        const record: ActiveInstall = {
            holder,
            property,
            wrapper,
            originalDescriptor: descriptor,
            hook,
        };
        let perTarget = this.active.get(holder);
        if (perTarget === undefined) {
            perTarget = new Map<string, ActiveInstall>();
            this.active.set(holder, perTarget);
        }
        perTarget.set(property, record);

        Object.defineProperty(holder, property, { ...descriptor, value: wrapper });
        return hook;
    }

    /** Restores every hook this registry still owns. Idempotent. */
    restoreAll(): void {
        for (const perTarget of [...this.active.values()]) {
            for (const record of [...perTarget.values()]) {
                record.hook.dispose();
            }
        }
    }

    /** Number of hooks currently owned; used by diagnostics and tests. */
    get size(): number {
        let count = 0;
        for (const perTarget of this.active.values()) {
            count += perTarget.size;
        }
        return count;
    }

    private release(hook: InstalledHookImpl): void {
        for (const [holder, perTarget] of [...this.active.entries()]) {
            const record = perTarget.get(hook.property);
            if (record === undefined || record.hook !== hook) {
                continue;
            }
            // Restore only when the currently installed function is still our
            // wrapper; never overwrite later modifications by other plugins.
            const current = (holder as Record<string, unknown>)[hook.property];
            if (current === record.wrapper) {
                Object.defineProperty(holder, hook.property, record.originalDescriptor);
            }
            perTarget.delete(hook.property);
            if (perTarget.size === 0) {
                this.active.delete(holder);
            }
        }
    }
}
