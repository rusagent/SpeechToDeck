/**
 * Explicit success/failure value for port methods whose failure is an expected
 * outcome rather than an exceptional condition (e.g. `BulkTextInserter.insert`,
 * spec §22). Errors inside the domain are `DictationError`; `Result` is the
 * transport for the ones a caller is expected to act on.
 */

export type Result<T, E> =
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
    return { ok: false, error };
}
