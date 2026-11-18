## Project Structure

- Work in a non-`main` git worktree for normal development
- Only modify `main` directly when the user explicitly authorizes template or repository-structure maintenance
- Manual worktrees live under `.worktrees/`
- Worktree-local state lives under `.local/`
- Shared specs live under `docs/specs/`
- Agent notes, plans, archives, and project status live under `.agents/`

## Ports and Service Environments

- **Formal / Production (正式版)**: Port `4100`. Uses `$XDG_RUNTIME_DIR/pigeon.sock` and `devices.json`. Default Tailscale HTTPS port is `8443`.
- **Test / Development (测试版)**: Port `4101` (`bun run dev:server` or `bun ./src/cli/index.ts start --port 4101`). Default Tailscale HTTPS port is `18443`.
- **Client Dev Server (Vite 前端调试)**: Port `5173` (`bun run dev`), proxies `/api` and `/ws` to the test daemon on `4101`.
- Any non-4100 port automatically isolates the admin socket to `pigeon-<port>.sock` and state/device pairing to `<XDG_DATA_HOME>/pigeon-<port>/devices.json` (compared against the production `server.port`, default `4100`). Never run test/dev daemons on port 4100 to avoid conflicting with the production service.
- **Tailscale HTTPS Ports**: Production default `8443`, test default `18443`. Configurable per instance via `server.tailscaleHttpsPort` in `config.json`. Both instances coexist concurrently with independent web origins.

### Worktree test daemon (测试版启动方式)

Run the test daemon from the worktree root with its own state, exactly like this; do not improvise other env setups.

1. **Seed once, by copying (never linking) Pigeon's state** from `~/.local/share/pigeon/`, so usage keeps the AGY desktop history that only Pigeon's cache holds:
   - `mkdir -p .local/data/pigeon .local/run`
   - `sqlite3 -readonly ~/.local/share/pigeon/usage.db ".backup '.local/data/pigeon/usage.db'"`
   - `cp -a ~/.local/share/pigeon/antigravity-cache .local/data/pigeon/`
2. **Link agent data that Pigeon finds through `XDG_DATA_HOME`**, or that agent's usage disappears: `ln -s ~/.local/share/opencode .local/data/opencode`. Pigeon only reads it.
3. **Start** (`HC_TERMINAL_SOCKET` must point at the real Herdr core, because `XDG_RUNTIME_DIR` is overridden; pass `--debug` when diagnosing connection or RPC latency):
   ```bash
   XDG_DATA_HOME=$PWD/.local/data XDG_RUNTIME_DIR=$PWD/.local/run \
   HC_TERMINAL_SOCKET=/run/user/$(id -u)/herdr-core/default.sock \
   PIGEON_CONFIG_PATH=$PWD/.local/data/pigeon-4101/config.json \
   bun --watch ./src/cli/index.ts start --port 4101 --public-url https://<tailnet-host>:18443
   ```
   The test config sets `client.usageScanInterval` to `15m`; keep it there.
4. **Verify it stays up**: about 30 s after start, the `bun` process must still be in the foreground and `curl http://127.0.0.1:4101/api/auth/status` must answer. A Herdr timeout at startup can make it exit; a "listening" line on screen is not proof.
5. The phone pairs once with the test daemon (its devices are isolated): use the pairing URL it prints.
6. While testing quota or usage, stop production (`systemctl --user stop pigeon`) so two daemons do not refresh at once; start it again afterwards (`systemctl --user start pigeon`).

## Development Workflow

1. Before starting feature work, read `AGENTS.md`, `.agents/PROJECT_STATUS.md`, `.agents/LESSONS.md`, and the relevant `docs/specs/`.
2. Use the currently available issue-driven development orchestration skill as the public entry point (`/oi` or `/orchestrate-with-issue`). Invoke it manually with an explicit action; ordinary conversation never authorizes Issue, worktree, dispatch, PR, or cleanup mutations.
3. Specs lead. A behavior change updates `docs/specs/` first, in the change's own branch, together with its acceptance tests; the code then follows the spec. A bug fix cites the spec clause the code violates; a refactor or chore touches no spec.
4. The executor chooses the implementation within the spec and the issue, self-checks against the issue's `Acceptance`, and opens the PR. Merge remains a user decision.
5. Update `.agents/PROJECT_STATUS.md` when project state, active work, or important decisions change; the issue-driven workflow's actions maintain the per-issue Active Work lines themselves.

## Verification

- `bun test` runs every check and test. Agents run it before every PR.

## Coding Rules

- Validate input only at trust boundaries — user input, network, files, external APIs — as the spec names them. Trust internal callers and types.
- Errors the spec does not list as expected fail loudly: no swallowed exceptions, log-and-continue, speculative fallbacks, or checks for states that cannot occur.
- Tests cover behavior the spec or the issue's `Acceptance` names, through public interfaces, one case per distinction the spec makes. A bug fix adds a regression test that fails without the fix. Do not add a test that cannot name the spec section it protects.

Document placement: durable behavior, interfaces, trust boundaries, error semantics, and decisions in `docs/specs/`; usage guidance in `docs/usage/`; one change's acceptance contract in the GitHub issue (in English); its shared authoring file in `.agents/issues/`; the issue's route, facts, risks, and private values in its plan under `.agents/plans/`; raw inputs for the user's own reference in `.local/requirements/`; optional temporary review/research in `.agents/notes/`; current state and active work in `.agents/PROJECT_STATUS.md`; lessons from agent mistakes in `.agents/LESSONS.md`.
