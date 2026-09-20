/**
 * KeyboardTabBridge — the frontend engine of the tab-bridge
 * architecture.
 *
 * The Big Picture keyboard lives in the CDP target titled exactly
 * "Steam Big Picture Mode", a document the plugin's own context cannot see
 * (the earlier registry path proved the SharedJSContext view is a dead end).
 * This engine drives the loader's official `executeInTab` API (verified
 * callable from the sandboxed frontend):
 *
 * - injects the self-installing bootstrap (idempotently, immediately at start
 *   and re-injected every `reinjectMs` — the SP document can be replaced);
 * - polls ONLY while `isEnabled` (the owner-approved 250 ms cadence) with
 *   ONE self-contained expression returning visibility,
 *   container presence, the in-window bootstrap flag, and drained press
 *   events — the single capability channel, no extra probe;
 * - translates keyboard visibility into keyboard context lifecycle (every
 *   appearance is a fresh context id);
 * - drains press events to the owner callback (the DictationController press
 *   path — the machine's press-serialization and stale-result semantics stay
 *   authoritative);
 * - performs the one-payload transcript insertion (`__stdMicInsert`), the
 *   fallback single paste (`__stdMicPaste`), and the visual-state
 *   pushes (`__stdMicState`).
 *
 * Failure semantics (verified loader behavior): `executeInTab` RESOLVES with
 * `{success: false}` for a missing tab title and for in-tab JS exceptions; a
 * loader transport outage rejects. Both are contained and drive a bounded
 * exponential backoff (never an unbounded error loop). A keyboard
 * context whose document stays unreachable across sustained failures is
 * closed — suppression stays truthful when the SP view dies mid-session.
 *
 * All capability facts (`transportOk`, `bootstrapInjected`, `keyboardSeen`)
 * are observed from poll results, never assumed.
 */

import type { KeyboardContext } from "../../domain/DictationSession";
import type { TabBridgeDiagnostics } from "../../application/ports/KeyboardHostPort";
import { RandomIdGenerator } from "../system/RandomIdGenerator";
import { Logger } from "../../shared/Logger";
import { SteamKeyboardContextFactory } from "./SteamKeyboardContext";
import {
    KEYBOARD_BRIDGE_BOOTSTRAP_SOURCE,
    buildInsertExpression,
    buildPasteExpression,
    buildPasteProbeExpression,
    buildPollExpression,
    buildStateExpression,
    buildTeardownExpression,
} from "./keyboardBridgeBootstrap";
import type { MicBridgeVisualState } from "./keyboardBridgeBootstrap";

/** Exact CDP tab title of the Big Picture keyboard document (probe evidence). */
export const SP_KEYBOARD_TAB_TITLE = "Steam Big Picture Mode";

/** Default poll cadence (owner-approved for the tab bridge). */
export const DEFAULT_TAB_BRIDGE_POLL_MS = 250;

/** Bootstrap re-injection cadence — SP document replacement healing. */
export const DEFAULT_TAB_BRIDGE_REINJECT_MS = 30_000;

/** Bounded backoff: first retry delay and hard cap. */
export const DEFAULT_TAB_BRIDGE_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_TAB_BRIDGE_BACKOFF_MAX_MS = 30_000;

/**
 * `start()` awaits one inject+poll cycle so the startup capability report is
 * built on settled facts; a hanging transport cannot hold the startup
 * sequence longer than this bound.
 */
export const DEFAULT_TAB_BRIDGE_START_SETTLE_MS = 5_000;

/**
 * Consecutive transport failures with an open context before the context is
 * closed as unreachable (≈ backoff-sum seconds; keeps suppression honest
 * when the SP view disappears mid-transcription).
 */
const TRANSPORT_FAILURES_BEFORE_CONTEXT_CLOSE = 4;

/** Result shape of the loader's `executeInTab` (verified: resolves, never rejects, for in-tab failures). */
export interface TabExecutionResult {
    readonly success: boolean;
    readonly result: unknown;
}

/** Transport seam — production binding is `@decky/api`'s `executeInTab`. */
export type TabExecutor = (
    tab: string,
    runAsync: boolean,
    code: string,
) => Promise<TabExecutionResult>;

/** Structural surface the one-payload insertion path consumes. */
export interface TabBridgeInsertionSurface {
    currentContext(): KeyboardContext | null;

    insertText(text: string): Promise<boolean>;
}

/** Structural surface the fallback paste path consumes. */
export interface TabBridgePasteSurface {
    currentContext(): KeyboardContext | null;

    invokePaste(): Promise<boolean>;

    probePasteMechanism(): Promise<boolean>;
}

/** Press event pushed by the bootstrap onto `window.__stdMicEvents`. */
export interface TabBridgePressEvent {
    readonly t: number;
    readonly kind: string;
}

/** Decoded poll payload (strict shape guard at the boundary). */
export interface TabBridgePollPayload {
    readonly v: boolean;
    readonly c: boolean;
    readonly b: boolean;
    readonly ev: readonly TabBridgePressEvent[];
    readonly f: boolean;
}

/** Stable lowercase degrade reasons (shared convention). */
export type TabBridgeDegradeReason =
    "sp-target-not-found" | "bridge-not-injected" | "signature-not-found";

/** Observed bridge facts; `reason` is null only when all three are proven. */
export interface TabBridgeFacts {
    readonly transportOk: boolean;
    readonly bootstrapInjected: boolean;
    readonly keyboardSeen: boolean;
    readonly pressesSeen: number;
    readonly reason: TabBridgeDegradeReason | null;
}

export interface KeyboardTabBridgeOptions {
    executor: TabExecutor;
    onPress: () => void;
    onKeyboardOpened: (context: KeyboardContext) => void;
    onKeyboardClosed: (contextId: string) => void;
    /** Poll/inject gate — the loop runs ONLY while the plugin is enabled. */
    isEnabled?: () => boolean;
    contexts?: SteamKeyboardContextFactory;
    tabTitle?: string;
    pollMs?: number;
    reinjectMs?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    startSettleMs?: number;
    logger?: Logger;
    now?: () => number;
}

function isPressEvent(value: unknown): value is TabBridgePressEvent {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record["t"] === "number" && typeof record["kind"] === "string";
}

/** Strict boundary guard for the poll payload crossing the tab boundary. */
export function parsePollPayload(raw: unknown): TabBridgePollPayload | null {
    if (typeof raw !== "string") {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
        typeof record["v"] !== "boolean" ||
        typeof record["c"] !== "boolean" ||
        typeof record["b"] !== "boolean" ||
        typeof record["f"] !== "boolean" ||
        !Array.isArray(record["ev"])
    ) {
        return null;
    }
    return {
        v: record["v"],
        c: record["c"],
        b: record["b"],
        f: record["f"],
        ev: record["ev"].filter(isPressEvent),
    };
}

export class KeyboardTabBridge {
    private readonly executor: TabExecutor;
    private readonly press: () => void;
    private readonly opened: (context: KeyboardContext) => void;
    private readonly closed: (contextId: string) => void;
    private readonly isEnabled: () => boolean;
    private readonly contexts: SteamKeyboardContextFactory;
    private readonly tabTitle: string;
    private readonly pollMs: number;
    private readonly reinjectMs: number;
    private readonly backoffBaseMs: number;
    private readonly backoffMaxMs: number;
    private readonly startSettleMs: number;
    private readonly logger: Logger;
    private readonly now: () => number;

    private current: KeyboardContext | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private ticking = false;
    private started = false;
    private stopped = false;

    private transportOk = false;
    private bootstrapInjected = false;
    private keyboardSeen = false;
    private pressesSeen = 0;
    private failureStreak = 0;
    private gateUntilMs = 0;
    private lastInjectAtMs = Number.NEGATIVE_INFINITY;

    constructor(options: KeyboardTabBridgeOptions) {
        this.executor = options.executor;
        this.press = options.onPress;
        this.opened = options.onKeyboardOpened;
        this.closed = options.onKeyboardClosed;
        this.isEnabled = options.isEnabled ?? (() => true);
        this.contexts =
            options.contexts ?? new SteamKeyboardContextFactory(new RandomIdGenerator());
        this.tabTitle = options.tabTitle ?? SP_KEYBOARD_TAB_TITLE;
        this.pollMs = options.pollMs ?? DEFAULT_TAB_BRIDGE_POLL_MS;
        this.reinjectMs = options.reinjectMs ?? DEFAULT_TAB_BRIDGE_REINJECT_MS;
        this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_TAB_BRIDGE_BACKOFF_BASE_MS;
        this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_TAB_BRIDGE_BACKOFF_MAX_MS;
        this.startSettleMs = options.startSettleMs ?? DEFAULT_TAB_BRIDGE_START_SETTLE_MS;
        this.logger = options.logger ?? new Logger("steam.keyboard");
        this.now = options.now ?? (() => Date.now());
    }

    // ── Lifecycle ──

    /**
     * Starts the poll loop and awaits ONE bounded inject+poll cycle so the
     * startup capability report is built on settled facts. Never throws:
     * transport failures are contained (the controller's startup sequence
     * must not fail because the SP view was briefly unavailable).
     */
    async start(): Promise<void> {
        if (this.started || this.stopped) {
            return;
        }
        this.started = true;
        this.timer = setInterval(() => {
            void this.tick();
        }, this.pollMs);
        await Promise.race([
            this.tick(),
            new Promise<void>((resolve) => {
                setTimeout(resolve, this.startSettleMs);
            }),
        ]);
    }

    /** Full stop — poll loop down, in-window bootstrap uninstalled, context closed. */
    async stop(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.pushTeardown();
        const closedId = this.current?.id;
        this.current = null;
        if (closedId !== undefined) {
            this.closed(closedId);
        }
    }

    /** Current keyboard context, or null while the keyboard is hidden. */
    currentContext(): KeyboardContext | null {
        return this.current;
    }

    /** Observed facts with the derived stable degrade reason. */
    getFacts(): TabBridgeFacts {
        const reason: TabBridgeDegradeReason | null = !this.transportOk
            ? "sp-target-not-found"
            : !this.bootstrapInjected
              ? "bridge-not-injected"
              : !this.keyboardSeen
                ? "signature-not-found"
                : null;
        return {
            transportOk: this.transportOk,
            bootstrapInjected: this.bootstrapInjected,
            keyboardSeen: this.keyboardSeen,
            pressesSeen: this.pressesSeen,
            reason,
        };
    }

    /** Panel-facing diagnostics snapshot (the diagnostics panel row source). */
    getDiagnostics(): TabBridgeDiagnostics {
        const facts = this.getFacts();
        return {
            injected: facts.bootstrapInjected,
            keyboardSeen: facts.keyboardSeen,
            pressChannelLive: facts.transportOk,
            reason: facts.reason,
        };
    }

    // ── Bridge operations (all exception-contained) ──

    /**
     * One-payload transcript insertion: resolves to true only when
     * the in-window `__stdMicInsert` reported success.
     */
    async insertText(text: string): Promise<boolean> {
        if (this.stopped) {
            return false;
        }
        try {
            const result = await this.executor(this.tabTitle, false, buildInsertExpression(text));
            return result.success === true && result.result === true;
        } catch {
            return false;
        }
    }

    /** Fallback final step: the single native paste in the keyboard document. */
    async invokePaste(): Promise<boolean> {
        if (this.stopped) {
            return false;
        }
        try {
            const result = await this.executor(this.tabTitle, false, buildPasteExpression());
            return result.success === true && result.result === true;
        } catch {
            return false;
        }
    }

    /** Read-only paste-mechanism recognition in the keyboard document. */
    async probePasteMechanism(): Promise<boolean> {
        if (this.stopped) {
            return false;
        }
        try {
            const result = await this.executor(this.tabTitle, false, buildPasteProbeExpression());
            return result.success === true && result.result === true;
        } catch {
            return false;
        }
    }

    /** Visual-state push (fire-and-forget, contained). */
    pushState(state: MicBridgeVisualState): void {
        if (this.stopped) {
            return;
        }
        void this.executor(this.tabTitle, false, buildStateExpression(state)).catch(
            () => undefined,
        );
    }

    private pushTeardown(): void {
        void this.executor(this.tabTitle, false, buildTeardownExpression()).catch(() => undefined);
    }

    // ── Poll loop ──

    private async tick(): Promise<void> {
        if (this.stopped || !this.started || this.ticking) {
            return;
        }
        if (!this.isEnabled()) {
            return; // poll loop ONLY while the plugin is enabled
        }
        const nowMs = this.now();
        if (nowMs < this.gateUntilMs) {
            return; // bounded backoff
        }
        this.ticking = true;
        try {
            if (this.now() - this.lastInjectAtMs >= this.reinjectMs) {
                this.lastInjectAtMs = this.now();
                if (!(await this.injectBootstrap())) {
                    this.registerTransportFailure();
                    return;
                }
                this.registerTransportSuccess();
            }
            await this.pollOnce();
        } finally {
            this.ticking = false;
        }
    }

    private async injectBootstrap(): Promise<boolean> {
        try {
            const result = await this.executor(
                this.tabTitle,
                false,
                KEYBOARD_BRIDGE_BOOTSTRAP_SOURCE,
            );
            return result.success === true;
        } catch {
            return false;
        }
    }

    private async pollOnce(): Promise<void> {
        let result: TabExecutionResult;
        try {
            result = await this.executor(this.tabTitle, false, buildPollExpression());
        } catch {
            this.registerTransportFailure();
            return;
        }
        if (result.success !== true) {
            this.registerTransportFailure();
            return;
        }
        const payload = parsePollPayload(result.result);
        if (payload === null) {
            this.logger.warn("tab bridge poll payload guard failed");
            this.registerTransportFailure();
            return;
        }
        this.registerTransportSuccess();
        this.absorbPollPayload(payload);
    }

    private absorbPollPayload(payload: TabBridgePollPayload): void {
        if (payload.b) {
            this.bootstrapInjected = true;
        }
        if (payload.c) {
            this.keyboardSeen = true;
        }
        if (payload.v && this.current === null) {
            const context = this.contexts.create(this.tabTitle, true);
            this.current = context;
            this.logger.info("keyboard opened via tab bridge", { contextId: context.id });
            this.opened(context);
        } else if (!payload.v && this.current !== null) {
            this.closeContext("keyboard hidden");
        }
        for (const event of payload.ev) {
            if (event.kind !== "press") {
                continue;
            }
            this.pressesSeen += 1;
            this.press();
        }
    }

    private closeContext(detail: string): void {
        const closedId = this.current?.id;
        this.current = null;
        if (closedId !== undefined) {
            this.logger.info("keyboard closed", { contextId: closedId, detail });
            this.closed(closedId);
        }
    }

    private registerTransportSuccess(): void {
        this.transportOk = true;
        this.failureStreak = 0;
        this.gateUntilMs = 0;
    }

    private registerTransportFailure(): void {
        this.failureStreak += 1;
        const delayMs = Math.min(
            this.backoffBaseMs * 2 ** (this.failureStreak - 1),
            this.backoffMaxMs,
        );
        this.gateUntilMs = this.now() + delayMs;
        // Suppression protection: a document with an open context that stays
        // unreachable is effectively gone — close it so suppression and the
        // context revalidation stay truthful.
        if (
            this.current !== null &&
            this.failureStreak >= TRANSPORT_FAILURES_BEFORE_CONTEXT_CLOSE
        ) {
            this.closeContext("transport unreachable");
        }
    }
}
