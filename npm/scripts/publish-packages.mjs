#!/usr/bin/env node
// Publishes the packages assembled by build-packages.mjs, in dependency order
// (distribution.md §4.2).
//
// Publishes the platform binary packages first, then polls the npm registry until
// all of them resolve before publishing the launcher package, so users who install
// the new release right away never hit a 404 on an optional binary dependency.
//
// Re-runnable on purpose: npm rejects a re-publish of an existing version, so
// anything already on the registry at this version is skipped and a rerun
// finishes a release that failed halfway.

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LAUNCHER_NAME = "@fangwangme/pigeon";
const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 20 * 60 * 1000;

function fail(message) {
  console.error(`publish-packages: ${message}`);
  process.exit(1);
}

/** `npm view` exits non-zero (E404) until this exact version is on the registry. */
async function checkPackageReady(name, version) {
  try {
    const { stdout } = await execFileAsync("npm", ["view", `${name}@${version}`, "version"]);
    return stdout.trim() === version;
  } catch {
    return false;
  }
}

async function waitForPackagesReady(packages) {
  let pending = packages;
  const startTime = Date.now();
  console.log(`\nWaiting for ${pending.length} platform package(s) to resolve on npm...`);

  while (true) {
    const ready = await Promise.all(pending.map((p) => checkPackageReady(p.name, p.version)));
    pending = pending.filter((_, i) => !ready[i]);
    if (pending.length === 0) {
      console.log("All platform packages resolve on npm.\n");
      return;
    }

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const remaining = pending.map((p) => `${p.name}@${p.version}`).join(", ");
    if (Date.now() - startTime >= TIMEOUT_MS) {
      fail(`timed out after ${elapsedSec}s waiting for ${remaining}. Rerun this workflow once npm has processed them.`);
    }
    console.log(`[${elapsedSec}s] still waiting for ${remaining}`);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function publish({ dir, pkg }) {
  if (await checkPackageReady(pkg.name, pkg.version)) {
    console.log(`skip    ${pkg.name}@${pkg.version} (already published)`);
    return;
  }
  console.log(`publish ${pkg.name}@${pkg.version}`);
  try {
    execFileSync("npm", ["publish", "--access", "public"], { cwd: dir, stdio: "inherit" });
  } catch {
    fail(
      `npm publish failed for ${pkg.name}@${pkg.version}. ` +
        `Packages published before it stay published; rerun to finish the rest.`,
    );
  }
}

const outDir = process.argv[2];
if (!outDir) fail("usage: publish-packages.mjs <dist-dir>");

const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "packages.json"), "utf8"));
const entries = manifest.publishOrder.map((dir) => ({
  dir,
  pkg: JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")),
}));
const platforms = entries.filter((e) => e.pkg.name !== LAUNCHER_NAME);
const launcher = entries.find((e) => e.pkg.name === LAUNCHER_NAME);

for (const entry of platforms) await publish(entry);
await waitForPackagesReady(platforms.map((e) => e.pkg));
await publish(launcher);
