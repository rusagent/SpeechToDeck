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
