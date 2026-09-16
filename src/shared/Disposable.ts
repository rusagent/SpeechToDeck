/**
 * Shared Disposable contract (spec §85).
 *
 * No anonymous event listener may be registered without a corresponding
 * disposable owner. `dispose` must be idempotent in every implementation
 * (spec §83: "Every cleanup operation is idempotent").
 */
export interface Disposable {
    dispose(): void | Promise<void>;
}
