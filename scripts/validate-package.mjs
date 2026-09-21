#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const violations = [];
const warnings = [];

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SEGMENTS = new Set([
    "src",
    "tests",
    "node_modules",
    "__pycache__",
    ".tmp",
    ".venv",
    ".worktrees",
]);
const REQUIRED_PLUGIN_ROOT_FILES = [
    "main.py",
    "LICENSE",
    "README.md",
    "dist/index.js",
    "models.json",
    "runtime-manifest.json",
];

function fail(message) {
    violations.push(message);
}

function warn(message) {
    warnings.push(message);
}

function loadZipEntries(buffer, zipPath) {
    if (buffer.readUInt32LE(0) !== 0x04034b50) {
        fail(`${zipPath}: does not look like a ZIP archive`);
        return null;
    }
    let eocd = -1;
    const minEocd = Math.max(0, buffer.length - 22 - 65535);
    for (let i = buffer.length - 22; i >= minEocd; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        fail(`${zipPath}: end of central directory not found`);
        return null;
    }
    const entryCount = buffer.readUInt16LE(eocd + 10);
    const cdSize = buffer.readUInt32LE(eocd + 12);
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
        fail(`${zipPath}: zip64 archives are not supported`);
        return null;
    }

    const entries = new Map();
    let p = cdOffset;
    for (let i = 0; i < entryCount; i++) {
        if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) {
            fail(`${zipPath}: corrupt central directory at offset ${p}`);
            return null;
        }
        const method = buffer.readUInt16LE(p + 10);
        const compressedSize = buffer.readUInt32LE(p + 20);
        const nameLen = buffer.readUInt16LE(p + 28);
        const extraLen = buffer.readUInt16LE(p + 30);
        const commentLen = buffer.readUInt16LE(p + 32);
        const localOffset = buffer.readUInt32LE(p + 42);
        const name = buffer.slice(p + 46, p + 46 + nameLen).toString("utf8");
        entries.set(name, { method, compressedSize, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }

    return {
        names: [...entries.keys()],
        readFile(entryName) {
            const entry = entries.get(entryName);
            if (entry === undefined) {
                throw new Error(`entry not found: ${entryName}`);
            }
            const local = entry.localOffset;
            if (buffer.readUInt32LE(local) !== 0x04034b50) {
                throw new Error(`corrupt local header for ${entryName}`);
            }
            const nameLen = buffer.readUInt16LE(local + 26);
            const extraLen = buffer.readUInt16LE(local + 28);
            const start = local + 30 + nameLen + extraLen;
            const raw = buffer.slice(start, start + entry.compressedSize);
            if (entry.method === 0) return raw;
            if (entry.method === 8) return inflateRawSync(raw);
            throw new Error(`unsupported compression method ${entry.method} for ${entryName}`);
        },
    };
}

function loadDirEntries(dirPath) {
    const names = [];
    const absolute = new Map();
    const walk = (relative) => {
        for (const name of readdirSync(path.join(dirPath, relative))) {
            const relPosix = relative === "" ? name : `${relative}/${name}`;
            const full = path.join(dirPath, relPosix);
            const stats = statSync(full);
            if (stats.isDirectory()) {
                names.push(`${relPosix}/`);
                walk(relPosix);
            } else {
                names.push(relPosix);
                absolute.set(relPosix, full);
            }
        }
    };
    walk("");
    return {
        names,
        readFile(entryName) {
            return readFileSync(absolute.get(entryName));
        },
    };
}

function parseJson(view, entryName, label) {
    let raw;
    try {
        raw = view.readFile(entryName);
    } catch (err) {
        fail(`${label}: cannot be read (${err.message})`);
        return null;
    }
    try {
        return JSON.parse(raw.toString("utf8"));
    } catch (err) {
        fail(`${label}: invalid JSON (${err.message})`);
        return null;
    }
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePackage(view, sourceLabel) {
    for (const name of view.names) {
        if (name.startsWith("/") || name.includes("\\") || name.endsWith("/.")) {
            fail(`${sourceLabel}: unsafe entry path ${JSON.stringify(name)}`);
        }
        const segments = name.replace(/\/$/, "").split("/");
        if (segments.some((segment) => segment === "..")) {
            fail(`${sourceLabel}: entry path escapes the package root: ${JSON.stringify(name)}`);
        }
    }
    if (violations.length > 0) return;

    const topLevel = new Map();
    for (const name of view.names) {
        const segments = name.replace(/\/$/, "").split("/");
        const isDir = name.endsWith("/") || segments.length > 1;
        const top = segments[0];
        topLevel.set(top, (topLevel.get(top) ?? false) || isDir);
    }
    if (topLevel.size !== 1) {
        fail(
            `${sourceLabel}: expected exactly one top-level directory, found ` +
                `${[...topLevel.keys()]
                    .sort()
                    .map((n) => JSON.stringify(n))
                    .join(", ")}`,
        );
        return;
    }
    const [topEntry] = topLevel.keys();
    if (!topLevel.get(topEntry)) {
        fail(
            `${sourceLabel}: expected a top-level directory, found the loose entry ${JSON.stringify(topEntry)}`,
        );
        return;
    }
    const pluginJson = parseJson(view, `${topEntry}/plugin.json`, "plugin.json");
    if (pluginJson === null) return;
    if (!isPlainObject(pluginJson)) {
        fail("plugin.json: top level must be an object");
        return;
    }
    const pluginName = pluginJson.name;
    if (typeof pluginName !== "string" || pluginName.length === 0) {
        fail('plugin.json: "name" must be a non-empty string');
        return;
    }
    if (topEntry !== pluginName) {
        fail(
            `${sourceLabel}: top-level directory must be named exactly ` +
                `${JSON.stringify(pluginName)} (plugin.json "name"), found ${JSON.stringify(topEntry)}`,
        );
    }

    const prefix = `${topEntry}/`;

    const apiVersion = pluginJson.api_version;
    if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion) || apiVersion < 1) {
        fail(
            `plugin.json: "api_version" must be an integer >= 1, got ${JSON.stringify(apiVersion)}`,
        );
    }
    if (Array.isArray(pluginJson.flags) && pluginJson.flags.length > 0) {
        fail('plugin.json: "flags" must stay empty (the plugin runs rootless)');
    }
    const publish = pluginJson.publish;
    if (!isPlainObject(publish)) {
        fail('plugin.json: "publish" must be an object (store metadata)');
    } else {
        if (!Array.isArray(publish.tags) || publish.tags.some((tag) => typeof tag !== "string")) {
            fail('plugin.json: "publish.tags" must be an array of strings');
        }
        if (typeof publish.description !== "string" || publish.description.length === 0) {
            fail('plugin.json: "publish.description" must be a non-empty string');
        }
        if (typeof publish.image !== "string") {
            fail('plugin.json: "publish.image" must be a string (hosted screenshot URL)');
        } else if (publish.image.length === 0) {
            warn(
                "plugin.json: publish.image is empty — the store submission needs a hosted " +
                    "icon/screenshot URL; set it before submitting.",
            );
        }
    }

    const packageJson = parseJson(view, `${prefix}package.json`, "package.json");
    if (packageJson !== null && isPlainObject(packageJson)) {
        const version = packageJson.version;
        if (typeof version !== "string" || SEMVER_RE.test(version) === false) {
            fail(
                `package.json: "version" must be semver MAJOR.MINOR.PATCH, got ${JSON.stringify(version)}`,
            );
        }
    }

    for (const required of REQUIRED_PLUGIN_ROOT_FILES) {
        if (!view.names.includes(`${prefix}${required}`)) {
            fail(`${sourceLabel}: missing required file ${JSON.stringify(prefix + required)}`);
        }
    }

    for (const name of view.names) {
        const segments = name.replace(/\/$/, "").split("/");
        if (segments.includes("defaults")) {
            fail(
                `${sourceLabel}: defaults/ must be flattened into the plugin root by the ` +
                    `packager; found ${JSON.stringify(name)}`,
            );
        }
        const forbidden = segments.filter((segment) => FORBIDDEN_SEGMENTS.has(segment));
        if (forbidden.length > 0) {
            fail(
                `${sourceLabel}: forbidden content ${JSON.stringify(forbidden[0])} in ` +
                    `${JSON.stringify(name)}`,
            );
        }
        if (/\.log$/i.test(name)) {
            fail(`${sourceLabel}: forbidden log file ${JSON.stringify(name)}`);
        }
    }
}

function usage() {
    console.error(
        "usage: node scripts/validate-package.mjs <plugin.zip>\n" +
            "       node scripts/validate-package.mjs --dir <staging-root>",
    );
    process.exit(2);
}

const args = process.argv.slice(2);
const dirFlagIndex = args.indexOf("--dir");
let view = null;
let sourceLabel;
if (dirFlagIndex >= 0) {
    const dirPath = args[dirFlagIndex + 1];
    if (dirPath === undefined || args.length !== 2) usage();
    sourceLabel = `dir ${dirPath}`;
    try {
        view = loadDirEntries(dirPath);
    } catch (err) {
        fail(`${dirPath}: cannot be read (${err.message})`);
    }
} else {
    if (args.length !== 1 || args[0].startsWith("-")) usage();
    const zipPath = args[0];
    sourceLabel = `zip ${zipPath}`;
    try {
        view = loadZipEntries(readFileSync(zipPath), zipPath);
    } catch (err) {
        fail(`${zipPath}: cannot be read (${err.message})`);
    }
}

if (view !== null) {
    validatePackage(view, sourceLabel);
}

if (violations.length > 0) {
    console.error(`package validation: ${violations.length} violation(s)`);
    for (const violation of violations) {
        console.error(`FAIL: ${violation}`);
    }
    for (const warning of warnings) {
        console.error(`WARN: ${warning}`);
    }
    process.exit(1);
}

for (const warning of warnings) {
    console.error(`WARN: ${warning}`);
}
console.log(`package validation: OK (${sourceLabel})`);
