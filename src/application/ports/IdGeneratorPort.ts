/**
 * Unique id source for session ids (backs stale-result protection).
 */
export interface IdGeneratorPort {
    nextId(): string;
}
