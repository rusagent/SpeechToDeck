import type { Disposable } from "../../../src/shared/Disposable";
import type { KeyboardContext } from "../../../src/domain/DictationSession";
import type {
    KeyboardHostDiagnostics,
    KeyboardHostListener,
    KeyboardHostPort,
} from "../../../src/application/ports/KeyboardHostPort";

/**
 * In-memory KeyboardHostPort fake. Tests open/close contexts to drive the
 * listener the controller subscribed with.
 */
export class FakeKeyboardHost implements KeyboardHostPort {
    readonly trace: string[];

    startError: Error | null = null;

    /** When set, reported through the optional diagnostics surface. */
    diagnostics: KeyboardHostDiagnostics | null = null;

    private listener: KeyboardHostListener | null = null;
    private context: KeyboardContext | null = null;
    private contextCounter = 0;

    constructor(trace: string[] = []) {
        this.trace = trace;
    }

    async start(): Promise<void> {
        this.trace.push("keyboard.start");
        if (this.startError !== null) {
            throw this.startError;
        }
    }

    async stop(): Promise<void> {
        this.trace.push("keyboard.stop");
    }

    currentContext(): KeyboardContext | null {
        return this.context;
    }

    subscribe(listener: KeyboardHostListener): Disposable {
        this.listener = listener;
        return {
            dispose: () => {
                this.listener = null;
            },
        };
    }

    mountMicrophoneControl(): Disposable {
        return {
            dispose: () => undefined,
        };
    }

    getDiagnostics(): KeyboardHostDiagnostics | null {
        return this.diagnostics;
    }

    /** Opens a keyboard context and emits keyboard-opened. */
    open(context?: Partial<KeyboardContext>): KeyboardContext {
        this.contextCounter += 1;
        const full: KeyboardContext = {
            id: context?.id ?? `ctx-${String(this.contextCounter)}`,
            windowToken: context?.windowToken ?? `win-${String(this.contextCounter)}`,
            visible: context?.visible ?? true,
        };
        this.context = full;
        this.listener?.({ type: "keyboard-opened", context: full });
        return full;
    }

    /** Closes the current context and emits keyboard-closed. */
    close(): void {
        if (this.context === null) {
            return;
        }
        const contextId = this.context.id;
        this.context = null;
        this.listener?.({ type: "keyboard-closed", contextId });
    }
}
