# Quota and Usage Specification

## 1. Purpose and Scope

The phone shows two dashboards about the agents on this computer:

- **Quota** — how much of each subscription's rate-limit windows is used, for Claude Code, Codex and Antigravity.
- **Usage** — tokens and estimated cost per day and per model, for every agent Pigeon drives: Claude Code, Codex, Antigravity, OpenCode and Pi.

Both run inside the daemon. Pigeon never runs or reads the separate `tokenpulse` tool; its behavior is the reference this spec was written from. The pages are specified in `mobile-ui-and-themes.md` §11, the wire messages in `protocol.md` §4.15–§4.18, and the credential handling in `security-and-pairing.md` §6.

Not covered: API-key balances (Pi, OpenCode providers), quota history, quota push alerts, and usage of agents Pigeon does not drive.

## 2. Quota

### 2.1 Snapshot model

A provider's quota is one snapshot:

| Field | Meaning |
| :--- | :--- |
| `provider` | `claude`, `codex` or `antigravity` |
| `plan` | The subscription plan the provider reports (e.g. `pro`, `free`), when it reports one |
| `account` | The account's email, when the provider exposes it |
| `windows` | Rate-limit windows, in the provider's order |
| `credits` | Reset credits with their expiry, when the provider reports any (Codex); empty otherwise |
| `fetchedAt` | When the snapshot was fetched (ms since epoch) |

A window has `id`, `label`, an optional model `family` (e.g. `Gemini`, `Claude`, `Gemini 4 Argon`), `usedPercent` (0–100, as reported), `periodMs` (the window length, when known) and `resetsAt` (ms since epoch, or null when the provider gives none). Pigeon shows exactly the windows a provider reports; it never adds a window the response does not contain.

### 2.2 Providers

Each provider reads the agent's own credentials (`security-and-pairing.md` §6) and calls the provider's usage endpoint.

- **Claude Code.** Credentials: `~/.claude/.credentials.json` (`claudeAiOauth`), and on macOS also the login Keychain item `Claude Code-credentials`. Usage: `GET https://api.anthropic.com/api/oauth/usage` with the access token and the `anthropic-beta: oauth-2025-04-20` header. `five_hour` maps to a 5-hour window, `seven_day` to a 7-day window, `seven_day_<family>` to a 7-day window of that family. The plan is the credential's `subscriptionType`. Token refresh: `POST https://platform.claude.com/v1/oauth/token`.
- **Codex.** Credentials: `$CODEX_HOME/auth.json`, then `~/.config/codex/auth.json`, then `~/.codex/auth.json`; the first readable one is used. Usage: `GET https://chatgpt.com/backend-api/wham/usage`; reset credits: `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`. Token refresh: `POST https://auth.openai.com/oauth/token`. The account is the email in the ID token.
- **Antigravity.** Three sources, tried in order; the first that answers wins:
  1. the running Antigravity language server (desktop app first, then the CLI's), over its local RPC;
  2. `agy -p /usage` when the installed `agy` version supports it, parsing its JSON output;
  3. the Cloud Code API, with the CLI's cached OAuth token (`~/.gemini/antigravity-cli/antigravity-oauth-token`), refreshed when expired.

  Window labels come from the model group (`Gemini`, `Claude`, specialized models by name) and the window length.

### 2.3 Credential refresh

- A credential whose access token has expired is refreshed **once** before the usage call. A usage call rejected as unauthorized (401/403) with a token that was not just refreshed triggers one refresh and one retry. The same refresh token is never sent twice in one fetch.
- **Write-conflict protection.** Before writing refreshed tokens back, the provider re-reads the credential source. If it no longer matches what was read before the refresh — the agent rotated it meanwhile — the refresh result is discarded, nothing is written, and the fetch continues with the newly stored credentials. Otherwise the new access token, the new refresh token (when one was returned) and the new expiry are written back, and every other field of the file is preserved.
- A credential that cannot be refreshed (no refresh token, refresh rejected) is a provider error (§2.6); the file is left as it was.

### 2.4 Pace and level

Both are computed on the phone from a window (`src/shared/quota.ts`) so that every surface agrees.

**Pace** compares the used share with the share of the window's time that has passed. With `remaining = resetsAt − now` and `elapsed = periodMs − remaining`:

- No pace when `usedPercent` ≤ 0 or ≥ 100, when `periodMs` or `resetsAt` is unknown, or when `elapsed` ≤ 0 or `remaining` ≤ 0.
- `expected = elapsed ÷ periodMs × 100`; `deficit = usedPercent − expected`.
- `|deficit| < 5` → **on track**.
- `deficit > 0` → **ahead**, with `eta = (100 − usedPercent) ÷ (usedPercent ÷ elapsed)` — the time until the window runs out at the current rate. Ahead always means `eta < remaining`: at the current rate the window runs out before it resets.
- otherwise → **behind**.

**Level** depends only on `usedPercent`: **normal** below 80, **warn** from 80, **exhausted** at 100. The level colors bars, numbers and the list-page dot (`mobile-ui-and-themes.md` §11.1); pace never colors a bar. Pace text is muted, except an ahead pace, which uses the warn color because it runs out before the reset.

### 2.5 Enabling providers

`client.quotaProviders` (`architecture.md` §4.7) holds one boolean per provider. Only enabled providers are fetched. Until the user sets it, its effective value enables exactly the providers whose credential source exists on this machine: the Claude credential file (or, on macOS, its Keychain item), any Codex `auth.json` of §2.2, and for Antigravity the CLI's OAuth token or the desktop app's data directory (`~/.config/Antigravity`, or `~/Library/Application Support/Antigravity` on macOS). This detection only checks that the source exists; it reads no credential.

### 2.6 Fetching, caching and failures

- The phone asks for quota when the quota page opens and when the user taps refresh (`protocol.md` §4.15). The daemon answers from a cache younger than 60 seconds, unless the request forces a refresh. Providers are fetched in parallel; one slow or failing provider never delays the others' results past its own timeout.
- **Expected errors**, reported per provider in the reply and never as a protocol error: credentials missing, credentials rejected or not refreshable, network unreachable or timed out, an unexpected HTTP status, a response that cannot be parsed. Each carries a short message naming the provider and the cause.
- A provider that fails keeps its previous snapshot in the reply, next to the error; the phone shows both.
- The list-page dot (`mobile-ui-and-themes.md` §11.1) comes from the last snapshots the daemon holds; the home page asks with the cache allowed and never forces a fetch.

## 3. Usage

### 3.1 Sources

The daemon reads each agent's local session data. It only reads; it never changes an agent's files.

| Agent | Source |
| :--- | :--- |
| Claude Code | `~/.claude/projects/**/*.jsonl` and `~/.claude/transcripts/**/*.jsonl`; assistant messages with `usage`. A message counted twice (same message id and request id) is counted once, keeping the latest copy. |
| Codex | `$CODEX_HOME/sessions` and `archived_sessions`, else `~/.codex/sessions` and `~/.codex/archived_sessions`, `**/*.jsonl`; token-count events. |
| Antigravity | the CLI's conversations (`~/.gemini/antigravity-cli/conversations`) and the desktop app's (`~/.gemini/antigravity/conversations`). |
| OpenCode | its SQLite databases (`opencode.db`, and the `-next`/`-dev`/`-beta` variants) under its data directory, opened read-only. |
| Pi | `~/.pi/agent/sessions/**/*.jsonl`. |

A missing source means that agent has no usage; it is not an error. A record that cannot be parsed is skipped and counted in the scan's `skipped` total, which the daemon logs once per scan.

### 3.2 Record model

Every source is normalized to records of: local date (`YYYY-MM-DD`, the computer's time zone), timestamp, agent, session id, model id (normalized to its canonical name, so the same model from two agents is one model), the model's company (`anthropic`, `openai`, `google`, other), and the token counts `input`, `output`, `cacheRead`, `cacheWrite`. A record counts as one message.

**Total tokens** = `input + output + cacheRead + cacheWrite`. **Cache-hit ratio** = `cacheRead ÷ total tokens × 100`, 0 when the total is 0, shown with two decimals.

The daemon keeps an index of records under its state directory and reads only what changed since the last scan (by file size and modification time, and by OpenCode's row ids). The index is a cache: deleting it only costs a full rescan.

### 3.3 Pricing

Cost is an estimate at public API prices; subscription users are not billed this way, and the pages say so.

- Prices come from models.dev, then LiteLLM's price list, then OpenRouter's model list, for the first source that knows the model; they are cached on disk for a day.
- Each day's cost uses that day's price snapshot once one has been recorded, so an old day's cost does not move when prices change.
- Cache reads and writes use the model's cache prices when it has them, else its input price.
- A model no source knows is **unpriced**: its tokens count, its cost is 0, and the reply marks it. When no source can be reached and no cache exists, every model is unpriced and the reply says prices are unavailable; tokens are still reported.

### 3.4 Ranges

A request names a preset (`protocol.md` §4.16). With `today` the computer's local date:

| Preset | From | To |
| :--- | :--- | :--- |
| `today` | today | today |
| `7d` | today − 6 days | today |
| `30d` | today − 29 days | today |
| `year` | January 1 of today's year | today |
| `all` | the first day with usage | today |
| `custom` | the given `from` | the given `to` (swapped when given in reverse) |

A range of one day is a **single day**; anything longer is a **period**.

### 3.5 Comparison

Each reply carries the totals of a comparison range next to the range's own, or none:

- `year` and `all` — no comparison.
- A single day that is today — the same weekday one week earlier, counting only usage up to the current time of day.
- Any other single day — the same weekday one week earlier, the whole day.
- A period of N days — the N days just before it.
- No comparison when the comparison range starts before the first day with usage.

The phone shows the change in percent, or as a multiple ("约 N 倍") from ten times upward.

### 3.6 Heatmap layout

A period is shown as a grid of days (`mobile-ui-and-themes.md` §11.3). Its orientation follows the range length only:

- **≤ 7 days — strip:** one row, starting at `from`, each cell labeled with its weekday.
- **spanning ≤ 6 Monday-based weeks — week rows:** one row per week, columns Monday to Sunday; days outside the range stay empty.
- **longer — week columns:** one column per Monday-based week, rows Monday to Sunday (the GitHub layout), scrollable and zoomable.

### 3.7 Freshness

A usage request scans what changed before answering; a scan that is already running is shared. Replies carry `scannedAt`.

## 4. Interfaces

The rules of §2.4 and §3.4–§3.6 and the Claude provider are reachable as modules, so both the daemon and the phone use one implementation and tests drive them directly:

- `src/shared/quota.ts` — `quotaLevel(usedPercent) → "normal" | "warn" | "exhausted"`; `quotaPace(window, now) → { kind: "on_track" | "ahead" | "behind", expectedPercent, deficit, etaMs? } | null`, where `window` has `usedPercent`, `periodMs` and `resetsAt` (either may be null) and `etaMs` is present for `ahead`.
- `src/shared/usage.ts` — `resolveRange(preset, today, { firstDay, from?, to? }) → { from, to }`; `comparisonRange(range, preset, today, firstDay, nowMinutes) → { from, to, untilMinutes } | null`, where `untilMinutes` (minutes after local midnight) is set only when comparing today; `heatmapLayout(range) → "strip" | "week-rows" | "week-columns"`; `cacheHitPercent(cacheRead, totalTokens)` rounded to two decimals. Dates are `YYYY-MM-DD` strings in local time.
- `src/server/quota/claude.ts` — `new ClaudeQuotaProvider({ home, usageUrl?, tokenUrl?, keychain?, now? })` and `fetch() → Promise<QuotaSnapshot>`. `home` replaces the user's home directory, the URLs replace the endpoints of §2.2, `keychain: false` skips the macOS Keychain, `now` replaces the clock. A provider error rejects with an `Error` whose message follows §2.6.
- `QuotaSnapshot`, `QuotaWindow` and the usage reply types live in `src/types/protocol.ts`.

## 5. Decisions

- **Rewrite inside Pigeon instead of calling `tokenpulse`** — users install one program. Rejected: running the `tokenpulse` binary or reading its databases.
- **Only the windows a provider reports** — the pages once showed windows that exist in code branches but not in the user's data, which misled. Rejected: fixed window lists per provider.
- **One color rule, by used share** — two rules (pace for bars, share for numbers) put a red bar next to a yellow number. Rejected: pace-colored bars.
- **Remaining or used is a setting, not a page toggle** — the bar, the time marker and the legend all follow it, so the page never mixes the two. Rejected: a toggle on the quota page.
- **Two usage layouts, single day and period** — a special 7-day view was one more thing to learn. Rejected: per-preset layouts.
- **Only date and model as dimensions; agent is a filter** — the old overview, daily and activity views were all date trends. Rejected: an agent table.
- **Cache-hit ratio stays its own figure and a sort key** — the user sorts models by it. Rejected: folding it into the cache-read figure.
