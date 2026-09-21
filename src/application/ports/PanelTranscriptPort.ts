import type { TranscriptClipboardStatus } from "./SpeechPort";

export interface PanelTranscriptSnapshot {
    readonly sessionId: string;
    readonly text: string;
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

    publish(snapshot: PanelTranscriptSnapshot): void {
        this.snapshot = snapshot;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}
