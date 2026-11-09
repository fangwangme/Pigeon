#!/usr/bin/env node
"use strict";

// Resolves the prebuilt binary for this machine and runs it.
//
// The launcher package depends on one binary package per platform through
// `optionalDependencies`, and package managers install only the one whose
// `os`/`cpu` match.

const { spawn } = require("node:child_process");

const platformKey = `${process.platform}-${process.arch}`;
const platformPackage = `@fangwangme/pigeon-${platformKey}`;

const SUPPORTED_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
]);

let binary;
try {
  binary = require.resolve(`${platformPackage}/bin/pigeon`);
} catch {
  if (SUPPORTED_PLATFORMS.has(platformKey)) {
    console.error(
      `pigeon: binary package ${platformPackage} was not installed.\n` +
        `This usually happens when the package manager skips optional dependencies or encounters registry delays.\n` +
        `To reinstall:\n` +
        `  bun add -g --force @fangwangme/pigeon\n` +
        `  # or: npm install -g --force @fangwangme/pigeon\n`,
    );
  } else {
    console.error(
      `pigeon: no prebuilt binary for ${platformKey}.\n` +
        `Pigeon currently supports macOS and Linux on arm64 and x64 architectures.\n`,
    );
  }
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// Forward termination signals so the daemon shuts down cleanly instead of
// being orphaned when only the launcher is signalled (distribution.md §3.3).
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const forwardSignal = (signal) => child.kill(signal);
for (const signal of FORWARDED_SIGNALS) process.on(signal, forwardSignal);

child.on("error", (error) => {
  console.error(`pigeon: failed to launch ${binary}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  // Drop the handlers first, or re-raising the child's signal below would be
  // forwarded again instead of terminating the launcher.
  for (const s of FORWARDED_SIGNALS) process.removeListener(s, forwardSignal);
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
