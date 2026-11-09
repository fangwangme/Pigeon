#!/usr/bin/env node
// Assembles the npm packages for a release from the binaries built by CI.
//
// Layout produced under --out:
//   <out>/@fangwangme__pigeon-<platform>-<arch>/   one per target, holds the binary
//   <out>/launcher/                                what users actually install
//   <out>/packages.json                            publish order, launcher last
//
// Publish the platform packages first: the launcher pins them as
// optionalDependencies, and npm resolves those at install time.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_SRC = path.join(HERE, "..", "launcher");
const REPO_ROOT = path.join(HERE, "..", "..");

/** Supported targets (distribution.md §2). Keep in sync with release.yml. */
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map(
  (key) => {
    const [os, cpu] = key.split("-");
    return { key, os, cpu };
  },
);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) {
      throw new Error(`Expected --key value pairs, got: ${argv.join(" ")}`);
    }
    args[key] = argv[i + 1];
  }
  for (const required of ["version", "artifacts", "out"]) {
    if (!args[required]) {
      throw new Error(`Missing --${required}`);
    }
  }
  return args;
}

/** The root package.json version is the source of truth; a mismatch means a mistagged release. */
function assertVersionMatchesPackage(version) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  if (manifest.version !== version) {
    throw new Error(
      `Version mismatch: tag says ${version}, package.json says ${manifest.version}. ` +
        `Bump the package version or retag.`,
    );
  }
}

/**
 * release.yml uploads one artifact directory per target, holding
 * `pigeon-<target>.tar.gz` with a single `pigeon` executable (distribution.md §2).
 */
function extractBinary(artifactsDir, target) {
  const dir = path.join(artifactsDir, `pigeon-${target.key}`);
  execFileSync("tar", ["-xzf", path.join(dir, `pigeon-${target.key}.tar.gz`), "-C", dir]);
  return path.join(dir, "pigeon");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function buildPlatformPackage({ target, version, artifactsDir, outDir }) {
  const name = `@fangwangme/pigeon-${target.key}`;
  const dir = path.join(outDir, name.replace("/", "__"));

  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  const dest = path.join(dir, "bin", "pigeon");
  fs.copyFileSync(extractBinary(artifactsDir, target), dest);
  fs.chmodSync(dest, 0o755);

  writeJson(path.join(dir, "package.json"), {
    name,
    version,
    description: `Pigeon binary for ${target.os} ${target.cpu}`,
    os: [target.os],
    cpu: [target.cpu],
    files: ["bin"],
    preferUnplugged: true,
    repository: {
      type: "git",
      url: "git+https://github.com/fangwangme/Pigeon.git",
    },
    license: "MIT",
  });

  return { name, dir };
}

function buildLauncher({ version, outDir, platformNames }) {
  const dir = path.join(outDir, "launcher");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });

  fs.copyFileSync(
    path.join(LAUNCHER_SRC, "bin", "pigeon.js"),
    path.join(dir, "bin", "pigeon.js"),
  );
  fs.chmodSync(path.join(dir, "bin", "pigeon.js"), 0o755);

  // The repo README is the package page on npmjs.com.
  fs.copyFileSync(path.join(REPO_ROOT, "README.md"), path.join(dir, "README.md"));

  const manifest = JSON.parse(
    fs.readFileSync(path.join(LAUNCHER_SRC, "package.json"), "utf8"),
  );
  manifest.version = version;
  manifest.optionalDependencies = Object.fromEntries(
    platformNames.map((name) => [name, version]),
  );

  writeJson(path.join(dir, "package.json"), manifest);
  return { name: manifest.name, dir };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertVersionMatchesPackage(args.version);

  const outDir = path.resolve(args.out);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const platforms = TARGETS.map((target) =>
    buildPlatformPackage({
      target,
      version: args.version,
      artifactsDir: path.resolve(args.artifacts),
      outDir,
    }),
  );

  const launcher = buildLauncher({
    version: args.version,
    outDir,
    platformNames: platforms.map((p) => p.name),
  });

  writeJson(path.join(outDir, "packages.json"), {
    version: args.version,
    publishOrder: [...platforms.map((p) => p.dir), launcher.dir],
  });

  for (const { name, dir } of [...platforms, launcher]) {
    console.log(`${name} -> ${dir}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`build-packages: ${error.message}`);
  process.exit(1);
}
