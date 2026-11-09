# Distribution and Release Specification

## 1. Overview and Distribution Goals

Pigeon is distributed through NPM under the package name `@fangwangme/pigeon`. Users can install or run Pigeon using `bunx @fangwangme/pigeon`, `npx @fangwangme/pigeon`, or global package installation (`bun add -g @fangwangme/pigeon` / `npm install -g @fangwangme/pigeon`) on Linux and macOS without needing Bun, Node, or build tools installed on their host systems.

To achieve zero-dependency execution across supported platforms, Pigeon adopts a two-tier package architecture:
1. **Platform Binary Packages**: Scoped platform packages containing the standalone precompiled binary with `os` and `cpu` manifest declarations.
2. **Launcher Package**: A lightweight wrapper package that declares platform packages as `optionalDependencies`, resolves the matching binary for the active host architecture, and executes it directly.

## 2. Multi-Platform Binary Targets

The Pigeon CLI and daemon compile into standalone binaries using Bun's native compilation and cross-target bundling (`bun build --compile --minify`):

| Target Triple / Target Key | Platform (`os`) | Architecture (`cpu`) | Bun Target | Binary Asset Name |
| :--- | :--- | :--- | :--- | :--- |
| `darwin-arm64` | `darwin` | `arm64` | `bun-darwin-arm64` | `pigeon-darwin-arm64` |
| `darwin-x64` | `darwin` | `x64` | `bun-darwin-x64` | `pigeon-darwin-x64` |
| `linux-arm64` | `linux` | `arm64` | `bun-linux-arm64` | `pigeon-linux-arm64` |
| `linux-x64` | `linux` | `x64` | `bun-linux-x64` | `pigeon-linux-x64` |

Windows is explicitly out of scope for v1 as the Pigeon bridge daemon and admin CLI interface rely on POSIX domain sockets (`$XDG_RUNTIME_DIR/pigeon.sock`) and POSIX signal semantics.

Each compiled target binary is packaged into a compressed archive (`pigeon-<target>.tar.gz`) containing the standalone executable `pigeon`.

## 3. Launcher and Package Assembly Architecture

### 3.1 Platform Packages (`@fangwangme/pigeon-<os>-<arch>`)
For each target, an isolated platform package is published containing:
- `bin/pigeon`: The native standalone binary with executable permissions.
- `package.json`: Specifying `"os": ["<os>"]`, `"cpu": ["<cpu>"]`, `"preferUnplugged": true`, and repository / license metadata.

### 3.2 Launcher Package (`@fangwangme/pigeon`)
The primary package installed by users contains:
- `bin/pigeon.js`: The executable Node/Bun compatible launcher shim.
- `package.json`:
  - `"bin": { "pigeon": "bin/pigeon.js" }`
  - `"optionalDependencies"`: Pinning each supported platform package to the exact matching version (`@fangwangme/pigeon-<os>-<arch>`).

Package managers (npm, bun, pnpm, yarn) automatically install only the platform package matching the host operating system and CPU architecture.

### 3.3 Binary Resolution and Execution Semantics
When `pigeon` is invoked via CLI or `npx`/`bunx`:
1. `bin/pigeon.js` identifies host OS and architecture via `process.platform` and `process.arch`.
2. It attempts to resolve `@fangwangme/pigeon-${process.platform}-${process.arch}/bin/pigeon` using `require.resolve`.
3. If resolved, it executes the target binary using child process spawning (`spawn`) passing all CLI arguments and inheriting `stdio: "inherit"` to support raw terminal control, QR codes, and real-time ANSI terminal rendering.
4. If resolution fails:
   - On supported platforms: exits with code 1 and outputs actionable instructions to reinstall (e.g. `bun add -g --force @fangwangme/pigeon` or `npm install -g --force @fangwangme/pigeon`).
   - On unsupported platforms: exits with code 1 and informs the user that prebuilt binaries are unavailable for their architecture.
5. Termination signals (`SIGINT`, `SIGTERM`, `SIGHUP`) received by the launcher are actively forwarded to the child process to ensure graceful daemon shutdown and prevent orphaned daemon processes. Exit codes and termination signals from the child binary are propagated faithfully to the caller.

## 4. Workflows and Automation Semantics

### 4.1 Continuous Integration (`ci.yml`)
- Triggered on pull requests and pushes targeting `main` (ignoring changes confined to `docs/**`, `**.md`, and `.agents/**`).
- Environment: `ubuntu-latest`.
- Steps:
  1. Checks out repository.
  2. Sets up Bun (`oven-sh/setup-bun@v2`).
  3. Installs dependencies (`bun install --frozen-lockfile`).
  4. Runs full test suite (`bun test`).
  5. Validates client bundle and daemon compilation (`bun run build`).

### 4.2 Automated Release (`release.yml`)
- Triggered on tag push (`v*`).
- Concurrency group cancels previous in-progress runs for the same reference.
- Permissions: `contents: write`.
- **Job 1: Build Matrix (`build`)**:
  - Compiles binaries for each target (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`) using Bun.
  - Packages each target into `.tar.gz` and uploads artifacts via `actions/upload-artifact@v4`.
- **Job 2: GitHub Release (`publish-release`)**:
  - Downloads all built artifacts.
  - Creates a GitHub Release via `gh release create` attaching all release archives, extracting changelog notes when present or falling back to `--generate-notes`.
- **Job 3: NPM Assembly and Publication (`publish-npm`)**:
  - Job permissions: `contents: read` and `id-token: write`, so npm can authenticate the run through Trusted Publishing (OIDC).
  - Prepares Node environment (`actions/setup-node@v4`, Node 24, registry url `https://registry.npmjs.org`). Trusted Publishing needs Node ≥ 22.14 and npm CLI ≥ 11.5.1.
  - Executes `node npm/scripts/build-packages.mjs`:
    - Asserts tag version matches root `package.json` version.
    - Assembles platform packages and launcher package into output directory (`.local/npm-dist`).
  - Executes `node npm/scripts/publish-packages.mjs`:
    - Reads package manifests in dependency order.
    - Publishes all platform packages first using `npm publish --access public`.
    - Polls the NPM registry (`npm view <pkg>@<ver> version`) at fixed intervals (default 10s) with a timeout until all platform packages are indexed and resolvable.
    - Publishes launcher package only after registry verification succeeds, eliminating 404 installation race conditions for optionalDependencies.
    - Operates idempotently: skips versions already present on the registry.

## 5. Trust Boundaries and Error Handling

- **Tag and Version Integrity**: `build-packages.mjs` strictly verifies that the release git tag matches root `package.json` version before assembling packages. A mismatch halts the workflow immediately.
- **Authentication**: npm publishing authenticates only through npm Trusted Publishing. Each published package (`@fangwangme/pigeon` and every `@fangwangme/pigeon-<os>-<arch>`) lists a GitHub Actions trusted publisher for repository `fangwangme/Pigeon` and workflow `release.yml`; `npm publish` exchanges the run's short-lived OIDC token for publish rights. No npm token is stored in the repository, its secrets, or the workflow environment. A run whose OIDC exchange fails stops at the first `npm publish`, before any package is published, and is safe to rerun.
  - Decision: Trusted Publishing replaces the `NPM_TOKEN` secret because write-capable npm tokens expire within 90 days and bypass-2FA direct-publish tokens are being retired; a short-lived per-run credential removes both the rotation chore and the stored secret.
- **Fail-Safe Execution**: The launcher checks binary execution results; errors or non-zero exit codes terminate cleanly with matching exit status.
