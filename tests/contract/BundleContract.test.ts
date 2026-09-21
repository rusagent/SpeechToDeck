import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function readText(relative: string): string {
    return readFileSync(join(repoRoot, relative), "utf8");
}

describe("committed build contract", () => {
    it("loads the plugin entry as an ES module (type: module)", () => {
        const pkg = JSON.parse(readText("package.json")) as { type?: string };
        expect(pkg.type).toBe("module");
    });

    it("builds through the official @decky/rollup helper, not the retired IIFE config", () => {
        const config = readText("rollup.config.mjs");
        expect(config).toContain("@decky/rollup");
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
        expect(bundle).toMatch(/^export\b/m);
    });

    it.skipIf(!hasBundle)("resolves externals through the page globals SP_REACT/SP_JSX/DFL", () => {
        const bundle = readFileSync(bundlePath, "utf8");
        expect(bundle).toContain("SP_REACT");
        expect(bundle).toContain("SP_JSX");
        expect(bundle).toContain("DFL");
        expect(bundle).not.toMatch(/from\s*"(react|react-dom|@decky\/ui)"/);
    });

    it.skipIf(!hasBundle)("bundles @decky/api instead of referencing a DeckyApi global", () => {
        const bundle = readFileSync(bundlePath, "utf8");
        expect(bundle).not.toMatch(/\bDeckyApi\b/);
        expect(bundle).not.toMatch(/\bDeckyUI\b/);
        expect(bundle).toContain(
            "__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit",
        );
    });
});
