export interface DiagnosticsSource {
    hydrateSetupProgress(): Promise<void>;

    restartRuntime(): Promise<void>;
}
