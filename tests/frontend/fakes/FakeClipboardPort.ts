import { Deferred } from "../../../src/shared/Deferred";
import type { ClipboardPort } from "../../../src/application/ports/ClipboardPort";

export class FakeClipboardPort implements ClipboardPort {
    readonly trace: string[];
    readonly writtenTexts: string[] = [];
    readonly writeCalls: string[] = [];

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

    releaseWrite(): void {
        this.writeGate?.resolve(undefined);
    }
}
