/**
 * Exhaustiveness guard for discriminated unions (spec §3.4/§98).
 *
 * Reachable only when a union gains a member without a matching handler; the
 * compiler makes the argument `never` in every exhaustively handled switch.
 */
export function assertNever(value: never, message = "Unhandled value"): never {
    let rendered: string;
    try {
        rendered = JSON.stringify(value);
    } catch {
        rendered = String(value);
    }
    throw new Error(`${message}: ${rendered}`);
}
