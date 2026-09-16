/**
 * MicrophoneButtonMount (spec §18/§66/§75/§102) — the single owner of the
 * injected React root for the keyboard microphone control (§3.5).
 *
 * `createMicrophoneControlRenderer` implements the host adapter's renderer
 * seam: it renders a live `MicrophoneButton` into the plugin-owned node and
 * its Disposable unmounts exactly that render. Visual truth is the
 * controller's state store consumed through `useSyncExternalStore` (§102);
 * the pushed `MicrophoneControlProps.onPress`/`visible` are honored, and the
 * pushed `active`/`busy` flags mirror the same pure model for non-store
 * consumers.
 *
 * `MicrophoneControlPresenter` is the reactive binding: it subscribes to the
 * controller store and mounts/updates/unmounts the control through the host
 * port whenever the model output meaningfully changes (§66 — the button
 * rerenders only on meaningful state changes).
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { DictationState } from "../../domain/DictationState";
import type { StateStore } from "../../application/DictationController";
import type {
    KeyboardHostPort,
    MicrophoneControlProps,
    MicrophoneControlRenderer,
} from "../../application/ports/KeyboardHostPort";
import type { Disposable } from "../../shared/Disposable";
import { MicrophoneButton } from "./MicrophoneButton";
import { microphoneButtonModel } from "./MicrophoneButtonModel";
import type { MicrophoneVisualState } from "./MicrophoneButtonModel";
import { detectEnvironmentLocale } from "../i18n/messages";
import type { Locale } from "../i18n/messages";

interface MicrophoneButtonBridgeProps {
    readonly store: StateStore<DictationState> | null;
    readonly visible: boolean;
    readonly onPress: () => void;
    readonly locale: Locale;
}

function MicrophoneButtonBridge({
    store,
    visible,
    onPress,
    locale,
}: MicrophoneButtonBridgeProps): React.ReactElement | null {
    // Bound, render-stable store accessors: useSyncExternalStore requires a
    // stable subscribe identity per store (§102).
    const subscribe = React.useMemo(
        () =>
            store === null ? subscribeNever : (onChange: () => void) => store.subscribe(onChange),
        [store],
    );
    const getSnapshot = React.useMemo(
        () => (store === null ? snapshotNever : () => store.getSnapshot()),
        [store],
    );
    React.useSyncExternalStore(subscribe, getSnapshot);
    if (store === null || !visible) {
        return null;
    }
    const model = microphoneButtonModel(store.getSnapshot());
    return (
        <MicrophoneButton
            state={model.visualState}
            disabled={model.disabled}
            onPress={onPress}
            locale={locale}
        />
    );
}

// Stable fallbacks for the storeless case: useSyncExternalStore compares
// snapshots by identity, so getSnapshot must never return a fresh object.
const BOOTING_SNAPSHOT: DictationState = { kind: "booting" };
const subscribeNever = (): (() => void) => () => undefined;
const snapshotNever = (): DictationState => BOOTING_SNAPSHOT;

/**
 * Creates the React-root lifecycle owner (§18). `getStore` is resolved at
 * render time; the composition root assigns the controller before any mount
 * can happen (mounts only occur after startup reached the store).
 */
export function createMicrophoneControlRenderer(
    getStore: () => StateStore<DictationState> | null,
    locale: Locale = detectEnvironmentLocale(),
): MicrophoneControlRenderer {
    const roots = new WeakMap<HTMLElement, Root>();
    return {
        render(host: HTMLElement, props: MicrophoneControlProps): Disposable {
            let root = roots.get(host);
            if (root === undefined) {
                root = createRoot(host);
                roots.set(host, root);
            }
            root.render(
                <MicrophoneButtonBridge
                    store={getStore()}
                    visible={props.visible}
                    onPress={props.onPress}
                    locale={locale}
                />,
            );
            return {
                dispose: () => {
                    const existing = roots.get(host);
                    if (existing === undefined) {
                        return; // idempotent (§83)
                    }
                    existing.unmount();
                    roots.delete(host);
                },
            };
        },
    };
}

type LastPosition =
    { readonly tag: "hidden" } | { readonly tag: "shown"; readonly visual: MicrophoneVisualState };

/**
 * Binds the controller state store to the host adapter's microphone control.
 * Shows the control only in usable states (booting/unavailable stay hidden —
 * §105: the mic button simply does not appear), and pushes §75-true
 * `active`/`busy` flags derived from the same pure model.
 */
export class MicrophoneControlPresenter implements Disposable {
    private unsubscribeStore: (() => void) | null = null;
    private mount: Disposable | null = null;
    private last: LastPosition = { tag: "hidden" };

    constructor(
        private readonly store: StateStore<DictationState>,
        private readonly keyboardHost: KeyboardHostPort,
        private readonly onPress: () => void | Promise<void>,
    ) {}

    start(): void {
        if (this.unsubscribeStore !== null) {
            return;
        }
        this.unsubscribeStore = this.store.subscribe(() => this.sync());
        this.sync();
    }

    dispose(): void {
        this.unsubscribeStore?.();
        this.unsubscribeStore = null;
        this.mount?.dispose();
        this.mount = null;
        this.last = { tag: "hidden" };
    }

    private sync(): void {
        const state = this.store.getSnapshot();
        const usable = state.kind !== "booting" && state.kind !== "unavailable";
        if (!usable) {
            if (this.last.tag === "shown") {
                this.mount?.dispose();
                this.mount = null;
                this.last = { tag: "hidden" };
            }
            return;
        }
        const model = microphoneButtonModel(state);
        if (this.last.tag === "shown" && this.last.visual === model.visualState) {
            return; // no meaningful visual change → no rerender (§66)
        }
        this.mount = this.keyboardHost.mountMicrophoneControl({
            visible: true,
            active: model.visualState === "recording",
            busy: model.visualState === "processing",
            onPress: () => {
                void this.onPress();
            },
        });
        this.last = { tag: "shown", visual: model.visualState };
    }
}
