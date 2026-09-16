/**
 * Captures the visual-harness screenshots and overflow probes.
 *
 * Screenshots follow the wave-visual-read capture limits: JPEG quality 42,
 * device scale 1, clipped to the owned surface (the 410px QAM column),
 * long edge ≤ 800px, height ≤ 450px. Files land in .tmp/ui-visual/
 * (gitignored); only the harness SOURCE under tests/visual/ is committed.
 *
 * Host tools (no project dependencies): a headless-capable Chromium and
 * ImageMagick (`magick`/`convert`). Override via CHROME env var.
 *
 * Targeting: the harness page stays unscrolled and reports its geometry to
 * the driver (data-geometry, written by harness-entry). Headless Chromium's
 * --screenshot maps window pixels 1:1 onto the page from its origin, but
 * does not reliably honor page-side scroll offsets — the old
 * scrollIntoView targeting captured the wrong region for section shots.
 * The driver therefore measures the section rects (dump-dom pass), takes a
 * full-window screenshot, and crops the exact column region with
 * ImageMagick; section shots clip to the titled section so it fills the
 * frame.
 *
 * Usage: node tests/visual/capture.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, ".tmp/ui-visual");

// The QAM column is 410px; the capture window is deliberately wider so the
// column is centered with a measurable offset and Chromium's minimum-window
// clamping cannot crop it. Only the crop output is 410px wide.
const COLUMN_WIDTH = 410;
const CAPTURE_WINDOW_WIDTH = 700;
const SECTION_MARGIN = 8; // page px around a section-targeted crop
const BOTTOM_MARGIN = 48; // spare page rows below the crop region

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

function fail(message) {
    console.error(`capture: FAIL: ${message}`);
    process.exit(1);
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

function chromeArgs(windowSize, extra) {
    return [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--virtual-time-budget=3000",
        `--window-size=${windowSize}`,
        ...extra,
    ];
}

/** Unscrolled page geometry reported by harness-entry (data-geometry). */
function readGeometry(query, windowHeight) {
    const dom = execFileSync(
        chrome,
        chromeArgs(`${CAPTURE_WINDOW_WIDTH},${windowHeight}`, [
            "--dump-dom",
            `file://${root}/tests/visual/index.html?${query}`,
        ]),
        { encoding: "utf8" },
    );
    const match = dom.match(/data-geometry="([^"]*)"/);
    if (match === null) {
        fail("harness page reported no data-geometry (bundle build or mount failed)");
    }
    return JSON.parse(match[1].replace(/&quot;/g, '"'));
}

function shot(name, query, { sectionTitle = null, height = 450 } = {}) {
    // Pass 1: measure the unscrolled page (section rects are independent of
    // the window height; #visual-root content flows from the top).
    const geometry = readGeometry(query, height + BOTTOM_MARGIN);
    let cropY = 0;
    let cropH = height;
    if (sectionTitle !== null) {
        const section = geometry.sections.find((section) => section.title === sectionTitle);
        if (section === undefined) {
            fail(`no panel section titled ${JSON.stringify(sectionTitle)} rendered`);
        }
        cropY = Math.max(0, section.top - SECTION_MARGIN);
        cropH = Math.min(450, section.height + 2 * SECTION_MARGIN);
    }
    // Pass 2: full-window screenshot at the capture size, then an exact
    // column crop at the measured offset.
    const png = path.join(out, `${name}.png`);
    const jpg = path.join(out, `${name}.jpg`);
    execFileSync(
        chrome,
        chromeArgs(`${CAPTURE_WINDOW_WIDTH},${cropY + cropH + BOTTOM_MARGIN}`, [
            `--screenshot=${png}`,
            `file://${root}/tests/visual/index.html?${query}`,
        ]),
        { stdio: "ignore" },
    );
    execFileSync(
        magick,
        [
            png,
            "-crop",
            `${COLUMN_WIDTH}x${cropH}+${geometry.rootX}+${cropY}`,
            "+repage",
            "-strip",
            "-quality",
            "42",
            jpg,
        ],
        { stdio: "ignore" },
    );
    rmSync(png);
    console.log(`${name} ${COLUMN_WIDTH}x${cropH} ${statSync(jpg).size} bytes`);
}

function overflowProbe(width, query) {
    const dom = execFileSync(
        chrome,
        chromeArgs(`${width},900`, [
            "--dump-dom",
            `file://${root}/tests/visual/index.html?${query}`,
        ]),
        { encoding: "utf8" },
    );
    const match = dom.match(/data-overflow-x="[a-z]*"/);
    console.log(`overflow probe at ${width}px: ${match?.[0] ?? "marker missing"}`);
}

// Panel clips (QAM column: top, and a Diagnostics-targeted section clip).
shot("panel-en-top", "case=panel&locale=en");
shot("panel-en-diag", "case=panel&locale=en&scroll=Diagnostics", { sectionTitle: "Diagnostics" });
shot("panel-de-top", "case=panel&locale=de");
// Microphone button, all four §20 states in one clip (EN + DE error text).
shot("mic-states-en", "case=mic&locale=en", { height: 160 });
shot("mic-states-de", "case=mic&locale=de", { height: 160 });

// Numeric overflow checks at the acceptance widths (no bitmaps needed).
for (const width of [390, 768]) {
    overflowProbe(width, "case=panel&locale=en");
}
