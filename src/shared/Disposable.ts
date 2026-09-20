/**
 * Shared Disposable contract.
 *
 * No anonymous event listener may be registered without a corresponding
 * disposable owner. `dispose` must be idempotent in every implementation
 * (every cleanup operation is idempotent).
 */
export interface Disposable {
    dispose(): void | Promise<void>;
}
