/**
 * Unique id source for session ids (spec §7.1, §11 stale-result protection).
 */
export interface IdGeneratorPort {
    nextId(): string;
}
