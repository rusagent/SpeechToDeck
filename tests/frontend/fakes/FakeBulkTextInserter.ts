import { Deferred } from "../../../src/shared/Deferred";
import { MAX_TRANSCRIPT_UTF8_BYTES } from "../../../src/domain/DictationError";
import { err, ok } from "../../../src/domain/Result";
import type { BulkInsertionCapability } from "../../../src/domain/Capability";
import type { DictationError } from "../../../src/domain/DictationError";
import type { KeyboardContext } from "../../../src/domain/DictationSession";
import type {
    BulkInsertResult,
    BulkTextInserter,
} from "../../../src/application/ports/BulkTextInserter";

export interface InsertionCall {
    readonly contextId: string;
    readonly text: string;
}

/** In-memory BulkTextInserter fake with configurable outcome and timing. */
export class FakeBulkTextInserter implements BulkTextInserter {
    readonly trace: string[];
    readonly insertCalls: InsertionCall[] = [];
    readonly probeCalls: string[] = [];

    probeResult: BulkInsertionCapability = {
        available: true,
        directInsert: true,
        clipboardOnly: false,
        maxTextBytes: MAX_TRANSCRIPT_UTF8_BYTES,
    };
    insertResult: BulkInsertResult = ok(undefined);
    /** When set, `insert` waits until the test resolves it. */
    insertGate: Deferred<void> | null = null;

    constructor(trace: string[] = []) {
        this.trace = trace;
    }

    async probe(context: KeyboardContext): Promise<BulkInsertionCapability> {
        this.trace.push(`inserter.probe:${context.id}`);
        this.probeCalls.push(context.id);
        return this.probeResult;
    }

    async insert(context: KeyboardContext, text: string): Promise<BulkInsertResult> {
        this.trace.push(`inserter.insert:${context.id}`);
        this.insertCalls.push({ contextId: context.id, text });
        if (this.insertGate !== null) {
            await this.insertGate.promise;
        }
        return this.insertResult;
    }

    failNextWith(error: DictationError): void {
        this.insertResult = err(error);
    }

    releaseInsert(): void {
        this.insertGate?.resolve(undefined);
    }
}
