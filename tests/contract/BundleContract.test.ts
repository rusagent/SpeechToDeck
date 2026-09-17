/**
 * Frontend bundle contract (spec §112 Packaging; decky-loader load path).
 *
 * Decision point: Decky Loader loads dist/index.js as an ES MODULE
 * (package.json "type": "module") and consumes only `m.default()` as the
 * callable plugin factory — the page provides NO globals of its own. This
 * guards the production regression "ReferenceError: DeckyApi is not defined"
 * from the retired IIFE build (globals DeckyApi/React/ReactDOM/DeckyUI).
 * The oracle is the official build contract of @decky/rollup (decky-plugin
 * template): ESM output with exports "default", externals rewritten to the
 * page globals SP_REACT/SP_JSX/SP_REACTDOM/DFL, and @decky/api bundled (it
 * resolves the loader at runtime via its secret-internals window property).
 *
 * CI runs this suite on a fresh checkout WITHOUT a prior `pnpm build`
 * (dist/ is gitignored), so the built-artifact block is exercised whenever
 * the bundle exists and visibly skipped otherwise; the committed
 * build-contract source is asserted unconditionally.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The suite runs from the repository root (package.json scripts, CI);
// import.meta.url is unusable here because the jsdom environment rewrites
// module URLs to the jsdom origin.
const repoRoot = process.cwd();

function readText(relative: string): string {
    return readFileSync(join(repoRoot, relative), "utf8");
}

describe("committed build contract", () => {
    it("loads the plugin entry as an ES module (type: module)", () => {
        const pkg = JSON.parse(readText("package.json")) as { type?: string };
        // The loader's `await import(url)` only evaluates ESM because of this
        // field; flipping it back would reintroduce the retired IIFE contract.
        expect(pkg.type).toBe("module");
    });

    it("builds through the official @decky/rollup helper, not the retired IIFE config", () => {
        const config = readText("rollup.config.mjs");
        expect(config).toContain("@decky/rollup");
        // Old-contract markers must stay gone: IIFE output and its globals.
        expect(config).not.toMatch(/format:\s*"iife"/);
        expect(config).not.toContain("DeckyApi");
        expect(config).not.toContain("DeckyUI");
    });
});

describe("built artifact dist/index.js", () => {
    const bundlePath = join(repoRoot, "dist", "index.js");
    const hasBundle = existsSync(bundlePath);

    it.skipIf(!hasBundle)("is ESM, not the retired IIFE", () => {
        const bundle = readFileSync(bundlePath, "utf8");
        expect(bundle.startsWith("(function")).toBe(false);
        // The loader binds the plugin via the default export (m.default()).
        expect(bundle).toMatch(/^export\b/m);
    });

    it.skipIf(!hasBundle)("resolves externals through the page globals SP_REACT/SP_JSX/DFL", () => {
        const bundle = readFileSync(bundlePath, "utf8");
        expect(bundle).toContain("SP_REACT");
        expect(bundle).toContain("SP_JSX");
        expect(bundle).toContain("DFL");
        // No bare module specifiers may survive: the Deck page provides no
        // module resolution for react/react-dom/@decky/ui.
        expect(bundle).not.toMatch(/from\s*"(react|react-dom|@decky\/ui)"/);
    });

    it.skipIf(!hasBundle)("bundles @decky/api instead of referencing a DeckyApi global", () => {
        const bundle = readFileSync(bundlePath, "utf8");
        // Word boundaries: bundled application identifiers such as the
        // DeckyApiTransport class are legitimate; the retired IIFE referenced
        // the bare page globals DeckyApi/DeckyUI, which must stay gone.
        expect(bundle).not.toMatch(/\bDeckyApi\b/);
        expect(bundle).not.toMatch(/\bDeckyUI\b/);
        // Bundled @decky/api resolves the loader through this window property.
        expect(bundle).toContain(
            "__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit",
        );
    });
});
