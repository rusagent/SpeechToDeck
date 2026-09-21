import type { IdGeneratorPort } from "../../../src/application/ports/IdGeneratorPort";

export class FakeIdGenerator implements IdGeneratorPort {
    private counter = 0;

    nextId(): string {
        this.counter += 1;
        return `id-${String(this.counter)}`;
    }
}
