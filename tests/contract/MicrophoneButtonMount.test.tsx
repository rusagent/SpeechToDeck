/**
 * MicrophoneButtonMount contract tests: the React
 * root lifecycle inside the plugin-owned node, store-driven visual truth via
 * useSyncExternalStore, exact cleanup across repeated cycles, and the
 * presenter's model-true active/busy pushing with change filtering.
 */

import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationError } from "../../src/domain/DictationError";
import {
    MicrophoneControlPresenter,
    createMicrophoneControlRenderer,
} from "../../src/presentation/keyboard/MicrophoneButtonMount";
import { FakeStateStore } from "./helpers";
import type { MicrophoneControlProps } from "../../src/application/ports/KeyboardHostPort";
import type { Disposable } from "../../src/shared/Disposable";
import { FakeKeyboardHost } from "../frontend/fakes/FakeKeyboardHost";
import type { DictationState } from "../../src/domain/DictationState";

afterEach(cleanup);

function readyState(): DictationState {
    return { kind: "ready" };
}

function recordingState(): DictationState {
    return {
        kind: "recording",
        session: { sessionId: "s1", keyboardContextId: "c1", startedAtMonotonicMs: 0 },
    };
}

describe("createMicrophoneControlRenderer", () => {
    it("renders a live model-true button from the store and cleans up exactly", async () => {
        const store = new FakeStateStore(readyState());
        const renderer = createMicrophoneControlRenderer(() => store, "en");
        const host = document.createElement("div");
        document.body.appendChild(host);

        const disposable = await act(async () =>
            renderer.render(host, {
                visible: true,
                active: false,
                busy: false,
                onPress: () => undefined,
            }),
        );

        const button = host.querySelector("button");
        expect(button).not.toBeNull();
        expect(button!.getAttribute("data-state")).toBe("ready");

        await act(async () => {
            store.set(recordingState());
        });
        expect(host.querySelector("button")!.getAttribute("data-state")).toBe("recording");
        expect(host.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");

        await act(async () => {
            disposable.dispose();
            disposable.dispose(); // idempotent
        });
        expect(host.childElementCount).toBe(0); // only the render is removed
    });

    it("survives repeated mount/unmount cycles (×10) inside one host", async () => {
        const store = new FakeStateStore(readyState());
        const renderer = createMicrophoneControlRenderer(() => store, "en");
        const host = document.createElement("div");
        document.body.appendChild(host);

        for (let cycle = 0; cycle < 10; cycle += 1) {
            const disposable = await act(async () =>
                renderer.render(host, {
                    visible: true,
                    active: false,
                    busy: false,
                    onPress: () => undefined,
                }),
            );
            expect(host.querySelectorAll("button")).toHaveLength(1);
            await act(async () => {
                disposable.dispose();
            });
            expect(host.childElementCount).toBe(0);
        }
    });

    it("presses route through the pushed MicrophoneControlProps.onPress", async () => {
        const store = new FakeStateStore(readyState());
        const onPress = vi.fn();
        const renderer = createMicrophoneControlRenderer(() => store, "en");
        const host = document.createElement("div");
        document.body.appendChild(host);

        await act(async () => {
            renderer.render(host, { visible: true, active: false, busy: false, onPress });
        });
        await act(async () => {
            fireEvent.click(host.querySelector("button")!);
        });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it("renders nothing when the pushed props say invisible or the store is absent", async () => {
        const store = new FakeStateStore(readyState());
        const renderer = createMicrophoneControlRenderer(() => store, "en");
        const host = document.createElement("div");
        document.body.appendChild(host);

        await act(async () => {
            renderer.render(host, {
                visible: false,
                active: false,
                busy: false,
                onPress: () => undefined,
            });
        });
        expect(host.querySelector("button")).toBeNull();

        const storelessHost = document.createElement("div");
        document.body.appendChild(storelessHost);
        const storeless = createMicrophoneControlRenderer(() => null, "en");
        await act(async () => {
            storeless.render(storelessHost, {
                visible: true,
                active: false,
                busy: false,
                onPress: () => undefined,
            });
        });
        expect(storelessHost.querySelector("button")).toBeNull();
    });
});

/**
 * Real-adapter-shaped mount recorder: `mountMicrophoneControl` returns one
 * stable Disposable and updates props in place, mirroring the production
 * host adapter's contract.
 */
interface MountRecord {
    props: MicrophoneControlProps | null;
    disposed: boolean;
}

function hostRecordingMounts(): { keyboardHost: FakeKeyboardHost; mounts: MountRecord[] } {
    const keyboardHost = new FakeKeyboardHost();
    const mounts: MountRecord[] = [{ props: null, disposed: false }];
    const mountDisposable: Disposable = {
        dispose: () => {
            for (const record of mounts) {
                record.disposed = true;
            }
        },
    };
    keyboardHost.mountMicrophoneControl = (props?: MicrophoneControlProps): Disposable => {
        mounts[0]!.props = props as MicrophoneControlProps;
        return mountDisposable;
    };
    return { keyboardHost, mounts };
}

describe("MicrophoneControlPresenter", () => {
    it("mounts on usable states, pushes model-true flags, hides when unavailable", () => {
        const store = new FakeStateStore({ kind: "booting" });
        const { keyboardHost, mounts } = hostRecordingMounts();
        const onPress = vi.fn();
        const presenter = new MicrophoneControlPresenter(store, keyboardHost, onPress);

        presenter.start();
        expect(mounts[0]!.props).toBeNull(); // booting → the mic does not appear

        store.set(readyState());
        expect(mounts[0]!.props).toMatchObject({ visible: true, active: false, busy: false });

        store.set(recordingState());
        expect(mounts[0]!.props).toMatchObject({ visible: true, active: true, busy: false });
        expect(onPress).not.toHaveBeenCalled();

        store.set({
            kind: "transcribing",
            session: { sessionId: "s1", keyboardContextId: "c1", startedAtMonotonicMs: 0 },
        });
        expect(mounts[0]!.props).toMatchObject({ active: false, busy: true });
        expect(mounts[0]!.disposed).toBe(false);

        store.set({ kind: "unavailable", reason: "MODEL_NOT_INSTALLED" });
        expect(mounts[0]!.disposed).toBe(true); // hidden again

        presenter.dispose();
    });

    it("does not re-mount when the visual state did not meaningfully change", () => {
        const store = new FakeStateStore(readyState());
        const { keyboardHost } = hostRecordingMounts();
        const mountSpy = vi.spyOn(keyboardHost, "mountMicrophoneControl");
        const presenter = new MicrophoneControlPresenter(store, keyboardHost, () => undefined);

        presenter.start();
        store.set(recordingState());
        store.set({
            kind: "recording",
            session: { sessionId: "s2", keyboardContextId: "c2", startedAtMonotonicMs: 5 },
        });

        expect(mountSpy).toHaveBeenCalledTimes(2); // ready → recording; same-kind update filtered
        presenter.dispose();
    });
});

describe("recording timer", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function mountBridge(store: FakeStateStore): { host: HTMLDivElement; dispose: () => void } {
        const renderer = createMicrophoneControlRenderer(() => store, "en");
        const host = document.createElement("div");
        document.body.appendChild(host);
        let disposable: Disposable | null = null;
        act(() => {
            disposable = renderer.render(host, {
                visible: true,
                active: false,
                busy: false,
                onPress: () => undefined,
            });
        });
        return {
            host,
            dispose: () => {
                act(() => {
                    disposable?.dispose();
                });
            },
        };
    }

    it("formats the monotonic session elapsed time as mm:ss and ticks once per second", () => {
        vi.useFakeTimers();
        const now = performance.now();
        const store = new FakeStateStore({
            kind: "recording",
            session: {
                sessionId: "s1",
                keyboardContextId: "c1",
                startedAtMonotonicMs: now - 65_000,
            },
        });
        const { host } = mountBridge(store);

        expect(host.querySelector("button")!.textContent).toMatch(/^01:0[45]$/); // ~65 s elapsed

        const before = host.querySelector("button")!.textContent;
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(host.querySelector("button")!.textContent).not.toBe(before); // timer ticked

        act(() => {
            store.set(readyState());
        });
        expect(host.querySelector("button")!.textContent).not.toMatch(/^\d{2}:\d{2}$/);

        // The interval is disposed with the session: a fresh recording
        // session restarts the timer from its own monotonic start.
        act(() => {
            store.set(recordingState());
        });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(host.querySelector("button")!.textContent).toMatch(/^\d{2}:\d{2}$/);
    });

    it("maps an error state to the localized message flash", () => {
        const store = new FakeStateStore({
            kind: "error",
            error: new DictationError("TRANSCRIPTION_FAILED"),
            recoverable: true,
        });
        const { dispose } = mountBridge(store);
        expect(document.querySelector('[role="status"]')?.textContent).toBe(
            "Transcription failed.",
        );
        dispose();
        expect(document.querySelector('[role="status"]')).toBeNull();
    });
});
