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
                this.logger.error("teardown step failed", {
                    step: step.name,
                    detail: describeError(error),
                });
            }
        }
    }
}
