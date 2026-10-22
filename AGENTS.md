## Project Structure

- Work in a non-`main` git worktree for normal development
- Only modify `main` directly when the user explicitly authorizes template or repository-structure maintenance
- Manual worktrees live under `.worktrees/`
- Worktree-local state lives under `.local/`
- Shared specs live under `docs/specs/`
- Agent notes, plans, archives, and project status live under `.agents/`

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
