#!/usr/bin/env node
// Artifact manifest validation (CI gate "artifact manifest validation", spec §97).
//
// Validates defaults/models.json against the model manifest schema (spec §50)
// and defaults/runtime-manifest.json against the runtime artifact integrity
// schema (spec §53). The script uses Node only — no third-party dependencies.
//
// Fail-closed policy: every violation, including an empty sha256 field, is a
// hard failure with a nonzero exit code. A manifest entry without a real,
// verified digest can never pass this gate. Digests are never guessed or
// computed from anything other than the actual downloaded artifact.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const SHA256_RE = /^[0-9a-f]{64}$/;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
// Curated v1 model set (spec §48).
const REQUIRED_MODEL_IDS = ["tiny", "base", "small"];
const ALLOWED_ENGINES = new Set(["whisper"]);

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
    fail(`${relativePath}: schemaVersion must be 1, got ${JSON.stringify(manifest.schemaVersion)}`);
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
  models.forEach((model, index) => {
    const label = `${relativePath}: models[${index}]`;
    if (!isPlainObject(model)) {
      fail(`${label}: must be an object`);
      return;
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
      fail(`${label}.multilingual: must be a boolean, got ${JSON.stringify(model.multilingual)}`);
    }

    if (typeof model.filename !== "string" || model.filename.length === 0) {
      fail(`${label}.filename: must be a non-empty string`);
    } else if (/[\\/]/.test(model.filename) || model.filename.includes("..")) {
      // Model files live in the plugin data directory only (spec §109: reject path traversal).
      fail(`${label}.filename: must be a plain file name, got ${JSON.stringify(model.filename)}`);
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

    if (model.sizeBytes !== undefined) {
      if (!Number.isInteger(model.sizeBytes) || model.sizeBytes <= 0) {
        fail(`${label}.sizeBytes: must be a positive integer when present`);
      }
    }
  });

  for (const requiredId of REQUIRED_MODEL_IDS) {
    if (!seenIds.has(requiredId)) {
      fail(`${relativePath}: curated v1 model set (spec §48) is missing ${JSON.stringify(requiredId)}`);
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

  artifacts.forEach((artifact, index) => {
    const label = `${relativePath}: artifacts[${index}]`;
    if (!isPlainObject(artifact)) {
      fail(`${label}: must be an object`);
      return;
    }

    for (const field of ["id", "engine", "arch", "version", "source", "license"]) {
      if (typeof artifact[field] !== "string" || artifact[field].length === 0) {
        fail(`${label}.${field}: must be a non-empty string (spec §53)`);
      }
    }

    if (typeof artifact.source === "string" && artifact.source.length > 0) {
      checkHttpsUrl(artifact.source, `${label}.source`);
    }

    if (typeof artifact.sha256 !== "string") {
      fail(`${label}.sha256: must be a string, got ${JSON.stringify(artifact.sha256)}`);
    } else if (artifact.sha256.length === 0) {
      fail(
        `${label}.sha256 is empty: FAILING GATE — the native runtime artifact is not pinned ` +
          "yet (spec §53). Acquire the exact artifact per bin/README.md, compute its SHA-256, " +
          "and fill in version, source, sha256 and license. Never invent or guess a digest.",
      );
    } else if (!SHA256_RE.test(artifact.sha256)) {
      fail(`${label}.sha256: must be 64 lowercase hex characters`);
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

console.log("artifact manifest validation: OK (models.json and runtime-manifest.json valid)");
