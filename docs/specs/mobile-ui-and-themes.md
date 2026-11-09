# Mobile UI and Theming Specification

## 1. Principles

Pigeon is a phone app for Herdr, written as a PWA. It follows the interaction model of a native iOS chat app (Claude Code for iOS is the reference), and keeps Herdr's own structure: workspace → tab → pane.

- **A conversation, not a terminal.** The session page shows the agent's transcript (`agent-session-normalization.md`). Raw keys and the terminal screen appear only when the user asks for them (§5). No key pads, macro bars or double-tap guards on the main screens.
- **One status, one place.** A pane's status is shown by its row icon on the lists and by the title of its session page.
- **Summary first, detail on demand.** Consecutive tool calls collapse into one line; a tap opens the group, another tap the detail.
- **When the agent needs you, the composer steps aside.** A prompt card takes the composer's place (§4).
- **One-handed.** Primary actions sit at the bottom; every hit target is at least 44 × 44 px (smaller visuals extend their hit area with padding or a pseudo-element).
- **UI language.** Simplified Chinese and English, chosen per browser (§10). Labels quoted in this spec are the Chinese strings; English has an equivalent for each.

### 1.1 Viewport and keyboard
- Viewport: `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`. Chromium resizes the layout above the keyboard, so the composer stays above it without visual-viewport code.
- Safe areas use `env(safe-area-inset-*)`.

### 1.2 Text input
- The composer is a native `<textarea>` that grows smoothly with content up to 280px (approx. 12 lines) with internal vertical scrolling and caret auto-scroll.
- **IME safety**: between `compositionstart` and `compositionend` (including system dictation) Enter never sends and the `/` list (§6.2) never opens.
- Enter outside composition sends on a hardware keyboard only; on a touch device Enter inserts a newline and the send button sends.
- **Drafts** are kept per pane in `localStorage` and survive reloads, offline periods and failed sends.
- **No autofill**: the composer turns off the browser's autofill and form suggestions (`autocomplete="off"` and the matching attributes), so a mobile browser does not show its password, address or card bar above the keyboard where it honours them.
- **Voice**: Pigeon records no audio. Voice input is the system keyboard's dictation.

## 2. Home

### 2.1 Workspaces (the start screen)
- Top left, the bionic pigeon logo mark (a compact 34×34px SVG `<Logo />` with subtle rounded border and gradient backdrop). Top right, one glass capsule with **filter** (§2.3), **quota** (§11.1) and **settings** (§8.1). There is no ☰, no device row, no tab bar, no pane row and no drawer.
- An **所有 Agent** summary row (count of agents, and of those waiting) opens §2.2.
- One collapsible group per Herdr workspace, in Herdr's order. The group header shows the workspace name, its git branch when it has one, and its tab count; its `+` opens a new session (§7.1) in that workspace. Collapsed state is kept in this browser.
- One row per tab. The left icon is the tab's status (its primary pane's): amber dot = waiting for you (`blocked`), spinner = working, check = done, hollow circle = idle, `>_` = plain terminal. The title is the tab label (`protocol.md` §5.3: the Herdr name the user gave the tab, else the session's title, else the agent's name); the subtitle names the agent and, when the tab has more than one pane, the pane count.
- A blue dot marks a tab whose agent finished (`done`) while this browser was not viewing it. Viewing the pane clears the mark, and the mark of a pane that no longer exists is dropped. Kept in this browser only. The status icon itself follows the daemon's seen mark (`herdr-adapter.md` §4): once any phone has viewed a finished pane, it shows idle.
- Swiping a row left reveals **重命名** and **关闭**; both use the same flows as the ⋯ menu (§6.1, §6.4).
- Bottom left, a search button filters rows by tab label and workspace name. Bottom right, a **新会话** button opens §7.1 for the workspace Herdr has focused.
- While the daemon or Herdr is unreachable, the connection banner (§8.3) sits above the list.

### 2.2 All agents
The header's glass capsule holds **quota** (§11.1) left of **filter**. Every pane with an agent, across workspaces, grouped by status in this order: **等待你** → **工作中** → **已完成** → **空闲**. Every group starts expanded each time the page opens; a group header collapses or expands its group, and its chevron points down when expanded and right when collapsed. Each row shows the tab label as its title; the subtitle shows the agent as a tinted label, then the workspace with a folder icon in muted text, so the two read apart at a glance. A waiting row adds one amber line saying what it waits for (the pane's summary). A tap opens that session; back returns here.

### 2.3 Filter
A sheet shared by §2.1 and §2.2: status (等待你, 工作中, 已完成, 空闲, 终端), agent kind, and display options (show plain terminals, show idle tabs). While a filter is active the filter button carries a dot. Stored in this browser's `localStorage` only, never synced.

## 3. Session page

### 3.1 Layout
- A glass header: back, the session title (prioritizes named tab labels, falling back to the agent session's title, then agent recipe name per `protocol.md` §5.3; a spinner while working, an amber dot while waiting), the pane in the subtitle when the tab has several, and ⋯ (§6.1). Tapping the title switches pane when there are several (§6.8).
- The body is the transcript (§3.2) when the pane has a structured session, else the screen cards (§3.6). A plain terminal tab shows the terminal view (§5) as its body.
- The composer (§6) floats at the bottom.

#### Transcript Cache
- **Store**: IndexedDB database `pigeon`, object store `paneCache`, keyed by `paneId`. Each entry holds `{ paneId, sessionId, savedAt, lastAccess, turns, sessionStats, sessionTitle, todos, session }`. Drafts and preferences stay in `localStorage`.
- **Eviction**:
  - TTL 7 days from `savedAt`;
  - LRU by `lastAccess`, at most 10 panes;
  - expired entries are swept at startup;
  - entries for panes absent from a snapshot are deleted, but only from a snapshot taken while `herdrConnected` is true, so a Herdr outage does not wipe the cache.
- **Restore**: opening a pane shows its cached transcript immediately if the entry's `sessionId` is the pane's current session as far as the client knows. While cached content is on screen, the header shows a "syncing" indicator (small spinner and "同步中 / Syncing" text). It clears when the server's first answer for that pane (`normalized_turns` or the resume `turns_delta`) arrives. The cache survives reloads; a pane opened after a reload is restored from it.
- **Invalidation**: the server's answer names a different `sessionId`, or `session.bound` is false → the cached entry is deleted and the fresh data shown.
- **Writes**, and only these:
  - when leaving a pane;
  - on `visibilitychange` to `hidden` and on `pagehide`;
  - when the active pane's `agentStatus` leaves `working` (end of a streamed answer);
  - after a full `normalized_turns`.
  No write per `turns_delta`.

### 3.2 Messages
- A user message is a right-aligned bubble; attachments show as thumbnails above it.
- Assistant text is GitHub-flavored Markdown laid out on the page, not in a card: headings, lists, inline code, code blocks with a copy button, links that open outside the app. Tables keep their column widths and scroll horizontally (`display:block; overflow-x:auto; white-space:nowrap`).
- The last reply of a finished turn has a copy button.
- Reasoning collapses to one line, "思考了 N 秒" (or "思考" when no duration is known); a tap shows the full text.
- Agent output is untrusted: Markdown is sanitized (`architecture.md` §5).

### 3.3 Tool calls
- Consecutive tool calls of a turn collapse into one summary line that counts them by verb, e.g. "读取了 4 个文件，编辑了 3 个文件", with the added/removed line totals of its edits. A group of one shows that call's own icon and label and opens its detail directly.
- **Group sheet**: the summary as its title, then a timeline of the calls. Each item shows its verb (运行, 编辑, 创建, 读取, 搜索, or the tool name) and its object; a command shows the agent's own description of it when the transcript has one, else the command.
- **Detail** (pushed inside the sheet, with back instead of close):
  - Command: description, command (wrapped, copyable), output (monospace, wrapped, copyable, truncated with "展开" past 40 lines), then exit code and duration; a non-zero exit code is red.
  - Edit / write: the file path (copyable) and the change as a diff with line numbers and add/remove bars. Diff lines do not wrap; the block scrolls horizontally.
  - Other tools: parameters above, result below.

### 3.4 Todo
When the session has a todo list (`agent-session-normalization.md` §3), a capsule at the bottom left shows "done/total"; a tap opens a sheet with every item and its state. A todo update in the transcript shows as one line "☰ 任务 n/m" that opens the same sheet. Agents without a todo tool show no capsule.

### 3.5 Running state and scrolling
- While working, the last turn ends with an animated "思考中…" line, and the send button becomes **■ 停止**.
- **Stop** sends the recipe's `interruptKeys` (Esc for agents, Ctrl+C for a plain terminal) at once, without confirmation.
- A message sent while the agent is working is queued by the daemon (`protocol.md` §4.2). Queued messages show as dashed bubbles below the last turn, each with **编辑** and **撤销**; they are sent in order when the turn ends. **编辑** shows only while the composer is on screen: while a prompt card hides the composer, only **撤销** shows. **编辑** takes the message out of the queue (`protocol.md` §4.13) and puts its text and attachments into the composer, replacing nothing the user has typed (the text is inserted at the caret); sending it again queues it at the end (user decision, 2026-11-07). When the message was already sent, the phone says so and leaves the composer unchanged.
- New content scrolls the page to the bottom only when the page was within 40 px of the bottom. Otherwise a round ↓ button appears above the composer and scrolls to the newest message.

### 3.6 Screen-card fallback
A pane with an agent but no bound session shows the classified screen cards (`herdr-adapter.md` §8.1) in the same message style: markdown text, tool lines, diffs, thoughts.

## 4. Prompt cards

When the pane has a `pendingInteraction` (`protocol.md` §5.4), a floating card replaces the composer, the header shows the amber dot and, if this phone is not viewing the pane, a push is sent (`push.md`).

### 4.1 Permission
- Title "需要授权", the question, and the tool call it is about when the transcript has it pending: the command, or a mini diff for an edit (a tap opens §3.3's detail).
- One button per numbered option, labels and order exactly as on screen. A tap sends that option (`interaction_respond`); the button shows "发送中…" and further taps do nothing until the answer is acked. The card goes away when the prompt leaves the screen.
- An option whose label asks to tell the agent something ("No, and tell …") is sent, then the composer returns with focus so the user can write the reason.
- **在终端中处理** opens the terminal view (§5). So does an ack with `approved: false`.

### 4.2 Questions
When the transcript has a pending question tool call (Claude `AskUserQuestion`), the card uses it: a large question title, options as "label + description", and **其他…** last, which sends the screen's own "other" option and then focuses the composer. **其他…** is shown only when the screen has such an option, and like **提交** it works only for the question on screen. With several questions the card pages with "‹ 1/4 ›"; the last page's button is **提交**. **下一题** stays disabled until an option is picked. ✕ collapses the card into a capsule "n 个问题等你回答" above the composer, which reopens it.
Answers are sent as the screen's numbered options: the card matches the current screen prompt to its question by text and sends the digit of the option with the same label. A label matches exactly first; a prefix match counts only when exactly one screen option has that prefix, and anything else opens the terminal view instead of guessing. A multi-select question offers **在终端中处理** in place of **提交**. Without a transcript question, the card is the plain §4.1 card.

### 4.3 Plan approval
When the transcript has a pending plan tool call (Claude `ExitPlanMode`), the card shows the plan as Markdown, faded past the card height with **全文** to read it in a sheet, and the screen's options as buttons. An option that asks to keep planning returns the composer like §4.1.

### 4.4 No numbered options
A prompt without numbered options, or `blocked` with nothing recognized, shows its question (or "Agent 在等待") and **在终端中处理** only.

## 5. Terminal view

- Reached only from a prompt card's **在终端中处理** or the ⋯ menu's **查看终端**. It is a sheet with the pane's current screen (`pane_state.rawScreen`, monospace, no wrapping) and a key row: ↑ ↓ ← → Enter Esc Tab Ctrl+C, plus the prompt's `fallbackKeys`.
- Keys go through `agent_send_keys`. Desktop focus is never moved.
- A plain terminal tab's session page is this view, and its composer sends command lines (`agent_prompt`).

## 6. Composer and session actions

### 6.1 Composer
- Collapsed: a glass capsule with `+`, a text field and send. Focused: attachment thumbnails, the model capsule (§6.4) and send.
- **+ sheet**: 相机, 照片, 文件 (the system pickers; files are uploaded at once, `protocol.md` §7), **Skills 与命令** (§6.3), **从历史会话恢复** (§7.2).
- Sending with attachments passes their upload ids; the daemon writes them into the prompt (`protocol.md` §4.2).

### 6.2 `/` at line start
Typing `/` as the first character of a line (outside IME composition) opens a popover above the composer with the same list as §6.3, filtered by what follows. Choosing an entry replaces the `/…` text with the entry's `invocation` followed by a space; it stays editable text.

### 6.3 Skills and commands
A sheet of the pane's entries (`protocol.md` §5.7), grouped by source: 项目 → 用户 → 插件 → 命令, with segment buttons to narrow. Each row shows the name and description. Choosing one inserts its invocation into the composer.

### 6.4 Model and effort
A sheet listing every model of the recipe (`herdr-adapter.md` §7.1) with a search field that filters by id and label, and, for the chosen model, its effort levels. A refresh button asks the daemon to read the agents' model lists again (`protocol.md` §4.14). The model capsule is shown for every agent pane, even while its list is empty. It shows the current values and their source: **启动参数** (from Pigeon's launch), **日志** (the transcript names the model) or **未知**. Changing them sends the recipe's runtime command as a prompt (`protocol.md` §4.9); when the agent has no such command the sheet says that the value can be chosen in a new session (or, for an agent that takes no model at launch either, only inside the agent) and changes nothing.

### 6.5 ⋯ menu
重命名 (renames the Herdr tab), 复制分支 (copies the tab's git branch; shown when there is one), 本会话的变更 (§6.6), 切换 pane (shown with several panes, §6.8), 查看终端 (§5), and **关闭会话** in red (§6.7).

### 6.6 Session changes
Every edit in the session's transcript, summed per file: path, added and removed lines. A tap expands that file's diffs in place (§3.3 diff view). Empty when the pane has no bound session.

### 6.7 Close
A confirmation sheet that states: the tab on the computer will close, which programs end (each pane's agent or shell), and whether one is working. It also says the agent's session log is kept. Confirming sends `close_tab`; the page then returns where the session was opened from (Home or 所有 Agent).

### 6.8 Switch pane
A sheet listing the tab's panes (agent or shell, status). The session page defaults to the tab's first pane with an agent. Switching never changes the desktop.

## 7. New session

### 7.1 New
A blank session page: segments **新建 / 恢复**, chips for **工作区** (Herdr's workspaces; preset from where it was opened), **Agent** (recipes) and **模型** (with effort; only for an agent that takes a model at launch, `protocol.md` §5.7), then the composer for the first message. Sending creates the tab with the first message (`protocol.md` §4.5) and opens it; the title starts as the first message and can be renamed. Creating a Herdr workspace is not offered.

### 7.2 Resume
The **恢复** segment (also reached from `+`) lists the agent's past sessions for the chosen workspace's folder (`protocol.md` §4.10): title or first message, and age. A tap opens a new tab that resumes it (`protocol.md` §4.5 `resumeSessionId`) and goes there. Resuming always opens a new tab.

## 8. Settings, pairing and connection

### 8.1 Settings (gear on home)
- **外观**: 跟随系统 / 浅色 / 深色; **降低透明度** (§9.2); **强调色**.
- **语言**: 跟随系统 / 中文 / English (§10).
- **额度与用量** (§11.4): rows **订阅额度** and **Token 用量** open §11.2 and §11.3, each with a live one-line summary; **额度显示** 剩余 / 已用; **列表页显示额度按钮**; and under **查询额度的服务** one switch per quota provider.
- **通知**: the push switches (`push.md` §5). Until delivery exists they are shown disabled with the note "推送投递尚未接通".
- **设备与配对**: the connection to the computer and to Herdr; paired devices, newest paired first, each with **移除** (revokes at once, `protocol.md` §4.12). The five newest show; any others sit behind one row that expands them; how to pair another phone (`pigeon pair` on the computer).
- **关于**: version; install-as-app hint.

### 8.2 Unpaired
Without a valid pairing only the pairing guide shows: scan the QR code from `pigeon pair`. It does not reconnect in a loop. Opening `/pair#code=…` pairs and goes to home (`security-and-pairing.md` §2).

### 8.3 Connection
- Daemon unreachable or Herdr offline: a banner at the top ("电脑未连接" / "Herdr 没有响应"), retried every 3 s, gone when back.
- A failed send keeps the draft and shows a toast with the reason.
- A new client build shows **有新版本 · 重新加载** (`architecture.md` §4.1).

## 9. Themes

### 9.1 Appearance
- Two palettes, light and dark; **跟随系统** follows `prefers-color-scheme`. No third-party branding.
- **Accent** (blue, purple, green, orange, pink) drives buttons, links and the working state. Waiting is always amber; errors red.
- Components use semantic tokens only: `--bg`, `--surface`, `--elev`, `--fg`, `--muted`, `--faint`, `--line`, `--accent`, `--onaccent`, `--accentbg`, `--warn`, `--warnbg`, `--danger`, `--addbg`, `--addfg`, `--delbg`, `--delfg`, `--code`.
- Data colors for the quota and usage pages (§11) are tokens too, each with a light and a dark value: one per agent (`--agent-claude`, `--agent-codex`, `--agent-agy`, `--agent-opencode`, `--agent-pi`), one per model company (`--co-anthropic`, `--co-openai`, `--co-google`, `--co-other`), the figure colors (`--fig-tokens`, `--fig-cost`, `--fig-input`, `--fig-output`, `--fig-cache`, `--fig-hit`), the two five-step heatmap scales (`--heat-tokens-1…5`, `--heat-cost-1…5`) and `--heat-empty`. The light values are darker than the dark ones so text in these colors keeps 4.5:1 on `--surface`; the heatmap scales are shared by both palettes, only `--heat-empty` differs.
- Text tokens meet WCAG AA: `--fg`, `--muted` and `--faint` reach 4.5:1 against `--bg` in both palettes.
- The theme is applied before first paint from `localStorage` (keys `pigeon_mode`, `pigeon_accent`), so the page never flashes the wrong palette.
- The document shell declares `<meta name="color-scheme" content="light dark">` and critical inline background and color styling on `html` and `body` in `<head>` so the browser canvas initializes to dark mode without a white flash before scripts execute. The pre-paint script and `applyTheme` synchronize `colorScheme` alongside `data-theme`.

### 9.2 Liquid Glass
- Glass is used only on the floating control layer: header buttons and capsules, the composer, the todo capsule, the ↓ button, menus, sheets, prompt cards and the `/` popover. Messages and lists stay opaque.
- Glass = a translucent fill with `backdrop-filter: blur() saturate()`, a light inner top edge, a dark inner bottom edge, and a soft diagonal highlight. The session header is a progressive blur fading into the content rather than a bar.
- WebKit cannot refract inside `backdrop-filter`, so there is no lens distortion.
- **降低透明度** replaces every glass surface with an opaque `--elev` surface. It defaults to on when `prefers-reduced-transparency: reduce` matches. Stored in this browser.

## 10. Language

### 10.1 Choosing the language
- The setting (§8.1) is **跟随系统**, **中文** or **English**, stored in this browser's `localStorage` (key `pigeon_locale`) and never synced to other phones.
- **跟随系统** walks the browser's preferred languages (`navigator.languages`) in order and takes the first one Pigeon has: a `zh` tag gives Chinese, an `en` tag English. When none matches, the UI is English.
- `<html lang>` follows the language in use (`zh-CN` or `en`), and a change applies at once without a reload.

### 10.2 What is translated
- Every string the PWA shows itself: labels, buttons, notes, empty states, toasts, error messages (`protocol.md` §8) and relative times ("2 小时前" / "2 hours ago").
- Text the daemon would otherwise compose is sent as data and rendered by the phone: built-in command descriptions (`protocol.md` §5.7), the pane summary of a running command or thinking (§5.3), the title of a prompt that carries none (§5.4), and push text (`push.md` §4).
- Not translated: anything the agent or the terminal wrote (transcripts, screen text, prompt questions and options), names (workspaces, tabs, agents, models), and the CLI on the computer.

### 10.3 Adding a language
- Each language is one dictionary of messages keyed by the same ids, plus one entry in the list of languages. English is the reference: it has every message.
- Another language may lack messages; a missing message shows the English text, never the id.
- A message's placeholders are named (`{count}`, `{name}`) and every language uses the same set. A message that depends on a count has plural forms chosen by `Intl.PluralRules`.

## 11. Quota and usage

Behavior and numbers come from `quota-and-usage.md`; this section is the presentation. The approved mockups are kept with issue #13's notes. Both pages share a header (back, the title **额度与用量** with the last refresh time, a refresh button) and a segmented **额度 | 用量** switch below it.

### 11.1 Quota button
- A gauge icon in the home capsule (left of settings) and in the All Agents capsule (left of filter); both open §11.2. **列表页显示额度按钮** hides both.
- A dot on the button: amber when any enabled provider's last snapshot has a window at level warn, red when one is exhausted (`quota-and-usage.md` §2.4); none otherwise.

### 11.2 Quota page
- One card per enabled provider, in the order Claude Code, Codex, Antigravity: the provider name in its agent color, then `plan · account` (plan omitted when there is none).
- One block per window, exactly as reported: the label (e.g. **5 小时**, **每周**, **每周 · Gemini 4 Argon**) and `重置 <time>` on one line (`Xd Yh` above a day, `Xh Ym`, else `Xm`; **未开始** at 0%); a bar; under it the primary figure, the secondary figure and the pace text.
- **额度显示** decides the direction everywhere on the page: `remaining` draws the bar as the remaining share, shows **剩余 N%** first and **已用 N%** second, and places the time marker at the share that should remain; `used` mirrors that. The legend says which (**白线 = 按时间应该剩下的位置** / **…应该用到的位置**) and links to the setting.
- Colors (`quota-and-usage.md` §2.4): the bar uses the provider's agent color at level normal, `--warn` at warn, `--danger` when exhausted; the primary figure is `--fg` at normal and the level color otherwise. Pace text: **节奏正常**, **超出 N% · 约 <eta> 后用完**, **低于节奏 N%**, muted, except **超出**, which is `--warn`. A window with no pace shows no marker.
- Reset credits, when a provider reports them, are listed under its windows with their expiry.
- A provider error shows as a red line naming the provider and the cause, above its card; the card keeps the previous snapshot. No enabled provider with data: an empty state with a link to **管理查询的服务** (§11.4).
- Under the cards: **管理查询的服务**, and one line explaining the colors.

### 11.3 Usage page
- **Range chips** at the top: **今天** (default) / **7 天** / **30 天** / **今年** / **全部** / **自定义**. **自定义** opens a bottom sheet with start and end date inputs bounded by the first day with usage and today, and **应用**; once applied, its chip shows `MM-DD ~ MM-DD`. Under the chips: the range in text, and the agent filter button (**全部 Agent** or `n/5`), which opens a sheet of the five agents with **全选**; at least one stays on, and the filter applies to the whole page.
- **按 Token | 按花费**: one page-wide switch; it decides the heatmap's scale, the list's order and the share column.
- **Figure cards**: 花费, Token, 会话, each with the change against the comparison (`quota-and-usage.md` §3.5), and one line naming what is compared (e.g. **与上周一（11-02）截至 17:33 比较**). Increase is `--danger`, decrease `--addfg`.
- **Single day** (today, or a custom range of one day): the cards, then the model list. **Period**: the cards, the heatmap, then the list with **按日期 | 按模型**.
- **Heatmap** (`quota-and-usage.md` §3.6): strip and week-row layouts fill the card width with cells labeled by date and need no zoom; the week-column layout opens at the newest week, scrolls sideways, and has **− / 适配 / +** zoom steps (cells of fit, 16, 24, 32 and 44px; dates show from 28px). The card shows active days and the current and longest streak in the range, and a five-step legend. Tapping a day with usage opens the day sheet.
- **List rows** show the full date or model name on the first line (never truncated) and, on the second, sessions (date rows) or agents (model rows), tokens, cost and the share; a bar under them shows the row against the largest. Date rows are newest first, model rows sorted by the page switch, or by cache-hit ratio when the model list's **排序** is set to **缓存命中**, which then shows **命中 N%**. Ten rows show, more load on scroll. Every row opens a sheet.
- **Day sheet**: the date and weekday; cost, tokens, input, output, cache read, cache write, cache hit, messages, sessions; then per agent its cost and its models with their figures.
- **Model sheet**: the model in its company color, the company and the range; cost, tokens, input, output, cache read, cache write, cache hit, messages, last used; per agent its tokens and cost; a small bar chart of the model's use per day in the range.
- Under the list: costs are estimates at public API prices, which subscriptions are not billed by; unpriced models and unavailable prices are named (`quota-and-usage.md` §3.3).

### 11.4 Settings group
- **订阅额度** (summary: one short item per enabled provider following **额度显示**, e.g. **Claude 5h 剩 48%**) and **Token 用量** (summary: **今日 $x · 近 7 天 $y**).
- **额度显示**: 剩余 / 已用 (`client.quotaDisplay`).
- **列表页显示额度按钮** (`client.quotaButton`).
- **查询额度的服务**: Claude Code, Codex, Antigravity, each a switch (`client.quotaProviders`) with a subtitle (**已登录 · <plan>**, or **不查询** when off).
