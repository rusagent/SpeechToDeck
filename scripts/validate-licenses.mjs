#!/usr/bin/env node
// Third-party license validation (CI gate "third-party license validation", spec §97).
//
// Checks that every runtime dependency declared in package.json is covered by
// THIRD_PARTY_NOTICES.md. Dev-only tooling does not ship in the plugin package
// (spec §112) and is therefore not checked here; bundled native artifacts are
// covered through the license field in defaults/runtime-manifest.json, which
// scripts/validate-manifests.mjs requires to be non-empty.
//
// Uses Node only — no third-party dependencies.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const noticesPath = path.join(repoRoot, "THIRD_PARTY_NOTICES.md");
if (!existsSync(noticesPath)) {
  errors.push("THIRD_PARTY_NOTICES.md is missing");
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});

if (existsSync(noticesPath)) {
  const notices = readFileSync(noticesPath, "utf8");
  for (const dep of runtimeDeps) {
    if (!notices.includes(dep)) {
      errors.push(`runtime dependency ${JSON.stringify(dep)} is not covered by THIRD_PARTY_NOTICES.md`);
    }
  }
}

const licensePath = path.join(repoRoot, "LICENSE");
if (!existsSync(licensePath)) {
  errors.push("LICENSE is missing (required in the plugin package, spec §112)");
}

if (errors.length > 0) {
  console.error(`third-party license validation: ${errors.length} violation(s)`);
  for (const error of errors) {
    console.error(`FAIL: ${error}`);
  }
  process.exit(1);
}

console.log(
  `third-party license validation: OK (${runtimeDeps.length} runtime dependency(ies) covered)`,
);
