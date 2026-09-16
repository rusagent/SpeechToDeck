/**
 * Structured, categorized logging (spec §86).
 *
 * Log entries carry primitives only: state kinds, stable error codes, session
 * and context ids, durations. Transcript text and other spoken content are
 * never passed into this module by application code (spec §73: never
 * `Transcript: "..."`).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory =
    | "plugin.lifecycle"
    | "steam.keyboard"
    | "steam.capability"
    | "dictation.session"
    | "speech.runtime"
    | "speech.model"
    | "output.paste";

export interface LogFields {
    readonly [field: string]: string | number | boolean;
}

export interface LogEntry {
    readonly level: LogLevel;
    readonly category: LogCategory;
    readonly message: string;
    readonly fields: LogFields;
}

export type LogSink = (entry: LogEntry) => void;

/** Sink that drops every entry; the application default until a sink is wired. */
export const nullSink: LogSink = () => undefined;

/** Development sink rendering the spec §86 example format. */
export const consoleSink: LogSink = (entry) => {
    const fields = Object.entries(entry.fields)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
    const line = `[${entry.category}] ${entry.message}${fields.length > 0 ? ` ${fields}` : ""}`;
    if (entry.level === "error") {
        console.error(line);
    } else if (entry.level === "warn") {
        console.warn(line);
    } else {
        console.log(line);
    }
};

export class Logger {
    constructor(
        private readonly category: LogCategory,
        private readonly sink: LogSink = consoleSink,
    ) {}

    debug(message: string, fields: LogFields = {}): void {
        this.emit("debug", message, fields);
    }

    info(message: string, fields: LogFields = {}): void {
        this.emit("info", message, fields);
    }

    warn(message: string, fields: LogFields = {}): void {
        this.emit("warn", message, fields);
    }

    error(message: string, fields: LogFields = {}): void {
        this.emit("error", message, fields);
    }

    private emit(level: LogLevel, message: string, fields: LogFields): void {
        this.sink({ level, category: this.category, message, fields });
    }
}
