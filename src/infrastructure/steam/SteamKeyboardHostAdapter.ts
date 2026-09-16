/**
 * SteamKeyboardHostAdapter (spec §14) — the exclusive owner of Steam-private
 * keyboard behavior.
 *
 * Duties (§14): locate the active Steam window and virtual keyboard manager,
 * hook the §15 lifecycle methods, detect keyboard appearance/disappearance,
 * create a context id per appearance (§7.2), locate the safe microphone mount
 * position and mount the React control through an injected renderer, and
 * restore all hooks on unload.
 *
 * Hard boundaries: it contains no dictation logic (§14); every Steam callback
 * boundary is exception-contained (§106); hooking follows the §104
 * preconditions; mounting appends a plugin-owned node and never replaces
 * Steam children (§18).
 */

import { DictationError } from "../../domain/DictationError";
import type { KeyboardContext } from "../../domain/DictationSession";
import type {
    KeyboardHostEvent,
    KeyboardHostListener,
    KeyboardHostPort,
    MicrophoneControlProps,
} from "../../application/ports/KeyboardHostPort";
import type { Disposable } from "../../shared/Disposable";
import { Logger } from "../../shared/Logger";
import { STEAM_KEYBOARD_PROFILES } from "./profiles";
import type { SteamKeyboardProfile } from "./profiles/SteamKeyboardProfile";
import { MIC_ROOT_ATTRIBUTE } from "./profiles/DefaultSteamKeyboardProfile";
import { SteamKeyboardContextFactory } from "./SteamKeyboardContext";
import {
    SteamHookRegistry,
    type HookWrapperFactory,
    type InstalledHook,
} from "./SteamHookRegistry";
import { SteamKeyboardLocator, DEFAULT_LOCATOR_CONFIG } from "./SteamKeyboardLocator";
import type { SteamLocatorConfig, SteamClock, SteamSleeper } from "./SteamKeyboardLocator";
import type {
    SteamKeyboardComponent,
    SteamVirtualKeyboardManager,
    SteamWindowHandle,
} from "./SteamInternalTypes";
import { RandomIdGenerator } from "../system/RandomIdGenerator";

/**
 * Seam between the host adapter and the microphone UI. Implementations render
 * into the plugin-owned node the adapter created; the returned Disposable
 * removes exactly that render (§18 cleanup).
 */
export interface MicrophoneControlRenderer {
    render(host: HTMLElement, props: MicrophoneControlProps): Disposable;
}

/** Discovery snapshot the paste mechanism discovery consumes (§26). */
export interface SteamKeyboardDiscovery {
    readonly contextId: string;
    readonly window: SteamWindowHandle;
    readonly manager: SteamVirtualKeyboardManager;
    readonly keyboardDom: HTMLElement;
    readonly component: SteamKeyboardComponent | null;
    readonly profile: SteamKeyboardProfile;
}

export interface SteamKeyboardDiscoveryProvider {
    getCurrentDiscovery(): SteamKeyboardDiscovery | null;
}

export interface SteamKeyboardHostAdapterOptions {
    renderer: MicrophoneControlRenderer;

    locator?: SteamKeyboardLocator;

    registry?: SteamHookRegistry;

    profiles?: readonly SteamKeyboardProfile[];

    contexts?: SteamKeyboardContextFactory;

    logger?: Logger;

    locatorConfig?: SteamLocatorConfig;

    locatorClock?: SteamClock;

    locatorSleeper?: SteamSleeper;
}

type LifecycleEventType = "opened" | "closed";

export class SteamKeyboardHostAdapter implements KeyboardHostPort, SteamKeyboardDiscoveryProvider {
    private readonly renderer: MicrophoneControlRenderer;
    private readonly locator: SteamKeyboardLocator;
    private readonly registry: SteamHookRegistry;
    private readonly profiles: readonly SteamKeyboardProfile[];
    private readonly contexts: SteamKeyboardContextFactory;
    private readonly logger: Logger;

    private readonly listeners = new Set<KeyboardHostListener>();
    private hooks: InstalledHook[] = [];
    private discovery: SteamKeyboardDiscovery | null = null;
    private current: KeyboardContext | null = null;
    private micDisposable: Disposable | null = null;
    private micRenderDisposable: Disposable | null = null;
    private micHostNode: HTMLElement | null = null;
    private micProps: MicrophoneControlProps | null = null;
    private discovering = false;
    private started = false;
    private stopped = false;

    constructor(options: SteamKeyboardHostAdapterOptions) {
        this.renderer = options.renderer;
        this.registry = options.registry ?? new SteamHookRegistry();
        this.profiles = options.profiles ?? STEAM_KEYBOARD_PROFILES;
        this.logger = options.logger ?? new Logger("steam.keyboard");
        this.locator =
            options.locator ??
            new SteamKeyboardLocator(
                options.locatorConfig ?? DEFAULT_LOCATOR_CONFIG,
                options.locatorClock,
                options.locatorSleeper,
            );
        this.contexts =
            options.contexts ?? new SteamKeyboardContextFactory(new RandomIdGenerator());
    }

    // ── Lifecycle (spec §13/§82) ──

    async start(): Promise<void> {
        if (this.started || this.stopped) {
            return;
        }

        // §104 preconditions: window reachable, manager recognizable,
        // methods callable. Any failure fails closed with a stable error the
        // controller maps onto the unavailable state (§105). The started flag
        // is set only after the hooks are installed, so a failed start does
        // not consume the lifecycle.
        const windowHandle = this.locator.locateWindow();
        const manager =
            windowHandle === null ? null : this.locator.locateKeyboardManager(windowHandle);
        if (windowHandle === null || manager === null) {
            throw new DictationError(
                "STEAM_KEYBOARD_NOT_FOUND",
                "Steam window or virtual keyboard manager is not reachable",
            );
        }
        this.installLifecycleHooks(manager);
        this.started = true;
        this.logger.info("keyboard host started", { windowToken: windowHandle.token });
    }

    async stop(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;

        // §83: unmount mic UI, then restore hooks. Both idempotent.
        this.unmountMicrophone();
        this.micDisposable = null;
        this.micProps = null;

        for (const hook of this.hooks) {
            hook.dispose();
        }
        this.hooks = [];

        const closedContextId = this.current?.id;
        this.current = null;
        this.discovery = null;
        if (closedContextId !== undefined) {
            this.emit({ type: "keyboard-closed", contextId: closedContextId });
        }
        this.logger.info("keyboard host stopped");
    }

    // ── KeyboardHostPort (spec §13) ──

    currentContext(): KeyboardContext | null {
        return this.current;
    }

    subscribe(listener: KeyboardHostListener): Disposable {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }

    /**
     * Registers the microphone control props. The control mounts as soon as a
     * supported keyboard is discovered; before that it stays pending. The
     * returned Disposable removes the plugin-owned node and only that node
     * (§18); calling `mountMicrophoneControl` again with fresh props updates
     * the existing mount in place.
     */
    mountMicrophoneControl(props: MicrophoneControlProps): Disposable {
        this.micProps = props;
        if (this.discovery !== null) {
            this.remountMicrophone();
        }
        if (this.micDisposable === null) {
            this.micDisposable = {
                dispose: () => {
                    this.micProps = null;
                    this.unmountMicrophone();
                    this.micDisposable = null;
                },
            };
        }
        return this.micDisposable;
    }

    // ── SteamKeyboardDiscoveryProvider ──

    getCurrentDiscovery(): SteamKeyboardDiscovery | null {
        return this.discovery;
    }

    // ── Hook plumbing (spec §15/§16/§104) ──

    private installLifecycleHooks(manager: SteamVirtualKeyboardManager): void {
        const visibleHook = this.registry.install(
            manager,
            "SetVirtualKeyboardVisible",
            this.lifecycleWrapper("opened"),
        );
        const hiddenHook = this.registry.install(
            manager,
            "SetVirtualKeyboardHidden",
            this.lifecycleWrapper("closed"),
        );
        if (visibleHook === null || hiddenHook === null) {
            visibleHook?.dispose();
            hiddenHook?.dispose();
            throw new DictationError(
                "STEAM_KEYBOARD_NOT_FOUND",
                "virtual keyboard manager methods are not patchable",
            );
        }
        this.hooks.push(visibleHook, hiddenHook);
    }

    /**
     * §15 wrapper factory: preserves original arguments, `this`, return value
     * and exception behavior; the lifecycle notification happens in a
     * `queueMicrotask` after the original succeeded, and the notification
     * itself is exception-contained (§106).
     */
    private lifecycleWrapper(eventType: LifecycleEventType): HookWrapperFactory {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const adapter = this;
        return (original) =>
            function lifecycleWrapper(this: unknown, ...args: unknown[]): unknown {
                const result = original.apply(this, args);
                queueMicrotask(() => {
                    try {
                        adapter.onKeyboardLifecycle(eventType);
                    } catch (error) {
                        adapter.logger.error("keyboard lifecycle notification failed", {
                            eventType,
                            detail: describeError(error),
                        });
                    }
                });
                return result;
            };
    }

    private onKeyboardLifecycle(eventType: LifecycleEventType): void {
        if (this.stopped) {
            return;
        }
        if (eventType === "opened") {
            void this.handleKeyboardOpened();
        } else {
            this.handleKeyboardHidden();
        }
    }

    // ── Keyboard appearance (spec §14/§17/§18) ──

    private async handleKeyboardOpened(): Promise<void> {
        if (this.discovering) {
            return;
        }
        this.discovering = true;
        try {
            const found = await this.locator.discoverKeyboard();
            if (this.stopped) {
                return;
            }
            if (found === null) {
                // Bounded discovery failed: mic simply does not appear
                // (§105); never guess-and-continue.
                this.logger.warn("keyboard discovery did not find a supported keyboard");
                return;
            }
            const keyboardDom = found.keyboardDom;
            if (keyboardDom === null || found.manager === null) {
                this.logger.warn("no matching keyboard profile", { unsupported: true });
                return;
            }
            const profile = this.profiles.find((candidate) => candidate.matches(found)) ?? null;
            if (profile === null) {
                this.logger.warn("no matching keyboard profile", { unsupported: true });
                return;
            }

            // Fresh appearance → fresh context id (§7.2).
            this.teardownPreviousAppearance();
            const context = this.contexts.create(found.window.token, true);
            this.discovery = {
                contextId: context.id,
                window: found.window,
                manager: found.manager,
                keyboardDom,
                component: found.component,
                profile,
            };
            this.current = context;
            this.emit({ type: "keyboard-opened", context });
            this.logger.info("keyboard mounted", { contextId: context.id, profile: profile.id });

            this.remountMicrophone();
        } finally {
            this.discovering = false;
        }
    }

    private handleKeyboardHidden(): void {
        this.unmountMicrophone();
        const closedContextId = this.current?.id;
        this.current = null;
        this.discovery = null;
        if (closedContextId !== undefined) {
            this.emit({ type: "keyboard-closed", contextId: closedContextId });
            this.logger.info("keyboard closed", { contextId: closedContextId });
        }
    }

    /** Removes the previous appearance's owned node and discovery state. */
    private teardownPreviousAppearance(): void {
        this.unmountMicrophone();
        this.current = null;
        this.discovery = null;
    }

    // ── Microphone mount (spec §18) ──

    private remountMicrophone(): void {
        if (this.micProps === null || this.discovery === null) {
            return;
        }
        this.unmountMicrophone();

        const mountPoint = this.discovery.profile.locateMountPoint(this.discovery.keyboardDom);
        if (mountPoint === null) {
            this.logger.warn("profile returned no microphone mount point");
            return;
        }
        const ownerDocument = mountPoint.ownerDocument;
        if (ownerDocument === null) {
            this.logger.warn("mount point has no owner document");
            return;
        }
        const hostNode = ownerDocument.createElement("div");
        hostNode.setAttribute(MIC_ROOT_ATTRIBUTE, "");
        mountPoint.appendChild(hostNode); // append-only: Steam children untouched (§18)

        try {
            this.micRenderDisposable = this.renderer.render(hostNode, this.micProps);
        } catch (error) {
            // §106: a broken renderer must not propagate into Steam UI code.
            hostNode.remove();
            this.micHostNode = null;
            this.logger.error("microphone renderer failed", { detail: describeError(error) });
            return;
        }
        this.micHostNode = hostNode;
        this.logger.info("microphone control mounted", { contextId: this.discovery.contextId });
    }

    private unmountMicrophone(): void {
        this.micRenderDisposable?.dispose();
        this.micRenderDisposable = null;
        // Removes exactly the plugin-owned node; Steam children stay (§18).
        if (this.micHostNode !== null) {
            this.micHostNode.remove();
            this.micHostNode = null;
        }
    }

    // ── Listener dispatch (§106 exception containment) ──

    private emit(event: KeyboardHostEvent): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch (error) {
                this.logger.error("keyboard listener failed", {
                    eventType: event.type,
                    detail: describeError(error),
                });
            }
        }
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
