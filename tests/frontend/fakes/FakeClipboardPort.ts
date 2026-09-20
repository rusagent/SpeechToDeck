import { Deferred } from "../../../src/shared/Deferred";
import type { ClipboardPort } from "../../../src/application/ports/ClipboardPort";

/**
 * In-memory ClipboardPort fake with configurable outcome and timing.
 * The controller's output leg is exactly one `writeText` per transcript.
 */
export class FakeClipboardPort implements ClipboardPort {
    readonly trace: string[];
    readonly writtenTexts: string[] = [];
    readonly writeCalls: string[] = [];

    /** When set, `writeText` waits until the test resolves it. */
    writeGate: Deferred<void> | null = null;
    writeError: Error | null = null;

    constructor(trace: string[] = []) {
        this.trace = trace;
    }

    async writeText(text: string): Promise<void> {
        this.trace.push("clipboard.writeText");
        this.writeCalls.push(text);
        if (this.writeGate !== null) {
            await this.writeGate.promise;
        }
        if (this.writeError !== null) {
            throw this.writeError;
        }
        this.writtenTexts.push(text);
    }

    /** Alias for releasing a armed write gate (mirrors the old inserter rig). */
    releaseWrite(): void {
        this.writeGate?.resolve(undefined);
    }
}
