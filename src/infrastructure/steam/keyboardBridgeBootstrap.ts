/**
 * Tab-bridge bootstrap source (v0.1.7) — string building ONLY.
 *
 * This module produces the self-installing JavaScript source that
 * `executeInTab("Steam Big Picture Mode", false, source)` evaluates inside the
 * real Big Picture keyboard document (the CDP target the SharedJSContext
 * cannot see). It contains no TypeScript runtime behavior: the plugin never
 * executes this code in its own context.
 *
 * In-window contract (all globals are plugin-namespaced `__std*`):
 * - Idempotency: a second evaluation is a no-op via `window.__stdKbBridgeLoaded`
 *   (the loader-side re-injection cadence and SP document reloads rely on it).
 * - `MutationObserver` on `document.body` watches for the keyboard container
 *   `[class*="VirtualKeyboard"]` gaining visibility (class token
 *   "VirtualKeyboardVisible" present — offsetWidth reads 0 in CEF on device
 *   while the keyboard is on screen, so the token alone is authoritative) and
 *   injects exactly
 *   ONE `<div id="std-mic-host" role="button" tabindex="0"
 *   aria-label="SpeechToDeck dictation">` bottom-left inside the container;
 *   the host is removed again when the keyboard hides. The container node is
 *   never mutated beyond appending the plugin-owned host (append-only).
 * - Press (click / Enter / Space): instant local pressed-state feedback, then
 *   `{t, kind: "press"}` is pushed onto `window.__stdMicEvents` (capped 10).
 * - Focus capture: on keyboard-visible and on every `focusin` while visible,
 *   the focused editable is recorded into `window.__stdMicFocus` as
 *   `{tag, path}` (a child-index recipe from `document.documentElement`).
 * - `window.__stdMicInsert(text)`: inserts the COMPLETE text in ONE operation
 *   into the captured editable — the native value setter from the element's
 *   prototype chain plus exactly one bubbled `input` InputEvent (the
 *   React-controlled-component-safe pattern); contenteditable uses one
 *   `execCommand("insertText")`. Returns true only on success; §2.2/§22
 *   one-payload semantics hold (no per-character synthesis anywhere).
 * - `window.__stdMicState(state)`: visual state push from the poller
 *   (idle/recording/error classes + `aria-pressed`).
 * - `window.__stdMicPaste()`: §24 fallback single native paste on the captured
 *   editable (execCommand("paste"), elevated by the loader's userGesture).
 * - `window.__stdMicTeardown()`: full in-window uninstall (§83 unload).
 *
 * Every entry point is exception-contained: the bridge must never throw inside
 * the Steam UI document.
 */

/** CSS-module-agnostic container selector (permanently present, per probe evidence). */
export const KEYBOARD_CONTAINER_SELECTOR = '[class*="VirtualKeyboard"]';

/**
 * Visibility selector: the literal "VirtualKeyboardVisible" class token. Both
 * the bootstrap's `isVisible` and the poll's `v` field trust this token alone
 * (offsetWidth reads 0 in CEF on device while visible).
 */
export const KEYBOARD_VISIBLE_SELECTOR = '[class*="VirtualKeyboardVisible"]';

/** Plugin-owned host node id inside the keyboard document. */
export const MIC_HOST_ID = "std-mic-host";

/** Visual states the frontend poller can push into the keyboard document. */
export type MicBridgeVisualState = "idle" | "recording" | "error";

/**
 * The self-installing bootstrap IIFE source. Deliberately conservative ES5-ish
 * code (var, no arrow functions): it runs in the Steam UI document, not in the
 * plugin bundle, and must survive whatever script hygiene CEF applies.
 */
export const KEYBOARD_BRIDGE_BOOTSTRAP_SOURCE = `
(function () {
    "use strict";
    if (window.__stdKbBridgeLoaded) {
        return true;
    }
    window.__stdKbBridgeLoaded = true;
    window.__stdMicEvents = [];
    window.__stdMicFocus = null;

    var HOST_ID = ${JSON.stringify(MIC_HOST_ID)};
    var PRESSED_CLASS = "std-mic-pressed";
    var STATE_CLASSES = ["std-mic-idle", "std-mic-recording", "std-mic-error"];
    var STYLE_ID = "std-mic-style";
    var MARGIN = 12;
    var HOST_SIZE = 48;
    var PRESSED_RESET_MS = 150;
    var EVENT_CAP = 10;

    var STYLE_TEXT =
        "#" + HOST_ID + ":hover { background-color: rgba(44, 48, 54, 0.98) !important; }" +
        "#" + HOST_ID + ":focus { outline: 2px solid rgba(120, 180, 255, 0.8); outline-offset: 1px; }" +
        "#" + HOST_ID + ".std-mic-recording { background-color: rgba(140, 38, 38, 0.95) !important;" +
        " border-color: rgba(255, 120, 120, 0.7) !important; }" +
        "#" + HOST_ID + ".std-mic-error { background-color: rgba(96, 60, 16, 0.95) !important;" +
        " border-color: rgba(255, 180, 90, 0.7) !important; }" +
        "#" + HOST_ID + "." + PRESSED_CLASS + " { transform: scale(0.92); }";

    var GLYPH =
        '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">' +
        '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z"/>' +
        '<path d="M18 11a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H9' +
        'a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.09A6 6 0 0 0 18 11z"/></svg>';

    var host = null;
    var observer = null;
    var focusListener = null;

    function findContainer() {
        return document.querySelector(${JSON.stringify(KEYBOARD_CONTAINER_SELECTOR)});
    }

    function isVisible(container) {
        if (!container) {
            return false;
        }
        // On device offsetWidth is 0 in CEF while the keyboard is on screen: the Steam class token alone is the authority.
        var cls = " " + String(container.className) + " ";
        return cls.indexOf("VirtualKeyboardVisible") !== -1;
    }

    function isEditable(el) {
        if (!el || el.nodeType !== 1) {
            return false;
        }
        return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
    }

    function snapshotFocus() {
        var el = document.activeElement;
        if (!isEditable(el)) {
            return null;
        }
        var path = [];
        var node = el;
        while (node && node.nodeType === 1 && node !== document.documentElement) {
            var parent = node.parentNode;
            if (!parent) {
                return null;
            }
            var index = -1;
            for (var i = 0; i < parent.childNodes.length; i++) {
                if (parent.childNodes[i] === node) {
                    index = i;
                    break;
                }
            }
            if (index < 0) {
                return null;
            }
            path.unshift(index);
            node = parent;
        }
        return { tag: el.tagName, path: path };
    }

    function resolveFocus() {
        var snap = window.__stdMicFocus;
        if (snap && snap.path) {
            var node = document.documentElement;
            var ok = true;
            for (var i = 0; i < snap.path.length; i++) {
                if (!node || !node.childNodes || node.childNodes[snap.path[i]] === undefined) {
                    ok = false;
                    break;
                }
                node = node.childNodes[snap.path[i]];
            }
            if (ok && node && isEditable(node)) {
                return node;
            }
        }
        // Captured element is gone: refresh from the current focus (best effort).
        var active = document.activeElement;
        if (isEditable(active)) {
            window.__stdMicFocus = snapshotFocus();
            return active;
        }
        return null;
    }

    function insertInto(el, text) {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
            var proto =
                el.tagName === "TEXTAREA"
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
            var desc = Object.getOwnPropertyDescriptor(proto, "value");
            if (!desc || typeof desc.set !== "function") {
                return false;
            }
            desc.set.call(el, text);
            var event;
            try {
                event = new InputEvent("input", { bubbles: true });
            } catch (err) {
                event = document.createEvent("Event");
                event.initEvent("input", true, false);
            }
            el.dispatchEvent(event);
            return true;
        }
        if (el.isContentEditable === true) {
            el.focus();
            if (!document.execCommand) {
                return false;
            }
            return document.execCommand("insertText", false, text) === true;
        }
        return false;
    }

    function removeHost() {
        if (host && host.parentNode) {
            host.parentNode.removeChild(host);
        }
        host = null;
    }

    function onPressed(event) {
        try {
            if (event && event.type === "keydown") {
                var key = event.key;
                if (key !== "Enter" && key !== " " && key !== "Spacebar") {
                    return;
                }
                if (typeof event.preventDefault === "function") {
                    event.preventDefault();
                }
            }
            if (!host) {
                return;
            }
            host.classList.add(PRESSED_CLASS);
            setTimeout(function () {
                if (host) {
                    host.classList.remove(PRESSED_CLASS);
                }
            }, PRESSED_RESET_MS);
            var queue = window.__stdMicEvents;
            if (!queue) {
                queue = [];
                window.__stdMicEvents = queue;
            }
            if (queue.length >= EVENT_CAP) {
                queue.shift();
            }
            queue.push({ t: Date.now(), kind: "press" });
        } catch (err) {
            /* contained: a press must never throw into Steam UI code */
        }
    }

    function ensureHost(container) {
        if (!host || host.ownerDocument !== document) {
            removeHost();
            host = document.createElement("div");
            host.id = HOST_ID;
            host.setAttribute("role", "button");
            host.setAttribute("tabindex", "0");
            host.setAttribute("aria-label", "SpeechToDeck dictation");
            host.setAttribute("aria-pressed", "false");
            host.style.position = "fixed";
            host.style.display = "flex";
            host.style.alignItems = "center";
            host.style.justifyContent = "center";
            host.style.width = HOST_SIZE + "px";
            host.style.height = HOST_SIZE + "px";
            host.style.boxSizing = "border-box";
            host.style.padding = "0";
            host.style.borderRadius = "12px";
            host.style.border = "1px solid rgba(255, 255, 255, 0.14)";
            host.style.backgroundColor = "rgba(32, 35, 40, 0.96)";
            host.style.color = "#e6eaee";
            host.style.zIndex = "2147483000";
            host.style.cursor = "pointer";
            host.style.userSelect = "none";
            host.style.transition = "transform 80ms ease, background-color 120ms ease";
            host.innerHTML = GLYPH;
            host.addEventListener("click", onPressed);
            host.addEventListener("keydown", onPressed);
        }
        if (host.parentNode !== container) {
            container.appendChild(host); // append-only: Steam children untouched
        }
        var rect = container.getBoundingClientRect();
        var viewWidth = window.innerWidth || document.documentElement.clientWidth;
        var viewHeight = window.innerHeight || document.documentElement.clientHeight;
        var left = Math.max(MARGIN, Math.min(rect.left + MARGIN, viewWidth - HOST_SIZE - MARGIN));
        var top = Math.max(
            MARGIN,
            Math.min(rect.bottom - HOST_SIZE - MARGIN, viewHeight - HOST_SIZE - MARGIN),
        );
        host.style.left = left + "px";
        host.style.top = top + "px";
    }

    function evaluate() {
        try {
            var container = findContainer();
            if (isVisible(container)) {
                if (!window.__stdMicFocus) {
                    window.__stdMicFocus = snapshotFocus();
                }
                ensureHost(container);
            } else {
                removeHost();
            }
        } catch (err) {
            /* contained */
        }
    }

    function setup() {
        if (!document.body) {
            return false;
        }
        observer = new MutationObserver(evaluate);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style"],
        });
        focusListener = function (event) {
            try {
                if (!isVisible(findContainer())) {
                    return;
                }
                if (event && event.target && isEditable(event.target)) {
                    window.__stdMicFocus = snapshotFocus();
                }
            } catch (err) {
                /* contained */
            }
        };
        document.addEventListener("focusin", focusListener, true);
        var styleEl = document.getElementById(STYLE_ID);
        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.id = STYLE_ID;
            document.head.appendChild(styleEl);
            styleEl.textContent = STYLE_TEXT;
        }
        evaluate();
        return true;
    }

    if (!setup()) {
        document.addEventListener(
            "DOMContentLoaded",
            function () {
                setup();
            },
            { once: true },
        );
    }

    // §61 safety net: the plugin's 250 ms poll calls this before reading the
    // state, so a missed observer event self-heals within one poll tick (no
    // idle timers in the keyboard window).
    window.__stdKbEvaluate = evaluate;

    window.__stdMicInsert = function (text) {
        try {
            if (typeof text !== "string" || text.length === 0) {
                return false;
            }
            var el = resolveFocus();
            if (!el) {
                return false;
            }
            return insertInto(el, text) === true;
        } catch (err) {
            return false;
        }
    };

    // §24 fallback step 5: the single native paste, executed inside the
    // keyboard document on the captured editable (CDP userGesture is set by
    // the loader's evaluate). Never types text itself.
    window.__stdMicPaste = function () {
        try {
            var el = resolveFocus();
            if (!el || !document.execCommand) {
                return false;
            }
            el.focus();
            return document.execCommand("paste") === true;
        } catch (err) {
            return false;
        }
    };

    window.__stdMicState = function (state) {
        try {
            if (!host) {
                return false;
            }
            for (var i = 0; i < STATE_CLASSES.length; i++) {
                host.classList.remove(STATE_CLASSES[i]);
            }
            if (state === "recording") {
                host.classList.add("std-mic-recording");
            } else if (state === "error") {
                host.classList.add("std-mic-error");
            } else {
                host.classList.add("std-mic-idle");
            }
            host.setAttribute("aria-pressed", state === "recording" ? "true" : "false");
            return true;
        } catch (err) {
            return false;
        }
    };

    window.__stdMicTeardown = function () {
        try {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            if (focusListener) {
                document.removeEventListener("focusin", focusListener, true);
                focusListener = null;
            }
            removeHost();
            var styleEl = document.getElementById(STYLE_ID);
            if (styleEl && styleEl.parentNode) {
                styleEl.parentNode.removeChild(styleEl);
            }
            window.__stdMicFocus = null;
            window.__stdMicEvents = [];
            window.__stdKbEvaluate = null;
            window.__stdKbBridgeLoaded = false;
            return true;
        } catch (err) {
            return false;
        }
    };

    return true;
})();
`;

/**
 * Poll expression: ONE self-contained synchronous evaluation returning the
 * bridge payload as JSON. Works with and without the bootstrap installed
 * (`b` reports the in-window flag, so injection success is observed, not
 * assumed). Drains up to 9 queued press events per poll (§61 cadence 250 ms).
 * The leading comma operand re-runs the bootstrap's visibility evaluation
 * FIRST, so a missed observer event self-heals within one poll tick (§61).
 * `v` reports the visibility CLASS TOKEN alone (same authority as the
 * bootstrap's `isVisible`): offsetWidth reads 0 in CEF on device while the
 * keyboard is on screen.
 */
export function buildPollExpression(): string {
    return (
        "(window.__stdKbEvaluate && window.__stdKbEvaluate(), " +
        "JSON.stringify({" +
        "v:!!document.querySelector(" +
        JSON.stringify(KEYBOARD_VISIBLE_SELECTOR) +
        ")," +
        "c:!!document.querySelector(" +
        JSON.stringify(KEYBOARD_CONTAINER_SELECTOR) +
        ")," +
        "b:!!window.__stdKbBridgeLoaded," +
        "ev:(window.__stdMicEvents&&window.__stdMicEvents.length)?window.__stdMicEvents.splice(0,9):[]," +
        "f:!!window.__stdMicFocus}))"
    );
}

/** One-payload insert expression; JSON.stringify provides the JS string escaping. */
export function buildInsertExpression(text: string): string {
    return `window.__stdMicInsert(${JSON.stringify(text)})`;
}

/** Visual-state push expression ("idle" | "recording" | "error"). */
export function buildStateExpression(state: MicBridgeVisualState): string {
    return `window.__stdMicState && window.__stdMicState(${JSON.stringify(state)})`;
}

/**
 * §58.5 analog for the §24 fallback: read-only paste-mechanism recognition in
 * the keyboard document. Never pastes — it only verifies the mechanism exists
 * (same honesty rule as the clipboard write-mechanism probe).
 */
export function buildPasteProbeExpression(): string {
    return (
        "(function(){try{return !!(document.queryCommandSupported && " +
        "document.queryCommandSupported('paste'));}catch(e){return false;}})()"
    );
}

/** §24 fallback step 5 expression: exactly one native paste on the focused editable. */
export function buildPasteExpression(): string {
    return "window.__stdMicPaste && window.__stdMicPaste()";
}

/** Full in-window uninstall (§83 unload hygiene). */
export function buildTeardownExpression(): string {
    return "window.__stdMicTeardown && window.__stdMicTeardown()";
}
