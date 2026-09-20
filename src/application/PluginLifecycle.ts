/**
 * Plugin startup and unload orchestration.
 *
 * Startup: load settings → initialize the speech runtime (backend init incl.
 * model load) → ready. `DictationController.start()` owns that ordering and
 * maps failures onto the `unavailable` state instead of throwing.
 *
 * Unload: mark the controller shutting down / reject new presses →
 * cancel the active recording → tear down the speech port (unsubscribe
 * backend events, stop the runtime). Every cleanup operation is idempotent.
 *
 * Disposal mechanism: teardown steps are registered in the reverse of
 * their execution order — speech, controller — so disposing in reverse
 * registration order runs the unload sequence exactly.
 */

import type { Disposable } from "../shared/Disposable";
import { Logger, nullSink } from "../shared/Logger";
import type { DictationController } from "./DictationController";
import type { SpeechPort } from "./ports/SpeechPort";

interface TeardownStep {
    readonly name: string;

    run(): void | Promise<void>;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class PluginLifecycle implements Disposable {
    private readonly teardowns: TeardownStep[] = [];
    private started = false;
    private disposed = false;

    constructor(
        private readonly controller: DictationController,
        private readonly speech: SpeechPort,
        private readonly logger: Logger = new Logger("plugin.lifecycle", nullSink),
    ) {
        // Registration order = reverse unload execution order (see module doc).
        this.teardowns.push(
            { name: "speech.shutdown", run: () => this.speech.shutdown() },
            { name: "controller.dispose", run: () => this.controller.dispose() },
        );
    }

    async start(): Promise<void> {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;
        await this.controller.start();
        this.logger.info("plugin started", { state: this.controller.getSnapshot().kind });
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

        for (const step of [...this.teardowns].reverse()) {
            try {
                await step.run();
            } catch (error) {
                // Every cleanup is idempotent; one failing step must not
                // block the remaining teardown (exception containment).
                this.logger.error("teardown step failed", {
                    step: step.name,
                    detail: describeError(error),
                });
            }
        }
    }
}
