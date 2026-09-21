export function assertNever(value: never, message = "Unhandled value"): never {
    let rendered: string;
    try {
        rendered = JSON.stringify(value);
    } catch {
        rendered = String(value);
    }
    throw new Error(`${message}: ${rendered}`);
}
