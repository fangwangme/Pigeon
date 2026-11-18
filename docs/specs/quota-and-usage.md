# Quota and Usage Specification

## 1. Purpose and Scope

The phone shows two dashboards about the agents on this computer:

- **Quota** — how much of each subscription's rate-limit windows is used, for Claude Code, Codex and Antigravity.
- **Usage** — tokens and estimated cost per day and per model, for every agent Pigeon drives: Claude Code, Codex, Antigravity, OpenCode and Pi.

Both run inside the daemon. Pigeon never runs or reads the separate `tokenpulse` tool; its behavior is the reference this spec was written from. The pages are specified in `mobile-ui-and-themes.md` §11, the wire messages in `protocol.md` §4.16–§4.19, and the credential handling in `security-and-pairing.md` §6.

Not covered: API-key balances (Pi, OpenCode providers), quota history, quota push alerts, and usage of agents Pigeon does not drive.

### 1.1 Feature switches

`client.quotaEnabled` (`architecture.md` §4.7, default `false`) and `client.usageEnabled` (`architecture.md` §4.7, default `true`) independently control Subscription Quota and Token Usage Dashboard across every paired phone (`mobile-ui-and-themes.md` §11.4). Legacy `quotaUsageEnabled` and the removed `usageScanMode` (issue #29) in `config.json` are dropped on load and rejected by `config_patch` (`protocol.md` §6.3).

When a feature switch is disabled (`false`):
- **Entry masking:** only that feature's Settings navigation row, feature-specific sub-settings, and provider list (for Quota) are hidden (`mobile-ui-and-themes.md` §11.4). The list-page entry button (`quotaButton`) remains visible whenever `(quotaEnabled || usageEnabled) && quotaButton` is `true`, opening Quota when `quotaEnabled` is `true` or Usage when only `usageEnabled` is `true` (`mobile-ui-and-themes.md` §11.1). Inside either page, both **额度** and **用量** tabs stay visible whenever at least one switch is `true`; selecting the disabled tab shows an amber (`--warn`) notice with a Settings shortcut and sends no daemon requests for that feature. Navigating to or restoring `/quota` or `/usage` redirects immediately to Home only when **both** `quotaEnabled` and `usageEnabled` are `false`.
- **Value preservation:** all other client configuration keys in `config.json` (such as `quotaDisplay`, `quotaButton`, `quotaShowAccount`, `quotaProviders`, and `usageScanInterval`) remain untouched, and `usage.db` remains intact.
- **Scan and query shutdown:** the phone sends no requests for a disabled feature. The daemon rejects `quota_get` when `quotaEnabled` is `false`, and rejects `usage_get`, `usage_day`, `usage_model` when `usageEnabled` is `false`, with `ERR_FEATURE_DISABLED` without querying providers or scanning files (`protocol.md` §4.16–§4.19). A scheduled tick skips a disabled item (§2.6), and the refresh timer is not armed while both switches are `false`.
- **In-flight work:** any fetch or scan already in flight when a switch turns off finishes gracefully without interruption.
- **Rebuild cache:** `pigeon rebuild-cache` via CLI remains permitted as an explicit administrative maintenance operation.
- **Enabling:** toggling either switch from `false` to `true` immediately triggers one refresh for that feature (`fetchAll` for quota, `scan` for usage) without waiting for the next timer tick.

## 2. Quota

### 2.1 Snapshot model

A provider's quota is one snapshot:

| Field | Meaning |
| :--- | :--- |
| `provider` | `claude`, `codex` or `antigravity` |
| `plan` | The subscription plan the provider reports (e.g. `pro`, `free`), when it reports one |
| `account` | The account's email, when the provider exposes it |
| `windows` | Rate-limit windows, grouped by category (`family`; windows without one form their own category) in the order the provider first names each category; within a category the 5-hour window comes first, then the 7-day one, then any other (user decision, 2026-11-14). This holds for every provider |
| `credits` | Reset credits with their expiry, when the provider reports any (Codex); empty otherwise |
| `extraUsage` | Optional `{ used, limit, currency }` when Claude's `extra_usage.is_enabled` is true |
| `fetchedAt` | When the snapshot was fetched (ms since epoch) |

A window has `id`, `label`, an optional model `family` (e.g. `Gemini`, `Claude`, `Gemini 4 Argon`), `usedPercent` (0–100, as reported), `periodMs` (the window length, when known) and `resetsAt` (ms since epoch, or null when the provider gives none). Pigeon shows exactly the windows a provider reports; it never adds a window the response does not contain.

### 2.2 Providers

Each provider reads the agent's own credentials (`security-and-pairing.md` §6) and calls the provider's usage endpoint.

- **Claude Code.** Credentials: `~/.claude/.credentials.json` (`claudeAiOauth`), and on macOS also the login Keychain item `Claude Code-credentials` (read-only); account email from `~/.claude.json` (`oauthAccount.emailAddress`). Usage: `GET https://api.anthropic.com/api/oauth/usage` with the access token and the `anthropic-beta: oauth-2025-04-20` header. When `limits[]` is present, each entry maps to a window (`group === "session"` → 5-hour period, `group === "weekly"` → 7-day period, unknown group preserves its label with `periodMs: null`; `scope.model.display_name` sets `family` and label `"7d · <display_name>"`; windows are ordered as in §2.1); when `limits[]` is absent, legacy top-level keys (`five_hour`, `seven_day`, `seven_day_<family>`) are read instead. When `extra_usage.is_enabled` is true, `extraUsage` carries `used` and `limit` scaled by `10 ** (decimal_places ?? 2)` and `currency` (shown even when `$0`). The plan is the credential's `subscriptionType`.
- **Codex.** Credentials: `$CODEX_HOME/auth.json`, then `~/.config/codex/auth.json`, then `~/.codex/auth.json`; the first readable one is used. Usage: `GET https://chatgpt.com/backend-api/wham/usage`; reset credits: `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`. The account is the email in the ID token.
- **Antigravity.** Three sources, tried in order; the first that answers wins:
  1. the running Antigravity language server (`desktop > ide > cli`), over its local RPC (`RetrieveUserQuotaSummary`, plus `GetUserStatus` for account email and subscription plan). Discovery checks daemon hub JSON files (`~/.gemini/antigravity/daemon/*.json`, `antigravity-ide/daemon/*.json`, `antigravity-cli/daemon/*.json` for live PIDs) first, then running processes (`--app_data_dir`, `--extension_server_port`/`--port`, `--csrf_token`, or Linux `/proc/<pid>/environ` `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN`). Connections are strictly restricted to local loopback addresses (`127.0.0.1` or `::1`) with a 10-second timeout; `ANTIGRAVITY_LS_ADDRESS` in the daemon environment acts as a test override;
  2. `agy -p /usage --output-format json` when the installed `agy` version supports it, parsing its JSON output. It runs even when the token file below has expired: the CLI refreshes its own login, which is the agent acting on its own credential (§2.3);
  3. the Cloud Code API, with the CLI's cached OAuth token (`~/.gemini/antigravity-cli/antigravity-oauth-token`) while it has not expired.

  Each group is a category: groups keep the API's order, and within a group 5h precedes weekly, followed by any other window (with `periodMs: null`), as in §2.1 — even though the API lists weekly first. Display names starting with `3p` or containing `claude` or `gpt` label as `"Claude/GPT"`; `"gemini"` / `"gemini models"` normalize to `"Gemini"`; other group names strip a trailing `" models"` (case-insensitive). Window `id` uses `bucket.id` directly when present. The account is the one the answering source is signed in as, because the CLI and the desktop app can be signed in to different Google accounts (2026-11-14): the language server's `GetUserStatus` email, else the stored sign-in of the program running that server; for the CLI source, the last `authenticated successfully as <email>` line of `~/.gemini/antigravity-cli/cli.log`, else that directory's `app_storage.json`; for the Cloud Code source, the token file's `id_token`. The desktop app's `app_storage.json` (`~/.config/Antigravity/`, or `~/Library/Application Support/Antigravity/` on macOS) names only a desktop language server's account. In an `app_storage.json`, the sign-in is `agy.onboarding.lastLoginUsername`, then `jetski.onboarding.lastLoginUsername`.

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

**Level & status colors.** `quotaLevel` depends only on `usedPercent`: **normal** below 80, **warn** from 80, **exhausted** at 100. Window bars, card status dots, and list-page warning dots combine level and pace (`mobile-ui-and-themes.md` §11.1–§11.2): `--danger` when exhausted or pace is **ahead**, `--warn` when level is **warn** or pace is **on_track**, and `--addfg` otherwise; primary figures use `--fg` unless warn/danger applies. Pace text colors `--addfg` for **behind**, `--warn` for **on_track**, and `--danger` for **ahead** or **exhausted**.

### 2.5 Enabling providers

`client.quotaProviders` (`architecture.md` §4.7) holds one boolean per provider. Only enabled providers are fetched. Until the user sets it, its effective value enables exactly the providers whose credential source exists on this machine: the Claude credential file (or, on macOS, its Keychain item), any Codex `auth.json` of §2.2, and for Antigravity the CLI's OAuth token or the desktop app's data directory (`~/.config/Antigravity`, or `~/Library/Application Support/Antigravity` on macOS). This detection only checks that the source exists; it reads no credential.

### 2.6 Fetching, caching and failures

- **One daemon-owned schedule (user decision, 2026-11-17):** quota and usage are refreshed by a single daemon timer at `client.usageScanInterval` (`1m`, `2m`, `5m`, `10m`, `15m` default). There is no scan mode: refresh is always scheduled. The timer runs while the daemon runs and at least one of `quotaEnabled` and `usageEnabled` is `true`, whether or not a phone is connected; phones connecting and disconnecting neither start, stop, nor re-time it. The daemon refreshes the enabled items once at start, then on every tick.
- On each tick, the enabled items refresh together and without blocking each other: both when both switches are on, only the enabled one otherwise (enabled quota providers fetch in parallel; usage scans newly modified files). A changed interval re-arms the timer from the moment of the change.
- **Requested refresh:** the quota page's Refresh button refreshes quota only (`quota_get` with `refresh: true`, `protocol.md` §4.16) and the usage page's refreshes usage only (`usage_get` with `force: true`, §4.17). A requested refresh joins one already running for that item, and never moves the timer.
- Every other read — opening the quota page, the home badge, the usage page, a day or model detail — answers from the cache (`providers` and `fetchedAt` for quota, the usage database for usage) and never fetches a provider or scans files (a usage request arriving before the daemon's first scan since start completes waits for it, §3.7).
- **Expected errors**, reported per provider in the cache, replies and pushes, and never as a protocol error: credentials missing, credentials rejected or not refreshable, network unreachable or timed out, an unexpected HTTP status, a response that cannot be parsed. Each carries a short message naming the provider and the cause.
- A provider that fails (including rate-limit HTTP 429) keeps its previous `snapshot` next to its new `error`; the phone shows both. Failed providers are not retried before the next interval.
- After any refresh completes, scheduled or requested, the daemon broadcasts updated state to online phones (`quota_updated` in `protocol.md` §5.11; `usage_updated` in `protocol.md` §5.12) so their open pages update silently without a manual refresh (`mobile-ui-and-themes.md` §11).

## 3. Usage

### 3.1 Sources

The daemon reads each agent's local session data. It only reads; it never changes an agent's files.

| Agent | Source |
| :--- | :--- |
| Claude Code | `~/.claude/projects/**/*.jsonl` and `~/.claude/transcripts/**/*.jsonl`; assistant messages with `usage`. A message counted twice (same message id and request id) is counted once, keeping the latest copy. |
| Codex | Both `$CODEX_HOME/sessions`, `$CODEX_HOME/archived_sessions` (when `$CODEX_HOME` is set) and `~/.codex/sessions`, `~/.codex/archived_sessions`, `**/*.jsonl` and `**/*.zst` (decompressed with `zstd -dc`); token-count events. |
| Antigravity | Both CLI SQLite conversations (`~/.gemini/antigravity-cli/conversations/*.db`) and local SQLite conversations (`~/.gemini/antigravity/conversations/*.db`) are scanned directly. For Desktop/IDE binary protobuf (`.pb`) sessions (`~/.gemini/antigravity/conversations/*.pb`, `~/.gemini/antigravity-ide/conversations/*.pb`), when a local Antigravity Language Server is online, Pigeon queries its local loopback RPC (`GetAllCascadeTrajectories` and `GetCascadeTrajectoryGeneratorMetadata`) and caches the parsed usage records incrementally into Pigeon's local cache under `$XDG_DATA_HOME/pigeon/antigravity-cache/cache.db`. When the Language Server is offline, Pigeon reads previously cached records without error. Both paths extract `input` (`#2`), total `output` (`#3`, covering both thinking `#9` and visible response `#10`, falling back to `#9 + #10` when `#3` is absent), `cacheRead` (`#5`), and `cacheWrite` (`#4`), along with `model_enum` (`#20`), `served_model` (`#19`), and `display_name` (`#21`, cached as `display_name` in `antigravity-cache/cache.db`, migrating existing tables in place and resetting cached session watermarks so online `.pb` sessions backfill `display_name`). |
| OpenCode | its SQLite databases (`opencode.db`, and the `-next`/`-dev`/`-beta` variants) under its data directory, opened read-only. |
| Pi | `~/.pi/agent/sessions/**/*.jsonl`. |

A missing source means that agent has no usage; it is not an error. A record that cannot be parsed is skipped and counted in the scan's `skipped` total, which the daemon logs once per scan. A source database or file that cannot be opened or read (locked, corrupted, a read error, `zstd` missing or failing for a compressed file) logs a warning and does not update `scan_file_state`, so subsequent scans retry it. A missing `zstd` is logged once per daemon run.

### 3.2 Record model

Every source is normalized to records of: local date (`YYYY-MM-DD`, the computer's time zone), timestamp, agent, session id, model id (normalized to its canonical name, so the same model from two agents is one model), the model's company (`anthropic`, `openai`, `google`, other), and the token counts `input`, `output`, `cacheRead`, `cacheWrite`. A record counts as one message.

Canonical model normalization strips date suffixes, preview markers, effort/variant suffixes (`-xhigh`, `-high`, `-medium`, `-low`, `-minimal`, `-free`, `-thinking`, `-tiered`), and trailing parenthesized tier/role tags on Antigravity display names (such as `(High)`, `(XHigh)`, `(Thinking)`, `(Orchestrator)`). For Antigravity records:

- Router and orchestrator slugs (`gemini-default`, `auto-gemini-3`, `gemini-pro-orchestrator*`, `gemini-flash-worker-agy`) name a routing endpoint rather than a concrete billed model, so `served_model` never shadows `display_name` when `served_model` is a routing slug.
- When a step omits both a non-routing `served_model` and `display_name`, it inherits the concrete model identity of another step sharing the same `model_enum` within the same session, else falls back to concrete versioned `MODEL_PLACEHOLDER_M*` aliases.
- When `display_name` (or a routing `served_model` with no concrete `display_name`) names only an unversioned Gemini family or codename — such as `Orchestrator (Carbon)` (`carbon`), `Orchestrator (Argon)` (`argon`), `Gemini Flash` (`flash`), or future element names — it resolves to the highest-version official `gemini-<version>-<family>` model whose `release_date` is on or before the record's `date` (falling back to the earliest release of that family when all exceed `date`, to undated catalog entries only when no `release_date` exists for that family, or staying unresolved until the catalog carries that family).

A record's key comes from the source's own ids and timestamp; a record whose source gives no timestamp is keyed by its file path and line number, so a rescan never stores it twice.

**Total tokens** = `input + output + cacheRead + cacheWrite`. **Cache-hit ratio** = `cacheRead ÷ total tokens × 100`, 0 when the total is 0, shown with two decimals.

The daemon keeps an index of records under its state directory and skips unchanged files via `scan_file_state` (matching `(mtime_ms, size_bytes)`, incorporating any companion `-wal` file's mtime/size for SQLite sources); modified JSONL and AGY sources are rescanned idempotently via `INSERT OR REPLACE`, while OpenCode SQLite databases additionally filter by a dual `(rowid, time_updated)` watermark cursor. The index is a cache: deleting it only costs a full rescan.

### 3.3 Pricing

Cost is an estimate at public API prices; subscription users are not billed this way, and the pages say so.

- Prices come from `models.dev`, then LiteLLM's price list, then OpenRouter's model list, for the first source that knows the model; they are cached on disk for 24 hours (`fetchedAt` TTL). Each pricing source is fetched separately in parallel with a 30-second timeout, and the cache is written when any source succeeds (user decision, 2026-11-17). Within `models.dev`, first-party official providers (`anthropic`, `openai`, `google`, `google-vertex`, `deepseek`, `zhipuai`, `zai`, `minimax`, `moonshotai`, `xai`, `mistral`, `cohere`) take precedence over third-party resellers when populating unprefixed canonical model IDs, and first-party `release_date` metadata is retained in the disk cache. A running daemon checks the 24-hour TTL on `PricingManager.initialize()` (never permanently short-circuiting after first load) and re-fetches once stale.
- Prices are stored as stage-based **price periods** (`model_price_periods (model, effective_from, effective_to, input_rate, output_rate, cache_read_rate, cache_write_rate)` where rates are USD per million tokens), alongside known `model_releases (model, release_date)` for contemporaneous family resolution:
  - When a model has no period yet and a price source first provides price $P_1$, it is recorded with `effective_from = '0000-01-01'` and `effective_to = NULL` so it covers release-day and earlier unpriced records.
  - On subsequent syncs, unchanged prices produce no database write. When an upstream price changes from the active (`effective_to IS NULL`) period: if `active.effective_from >= today`, the active row is updated in place; otherwise the active row is closed with `effective_to = addDays(today, -1)` and a new active row opens with `effective_from = today` and `effective_to = NULL`. Earlier days continue to resolve to their historical period so past costs do not shift.
  - After every scan while prices are available, Antigravity codenames/aliases are repaired. Once per catalog (re)load that changes its entries (the first scan after the daemon starts, and the first after a 24h refresh brings new prices or release dates; an offline retry that reloads the same stale cache is not one), `model_price_periods` and `model_releases` are synced with the catalog before the scan prices new records, unversioned Antigravity family records are re-evaluated against updated release dates, and after it **all** `unpriced = 1` records across **every** agent are looked up by `(canonical_model_id, date)` (`effective_from <= date AND (effective_to IS NULL OR effective_to >= date)`) and backfilled with their period's cost and `unpriced = 0`.
  - `pigeon rebuild-cache` clears `usage_records` and `scan_file_state`, preserving `model_price_periods` and `model_releases`.
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
- **longer — week columns:** one column per Monday-based week, rows Monday to Sunday (the GitHub layout), scrolled sideways; it has no zoom (user decision, 2026-11-16).

### 3.7 Freshness and Storage

Usage is scanned on the shared schedule of §2.6 while `client.usageEnabled` is `true`, and when the usage page's Refresh asks for it (`force: true`). Requests answer from SQLite without scanning, except that a request arriving before the daemon's first scan since start has completed waits for that scan. A scan already running is shared by every caller. The former realtime mode (`client.usageScanMode`) is removed (user decision, 2026-11-17).

Scans run off the daemon's event loop (in a Worker), so a first scan or a rebuild never delays WebSocket traffic. Requests read directly from SQLite and reuse a bounded 64-entry in-memory report cache in `UsageService` keyed by `scannedAt` and query parameters (including current day/minute for live `today` comparisons), cleared after every scan or rebuild.

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
- **Antigravity orchestrator and worker steps merge into their contemporaneous canonical models** — Antigravity logs each planner and worker step separately with its display name; unversioned family labels (such as `Orchestrator (Carbon)`, `Orchestrator (Argon)`, or `Gemini Flash`) resolve to the highest-version official Gemini model of that family released on or before the record's date (user decision, 2026-11-18). Rejected: hardcoding current generation numbers or inventing separate synthetic model rows.
- **Only the windows a provider reports** — the pages once showed windows that exist in code branches but not in the user's data, which misled. Rejected: fixed window lists per provider.
- **One color rule, by used share** — two rules (pace for bars, share for numbers) put a red bar next to a yellow number. Rejected: pace-colored bars.
- **Remaining or used is a setting, not a page toggle** — the bar, the time marker and the legend all follow it, so the page never mixes the two. Rejected: a toggle on the quota page.
- **Two usage layouts, single day and period** — a special 7-day view was one more thing to learn. Rejected: per-preset layouts.
- **Only date and model as dimensions; agent is a filter** — the old overview, daily and activity views were all date trends. Rejected: an agent table.
- **Cache-hit ratio stays its own figure in Day and Model detail sheets** — kept separate rather than folded into cache-read tokens.
