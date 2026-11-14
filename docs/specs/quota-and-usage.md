# Quota and Usage Specification

## 1. Purpose and Scope

The phone shows two dashboards about the agents on this computer:

- **Quota** — how much of each subscription's rate-limit windows is used, for Claude Code, Codex and Antigravity.
- **Usage** — tokens and estimated cost per day and per model, for every agent Pigeon drives: Claude Code, Codex, Antigravity, OpenCode and Pi.

Both run inside the daemon. Pigeon never runs or reads the separate `tokenpulse` tool; its behavior is the reference this spec was written from. The pages are specified in `mobile-ui-and-themes.md` §11, the wire messages in `protocol.md` §4.16–§4.19, and the credential handling in `security-and-pairing.md` §6.

Not covered: API-key balances (Pi, OpenCode providers), quota history, quota push alerts, and usage of agents Pigeon does not drive.

### 1.1 Master switch

`client.quotaUsageEnabled` (`architecture.md` §4.7, default `true`) controls both Subscription Quota and Token Usage Dashboard features across every paired phone (`mobile-ui-and-themes.md` §11.4).

When disabled (`false`):
- **Entry masking:** the Settings card shows only the master switch; all inner navigation rows and detailed settings, as well as the queried-providers card, are hidden (`mobile-ui-and-themes.md` §8.1, §11.4). The header gauge buttons on both Home and All Agents pages are hidden (`mobile-ui-and-themes.md` §11.1). Navigating to or restoring a quota or usage route redirects immediately to Home.
- **Value preservation:** all other client configuration keys in `config.json` (such as `quotaDisplay`, `quotaButton`, `quotaShowAccount`, `quotaProviders`, `usageScanMode`, and `usageScanInterval`) remain untouched. Aggregated session usage in `usage.db` remains intact. When re-enabled, previous settings and historical data are instantly restored.
- **Scan and query shutdown:** the phone sends no `quota_get`, `usage_get`, `usage_day`, or `usage_model`. The daemon's WebSocket dispatch rejects any of those requests with `ERR_FEATURE_DISABLED` without calling a provider or scanning files (`protocol.md` §4.16–§4.19). `UsageService` stops its background scheduled timer; no session files are scanned. `QuotaService` makes no network requests or language server queries.
- **In-flight work:** any scan or quota query already in flight when the switch is disabled is allowed to complete gracefully without interruption to avoid corrupting SQLite or file states.
- **Rebuild cache:** `pigeon rebuild-cache` via CLI remains permitted as an explicit administrative maintenance operation.
- **Re-enabling:** transitioning from disabled to enabled immediately triggers one usage scan and one quota fetch to restore fresh data without waiting for an interval timer.

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
| `extraUsage` | Optional `{ used, limit, currency }` when Claude's `extra_usage.is_enabled` is true |
| `fetchedAt` | When the snapshot was fetched (ms since epoch) |

A window has `id`, `label`, an optional model `family` (e.g. `Gemini`, `Claude`, `Gemini 4 Argon`), `usedPercent` (0–100, as reported), `periodMs` (the window length, when known) and `resetsAt` (ms since epoch, or null when the provider gives none). Pigeon shows exactly the windows a provider reports; it never adds a window the response does not contain.

### 2.2 Providers

Each provider reads the agent's own credentials (`security-and-pairing.md` §6) and calls the provider's usage endpoint.

- **Claude Code.** Credentials: `~/.claude/.credentials.json` (`claudeAiOauth`), and on macOS also the login Keychain item `Claude Code-credentials` (read-only). Usage: `GET https://api.anthropic.com/api/oauth/usage` with the access token and the `anthropic-beta: oauth-2025-04-20` header. When `limits[]` is present, each entry maps to a window (`group === "session"` → 5-hour period, `group === "weekly"` → 7-day period, unknown group preserves its label with `periodMs: null`; `scope.model.display_name` sets `family` and label `"7d · <display_name>"`, with `session` entries ordered first); when `limits[]` is absent, legacy top-level keys (`five_hour`, `seven_day`, `seven_day_<family>`) are read instead. When `extra_usage.is_enabled` is true, `extraUsage` carries `used` and `limit` scaled by `10 ** (decimal_places ?? 2)` and `currency` (shown even when `$0`). The plan is the credential's `subscriptionType`.
- **Codex.** Credentials: `$CODEX_HOME/auth.json`, then `~/.config/codex/auth.json`, then `~/.codex/auth.json`; the first readable one is used. Usage: `GET https://chatgpt.com/backend-api/wham/usage`; reset credits: `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`. The account is the email in the ID token.
- **Antigravity.** Three sources, tried in order; the first that answers wins:
  1. the running Antigravity language server (desktop app first, then the CLI's), over its local RPC (`RetrieveUserQuotaSummary`, plus `GetUserStatus` for account email and subscription plan). The language server is discovered by inspecting running processes for arguments (`--app_data_dir`) or process environment variables (`ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`). Connections are strictly restricted to local loopback addresses (`127.0.0.1` or `::1`) with a 10-second timeout; `ANTIGRAVITY_LS_ADDRESS` in daemon environment acts as a test override;
  2. `agy -p /usage --output-format json` when the installed `agy` version supports it, parsing its JSON output;
  3. the Cloud Code API, with the CLI's cached OAuth token (`~/.gemini/antigravity-cli/antigravity-oauth-token`) while it has not expired.

  Groups keep the API's order; within a group, 5h precedes weekly, followed by any other window (with `periodMs: null`). Bucket IDs starting with `3p` or group names containing both `claude` and `gpt` label as `"Claude/GPT"`; other group names strip a trailing `" models"` (case-insensitive). Window `id` uses `bucket.id` directly when present. Account email prefers `GetUserStatus`, falling back to the OAuth `id_token` or `app_storage.json` (`agy.onboarding.lastLoginUsername`, then `jetski.onboarding.lastLoginUsername`).

### 2.3 Expired credentials

Pigeon never refreshes or writes an agent's credentials (user decision, 2026-11-11): a rotating refresh token used by both Pigeon and the agent can sign the agent out, and the gain is only a quota figure.

- A credential whose access token has expired, or a usage call rejected as unauthorized (401/403), is a provider error (§2.6). Its message names the provider and says to open that agent so it refreshes its login (e.g. `Claude: login expired — open Claude Code to refresh it`). No token endpoint is called, and the credential source is left as it was.
- The next fetch reads the source again, so the quota returns as soon as the agent has refreshed.

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

- The phone asks for quota when the quota page opens and when the user taps refresh (`protocol.md` §4.16). The daemon answers from a rate-limiting protection cache younger than 60 seconds. Providers are fetched in parallel; one slow or failing provider never delays the others' results past its own timeout.
- **Expected errors**, reported per provider in the reply and never as a protocol error: credentials missing, credentials rejected or not refreshable, network unreachable or timed out, an unexpected HTTP status, a response that cannot be parsed. Each carries a short message naming the provider and the cause.
- A provider that fails keeps its previous snapshot in the reply, next to the error; the phone shows both.
- A provider that failed is not fetched again for 60 seconds, whether or not it has a previous snapshot; replies in that time carry its last error. This keeps a rate-limited (429) provider from being hit on every request.
- The list-page dot (`mobile-ui-and-themes.md` §11.1) comes from the last snapshots the daemon holds; the home page asks with the cache allowed and never forces a fetch.

## 3. Usage

### 3.1 Sources

The daemon reads each agent's local session data. It only reads; it never changes an agent's files.

| Agent | Source |
| :--- | :--- |
| Claude Code | `~/.claude/projects/**/*.jsonl` and `~/.claude/transcripts/**/*.jsonl`; assistant messages with `usage`. A message counted twice (same message id and request id) is counted once, keeping the latest copy. |
| Codex | `$CODEX_HOME/sessions` and `archived_sessions`, else `~/.codex/sessions` and `~/.codex/archived_sessions`, `**/*.jsonl`; token-count events. |
| Antigravity | The CLI's SQLite conversations (`~/.gemini/antigravity-cli/conversations/*.db`) and Desktop's (`~/.gemini/antigravity/conversations/*.db`) are scanned directly. For Desktop binary protobuf (`.pb`) sessions, when the local Antigravity Language Server is online, Pigeon queries its local loopback RPC (`GetAllCascadeTrajectories` and `GetCascadeTrajectoryGeneratorMetadata`) and caches the parsed usage records incrementally into Pigeon's local cache under `$XDG_DATA_HOME/pigeon/antigravity-cache/cache.db`. When the Language Server is offline, Pigeon reads previously cached records without error. |
| OpenCode | its SQLite databases (`opencode.db`, and the `-next`/`-dev`/`-beta` variants) under its data directory, opened read-only. |
| Pi | `~/.pi/agent/sessions/**/*.jsonl`. |

A missing source means that agent has no usage; it is not an error. A record that cannot be parsed is skipped and counted in the scan's `skipped` total, which the daemon logs once per scan. A source database or file that cannot be opened or read (locked, corrupted, a read error, `zstd` missing or failing for a compressed file) logs a warning and does not update `scan_file_state`, so subsequent scans retry it. A missing `zstd` is logged once per daemon run.

### 3.2 Record model

Every source is normalized to records of: local date (`YYYY-MM-DD`, the computer's time zone), timestamp, agent, session id, model id (normalized to its canonical name, so the same model from two agents is one model), the model's company (`anthropic`, `openai`, `google`, other), and the token counts `input`, `output`, `cacheRead`, `cacheWrite`. A record counts as one message.

A record's key comes from the source's own ids and timestamp; a record whose source gives no timestamp is keyed by its file path and line number, so a rescan never stores it twice.

**Total tokens** = `input + output + cacheRead + cacheWrite`. **Cache-hit ratio** = `cacheRead ÷ total tokens × 100`, 0 when the total is 0, shown with two decimals.

The daemon keeps an index of records under its state directory and reads only what changed since the last scan (by file size and modification time, and by OpenCode's row ids). The index is a cache: deleting it only costs a full rescan.

### 3.3 Pricing

Cost is an estimate at public API prices; subscription users are not billed this way, and the pages say so.

- Prices come from `models.dev`, then LiteLLM's price list, then OpenRouter's model list, for the first source that knows the model; they are cached on disk for 24 hours (`fetchedAt` TTL). Within `models.dev`, first-party official providers (`anthropic`, `openai`, `google`, `google-vertex`, `deepseek`, `zhipuai`, `zai`, `minimax`, `moonshotai`, `xai`, `mistral`, `cohere`) take precedence over third-party resellers when populating unprefixed canonical model IDs. A running daemon checks the 24-hour TTL on `PricingManager.initialize()` (never permanently short-circuiting after first load) and re-fetches once stale.
- Prices are stored as stage-based **price periods** (`model_price_periods (model_id, start_date, end_date, input_cost, output_cost, cache_read_cost, cache_write_cost)`):
  - When a model has no period yet and a price source first provides price $P_1$, it is recorded with `start_date = '0000-01-01'` and `end_date = NULL` so it covers release-day and earlier unpriced records.
  - On subsequent syncs, unchanged prices produce no database write. When an upstream price changes from the active (`end_date IS NULL`) period: if `active.start_date >= today`, the active row is updated in place; otherwise the active row is closed with `end_date = addDays(today, -1)` and a new active row opens with `start_date = today` and `end_date = NULL`. Earlier days continue to resolve to their historical period so past costs do not shift.
  - After every scan while prices are available, Antigravity codenames/aliases are repaired first, and then **all** `unpriced = 1` records across **every** agent are looked up by `(canonical_model_id, date)` (`start_date <= date AND (end_date IS NULL OR end_date >= date)`) and backfilled with their period's cost and `unpriced = 0`.
  - `pigeon rebuild-cache` clears `usage_records` and `scan_file_state`, preserving `model_price_periods`.
- Cache reads and writes use the model's cache prices when it has them, else its input price.
- A model no source knows is **unpriced**: its tokens count, its cost is 0, and the reply marks it. When network sources cannot be reached, previously cached prices on disk (even if older than 24 hours) serve as an offline fallback; when no cache exists, every model is unpriced and the reply says prices are unavailable. A failed price initialization does not permanently mark pricing loaded; subsequent background scans continue to retry after `retryIntervalMs`.

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

### 3.7 Freshness and Storage

Usage scanning operates in one of two modes (`client.usageScanMode`):
- **Scheduled** (`scheduled`, default): background scans run periodically at the configured interval (`1m`, `2m`, `5m` default, `10m`, `15m`). Client requests answer immediately from SQLite without blocking on filesystem reads; forced refresh (`force: true`) rescans newly modified session files only in realtime mode, while scheduled mode answers from the background cache (user decision, 2026-11-11).
- **Realtime** (`realtime`): every usage request checks and scans newly modified session files before answering; a scan that is already running is shared.

Scans run off the daemon's event loop (in a Worker), so a first scan or a rebuild never delays WebSocket traffic. JSONL files are read from the byte offset where the previous scan stopped, unless the file shrank.

All aggregated usage data is stored in a single SQLite database at `$XDG_DATA_HOME/pigeon/usage.db` (falling back to `~/.local/share/pigeon/usage.db`), shared by every instance (`architecture.md` §4.6). The cache can be rebuilt from scratch at any time using the CLI command `pigeon rebuild-cache`. Replies carry `scannedAt` reflecting the timestamp when the database scan was last completed.

## 4. Interfaces

The rules of §2.4 and §3.4–§3.6 and the Claude provider are reachable as modules, so both the daemon and the phone use one implementation and tests drive them directly:

- `src/shared/quota.ts` — `quotaLevel(usedPercent) → "normal" | "warn" | "exhausted"`; `quotaPace(window, now) → { kind: "on_track" | "ahead" | "behind", expectedPercent, deficit, etaMs? } | null`, where `window` has `usedPercent`, `periodMs` and `resetsAt` (either may be null) and `etaMs` is present for `ahead`.
- `src/shared/usage.ts` — `resolveRange(preset, today, { firstDay, from?, to? }) → { from, to }`; `comparisonRange(range, preset, today, firstDay, nowMinutes) → { from, to, untilMinutes } | null`, where `untilMinutes` (minutes after local midnight) is set only when comparing today; `heatmapLayout(range) → "strip" | "week-rows" | "week-columns"`; `cacheHitPercent(cacheRead, totalTokens)` rounded to two decimals. Dates are `YYYY-MM-DD` strings in local time.
- `src/server/quota/claude.ts` — `new ClaudeQuotaProvider({ home, usageUrl?, keychain?, now? })` and `fetch() → Promise<QuotaSnapshot>`. `home` replaces the user's home directory, `usageUrl` the usage endpoint of §2.2, `keychain: false` skips the macOS Keychain and a `{ read }` credential source replaces it, `now` replaces the clock. The Keychain item is used only when the credential file does not exist. A provider error rejects with an `Error` whose message follows §2.3 and §2.6.
- `QuotaSnapshot`, `QuotaWindow` and the usage reply types live in `src/types/protocol.ts`.

## 5. Decisions

- **Rewrite inside Pigeon instead of calling `tokenpulse`** — users install one program. Rejected: running the `tokenpulse` binary or reading its databases.
- **Build Antigravity Desktop cache natively without copying external data** — Desktop `.pb` sessions are queried from the local loopback Language Server RPC and cached incrementally into Pigeon's native SQLite cache (`$XDG_DATA_HOME/pigeon/antigravity-cache/cache.db`). When the Language Server is offline, existing cache is used without error. Rejected: copying database files or alias mapping files from external tools.
- **Only the windows a provider reports** — the pages once showed windows that exist in code branches but not in the user's data, which misled. Rejected: fixed window lists per provider.
- **One color rule, by used share** — two rules (pace for bars, share for numbers) put a red bar next to a yellow number. Rejected: pace-colored bars.
- **Remaining or used is a setting, not a page toggle** — the bar, the time marker and the legend all follow it, so the page never mixes the two. Rejected: a toggle on the quota page.
- **Two usage layouts, single day and period** — a special 7-day view was one more thing to learn. Rejected: per-preset layouts.
- **Only date and model as dimensions; agent is a filter** — the old overview, daily and activity views were all date trends. Rejected: an agent table.
- **Cache-hit ratio stays its own figure and a sort key** — the user sorts models by it. Rejected: folding it into the cache-read figure.
