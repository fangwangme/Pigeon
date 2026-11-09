#!/usr/bin/env node
"use strict";

// Resolves the prebuilt binary for this machine and runs it.
//
// The launcher package depends on one binary package per platform through
// `optionalDependencies`, and package managers install only the one whose
// `os`/`cpu` match.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const platformPackage = `@fangwangme/pigeon-${process.platform}-${process.arch}`;
const executable = "pigeon";

const SUPPORTED_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
]);

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

let binary;
try {
  binary = require.resolve(`${platformPackage}/bin/${executable}`);
} catch {
  const currentPlatformKey = `${process.platform}-${process.arch}`;
  if (SUPPORTED_PLATFORMS.has(currentPlatformKey)) {
    console.error(
      `pigeon: binary package ${platformPackage} was not installed.\n` +
        `This usually happens when the package manager skips optional dependencies or encounters registry delays.\n` +
        `To reinstall:\n` +
        `  bun add -g --force @fangwangme/pigeon\n` +
        `  # or: npm install -g --force @fangwangme/pigeon\n`,
    );
  } else {
    console.error(
      `pigeon: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
        `Pigeon currently supports macOS and Linux on arm64 and x64 architectures.\n`,
    );
  }
  process.exit(1);
}

// Check version consistency between launcher shell and platform binary package.
try {
  const launcherPkg = readJsonSafe(path.join(__dirname, "..", "package.json"));
  let platformPkg = readJsonSafe(path.join(path.dirname(binary), "..", "package.json"));
  if (!platformPkg) {
    try {
      platformPkg = readJsonSafe(require.resolve(`${platformPackage}/package.json`));
    } catch {
      // ignore
    }
  }

  if (
    launcherPkg &&
    platformPkg &&
    launcherPkg.version &&
    platformPkg.version &&
    launcherPkg.version !== platformPkg.version
  ) {
    console.warn(
      `pigeon: warning: version mismatch detected.\n` +
        `  launcher shell: v${launcherPkg.version}\n` +
        `  binary package: v${platformPkg.version} (${platformPackage})\n` +
        `This can occur if optional dependencies were cached or skipped during update.\n` +
        `To update the binary package, run:\n` +
        `  bun add -g --force @fangwangme/pigeon@${launcherPkg.version}\n` +
        `  # or: npm install -g --force @fangwangme/pigeon@${launcherPkg.version}\n`,
    );
  }
} catch {
  // Best-effort check; do not block execution if package inspection fails.
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`pigeon: failed to launch ${binary}: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 0);
}
