/**
 * SteamKeyboardHostAdapter (spec §14) — the exclusive owner of Steam-private
 * keyboard behavior.
 *
 * Duties (§14): enumerate the per-window virtual keyboard managers from the
 * SharedJSContext window-store registry (v0.1.6), hook the §15 lifecycle
 * methods on EVERY instance, detect keyboard appearance/disappearance,
 * create a context id per appearance (§7.2), locate the safe microphone mount
 * position in the owning window's document and mount the React control
 * through an injected renderer, and restore all hooks on unload.
 *
 * v0.1.6 redirect (owner decision): the mount is frontend-only through the
 * window-store registry — no CDP dependency. The registry window instances
 * are TRANSIENT (live-probed: they exist while the keyboard is in use), so
 * enumeration re-runs on every lifecycle hook and on a slow owner-approved
 * panel-lifetime poll (§61 deviation documented in the spec update); a
 * catch-up scan mounts into keyboards that appeared before their manager was
 * hookable. The still-open question is the exact document accessor from an
 * instance — the bounded candidate chain is logged so one on-device journal
 * read settles it.
 *
 * Hard boundaries: it contains no dictation logic (§14); every Steam callback
 * boundary is exception-contained (§106); hooking follows the §104
 * preconditions; mounting appends a plugin-owned node and never replaces
 * Steam children (§18).
 */

import { DictationError } from "../../domain/DictationError";
import type { KeyboardContext } from "../../domain/DictationSession";
import type {
    KeyboardHostDiagnostics,
    KeyboardHostEvent,
    KeyboardHostListener,
    KeyboardHostPort,
    MicrophoneControlProps,
    MicrophoneControlRenderer,
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
import { SteamWindowRegistry } from "./SteamWindowRegistry";
import type { SteamUiWindowEntry } from "./SteamWindowRegistry";
import type {
    SteamKeyboardComponent,
    SteamVirtualKeyboardManager,
    SteamWindowHandle,
} from "./SteamInternalTypes";
import { RandomIdGenerator } from "../system/RandomIdGenerator";

/** Owner-approved slow re-enumeration cadence (§61 deviation, see header). */
export const DEFAULT_REGISTRY_POLL_MS = 5000;

/** Discovery snapshot the paste mechanism discovery consumes (§26). */
export interface SteamKeyboardDiscovery {
    readonly contextId: string;
    readonly window: SteamWindowHandle;
    readonly manager: SteamVirtualKeyboardManager | null;
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

    windowRegistry?: SteamWindowRegistry;

    profiles?: readonly SteamKeyboardProfile[];

    contexts?: SteamKeyboardContextFactory;

    logger?: Logger;

    locatorConfig?: SteamLocatorConfig;

    locatorClock?: SteamClock;

    locatorSleeper?: SteamSleeper;

    /**
     * Re-enumeration cadence in ms, or null to disable the timer (tests drive
     * `refreshRegistry()` manually). Default: {@link DEFAULT_REGISTRY_POLL_MS}.
     */
    pollMs?: number | null;
}

type LifecycleEventType = "opened" | "closed";

/** Stable degrade reasons surfaced through `getDiagnostics` (§105). */
export type KeyboardHostDegradeReason =
    "registry-not-found" | "manager-not-found" | "signature-not-found";

export class SteamKeyboardHostAdapter implements KeyboardHostPort, SteamKeyboardDiscoveryProvider {
    private readonly renderer: MicrophoneControlRenderer;
    private readonly locator: SteamKeyboardLocator;
    private readonly registry: SteamHookRegistry;
    private readonly windowRegistry: SteamWindowRegistry;
    private readonly profiles: readonly SteamKeyboardProfile[];
    private readonly contexts: SteamKeyboardContextFactory;
    private readonly logger: Logger;
    private readonly pollMs: number | null;

    private readonly listeners = new Set<KeyboardHostListener>();
    private hooks: InstalledHook[] = [];
    private readonly hookedManagers = new Set<SteamVirtualKeyboardManager>();
    private discovery: SteamKeyboardDiscovery | null = null;
    private current: KeyboardContext | null = null;
    private currentKeyboardDom: HTMLElement | null = null;
    private micDisposable: Disposable | null = null;
    private micRenderDisposable: Disposable | null = null;
    private micHostNode: HTMLElement | null = null;
    private micProps: MicrophoneControlProps | null = null;
    private discovering = false;
    private started = false;
    private stopped = false;
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    // Sticky §58 evidence: transient registry absence must not un-see facts.
    private registryEverFound = false;
    private signatureEverSeen = false;
    private documentEverResolved = false;

    constructor(options: SteamKeyboardHostAdapterOptions) {
        this.renderer = options.renderer;
        this.registry = options.registry ?? new SteamHookRegistry();
        this.profiles = options.profiles ?? STEAM_KEYBOARD_PROFILES;
        this.logger = options.logger ?? new Logger("steam.keyboard");
        this.pollMs = options.pollMs === undefined ? DEFAULT_REGISTRY_POLL_MS : options.pollMs;
        this.locator =
            options.locator ??
            new SteamKeyboardLocator(
                options.locatorConfig ?? DEFAULT_LOCATOR_CONFIG,
                options.locatorClock,
                options.locatorSleeper,
                options.windowRegistry,
            );
        this.windowRegistry = options.windowRegistry ?? new SteamWindowRegistry();
        this.contexts =
            options.contexts ?? new SteamKeyboardContextFactory(new RandomIdGenerator());
    }

    // ── Lifecycle (spec §13/§82) ──

    async start(): Promise<void> {
        if (this.started || this.stopped) {
            return;
        }

        // §104 precondition: the Steam UI window registry signature is
        // reachable. Any failure fails closed with a stable error the
        // controller maps onto the unavailable state (§105). Manager absence
        // alone is NOT a start failure: the live probe showed instances are
        // transient (present while the keyboard is in use), so the adapter
        // degrades through `getDiagnostics` and keeps re-enumerating.
        const windowHandle = this.locator.locateWindow();
        if (windowHandle === null) {
            throw new DictationError(
                "STEAM_KEYBOARD_NOT_FOUND",
                "Steam window registry signature is not reachable",
            );
        }
        this.started = true;
        this.refreshRegistry();
        if (this.pollMs !== null) {
            this.pollTimer = setInterval(() => {
                this.refreshRegistry();
            }, this.pollMs);
        }
        this.logger.info("keyboard host started", { windowToken: windowHandle.token });
    }

    async stop(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;

        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        // §83: unmount mic UI, then restore hooks. Both idempotent.
        this.unmountMicrophone();
        this.micDisposable = null;
        this.micProps = null;

        for (const hook of this.hooks) {
            hook.dispose();
        }
        this.hooks = [];
        this.hookedManagers.clear();

        const closedContextId = this.current?.id;
        this.current = null;
        this.currentKeyboardDom = null;
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

    /**
     * §58-shaped keyboard hook facts for the capability report and the
     * diagnostics panel. `reason` is a stable lowercase code, null when the
     * hook is fully available (§57: no optimistic assumption).
     */
    getDiagnostics(): KeyboardHostDiagnostics {
        const managersHooked = this.hookedManagers.size;
        let reason: KeyboardHostDegradeReason | null = null;
        if (!this.registryEverFound) {
            reason = "registry-not-found";
        } else if (managersHooked === 0) {
            reason = "manager-not-found";
        } else if (!this.signatureEverSeen) {
            reason = "signature-not-found";
        }
        return {
            registryFound: this.registryEverFound,
            managersHooked,
            keyboardSignatureSeen: this.signatureEverSeen,
            documentResolved: this.documentEverResolved,
            reason,
        };
    }

    // ── SteamKeyboardDiscoveryProvider ──

    getCurrentDiscovery(): SteamKeyboardDiscovery | null {
        return this.discovery;
    }

    // ── Registry lifecycle (v0.1.6) ──

    /**
     * One cheap, repeatable enumeration pass: hook managers that appeared,
     * prune hooks of instances that vanished, and catch up on keyboards that
     * became visible without an observed show call (the transient-instance
     * race). Safe to call at any rate — property reads only (§61).
     */
    refreshRegistry(): void {
        if (this.stopped) {
            return;
        }
        try {
            const snapshot = this.windowRegistry.enumerate();
            if (snapshot.registryFound) {
                this.registryEverFound = true;
            }
            if (snapshot.documentsResolved > 0) {
                this.documentEverResolved = true;
            }

            const present = new Set<SteamVirtualKeyboardManager>();
            for (const entry of snapshot.entries) {
                present.add(entry.manager);
                if (this.hookedManagers.has(entry.manager)) {
                    continue;
                }
                if (this.installLifecycleHooks(entry.manager)) {
                    this.hookedManagers.add(entry.manager);
                }
            }
            // No pruning of vanished instances: their wrappers may live on a
            // shared prototype holder, and a premature restore could unhook a
            // method other live instances still route through. Wrappers on
            // dead objects are unreachable and bounded per session (§65);
            // stop() disposes everything.

            this.catchUpVisibleKeyboard();
        } catch (error) {
            // §106: re-enumeration must never propagate into Steam UI code.
            this.logger.error("registry refresh failed", {
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // ── Hook plumbing (spec §15/§16/§104) ──

    /**
     * §15 wrappers on one manager instance. Returns false (installing
     * nothing) when any §104 precondition fails; the instance is simply not
     * hookable and the failure degrades through diagnostics.
     */
    private installLifecycleHooks(manager: SteamVirtualKeyboardManager): boolean {
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
            this.logger.warn("virtual keyboard manager methods are not patchable");
            return false;
        }
        this.hooks.push(visibleHook, hiddenHook);
        return true;
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
            this.mountVisibleKeyboard("hook");
        } finally {
            this.discovering = false;
        }
    }

    private handleKeyboardHidden(): void {
        this.unmountMicrophone();
        const closedContextId = this.current?.id;
        this.current = null;
        this.currentKeyboardDom = null;
        this.discovery = null;
        if (closedContextId !== undefined) {
            this.emit({ type: "keyboard-closed", contextId: closedContextId });
            this.logger.info("keyboard closed", { contextId: closedContextId });
        }
    }

    /**
     * Mounts into a visible supported keyboard, scanning every registry
     * window document (the keyboard may live in a foreign gamepadui window)
     * plus the plugin's own document as fallback. `source` distinguishes the
     * §15 show-hook path (the manager call is itself the visibility evidence)
     * from the catch-up path, which requires the verified visibility class.
     */
    private mountVisibleKeyboard(source: "hook" | "catch-up"): void {
        const scan = this.scanForKeyboard(source === "catch-up");
        if (scan === null) {
            if (source === "hook") {
                this.logger.warn("keyboard discovery did not find a supported keyboard");
            }
            return;
        }
        const { entry, windowHandle, keyboardDom, profile, visible } = scan;
        if (source === "catch-up" && !visible) {
            return; // catch-up mounts only a provably visible keyboard (§58)
        }

        // Fresh appearance → fresh context id (§7.2).
        this.teardownPreviousAppearance();
        const context = this.contexts.create(entry?.token ?? "own-window", true);
        this.discovery = {
            contextId: context.id,
            window: windowHandle,
            manager: entry?.manager ?? null,
            keyboardDom,
            component: this.locator.locateKeyboardComponent(keyboardDom),
            profile,
        };
        this.current = context;
        this.currentKeyboardDom = keyboardDom;
        this.signatureEverSeen = true;
        this.emit({ type: "keyboard-opened", context });
        this.logger.info("keyboard mounted", {
            contextId: context.id,
            profile: profile.id,
            source,
        });

        this.remountMicrophone();
    }

    /**
     * Catch-up within `refreshRegistry`: mount a keyboard that became
     * visible without an observed show call, and close a context whose
     * keyboard went hidden without an observed hide call (missed-event
     * healing for the transient instances).
     */
    private catchUpVisibleKeyboard(): void {
        if (this.current !== null) {
            const dom = this.currentKeyboardDom;
            if (dom !== null && !this.locator.isKeyboardVisible(dom)) {
                this.handleKeyboardHidden();
            }
            return;
        }
        this.mountVisibleKeyboard("catch-up");
    }

    /**
     * One keyboard scan across all registry window documents plus the
     * plugin's own document. `requireVisibleClass` is the catch-up rule; the
     * §15 hook path relaxes it because the manager call is the primary
     * evidence (§15) and the class toggle is corroborating (§60).
     */
    private scanForKeyboard(requireVisibleClass: boolean): {
        entry: SteamUiWindowEntry | null;
        windowHandle: SteamWindowHandle;
        keyboardDom: HTMLElement;
        profile: SteamKeyboardProfile;
        visible: boolean;
    } | null {
        const ownDocument = (globalThis as { document?: Document }).document;
        const scanned = new Set<Document>();

        const candidates: { entry: SteamUiWindowEntry | null; document: Document | null }[] = [
            ...this.windowRegistry
                .enumerate()
                .entries.map((entry) => ({ entry, document: entry.document })),
            { entry: null, document: ownDocument ?? null },
        ];

        let unsupportedSeen = false;
        for (const { entry, document } of candidates) {
            if (document === null || scanned.has(document)) {
                continue;
            }
            scanned.add(document);
            const keyboardDom = this.locator.locateKeyboardDomIn(document);
            if (keyboardDom === null) {
                continue;
            }
            const visible = this.locator.isKeyboardVisible(keyboardDom);
            if (requireVisibleClass && !visible) {
                continue;
            }
            const windowHandle: SteamWindowHandle = {
                token: entry?.token ?? "own-window",
                window: document.defaultView ?? this.ownWindow(),
                document,
            };
            const component = this.locator.locateKeyboardComponent(keyboardDom);
            const profile =
                this.profiles.find((candidate) =>
                    candidate.matches({
                        window: windowHandle,
                        manager: entry?.manager ?? null,
                        keyboardDom,
                        component,
                    }),
                ) ?? null;
            if (profile === null) {
                unsupportedSeen = true;
                continue;
            }
            return { entry, windowHandle, keyboardDom, profile, visible };
        }
        if (unsupportedSeen) {
            this.logger.warn("no matching keyboard profile", { unsupported: true });
        }
        return null;
    }

    private ownWindow(): Window {
        return (globalThis as { window?: Window }).window ?? (globalThis as unknown as Window);
    }

    /**
     * Removes the previous appearance's owned node and discovery state. When
     * a repeat appearance arrives without an intervening hidden notification,
     * the stale context is closed explicitly so consumers see the complete
     * closed→opened context sequence (§7.2).
     */
    private teardownPreviousAppearance(): void {
        this.unmountMicrophone();
        const staleContextId = this.current?.id;
        this.current = null;
        this.currentKeyboardDom = null;
        this.discovery = null;
        if (staleContextId !== undefined) {
            this.emit({ type: "keyboard-closed", contextId: staleContextId });
            this.logger.info("keyboard closed", { contextId: staleContextId });
        }
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
