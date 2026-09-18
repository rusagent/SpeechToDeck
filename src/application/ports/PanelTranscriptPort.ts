/**
 * Last-transcript snapshot store for the plugin panel's dictation card
 * (additive v0.2 transport-level UI state, mirroring the setup-progress
 * store pattern).
 *
 * The adapter publishes every guarded `transcript_ready` payload here —
 * with the additive backend clipboard outcome — so the card can show the
 * transcript preview, the clipboard status line and the "copy again"
 * action. It never enters the dictation state machine (§8) and never
 * touches insertion; §12 suppression semantics on the controller are
 * unchanged. The store holds at most the latest transcript; nothing here
 * is persisted or logged (§73).
 */

import type { TranscriptClipboardStatus } from "./SpeechPort";

export interface PanelTranscriptSnapshot {
    readonly sessionId: string;
    readonly text: string;
    /** Backend clipboard leg outcome ("skipped" for older backends). */
    readonly clipboard: TranscriptClipboardStatus;
}

export class PanelTranscriptStore {
    private readonly listeners = new Set<() => void>();
    private snapshot: PanelTranscriptSnapshot | null = null;

    getSnapshot(): PanelTranscriptSnapshot | null {
        return this.snapshot;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Publishes an already guarded payload (the adapter owns validation). */
    publish(snapshot: PanelTranscriptSnapshot): void {
        this.snapshot = snapshot;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}
