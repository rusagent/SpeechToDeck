import type { IdGeneratorPort } from "../../../src/application/ports/IdGeneratorPort";

/** Deterministic sequential ids: id-1, id-2, ... */
export class FakeIdGenerator implements IdGeneratorPort {
    private counter = 0;

    nextId(): string {
        this.counter += 1;
        return `id-${String(this.counter)}`;
    }
}
