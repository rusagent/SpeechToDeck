/**
 * Captures the visual-harness screenshots and overflow probes.
 *
 * Screenshots follow the wave-visual-read capture limits: JPEG quality 42,
 * device scale 1, clipped to the owned surface (the 410px QAM column),
 * long edge ≤ 800px, height ≤ 450px. Files land in .tmp/ui-polish/visual/
 * (gitignored); only the harness SOURCE under tests/visual/ is committed.
 *
 * Host tools (no project dependencies): a headless-capable Chromium and
 * ImageMagick (`magick`/`convert`). Override via CHROME env var.
 *
 * Usage: node tests/visual/capture.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, ".tmp/ui-polish/visual");

function firstAvailable(candidates) {
    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ["--version"], { stdio: "ignore" });
            return candidate;
        } catch {
            // try the next candidate
        }
    }
    return null;
}

const chrome =
    process.env.CHROME ?? firstAvailable(["chromium", "chromium-browser", "google-chrome-stable"]);
const magick = firstAvailable(["magick", "convert"]);
if (chrome === null || magick === null) {
    console.error("capture.mjs requires a Chromium binary and ImageMagick on PATH");
    process.exit(1);
}

mkdirSync(out, { recursive: true });

// Build the harness bundle with the repo's own toolchain (no new deps).
execFileSync(
    path.join(root, "node_modules/.bin/rollup"),
    ["-c", "tests/visual/rollup.config.mjs", "--silent"],
    { cwd: root, stdio: "inherit" },
);

function shot(name, width, height, query) {
    const png = path.join(out, `${name}.png`);
    const jpg = path.join(out, `${name}.jpg`);
    execFileSync(
        chrome,
        [
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--virtual-time-budget=3000",
            `--window-size=${width},${height}`,
            `--screenshot=${png}`,
            `file://${root}/tests/visual/index.html?${query}`,
        ],
        { stdio: "ignore" },
    );
    execFileSync(magick, [png, "-strip", "-quality", "42", jpg], { stdio: "ignore" });
    rmSync(png);
    console.log(`${name} ${width}x${height} ${statSync(jpg).size} bytes`);
}

function overflowProbe(width, query) {
    const dom = execFileSync(
        chrome,
        [
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--virtual-time-budget=3000",
            `--window-size=${width},900`,
            "--dump-dom",
            `file://${root}/tests/visual/index.html?${query}`,
        ],
        { encoding: "utf8" },
    );
    const match = dom.match(/data-overflow-x="[a-z]*"/);
    console.log(`overflow probe at ${width}px: ${match?.[0] ?? "marker missing"}`);
}

// Panel clips (QAM column, top and diagnostics sections, EN + DE).
shot("panel-en-top", 410, 450, "case=panel&locale=en");
shot("panel-en-diag", 410, 450, "case=panel&locale=en&scroll=Diagnostics");
shot("panel-de-top", 410, 450, "case=panel&locale=de");
// Microphone button, all four §20 states in one clip (EN + DE error text).
shot("mic-states-en", 410, 160, "case=mic&locale=en");
shot("mic-states-de", 410, 160, "case=mic&locale=de");

// Numeric overflow checks at the acceptance widths (no bitmaps needed).
for (const width of [390, 768]) {
    overflowProbe(width, "case=panel&locale=en");
}
