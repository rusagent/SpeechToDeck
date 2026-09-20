/**
 * DiagnosticsSource — the panel's data-source seam wired by the composition
 * root (no Decky/Steam imports).
 *
 * The read-only Diagnostics section was removed from the panel
 * (owner declutter), which orphaned the capability/cross-view loaders — the
 * interface is trimmed to the two members the panel still consumes: the
 * setup-progress hydration and the explicit runtime restart behind the
 * setup retry button (grep-proven zero callers for the rest; the
 * loader-side diagnostic providers are untouched).
 */

export interface DiagnosticsSource {
    /**
     * Hydrates the setup store from the status report so a startup
     * failure that fired before the panel subscribed still renders (live
     * events always win). No-op when the runtime is fine or a snapshot
     * already exists.
     */
    hydrateSetupProgress(): Promise<void>;

    /** The explicit runtime restart behind the failed-state retry button. */
    restartRuntime(): Promise<void>;
}
