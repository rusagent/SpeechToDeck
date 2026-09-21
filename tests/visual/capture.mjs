import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, ".tmp/ui-visual");

const COLUMN_WIDTH = 410;
const CAPTURE_WINDOW_WIDTH = 700;
const SECTION_MARGIN = 8;
const BOTTOM_MARGIN = 48;

function firstAvailable(candidates) {
    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ["--version"], { stdio: "ignore" });
            return candidate;
        } catch {}
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

function findRegion(geometry, name) {
    const rect = (geometry.regions ?? []).find((candidate) => candidate.name === name);
    if (rect === undefined) {
        fail(`no harness region named ${JSON.stringify(name)} rendered`);
    }
    return rect;
}

function readGeometry(query, windowHeight, extra = []) {
    const dom = execFileSync(
        chrome,
        chromeArgs(`${CAPTURE_WINDOW_WIDTH},${windowHeight}`, [
            "--dump-dom",
            `file://${root}/tests/visual/index.html?${query}`,
            ...extra,
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
        const rect = findRegion(geometry, region);
        cropY = Math.max(0, rect.top - SECTION_MARGIN);
        cropH = Math.min(450, rect.height + 2 * SECTION_MARGIN);
    } else if (startRegion !== null) {
        const rect = findRegion(geometry, startRegion);
        cropY = Math.max(0, rect.top - SECTION_MARGIN);
        cropH = height;
    }
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

function modalShot(name, query, { width = 640, height = 450, region = "downloadModal" } = {}) {
    const holdWindow = ["--virtual-time-budget=400"];
    const geometry = readGeometry(query, height, holdWindow);
    findRegion(geometry, region);
    const png = path.join(out, `${name}.png`);
    const jpg = path.join(out, `${name}.jpg`);
    execFileSync(
        chrome,
        chromeArgs(`${width},${height}`, [
            ...holdWindow,
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

function storeShot() {
    const query = "case=panel&locale=en";
    const height = 450;
    const scale = 2;
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

shot("panel-en-top", "case=panel&locale=en");
shot("panel-de-top", "case=panel&locale=de");
shot("panel-load-failed-en", "case=panel&load=failed&locale=en", { height: 400 });
shot("setup-indeterminate-en", "case=setup&variant=indeterminate&locale=en", { height: 320 });
shot("setup-download-en", "case=setup&variant=download&locale=en", { height: 320 });
shot("setup-failed-en", "case=setup&variant=failed&locale=en", { height: 400 });
shot("setup-failed-de", "case=setup&variant=failed&locale=de", { height: 400 });
shot("setup-ready-hidden-en", "case=setup&variant=ready&locale=en", { height: 320 });
shot("setup-hydrated-failed-en", "case=setup&variant=hydrated-failed&locale=en", { height: 400 });
shot("mic-states-en", "case=mic&locale=en", { height: 160 });
shot("mic-states-de", "case=mic&locale=de", { height: 160 });
shot("dictation-idle-en", "case=dictation&dictation=idle&locale=en", { height: 300 });
shot("dictation-recording-en", "case=dictation&dictation=recording&locale=en", { height: 300 });
shot("dictation-transcript-en", "case=dictation&dictation=transcript&locale=en", { height: 420 });
shot("dictation-transcript-de", "case=dictation&dictation=transcript&locale=de", { height: 420 });
shot("panel-speech-en", "case=panel&catalog=ready&locale=en", {
    sectionTitle: "Speech",
});
modalShot("panel-modal-en", "case=panel&catalog=modal&locale=en");
modalShot("panel-manage-en", "case=panel&catalog=manage&locale=en", {
    region: "manageModal",
});
storeShot();

for (const width of [390, 768]) {
    overflowProbe(width, "case=panel&locale=en");
}
