#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const DOS_TIME = 0;
const DOS_DATE = 0x21;

const REQUIRED_ROOT_FILES = ["main.py", "plugin.json", "package.json", "LICENSE", "README.md"];
const OPTIONAL_ROOT_FILES = ["THIRD_PARTY_NOTICES.md", "defaults.txt"];
const REQUIRED_DEFAULTS_FILES = ["models.json", "runtime-manifest.json"];

function fail(message) {
    console.error(`package build: FAIL: ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const args = { src: undefined, out: undefined, dev: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--src") args.src = argv[++i];
        else if (argv[i] === "--out") args.out = argv[++i];
        else if (argv[i] === "--dev") args.dev = true;
        else fail(`unknown argument ${JSON.stringify(argv[i])}`);
    }
    if (args.src === undefined || args.out === undefined) {
        console.error("usage: node scripts/build-package.mjs --src <dir> --out <dir> [--dev]");
        process.exit(2);
    }
    return args;
}

const EXCLUDED_SEGMENTS = new Set([
    "src",
    "tests",
    "node_modules",
    "__pycache__",
    ".tmp",
    ".venv",
    ".worktrees",
]);

function listFilesRecursive(root, relative = "") {
    const files = [];
    for (const entry of readdirSync(path.join(root, relative))) {
        if (EXCLUDED_SEGMENTS.has(entry) || /\.log$/i.test(entry)) continue;
        const relPosix = relative === "" ? entry : `${relative}/${entry}`;
        if (statSync(path.join(root, relPosix)).isDirectory()) {
            files.push(...listFilesRecursive(root, relPosix));
        } else {
            files.push(relPosix);
        }
    }
    return files.sort();
}

function selectEntries(src, pluginName) {
    const entries = [];
    const addFile = (relPosix, zipPath, executable = false) => {
        const absPath = path.join(src, relPosix);
        if (!statSync(absPath).isFile()) {
            fail(`${relPosix} is not a regular file`);
        }
        entries.push({ zipPath: `${pluginName}/${zipPath}`, absPath, executable });
    };
    const mustExist = (relPosix) => {
        if (!existsSync(path.join(src, relPosix))) {
            fail(`required source is missing: ${relPosix}`);
        }
    };

    mustExist("dist/index.js");
    mustExist("backend/__init__.py");
    for (const relPosix of listFilesRecursive(src, "dist")) {
        addFile(relPosix, relPosix);
    }
    for (const relPosix of listFilesRecursive(src, "backend")) {
        addFile(relPosix, relPosix);
    }
    if (existsSync(path.join(src, "bin"))) {
        for (const relPosix of listFilesRecursive(src, "bin")) {
            addFile(relPosix, relPosix, true);
        }
    } else {
        console.error("package build: WARN: no bin/ directory (optional; runtime artifact)");
    }

    for (const file of REQUIRED_ROOT_FILES) {
        mustExist(file);
        addFile(file, file);
    }
    for (const file of OPTIONAL_ROOT_FILES) {
        if (existsSync(path.join(src, file))) addFile(file, file);
    }

    for (const file of REQUIRED_DEFAULTS_FILES) {
        if (existsSync(path.join(src, "defaults", file))) {
            addFile(path.join("defaults", file), file);
        } else if (existsSync(path.join(src, file))) {
            addFile(file, file);
        } else {
            fail(`required defaults file is missing: ${file}`);
        }
    }
    return entries;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosAttributes(executable, isDir) {
    const posix = isDir ? 0o40755 : executable ? 0o100755 : 0o100644;
    return ((posix << 16) | (isDir ? 0x10 : 0)) >>> 0;
}

function buildZip(pluginName, entries) {
    const chunks = [];
    const central = [];
    let offset = 0;

    const pushRecord = (header, nameBytes, body) => {
        chunks.push(header, nameBytes, body);
        offset += header.length + nameBytes.length + body.length;
    };

    const dirEntries = [...new Set(entries.map((entry) => path.dirname(entry.zipPath)))].filter(
        (dir) => dir !== ".",
    );
    const allEntries = [
        ...dirEntries.map((dir) => ({ zipPath: `${dir}/`, absPath: null, executable: false })),
        ...entries,
    ];

    for (const entry of allEntries) {
        const isDir = entry.absPath === null;
        const nameBytes = Buffer.from(entry.zipPath, "utf8");
        const body = isDir ? Buffer.alloc(0) : readFileSync(entry.absPath);
        const crc = crc32(body);
        const localHeaderOffset = offset;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        pushRecord(local, nameBytes, body);

        const centralEntry = Buffer.alloc(46);
        centralEntry.writeUInt32LE(0x02014b50, 0);
        centralEntry.writeUInt16LE(0x031e, 4);
        centralEntry.writeUInt16LE(20, 6);
        centralEntry.writeUInt16LE(0, 8);
        centralEntry.writeUInt16LE(0, 10);
        centralEntry.writeUInt16LE(DOS_TIME, 12);
        centralEntry.writeUInt16LE(DOS_DATE, 14);
        centralEntry.writeUInt32LE(crc, 16);
        centralEntry.writeUInt32LE(body.length, 20);
        centralEntry.writeUInt32LE(body.length, 24);
        centralEntry.writeUInt16LE(nameBytes.length, 28);
        centralEntry.writeUInt16LE(0, 30);
        centralEntry.writeUInt16LE(0, 32);
        centralEntry.writeUInt16LE(0, 34);
        centralEntry.writeUInt16LE(0, 36);
        centralEntry.writeUInt32LE(dosAttributes(entry.executable, isDir), 38);
        centralEntry.writeUInt32LE(localHeaderOffset, 42);
        central.push(centralEntry, nameBytes);
    }

    const centralDirectory = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(allEntries.length, 8);
    eocd.writeUInt16LE(allEntries.length, 10);
    eocd.writeUInt32LE(centralDirectory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...chunks, centralDirectory, eocd]);
}

const args = parseArgs(process.argv.slice(2));
if (!statSync(args.src).isDirectory()) fail(`--src ${args.src} is not a directory`);
mkdirSync(args.out, { recursive: true });

const plugin = JSON.parse(readFileSync(path.join(args.src, "plugin.json"), "utf8"));
if (typeof plugin.name !== "string" || plugin.name.length === 0) {
    fail('plugin.json "name" must be a non-empty string');
}
const pluginName = plugin.name;

const entries = selectEntries(args.src, pluginName);
const checksums = [];
for (const suffix of args.dev ? ["", "-dev"] : [""]) {
    const zipName = `${pluginName}${suffix}.zip`;
    const zipBuffer = buildZip(pluginName, entries);
    const zipPath = path.join(args.out, zipName);
    writeFileSync(zipPath, zipBuffer);
    const digest = createHash("sha256").update(zipBuffer).digest("hex");
    checksums.push(`${digest}  ${zipName}`);
    console.log(`package build: wrote ${zipPath} (${zipBuffer.length} bytes, sha256 ${digest})`);
}
writeFileSync(path.join(args.out, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
console.log(`package build: OK (${entries.length} files, plugin ${JSON.stringify(pluginName)})`);
