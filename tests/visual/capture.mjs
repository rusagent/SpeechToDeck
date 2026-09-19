/**
 * Captures the visual-harness screenshots and overflow probes.
 *
 * Screenshots follow the wave-visual-read capture limits: JPEG quality 42,
 * device scale 1, clipped to the owned surface (the 410px QAM column),
 * long edge ≤ 800px, height ≤ 450px. Files land in .tmp/ui-visual/
 * (gitignored); only the harness SOURCE under tests/visual/ is committed.
 *
 * Single committed exception: storeShot() writes the store listing asset
 * assets/screenshot.jpg from the same real-panel page (EN, top sections) at
 * 2x device scale and JPEG quality 75 — the review capture limits above do
 * not bind store assets.
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

function chromeArgs(windowSize, extra, deviceScaleFactor = 1) {
    return [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        `--force-device-scale-factor=${deviceScaleFactor}`,
        "--virtual-time-budget=3000",
        `--window-size=${windowSize}`,
        ...extra,
    ];
}

/** Unscrolled page geometry reported by harness-entry (data-geometry). */
function findRegion(geometry, name) {
    const rect = (geometry.regions ?? []).find((candidate) => candidate.name === name);
    if (rect === undefined) {
        fail(`no harness region named ${JSON.stringify(name)} rendered`);
    }
    return rect;
}

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

function shot(
    name,
    query,
    { sectionTitle = null, region = null, startRegion = null, height = 450 } = {},
) {
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
    } else if (region !== null) {
        // Named sub-section region reported by harness-entry (e.g. the
        // catalog-driven ModelPicker block inside the Speech section).
        const rect = findRegion(geometry, region);
        cropY = Math.max(0, rect.top - SECTION_MARGIN);
        cropH = Math.min(450, rect.height + 2 * SECTION_MARGIN);
    } else if (startRegion !== null) {
        // Region-anchored fixed-height crop: starts at the named region and
        // extends `height` px (the full 605px picker cannot fit the ≤450px
        // review limit, so catalog shots anchor at the decisive group).
        const rect = findRegion(geometry, startRegion);
        cropY = Math.max(0, rect.top - SECTION_MARGIN);
        cropH = height;
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

// Download modal (v0.2.5 on-device fix): the REAL surface is a fullscreen
// Steam overlay — the on-device CDP capture measured ModalOverlayContent at
// the full 854px browserview width with the dialog box drawn by ModalRoot
// centered inside — so a 410px QAM column crop cannot contain it. The honest
// representation captures the whole overlay window at a representative 640px
// width (within the wave-visual-read long-edge limit): the ModalRoot dialog
// box on the dimmed page, plus Steam's X close icon above it. The geometry
// pass doubles as the sentinel that the modal actually opened.
function modalShot(name, query, width = 640, height = 450) {
    const geometry = readGeometry(query, height);
    findRegion(geometry, "downloadModal");
    const png = path.join(out, `${name}.png`);
    const jpg = path.join(out, `${name}.jpg`);
    execFileSync(
        chrome,
        chromeArgs(`${width},${height}`, [
            `--screenshot=${png}`,
            `file://${root}/tests/visual/index.html?${query}`,
        ]),
        { stdio: "ignore" },
    );
    execFileSync(
        magick,
        [png, "-crop", `${width}x${height}+0+0`, "+repage", "-strip", "-quality", "42", jpg],
        { stdio: "ignore" },
    );
    rmSync(png);
    console.log(`${name} ${width}x${height} ${statSync(jpg).size} bytes`);
}

// Store listing asset: the real settings panel (EN, top sections) at 2x
// device scale, JPEG quality 75 (store assets are not bound by the
// wave-visual-read review limits; target < 150KB). Committed under assets/.
function storeShot() {
    const query = "case=panel&locale=en";
    const height = 450;
    const scale = 2;
    // Geometry is measured at scale 1 (CSS px); the 2x screenshot crop is
    // the same region in device px.
    const geometry = readGeometry(query, height + BOTTOM_MARGIN);
    const png = path.join(out, "store-screenshot.png");
    execFileSync(
        chrome,
        chromeArgs(
            `${CAPTURE_WINDOW_WIDTH},${height + BOTTOM_MARGIN}`,
            [`--screenshot=${png}`, `file://${root}/tests/visual/index.html?${query}`],
            scale,
        ),
        { stdio: "ignore" },
    );
    const assets = path.join(root, "assets");
    mkdirSync(assets, { recursive: true });
    const jpg = path.join(assets, "screenshot.jpg");
    execFileSync(
        magick,
        [
            png,
            "-crop",
            `${COLUMN_WIDTH * scale}x${height * scale}+${geometry.rootX * scale}+0`,
            "+repage",
            "-strip",
            "-quality",
            "75",
            jpg,
        ],
        { stdio: "ignore" },
    );
    rmSync(png);
    console.log(
        `store screenshot (assets/screenshot.jpg) ${COLUMN_WIDTH * scale}x${height * scale} ${statSync(jpg).size} bytes`,
    );
}

// Panel clips (QAM column: top of the decluttered panel, EN + DE).
shot("panel-en-top", "case=panel&locale=en");
shot("panel-de-top", "case=panel&locale=de");
// Setup progress, REAL panel with the dedicated store preset per state:
// active-indeterminate daemon step, determinate download at 37%, failed with
// retry (EN + DE), and terminal ready hiding the panel again.
shot("setup-indeterminate-en", "case=setup&variant=indeterminate&locale=en", { height: 320 });
shot("setup-download-en", "case=setup&variant=download&locale=en", { height: 320 });
shot("setup-failed-en", "case=setup&variant=failed&locale=en", { height: 400 });
shot("setup-failed-de", "case=setup&variant=failed&locale=de", { height: 400 });
shot("setup-ready-hidden-en", "case=setup&variant=ready&locale=en", { height: 320 });
// Hydrated failure: the panel shows the failed state from the §30 status
// report alone (real adapter hydration, no live setup_progress event).
shot("setup-hydrated-failed-en", "case=setup&variant=hydrated-failed&locale=en", { height: 400 });
// Microphone button, all four §20 states in one clip (EN + DE error text).
shot("mic-states-en", "case=mic&locale=en", { height: 160 });
shot("mic-states-de", "case=mic&locale=de", { height: 160 });
// Dictation card (v0.2): idle big button, live recording strip fed with
// real received frames, settled transcript + clipboard block (EN + DE).
shot("dictation-idle-en", "case=dictation&dictation=idle&locale=en", { height: 300 });
shot("dictation-recording-en", "case=dictation&dictation=recording&locale=en", { height: 300 });
shot("dictation-transcript-en", "case=dictation&dictation=transcript&locale=en", { height: 420 });
shot("dictation-transcript-de", "case=dictation&dictation=transcript&locale=de", { height: 420 });
// Model-select flow (ADR-011, v0.2.5): the REAL Speech section reading
// Language → Model over a canned list_models snapshot (concrete language
// "de"), then the REAL download modal opened through the production
// openModelDownloadModal path with the single-flight download live at 40%
// (ModalRoot dialog box: title header, description, percent + determinate
// bar, Cancel in the footer — captured fullscreen-overlay style via
// modalShot).
shot("panel-speech-en", "case=panel&catalog=ready&language=de&locale=en", {
    sectionTitle: "Speech",
});
modalShot("panel-modal-en", "case=panel&catalog=modal&language=de&locale=en");
storeShot();

// Numeric overflow checks at the acceptance widths (no bitmaps needed).
for (const width of [390, 768]) {
    overflowProbe(width, "case=panel&locale=en");
}
