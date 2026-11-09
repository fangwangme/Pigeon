import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");

describe("packaging behavior end-to-end (distribution.md §3, §5, issue #9 review)", () => {
  test("build-packages.mjs assembles platform manifests, launcher dependencies, and publish order", () => {
    const tmpDir = join("/tmp", `pigeon-test-pkg-${Date.now()}`);
    const artifactsDir = join(tmpDir, "artifacts");
    const outDir = join(tmpDir, "out");
    mkdirSync(artifactsDir, { recursive: true });

    const targets = [
      { key: "darwin-arm64", os: "darwin", cpu: "arm64" },
      { key: "darwin-x64", os: "darwin", cpu: "x64" },
      { key: "linux-arm64", os: "linux", cpu: "arm64" },
      { key: "linux-x64", os: "linux", cpu: "x64" },
    ];

    try {
      // Setup mock artifacts
      for (const target of targets) {
        const targetDir = join(artifactsDir, `pigeon-${target.key}`);
        mkdirSync(targetDir, { recursive: true });
        const binPath = join(targetDir, "pigeon");
        writeFileSync(binPath, "#!/bin/sh\necho 'pigeon mock binary'\n");
        chmodSync(binPath, 0o755);
      }

      const rootPkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
      const version = rootPkg.version;

      const run = spawnSync(
        "node",
        [
          join(rootDir, "npm", "scripts", "build-packages.mjs"),
          "--version",
          version,
          "--artifacts",
          artifactsDir,
          "--out",
          outDir,
        ],
        { encoding: "utf8" }
      );

      expect(run.status).toBe(0);

      // Verify launcher package
      const launcherPkg = JSON.parse(
        readFileSync(join(outDir, "launcher", "package.json"), "utf8")
      );
      expect(launcherPkg.name).toBe("@fangwangme/pigeon");
      expect(launcherPkg.version).toBe(version);
      for (const target of targets) {
        expect(
          launcherPkg.optionalDependencies[`@fangwangme/pigeon-${target.os}-${target.cpu}`]
        ).toBe(version);
      }

      // Verify each platform package
      for (const target of targets) {
        const platformDir = join(outDir, `@fangwangme__pigeon-${target.os}-${target.cpu}`);
        expect(existsSync(platformDir)).toBe(true);
        expect(existsSync(join(platformDir, "bin", "pigeon"))).toBe(true);

        const platformPkg = JSON.parse(
          readFileSync(join(platformDir, "package.json"), "utf8")
        );
        expect(platformPkg.name).toBe(`@fangwangme/pigeon-${target.os}-${target.cpu}`);
        expect(platformPkg.version).toBe(version);
        expect(platformPkg.os).toEqual([target.os]);
        expect(platformPkg.cpu).toEqual([target.cpu]);
        expect(platformPkg.preferUnplugged).toBe(true);
      }

      // Verify publishOrder in packages.json
      const manifest = JSON.parse(readFileSync(join(outDir, "packages.json"), "utf8"));
      expect(manifest.version).toBe(version);
      expect(manifest.publishOrder.length).toBe(targets.length + 1);
      expect(manifest.publishOrder[manifest.publishOrder.length - 1]).toBe(
        join(outDir, "launcher")
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("build-packages.mjs halts with exit code 1 when tag version mismatches root package.json", () => {
    const tmpDir = join("/tmp", `pigeon-test-mismatch-${Date.now()}`);
    try {
      mkdirSync(tmpDir, { recursive: true });
      const run = spawnSync(
        "node",
        [
          join(rootDir, "npm", "scripts", "build-packages.mjs"),
          "--version",
          "9.9.9",
          "--artifacts",
          tmpDir,
          "--out",
          join(tmpDir, "out"),
        ],
        { encoding: "utf8" }
      );

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Version mismatch");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pigeon.js exits with code 1 and prints installation guidance when platform package is missing", () => {
    const tmpDir = join("/tmp", `pigeon-test-launcher-${Date.now()}`);
    try {
      mkdirSync(tmpDir, { recursive: true });
      const run = spawnSync("node", [join(rootDir, "npm", "launcher", "bin", "pigeon.js")], {
        cwd: tmpDir,
        encoding: "utf8",
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("pigeon: binary package @fangwangme/pigeon-");
      expect(run.stderr).toContain("bun add -g --force @fangwangme/pigeon");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
