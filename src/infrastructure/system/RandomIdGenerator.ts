import type { IdGeneratorPort } from "../../application/ports/IdGeneratorPort";

export class RandomIdGenerator implements IdGeneratorPort {
    private fallbackSequence = 0;

    nextId(): string {
        const cryptoRef = globalThis as { crypto?: { randomUUID?: () => string } };
        const randomUUID = cryptoRef.crypto?.randomUUID;
        if (typeof randomUUID === "function") {
            return randomUUID.call(cryptoRef.crypto);
        }
        this.fallbackSequence += 1;
        return `id-${String(this.fallbackSequence)}-${Math.random().toString(36).slice(2)}`;
    }
}
