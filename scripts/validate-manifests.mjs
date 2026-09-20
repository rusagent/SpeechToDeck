#!/usr/bin/env node
// Artifact manifest validation (CI gate "artifact manifest validation").
//
// Validates defaults/models.json against the model manifest schema
// and defaults/runtime-manifest.json against the runtime artifact integrity
// schema. The script uses Node only — no third-party dependencies.
//
// Gate policy (done means the CI gate list is green):
// - models.json violations are always hard failures with a nonzero exit
//   code. A model entry without a real, verified digest can never pass this
//   gate; digests are never guessed or computed from anything other than the
//   actual downloaded artifact.
// - The runtime manifest pins both Voxtype v1.0.1 x86_64 Linux artifacts
//   (avx2 + vulkan; see bin/README.md). The gate still reports a loud
//   RUNTIME_UNPINNED diagnostic if an artifact ever loses its digest: product
//   code fails closed against an unpinned manifest (backend startup:
//   RUNTIME_START_FAILED), so the DEFAULT run exits 0 with the diagnostic.
//   `--strict` (release packaging) fails on any unpinned runtime. Everything
//   else about the runtime manifest (malformed JSON, wrong schemaVersion,
//   invalid https source, bad sha256 format, duplicate ids/variants) is a
//   hard failure in both modes.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const strict = process.argv.includes("--strict");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const unpinned = [];

const SHA256_RE = /^[0-9a-f]{64}$/;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
// Additive curated-catalog rules (ADR-011), mirrored exactly by
// backend/infrastructure/model/model_manifest.py.
const LANGUAGE_CODE_RE = /^[a-z]{2,8}(-[a-z0-9]{1,8})*$/;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_MODEL_SIZE_BYTES = 2147483648;
// Curated v1 model set.
const REQUIRED_MODEL_IDS = ["tiny", "base", "small"];
const ALLOWED_ENGINES = new Set(["whisper"]);
const ALLOWED_MODEL_FIELDS = new Set([
    "id",
    "engine",
    "multilingual",
    "filename",
    "downloadUrl",
    "sha256",
    "sizeBytes",
    "languages",
    "description",
]);

function fail(message) {
    errors.push(message);
}

function loadJson(relativePath) {
    const fullPath = path.join(repoRoot, relativePath);
    let raw;
    try {
        raw = readFileSync(fullPath, "utf8");
    } catch (err) {
        fail(`${relativePath}: cannot be read (${err.message})`);
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        fail(`${relativePath}: invalid JSON (${err.message})`);
        return null;
    }
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSchemaVersion(manifest, relativePath) {
    if (manifest.schemaVersion !== 1) {
        fail(
            `${relativePath}: schemaVersion must be 1, got ${JSON.stringify(manifest.schemaVersion)}`,
        );
    }
}

function checkHttpsUrl(value, label) {
    if (/\s/.test(value)) {
        fail(`${label}: contains whitespace`);
        return;
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        fail(`${label}: not a valid URL (${JSON.stringify(value)})`);
        return;
    }
    if (parsed.protocol !== "https:") {
        fail(`${label}: must use https, got ${JSON.stringify(parsed.protocol)}`);
    }
}

function validateModels() {
    const relativePath = path.join("defaults", "models.json");
    const manifest = loadJson(relativePath);
    if (manifest === null) return;
    if (!isPlainObject(manifest)) {
        fail(`${relativePath}: top level must be an object`);
        return;
    }
    requireSchemaVersion(manifest, relativePath);

    const { models } = manifest;
    if (!Array.isArray(models) || models.length === 0) {
        fail(`${relativePath}: "models" must be a non-empty array`);
        return;
    }

    const seenIds = new Set();
    const seenFilenames = new Set();
    models.forEach((model, index) => {
        const label = `${relativePath}: models[${index}]`;
        if (!isPlainObject(model)) {
            fail(`${label}: must be an object`);
            return;
        }

        const unknown = Object.keys(model).filter((field) => !ALLOWED_MODEL_FIELDS.has(field));
        if (unknown.length > 0) {
            fail(`${label}: unknown fields ${JSON.stringify(unknown.sort())}`);
        }

        if (typeof model.id !== "string" || !MODEL_ID_RE.test(model.id)) {
            fail(`${label}.id: must match ${MODEL_ID_RE}, got ${JSON.stringify(model.id)}`);
        } else {
            if (seenIds.has(model.id)) {
                fail(`${label}.id: duplicate model id ${JSON.stringify(model.id)}`);
            }
            seenIds.add(model.id);
        }

        if (!ALLOWED_ENGINES.has(model.engine)) {
            fail(
                `${label}.engine: must be one of ${[...ALLOWED_ENGINES].join(", ")}, ` +
                    `got ${JSON.stringify(model.engine)}`,
            );
        }

        if (typeof model.multilingual !== "boolean") {
            fail(
                `${label}.multilingual: must be a boolean, got ${JSON.stringify(model.multilingual)}`,
            );
        }

        if (typeof model.filename !== "string" || model.filename.length === 0) {
            fail(`${label}.filename: must be a non-empty string`);
        } else if (/[\\/]/.test(model.filename) || model.filename.includes("..")) {
            // Model files live in the plugin data directory only (reject path traversal).
            fail(
                `${label}.filename: must be a plain file name, got ${JSON.stringify(model.filename)}`,
            );
        } else if (seenFilenames.has(model.filename)) {
            // ADR-011: the filename is the local store name; two models sharing
            // it would overwrite each other's artifact.
            fail(`${label}.filename: duplicate filename ${JSON.stringify(model.filename)}`);
        } else {
            seenFilenames.add(model.filename);
        }

        if (typeof model.downloadUrl !== "string" || model.downloadUrl.length === 0) {
            fail(`${label}.downloadUrl: must be a non-empty string`);
        } else {
            checkHttpsUrl(model.downloadUrl, `${label}.downloadUrl`);
        }

        if (typeof model.sha256 !== "string") {
            fail(`${label}.sha256: must be a string, got ${JSON.stringify(model.sha256)}`);
        } else if (model.sha256.length === 0) {
            fail(
                `${label}.sha256 is empty: FAILING GATE — model artifacts must ship with a real ` +
                    "SHA-256 digest (spec §50). Never invent or guess a digest; compute it from the " +
                    "downloaded artifact.",
            );
        } else if (!SHA256_RE.test(model.sha256)) {
            fail(`${label}.sha256: must be 64 lowercase hex characters`);
        }

        if (model.sizeBytes === undefined) {
            // ADR-011: required so the picker can show a human-readable size
            // before download without network probes.
            fail(`${label}.sizeBytes: is required`);
        } else if (!Number.isInteger(model.sizeBytes) || model.sizeBytes <= 0) {
            fail(`${label}.sizeBytes: must be a positive integer`);
        } else if (model.sizeBytes > MAX_MODEL_SIZE_BYTES) {
            fail(`${label}.sizeBytes: exceeds the ${MAX_MODEL_SIZE_BYTES} byte cap`);
        }

        if (model.languages !== undefined) {
            const languages = model.languages;
            if (
                !Array.isArray(languages) ||
                languages.length === 0 ||
                !languages.every((code) => typeof code === "string" && LANGUAGE_CODE_RE.test(code))
            ) {
                fail(
                    `${label}.languages: must be a non-empty array of lowercase language codes, ` +
                        `got ${JSON.stringify(languages)}`,
                );
            }
        }

        if (model.description !== undefined) {
            if (typeof model.description !== "string" || model.description.length === 0) {
                fail(`${label}.description: must be a non-empty string when present`);
            } else if (model.description.length > MAX_DESCRIPTION_CHARS) {
                fail(`${label}.description: exceeds ${MAX_DESCRIPTION_CHARS} characters`);
            }
        }
    });

    for (const requiredId of REQUIRED_MODEL_IDS) {
        if (!seenIds.has(requiredId)) {
            fail(
                `${relativePath}: curated v1 model set (spec §48) is missing ${JSON.stringify(requiredId)}`,
            );
        }
    }
}

function validateRuntimeManifest() {
    const relativePath = path.join("defaults", "runtime-manifest.json");
    const manifest = loadJson(relativePath);
    if (manifest === null) return;
    if (!isPlainObject(manifest)) {
        fail(`${relativePath}: top level must be an object`);
        return;
    }
    requireSchemaVersion(manifest, relativePath);

    const { artifacts } = manifest;
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
        fail(`${relativePath}: "artifacts" must be a non-empty array`);
        return;
    }

    // One artifact per compute variant, selected by the supervisor from the
    // settings computeBackend (cpu → avx2 build, vulkan → vulkan build, auto →
    // explicit probe policy). Each variant must appear at most once.
    const VARIANT_VALUES = new Set(["cpu", "vulkan"]);
    const seenIds = new Set();
    const seenVariants = new Set();

    artifacts.forEach((artifact, index) => {
        const label = `${relativePath}: artifacts[${index}]`;
        if (!isPlainObject(artifact)) {
            fail(`${label}: must be an object`);
            return;
        }

        // A runtime artifact is "unpinned" while its sha256 is still empty
        // (acquisition procedure in bin/README.md).
        const pinned =
            typeof artifact.sha256 === "string" &&
            artifact.sha256.length > 0 &&
            SHA256_RE.test(artifact.sha256);

        if (typeof artifact.sha256 !== "string") {
            fail(`${label}.sha256: must be a string, got ${JSON.stringify(artifact.sha256)}`);
        } else if (!pinned && artifact.sha256.length > 0) {
            fail(`${label}.sha256: must be 64 lowercase hex characters`);
        }

        for (const field of ["id", "engine", "arch"]) {
            if (typeof artifact[field] !== "string" || artifact[field].length === 0) {
                fail(`${label}.${field}: must be a non-empty string (spec §53)`);
            }
        }

        if (typeof artifact.id === "string" && artifact.id.length > 0) {
            if (seenIds.has(artifact.id)) {
                fail(`${label}.id: duplicate artifact id ${JSON.stringify(artifact.id)}`);
            }
            seenIds.add(artifact.id);
        }

        if (typeof artifact.variant !== "string" || artifact.variant.length === 0) {
            fail(`${label}.variant: must be a non-empty string (one of cpu, vulkan)`);
        } else if (!VARIANT_VALUES.has(artifact.variant)) {
            fail(
                `${label}.variant: must be one of ${[...VARIANT_VALUES].join(", ")}, ` +
                    `got ${JSON.stringify(artifact.variant)}`,
            );
        } else {
            if (seenVariants.has(artifact.variant)) {
                fail(`${label}.variant: duplicate variant ${JSON.stringify(artifact.variant)}`);
            }
            seenVariants.add(artifact.variant);
        }

        if (pinned) {
            // Once pinned, every provenance field must be filled.
            for (const field of ["version", "source", "license"]) {
                if (typeof artifact[field] !== "string" || artifact[field].length === 0) {
                    fail(
                        `${label}.${field}: must be a non-empty string for a pinned artifact (spec §53)`,
                    );
                }
            }
        }

        if (typeof artifact.source === "string" && artifact.source.length > 0) {
            checkHttpsUrl(artifact.source, `${label}.source`);
        }

        if (!pinned) {
            unpinned.push(`${artifact.id ?? `artifacts[${index}]`}`);
        }
    });
}

validateModels();
validateRuntimeManifest();

if (errors.length > 0) {
    console.error(`artifact manifest validation: ${errors.length} violation(s)`);
    for (const error of errors) {
        console.error(`FAIL: ${error}`);
    }
    process.exit(1);
}

if (unpinned.length > 0) {
    const list = unpinned.join(", ");
    if (strict) {
        console.error(
            `RUNTIME_UNPINNED (--strict): ${list} — the native runtime artifact in ` +
                "defaults/runtime-manifest.json is not pinned. Release packaging requires " +
                "version, source, sha256 and license per bin/README.md (spec §53). " +
                "Never invent or guess a digest; compute it from the acquired artifact.",
        );
        process.exit(1);
    }
    console.error(
        "RUNTIME_UNPINNED: the native runtime artifact in defaults/runtime-manifest.json " +
            `is not pinned yet (artifacts: ${list}). ` +
            "This is the documented pre-pin state: product code fails closed against it " +
            "(backend startup: RUNTIME_START_FAILED, spec §53) and CI stays green (spec §129). " +
            "Before release packaging, pin version, source, sha256 and license per " +
            "bin/README.md — never invent or guess a digest.",
    );
    console.log(
        "artifact manifest validation: OK (models.json valid; runtime artifact unpinned — see RUNTIME_UNPINNED above)",
    );
    process.exit(0);
}

console.log("artifact manifest validation: OK (models.json and runtime-manifest.json valid)");
