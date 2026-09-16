/**
 * Keyboard host contract (spec §13) with the listener and microphone-control
 * prop types the host implementation consumes.
 */

import type { KeyboardContext } from "../../domain/DictationSession";
import type { Disposable } from "../../shared/Disposable";

/**
 * Props for the microphone control mounted into the Steam keyboard
 * (spec §13/§19). `active` becomes true only after recording start has been
 * acknowledged (§75); `busy` disables the button during transient states (§10).
 */
export interface MicrophoneControlProps {
    readonly visible: boolean;
    readonly active: boolean;
    readonly busy: boolean;
    readonly onPress: () => void;
}

/**
 * Keyboard lifecycle events pushed by the host. Every keyboard appearance is a
 * new context id (spec §7.2).
 */
export type KeyboardHostEvent =
    | { readonly type: "keyboard-opened"; readonly context: KeyboardContext }
    | { readonly type: "keyboard-closed"; readonly contextId: string };

export type KeyboardHostListener = (event: KeyboardHostEvent) => void;

export interface KeyboardHostPort {
    start(): Promise<void>;

    currentContext(): KeyboardContext | null;

    subscribe(listener: KeyboardHostListener): Disposable;

    mountMicrophoneControl(props: MicrophoneControlProps): Disposable;

    stop(): Promise<void>;
}
