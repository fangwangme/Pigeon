import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");

describe("distribution and packaging (distribution.md, issue #9)", () => {
  test("test_ci_workflow_structure: ci.yml exists with bun setup and test triggers", () => {
    const ciPath = join(rootDir, ".github", "workflows", "ci.yml");
    expect(existsSync(ciPath)).toBe(true);
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("oven-sh/setup-bun");
    expect(content).toContain("bun test");
    expect(content).toContain("bun run build");
  });

  test("test_release_workflow_structure: release.yml exists with 4-target matrix and publish steps", () => {
    const releasePath = join(rootDir, ".github", "workflows", "release.yml");
    expect(existsSync(releasePath)).toBe(true);
    const content = readFileSync(releasePath, "utf-8");
    expect(content).toContain("tags:");
    expect(content).toContain("darwin-arm64");
    expect(content).toContain("darwin-x64");
    expect(content).toContain("linux-arm64");
    expect(content).toContain("linux-x64");
    expect(content).toContain("build-packages.mjs");
    expect(content).toContain("publish-packages.mjs");
  });

  test("test_release_npm_trusted_publishing: publish-npm authenticates through OIDC, never an npm token (distribution.md §4.2, §5)", () => {
    const content = readFileSync(join(rootDir, ".github", "workflows", "release.yml"), "utf-8");
    const publishNpmJob = content.slice(content.indexOf("\n  publish-npm:"));
    expect(publishNpmJob).toContain("id-token: write");
    expect(publishNpmJob).toContain('node-version: "24"');
    expect(content).not.toContain("NPM_TOKEN");
    expect(content).not.toContain("NODE_AUTH_TOKEN");
  });

  test("test_launcher_package_json: launcher declares @fangwangme/pigeon and 4 optionalDependencies", () => {
    const launcherPkgPath = join(rootDir, "npm", "launcher", "package.json");
    expect(existsSync(launcherPkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(launcherPkgPath, "utf-8"));
    expect(pkg.name).toBe("@fangwangme/pigeon");
    expect(pkg.bin?.pigeon).toBe("bin/pigeon.js");
    expect(pkg.optionalDependencies).toBeDefined();
    expect(pkg.optionalDependencies["@fangwangme/pigeon-darwin-arm64"]).toBeDefined();
    expect(pkg.optionalDependencies["@fangwangme/pigeon-darwin-x64"]).toBeDefined();
    expect(pkg.optionalDependencies["@fangwangme/pigeon-linux-arm64"]).toBeDefined();
    expect(pkg.optionalDependencies["@fangwangme/pigeon-linux-x64"]).toBeDefined();
  });

  test("test_launcher_binary_resolution: launcher shim resolves platform package or prints actionable instructions", () => {
    const launcherBinPath = join(rootDir, "npm", "launcher", "bin", "pigeon.js");
    expect(existsSync(launcherBinPath)).toBe(true);
    const content = readFileSync(launcherBinPath, "utf-8");
    expect(content).toContain("@fangwangme/pigeon-");
    expect(content).toContain("spawn(");
    expect(content).toContain("bun add -g --force @fangwangme/pigeon");
  });

  test("test_build_and_publish_scripts: build-packages.mjs and publish-packages.mjs exist with target mapping and registry polling", () => {
    const buildScript = join(rootDir, "npm", "scripts", "build-packages.mjs");
    const publishScript = join(rootDir, "npm", "scripts", "publish-packages.mjs");
    expect(existsSync(buildScript)).toBe(true);
    expect(existsSync(publishScript)).toBe(true);

    const buildContent = readFileSync(buildScript, "utf-8");
    expect(buildContent).toContain("darwin-arm64");
    expect(buildContent).toContain("linux-x64");
    expect(buildContent).toContain("optionalDependencies");

    const publishContent = readFileSync(publishScript, "utf-8");
    expect(publishContent).toContain("npm view");
    expect(publishContent).toContain("checkPackageReady");
  });
});
