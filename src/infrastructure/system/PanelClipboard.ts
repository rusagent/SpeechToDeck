/**
 * Panel-side clipboard copy (additive v0.2, primary clipboard path).
 *
 * Writes the transcript into the QuickAccess CEF clipboard with the
 * shipped-plugin pattern proven by the snippets plugin
 * (src/index.tsx:65-109): a hidden input, focus + select, then
 * `document.execCommand("copy")` — reported as the most reliable copy in
 * Game Mode — with `navigator.clipboard.writeText` as the fallback. The
 * caller reports the outcome in the UI; nothing here logs the text (§73).
 *
 * Whether this CEF clipboard is the exact clipboard the Steam keyboard's
 * Paste key reads is a live-verify item on device (research lane, Q4);
 * the backend xclip leg reports its own independent outcome.
 */

const COPY_INPUT_STYLE: Partial<CSSStyleDeclaration> = {
    position: "fixed",
    left: "-9999px",
    top: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    border: "none",
    padding: "0",
    margin: "0",
};

function copyViaExecCommand(text: string, doc: Document): boolean {
    const input = doc.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "true");
    for (const [key, value] of Object.entries(COPY_INPUT_STYLE)) {
        if (typeof value === "string") {
            input.style.setProperty(key, value);
        }
    }
    doc.body.appendChild(input);
    try {
        input.focus();
        input.select();
        return doc.execCommand("copy");
    } catch {
        return false;
    } finally {
        input.remove();
    }
}

async function copyViaAsyncClipboard(text: string, nav: Navigator): Promise<boolean> {
    try {
        const clipboard = nav.clipboard;
        if (clipboard === undefined) {
            return false;
        }
        await clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

/**
 * Copies the complete text, never a chunk (§25). Resolves `true` only when
 * a mechanism reported success; never throws.
 */
export async function copyTextToClipboard(
    text: string,
    doc: Document = document,
    nav: Navigator = navigator,
): Promise<boolean> {
    if (text.length === 0) {
        return false;
    }
    if (copyViaExecCommand(text, doc)) {
        return true;
    }
    return copyViaAsyncClipboard(text, nav);
}
