# Mobile UI and Theming Specification

## 1. Principles

Pigeon is a phone app for Herdr, written as a PWA. It follows the interaction model of a native iOS chat app (Claude Code for iOS is the reference), and keeps Herdr's own structure: workspace → tab → pane.

- **A conversation, not a terminal.** The session page shows the agent's transcript (`agent-session-normalization.md`). Raw keys and the terminal screen appear only when the user asks for them (§5). No key pads, macro bars or double-tap guards on the main screens.
- **One status, one place.** A pane's status is shown by its row icon on the lists and by the title of its session page.
- **Summary first, detail on demand.** Consecutive tool calls collapse into one line; a tap opens the group, another tap the detail.
- **The composer is always there** (user decision, 2026-11-11). When the agent needs you, a prompt card floats above the composer (§4); typing is never taken away.
- **One-handed.** Primary actions sit at the bottom; every hit target is at least 44 × 44 px (smaller visuals extend their hit area with padding or a pseudo-element).
- **UI language.** Simplified Chinese and English, chosen per browser (§10). Labels quoted in this spec are the Chinese strings; English has an equivalent for each.

### 1.1 Viewport and keyboard
- Viewport: `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`. Chromium resizes the layout above the keyboard; iOS does not, so the keyboard rule below covers it.
- Safe areas use `env(safe-area-inset-*)`.
- **Standalone mode**: when the app runs from the home screen (`display-mode: standalone`, or `navigator.standalone` on iOS), the root carries `data-mode="standalone"`. The composer dock sits 2 px above the bottom safe area instead of 10 px, and the home bottom bar (§2.1) 8 px instead of 20 px, so no empty band shows under them.
- **Opaque status bar** (issue #21): the page does not ask for a translucent status bar (no `apple-mobile-web-app-status-bar-style`), so a home-screen app's status bar is opaque in the page's color and the page starts below it. On iOS 26 a translucent status bar shortens the page by the status bar's height, which leaves an empty band under the bottom controls, and blurs whatever scrolls under the bar; the page can undo neither. iOS reads this setting when the app is added to the home screen, so an installed app picks it up only after it is added again.
- **Headers and the top safe area**: every page header reserves `env(safe-area-inset-top)` above its controls, and no page replaces that padding, so nothing tappable sits under the status bar. The window itself never scrolls; only a page's scroll area does, and the window returns to the top when a text field loses focus or the page changes.
- **Keyboard on iOS**: iOS shrinks only the visual viewport for the on-screen keyboard. While a text field has focus, the page is sized and placed to the visual viewport, so the header stays in view and the composer dock sits directly above the keyboard, with the 8 px dock gap and no bottom safe area. With no text field focused, the page fills the layout viewport and visual-viewport readings are ignored, since iOS 26 can leave them stale after the keyboard closes. The bar iOS shows between a field and the keyboard (previous, next, done) belongs to the system; a web page cannot hide it.
- **Back by swipe** (user decision, 2026-11-12): on every page except Home, a horizontal swipe that starts within 24 px of the left screen edge and travels right at least 80 px goes back, exactly like the header's back button, so a page whose back button is out of reach never traps the user. A swipe that starts inside a horizontally scrolling element (range chips, tables, code blocks, diffs) scrolls that element instead.
- **Text size**: the document sets `text-size-adjust: 100%` (and `-webkit-text-size-adjust`), so WebKit never enlarges some lines of a code block, a diff or a list.

### 1.2 Text input
- The composer is a native `<textarea>` that grows smoothly with content up to 280px (approx. 12 lines) with internal vertical scrolling and caret auto-scroll.
- **IME safety**: between `compositionstart` and `compositionend` (including system dictation) Enter never sends and the `/` list (§6.2) never opens.
- Enter outside composition sends on a hardware keyboard only; on a touch device Enter inserts a newline and the send button sends.
- **Drafts** are kept per pane in `localStorage` and survive reloads, offline periods and failed sends.
- **No autofill**: the composer turns off the browser's autofill and form suggestions (`autocomplete="off"` and the matching attributes), so a mobile browser does not show its password, address or card bar above the keyboard where it honours them. The composer is not inside a `<form>`.
- **Paste**: pasting images into the composer uploads them as attachments (`protocol.md` §7), exactly like the + sheet's pickers; pasting an upload file path or image creates an attachment thumbnail card (56×56px image preview with remove button) above the textarea; other pasted text stays text.
- **Voice**: Pigeon records no audio. Voice input is the system keyboard's dictation.

## 2. Home

### 2.1 Workspaces (the start screen)
- The header's top padding is the same as every page header's (§1.1), and the gaps below it are kept tight.
- Top left, the bionic pigeon logo mark (a compact 34×34px SVG `<Logo />` with subtle rounded border and gradient backdrop). Top right, one glass capsule with **filter** (§2.3), **quota** (§11.1) and **settings** (§8.1). There is no ☰, no device row, no tab bar, no pane row and no drawer.
- An **所有 Agent** summary row (count of agents, and of those waiting) opens §2.2.
- One collapsible group per Herdr workspace, in Herdr's order. The group header shows the workspace name, its git branch when it has one, and its tab count; its `+` opens a new session (§7.1) in that workspace. Collapsed state is kept in this browser.
- One row per tab. The left icon is the agent or shell avatar (`<AgentIcon>`: official Antigravity arch, Claude 8-bit crab, Codex rosette, OpenCode box, Pi mark, or skeumorphic terminal window with traffic lights and prompt). The title is the tab label (`protocol.md` §5.3: the Herdr name the user gave the tab, else the session's title, else the agent's name). The subtitle shows the primary pane's model (`protocol.md` §5.3 `model`, named as in §6.4) and, when the tab has more than one pane, the pane count, joined by ` · `; without a known model only the pane count shows. A plain terminal keeps its program as subtitle.
- The row's right end holds the single status dot (`<StatusIcon>`: amber dot = waiting for you / `blocked`, blue pulsing dot = `working`, green dot `#10b981` = finished / `done`, subtle gray dot = `idle` / plain terminal). Session status is indicated purely by this dot's color: an agent that finishes shows green (`done`) waiting to be read; viewing the pane reports presence to the daemon (`herdr-adapter.md` §4), which marks it seen and transitions it to gray (`idle`). No separate unread dot is shown.
- Swiping a row left reveals **重命名** and **关闭**; both use the same flows as the ⋯ menu (§6.1, §6.4).
- Bottom left, a search button filters rows by tab label and workspace name. Bottom right, a **新会话** button opens §7.1 for the workspace Herdr has focused.
- While the daemon or Herdr is unreachable, the connection banner (§8.3) sits above the list.
- Home and All Agents view no pane (`protocol.md` §4.4 `paneId: null`), so the daemon polls nothing for them.

### 2.2 All agents
The header holds **quota** (§11.1) and **filter** (§2.3).
- **By Status** (default, selected via filter sheet §2.3): Every pane with an agent, grouped by status in urgency order: **等待你** → **工作中** → **已完成** → **空闲**.
- **By Workspace** (selected via filter sheet §2.3): Grouped by Herdr workspace, with workspaces and items sorted by status urgency priority (`blocked` → `working` → `done` → `idle`).
- Every group starts expanded each time the page opens; a group header collapses or expands its group, and its chevron points down when expanded and right when collapsed. Each row shows the agent's icon, the tab label as title, and a subtitle with workspace folder and model tag (flex allocation prioritizes workspace folder visibility over model label when space is tight). A waiting row adds one amber line saying what it waits for (the pane's summary). A tap opens that session; back returns here.

### 2.3 Filter
A sheet shared by §2.1 and §2.2: status (等待你, 工作中, 已完成, 空闲, 终端), agent kind, grouping (按状态 / By Status default, or 按工作区 / By Workspace), and display options (show plain terminals, show idle tabs). The filter button stays clean without an indicator dot; when filters are active the filter sheet provides a reset action to restore defaults. Stored in this browser's `localStorage` only, never synced.

## 3. Session page

### 3.1 Layout
- A glass header bar with a hairline at its bottom edge; content scrolling under it is blurred and never shows through as legible text. It holds back (hit area 44 × 44 px), the session title (prioritizes named tab labels, falling back to the agent session's title, then agent recipe name per `protocol.md` §5.3; a spinner while working, an amber dot while waiting), a subtitle, and ⋯ (§6.1). The subtitle is the pane's model (named as in §6.4) and thinking level joined by ` · ` (`protocol.md` §5.6 `session.model`, `session.thinking`; an unknown value is left out, and the line when both are), preceded by the pane's name when the tab has several panes. Tapping the title switches pane when there are several (§6.8).
- The body is the transcript (§3.2) when the pane has a structured session, else the screen cards (§3.6). A plain terminal tab shows the terminal view (§5) as its body.
- The composer (§6) floats at the bottom.

#### Pane views in memory
- The client keeps the view of up to 10 recently viewed panes in memory: turns (light form, `agent-session-normalization.md` §3.3), `seq`, status, queue, prompt card and scroll position; `pane_tail` (`protocol.md` §5.10) fills views of working and waiting panes the phone is not viewing.
- **Switching** to a pane swaps its view in synchronously: no empty or loading frame. Before any server data, the header's status comes from the latest `snapshot_update`, never from the previous pane. The bootstrap (`protocol.md` §3.3) is then applied in place, keyed by `turnId`, so turns that did not change keep their DOM (and an expanded reasoning stays expanded). Rendered Markdown is cached by its source text.
- Sticking to the bottom happens in the same frame as the DOM update, once per bootstrap.
- Tool and reasoning details (`protocol.md` §4.20) live in memory only; offline they are not available (user decision, 2026-11-10).
- Each switch records `performance.mark`/`measure` entries for its phases (view swap, bootstrap received, bootstrap applied), with the bootstrap's `serverMs`.

#### Transcript Cache
- **Store**: IndexedDB database `pigeon`, object store `paneCache`, keyed by `paneId`. Each entry holds `{ paneId, sessionId, seq, savedAt, lastAccess, turns, sessionStats, sessionTitle, todos, session }` in the light form. It restores views after a reload; switching never waits for it. Drafts and preferences stay in `localStorage`.
- **Eviction**:
  - TTL 7 days from `savedAt`;
  - LRU by `lastAccess`, at most 10 panes;
  - expired entries are swept at startup;
  - entries for panes absent from a snapshot are deleted, but only from a snapshot taken while `herdrConnected` is true, so a Herdr outage does not wipe the cache.
- **Restore**: opening a pane that has no view in memory shows its cached transcript as soon as it is read, if the entry's `sessionId` is the pane's current session as far as the client knows. While cached content is on screen, the header shows a "syncing" indicator (small spinner and "同步中 / Syncing" text). It clears when the server's first answer for that pane (`normalized_turns` or the resume `turns_delta`) arrives. The cache survives reloads; a pane opened after a reload is restored from it.
- **Invalidation**: the server's answer names a different `sessionId`, or `session.bound` is false → the cached entry is deleted and the fresh data shown.
- **Writes**, and only these, each saving the pane's view with its prompt queue:
  - when leaving a pane;
  - on `visibilitychange` to `hidden` and on `pagehide`;
  - when the active pane's `agentStatus` leaves `working` (end of a streamed answer).
  Nothing is written while turns stream in, and reading an entry does not write it back: `lastAccess` is kept in memory and saved with the next write.

### 3.2 Messages
- A user message is a right-aligned bubble; attachments show as thumbnails above it. A tap on an image thumbnail opens the image full-screen inside the app (pinch to zoom; a tap or ✕ closes it). The page never navigates away for it, because a page opened outside the home-screen app does not carry its session cookie.
- Assistant text is GitHub-flavored Markdown laid out on the page, not in a card: headings, lists, inline code, code blocks with a copy button, links that open outside the app. Tables keep their column widths and scroll horizontally (`display:block; overflow-x:auto; white-space:nowrap`).
- The last reply of a finished turn has a copy button and its time (`agent-session-normalization.md` §3 `updatedAt`): `HH:mm` on the same day, else `MM-DD HH:mm`.
- An agent error (`agent-session-normalization.md` §3, item `error`) shows in its turn as one line in `--danger` with the agent's own text, for example "You've hit your session limit · resets 4:40pm". Pigeon adds no explanation of its own.
- Reasoning collapses to one line, "思考了 N 秒" (or "思考" when no duration is known); a tap shows the full text.
- Agent output is untrusted: Markdown is sanitized (`architecture.md` §5).

### 3.3 Tool calls
- Consecutive tool calls of a turn collapse into one summary line that counts them by verb, e.g. "读取了 4 个文件，编辑了 3 个文件", with the added/removed line totals of its edits. A group of one shows that call's own icon and label and opens its detail directly.
- **Group sheet**: the summary as its title, then a timeline of the calls. The sheet shows a scroll indicator, and while it is not scrolled to its end a round ↓ button scrolls to the last call. Each item shows its verb (运行, 编辑, 创建, 读取, 搜索, or the tool name) and its object; a command shows the agent's own description of it when the transcript has one, else the command.
- **Detail** (pushed inside the sheet, with back instead of close):
  - Command: description, command (wrapped, copyable), output (monospace, wrapped, copyable, truncated with "展开" past 40 lines), then exit code and duration; a non-zero exit code is red.
  - Edit / write: the file path (copyable, displayed with reverse truncation anchored to the file name so the tail is always visible and leading paths truncate first) and the change as a diff with line numbers and add/remove bars. Diff lines do not wrap; the block scrolls horizontally.
  - Other tools: parameters above, result below.

### 3.4 Todo
When the session has a todo list (`agent-session-normalization.md` §3), a capsule at the bottom left shows "done/total"; a tap opens a sheet with every item and its state. A todo update in the transcript shows as one line "☰ 任务 n/m" that opens the same sheet. Agents without a todo tool show no capsule.

### 3.5 Running state and scrolling
- While working, the last turn ends with an animated "思考中…" line, and the send button becomes **■ 停止**.
- **Stop** sends the recipe's `interruptKeys` (Esc for agents, Ctrl+C for a plain terminal) at once, without confirmation.
- A message sent while the agent is working is queued by the daemon (`protocol.md` §4.2). Queued messages show as dashed bubbles below the last turn, each with **编辑** and **撤销**; they are sent in order when the turn ends. **编辑** loads the message's text and attachments into the composer for in-place editing; the draft that was in the composer is kept aside and comes back when the edit is submitted or abandoned. The message remains in the server queue at its original position (`protocol.md` §4.14). Submitting the updated prompt sends `queue_update` to update the queued item in-place without altering queue order or advancing newer items. When the message was already sent before the update, the phone says so and the edited text stays in the composer as an ordinary draft; a cancel that comes too late is reported the same way.
- While the pane's queue is paused after an agent error (`protocol.md` §4.2), the queued bubbles show **已暂停**, and the first one offers **继续发送**, which sends `queue_resume` (`protocol.md` §4.22).
- New content scrolls the page to the bottom only when the page was within 40 px of the bottom. Otherwise a round ↓ button appears above the composer and scrolls to the newest message. It sits at least 32 px above the composer's top edge, so a thumb reaching for it cannot hit the send button.

### 3.6 Screen-card fallback
A pane with an agent but no bound session shows the classified screen cards (`herdr-adapter.md` §8.1) in the same message style: markdown text, tool lines, diffs, thoughts. While waiting for the initial screen data (`!paneLoaded`), the view displays "正在读取这个 pane… / Reading this pane…". Once the initial screen state has loaded and no cards could be classified, the view displays the terminal raw screen fallback or an empty-session state ("无结构化会话") with an "打开终端 / Open terminal" button, rather than continuing to display "Reading this pane…".

## 4. Prompt cards

When the pane has a `pendingInteraction` (`protocol.md` §5.4), a floating card appears above the composer, which stays mounted and usable, the header shows the amber dot and, if this phone is not viewing the pane, a push is sent (`push.md`). Text sent from the composer goes to the pane like any prompt; while Herdr reports `blocked`, Herdr refuses it (`ERR_AGENT_BLOCKED`, `protocol.md` §4.2), and the phone shows that error and keeps the draft.

### 4.1 Permission
- Title "需要授权", the question, and the tool call it is about when the transcript has it pending: the command, or a mini diff for an edit (a tap opens §3.3's detail).
- One button per numbered option, labels and order exactly as on screen. A tap sends that option (`interaction_respond`); the button shows "发送中…" and further taps do nothing until the answer is acked. The card goes away when the prompt leaves the screen.
- An option whose label asks to tell the agent something ("No, and tell …") is sent, then the composer gets focus so the user can write the reason.
- **在终端中处理** opens the terminal view (§5). So does an ack with `approved: false`.

### 4.2 Questions
When the transcript has a pending question tool call (Claude `AskUserQuestion`), the card uses it, whether the interaction was recognized on screen or comes from the transcript (`protocol.md` §5.4 `source`): a large question title, options as "label + description", and **其他…** last, which sends the screen's own "other" option and then focuses the composer. **其他…** is shown only when the screen has such an option, and like **提交** it works only for the question on screen. With several questions the card pages with "‹ 1/4 ›"; the last page's button is **提交**. **下一题** stays disabled until an option is picked. ✕ collapses the card into a capsule "n 个问题等你回答" above the composer, which reopens it.
Answers to an interaction recognized on screen are sent as the screen's numbered options: the card matches the current screen prompt to its question by text and sends the digit of the option with the same label. A label matches exactly first; a prefix match counts only when exactly one screen option has that prefix, and anything else opens the terminal view instead of guessing. A transcript interaction is answered entirely in the card (user decision, 2026-11-13): each page picks one option, or several for a multi-select question; **下一题** moves to the next page once the page has a pick; **提交** on the last page, enabled once every question has a pick, sends all the picks at once (`protocol.md` §4.1 `optionIds`), and the daemon sends the agent's keys (`herdr-adapter.md` §7.2). The card offers no terminal action and no **其他…** for a transcript interaction. Without a transcript question, the card is the plain §4.1 card.

### 4.3 Plan approval
When the transcript has a pending plan tool call (Claude `ExitPlanMode`), the card shows the plan as Markdown, faded past the card height with **全文** to read it in a sheet, and the screen's options as buttons. An option that asks to keep planning focuses the composer like §4.1.

### 4.4 No numbered options
A prompt without numbered options, or `blocked` with nothing recognized, shows as a dialog over the session page with the screen's last lines, titled **错误** when they read as an agent error (error, failure, capacity, limit, quota, exception, unavailable) and **提示** otherwise, and one **关闭** button (user decision, 2026-11-13). **关闭**, a tap outside the dialog or its × closes it on this page and sends nothing to the agent; the composer stays usable underneath. A closed prompt does not show again; a new one does. The dialog offers no terminal action; the ⋯ menu's **查看终端** remains.

## 5. Terminal view

- Reached only from a prompt card's **在终端中处理** or the ⋯ menu's **查看终端**. It is a sheet with the pane's current screen (`pane_state.rawScreen`, monospace, no wrapping) and a key row: ↑ ↓ ← → Enter Esc Tab Ctrl+C, plus the prompt's `fallbackKeys`. While it is open the phone watches the pane's screen (`protocol.md` §4.21).
- Keys go through `agent_send_keys`. Desktop focus is never moved.
- A plain terminal tab's session page is this view, and its composer sends command lines (`agent_prompt`).

## 6. Composer and session actions

### 6.1 Composer
- Collapsed: a clean glass capsule with the text field and send button (the `+` button is hidden when collapsed to maximize horizontal space and avoid visual clutter). Focused: expanded multi-line textarea (min-height: 64px) for comfortable scrolling and dragging, attachment thumbnails, the bottom toolbar with the compact `+` helper button, and a full-size 44px send button. The composer has no model control: a session's model and thinking level are chosen when it is created (§6.4, §7.1) and shown in the header (§3.1).
- **+ sheet**: 相机, 照片, 文件 (the system pickers; files are uploaded at once, `protocol.md` §7), **Skills 与命令** (§6.3), **从历史会话恢复** (§7.2).
- Sending with attachments passes their upload ids; the daemon writes them into the prompt (`protocol.md` §4.2).

### 6.2 `/` at line start
Typing `/` as the first character of a line (outside IME composition) opens a popover above the composer with the same list as §6.3, filtered by what follows. Choosing an entry replaces the `/…` text with the entry's `invocation` followed by a space; it stays editable text.

### 6.3 Skills and commands
A sheet of the pane's entries (`protocol.md` §5.7), grouped by source: 项目 → 用户 → 插件 → 命令, with segment buttons to narrow. Each row shows the name and description. Choosing one inserts its invocation into the composer.

### 6.4 Model and thinking level
Chosen only when a session is created (§7.1; user decision, 2026-11-12). A running session's model and level are shown in its header (§3.1) and never changed from the phone; to use another model, the user starts a new session.
- **Picker sheet**: the agent's models (`herdr-adapter.md` §7.1). A fixed card at the top holds the chosen model: its label, its id in monospace, and its thinking levels as one row of chips that scrolls sideways when it does not fit, or **不支持** when the model has none (the model's levels are a list, empty for a model without thinking). Choosing a model in the list moves it into the card; the level is kept when the new model offers it, else the model's first level is chosen. The list scrolls under the card, which never scrolls away. The approved mockup is board C of issue #21's design canvas.
- A search field filters by id and label when the agent has more than five models. There is no provider filter.
- Each row shows the model's label and, when it has levels, their count.
- A refresh button asks the daemon to fetch this agent's list again (`protocol.md` §4.15).
- **Model names** everywhere (home and All agents rows, the 恢复 list, the session header, the picker, the usage model rows; one rule for all of them) show the model's catalog label (`herdr-adapter.md` §7.1). A model the catalog does not list shows the part of its id after the last `/`, or the whole id when it has none.

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
A blank session page: segments **新建 / 恢复**, chips for **工作区** (Herdr's workspaces; preset from where it was opened), **Agent** (recipes) and **模型** (opens §6.4's picker; only for an agent that takes a model at launch, `protocol.md` §5.7), then the composer for the first message. Sending creates the tab with the first message (`protocol.md` §4.5) and opens it; the title starts as the first message and can be renamed. Creating a Herdr workspace is not offered.

### 7.2 Resume
The **恢复** segment (also reached from `+`) lists the agent's past sessions for the chosen workspace's folder (`protocol.md` §4.10): title or first message, then the age and the model joined by ` · ` (only the age when the model is unknown). A tap opens a new tab that resumes it (`protocol.md` §4.5 `resumeSessionId`) and goes there. Resuming always opens a new tab.

## 8. Settings, pairing and connection

### 8.1 Settings (gear on home)
- **外观**: 跟随系统 / 浅色 / 深色; **降低透明度** (§9.2); **强调色**.
- **语言**: 跟随系统 / 中文 / English (§10).
- **额度与用量** (§11.4): rows **订阅额度** and **Token 用量** open §11.2 and §11.3, each with a live one-line summary; **额度显示** 剩余 / 已用; **列表页显示额度按钮**; and under **查询额度的服务** one switch per quota provider.
- **通知**: the push switches **等你确认** and **完成时** (`push.md` §6). Turning one on asks for notification permission from that tap and subscribes this device. They are disabled, with a note, in a plain HTTP mode ("需要 HTTPS（Tailscale Serve）"), on iOS outside the home-screen app ("添加到主屏幕后可用"), and when permission was denied ("通知权限已被拒绝").
- **设备与配对**: the connection to the computer and to Herdr; paired devices, newest paired first, each with **移除** (revokes at once, `protocol.md` §4.12). The five newest show; any others sit behind one row that expands them; how to pair another phone (`pigeon pair` on the computer).
- **关于**: the version with its environment (`architecture.md` §4.8): `0.1.8`, `0.1.8 (dev)` or `0.1.8 (test:4101)`; install-as-app hint.

### 8.2 Unpaired
Without a valid pairing only the pairing guide shows: scan the QR code from `pigeon pair`. It does not reconnect in a loop. Opening `/pair#code=…` pairs and goes to home (`security-and-pairing.md` §2).
- A pairing request that fails without an answer (network down, daemon restarting) shows the error with **重试**; the code is kept until the daemon accepts or refuses it.
- In an in-app browser (WeChat, QQ, Weibo, Telegram, Line, Facebook, Instagram, recognized by user agent) the page sends no pairing request, so a single-use code is not spent in a browser the user then leaves. It asks to open the link in Safari or Chrome and offers to copy it.

### 8.3 Connection
- Daemon unreachable or Herdr offline: a banner at the top ("电脑未连接" / "Herdr 没有响应"), retried every 3 s, gone when back.
- A failed send keeps the draft and shows a toast with the reason.
- A new client build shows **有新版本 · 重新加载** (`architecture.md` §4.1).
- Close code `4409` (incompatible protocol) shows **应用版本过旧 · 重新加载** and does not reconnect (`protocol.md` §2.2).

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
- Glass = a translucent fill with `backdrop-filter: blur() saturate()`, a light inner top edge, a dark inner bottom edge, and a soft diagonal highlight. The session header is a glass bar with a bottom hairline (§3.1).
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

Behavior and numbers come from `quota-and-usage.md`; this section is the presentation. The approved mockups are kept with issue #13's notes. Both pages share a header (back, the title **额度与用量** with the last refresh time, a refresh button; the standard page header with the top safe area of §1.1) and a segmented **额度 | 用量** switch below it.

### 11.1 Quota button
- A gauge icon in the home capsule (left of settings) and in the All Agents capsule (left of filter); both open §11.2. The button shows when both `client.quotaUsageEnabled` and `client.quotaButton` are on (`architecture.md` §4.7); when either is off the button is hidden on both pages.
- A dot on the button: amber when any enabled provider's last snapshot has a window at level warn, red when one is exhausted (`quota-and-usage.md` §2.4); none otherwise.

### 11.2 Quota page
- One card per enabled provider, in the order Claude Code, Codex, Antigravity: the provider name in its agent color, then `plan · account` (plan omitted when there is none).
- One block per window, exactly as reported: the label (e.g. **5 小时**, **每周**, **每周 · Gemini 4 Argon**) and `重置 <time>` on one line (`Xd Yh` above a day, `Xh Ym`, else `Xm`; **未开始** at 0%); a bar; under it the primary figure, the secondary figure and the pace text.
- **额度显示** decides the direction everywhere on the page: `remaining` draws the bar as the remaining share, shows **剩余 N%** first and **已用 N%** second, and places the time marker at the share that should remain; `used` mirrors that. The legend says which (**白线 = 按时间应该剩下的位置** / **…应该用到的位置**) and links to the setting.
- Colors (`quota-and-usage.md` §2.4): the bar uses the provider's agent color at level normal, `--warn` at warn, `--danger` when exhausted; the primary figure is `--fg` at normal and the level color otherwise. Pace text: **节奏正常**, **超出 N% · 约 <eta> 后用完**, **低于节奏 N%**, muted, except **超出**, which is `--warn`. A window with no pace shows no marker.
- Reset credits, when a provider reports them, are listed under its windows with their expiry.
- A provider error shows as a red line naming the provider and the cause, above its card; the card keeps the previous snapshot. No enabled provider with data: an empty state with a link to **管理查询的服务** (§11.4).
- Loading state: while querying initial quota, the page renders pulsing skeleton cards for enabled providers with a loading spinner and message, hiding the empty state until loading finishes. The header subtitle reflects the server's actual fetch timestamp.
- Under the cards: **管理查询的服务**, and one line explaining the colors.

### 11.3 Usage page
- Loading state: while querying initial usage report, the page renders skeleton figure cards, a skeleton heatmap placeholder, and skeleton list rows with a loading spinner and message, hiding the empty state until loading finishes. The header subtitle reflects the server's actual scan completion timestamp (`scannedAt`).
- **Range chips** at the top: **今天** (default) / **7 天** / **30 天** / **今年** / **全部** / **自定义**. **自定义** opens a bottom sheet with start and end date inputs bounded by the first day with usage and today, and **应用**; once applied, its chip shows `MM-DD ~ MM-DD`. Under the chips: the range in text, and the agent filter button (**全部 Agent** or `n/5`), which opens a sheet of the five agents with **全选**; at least one stays on, and the filter applies to the whole page.
- **按 Token | 按花费**: one page-wide switch; it decides the heatmap's scale, the list's order and the share column.
- **Figure cards**: 花费, Token, 会话, each with the change against the comparison (`quota-and-usage.md` §3.5), and one line naming what is compared (e.g. **与上周一（11-02）截至 17:33 比较**). Increase is `--danger`, decrease `--addfg`.
- **Single day** (today, or a custom range of one day): the cards, then the model list. **Period**: the cards, the heatmap, then the list with **按日期 | 按模型**.
- **Heatmap** (`quota-and-usage.md` §3.6): strip and week-row layouts fill the card width with cells labeled by date and need no zoom; the week-column layout opens at the newest week, scrolls sideways, and has **− / 适配 / +** zoom steps (cells of fit, 16, 24, 32 and 44px; dates show from 28px). The card shows active days and the current and longest streak in the range, and a five-step legend. Tapping a day with usage opens the day sheet.
- **List rows** show the full date or model name on the first line (never truncated; a model by its catalog label when the catalog resolves its id, else as recorded) and, on the second, sessions (date rows) or agents (model rows), tokens, cost and the share; a bar under them shows the row against the largest. Date rows are newest first, model rows sorted by the page switch, or by cache-hit ratio when the model list's **排序** is set to **缓存命中**, which then shows **命中 N%**. Ten rows show, more load on scroll. Every row opens a sheet.
- **Day sheet**: the date and weekday; cost, tokens, input, output, cache read, cache write, cache hit, messages, sessions; then per agent its cost and its models with their figures.
- **Model sheet**: the model in its company color, the company and the range; cost, tokens, input, output, cache read, cache write, cache hit, messages, last used; per agent its tokens and cost; a small bar chart of the model's use per day in the range.
- Under the list: costs are estimates at public API prices, which subscriptions are not billed by; unpriced models and unavailable prices are named (`quota-and-usage.md` §3.3).

### 11.4 Settings group
- The **额度与用量** card begins with the master toggle **启用额度与用量查询** (`client.quotaUsageEnabled`, default `true`). When off, all following items in the card and the **查询额度的服务** card are hidden. If the client route is on quota or usage when the toggle turns off (including broadcasts from other phones or route restored on reload), it redirects immediately to home.
- **订阅额度** (summary: one short item per enabled provider following **额度显示**, e.g. **Claude 5h 剩 48%**) and **Token 用量** (summary: **今日 $x · 近 7 天 $y**).
- **额度显示**: 剩余 / 已用 (`client.quotaDisplay`).
- **列表页显示额度按钮** (`client.quotaButton`).
- **显示账号信息** (`client.quotaShowAccount`, 默认开启；关闭时额度卡片不显示套餐级别与账号邮箱).
- **用量统计模式**: 定时扫描 / 实时扫描 (`client.usageScanMode`, 默认 `scheduled`)；在定时扫描模式下提供扫描间隔选择 (**1m**, **2m**, **5m**, **10m**, **15m**，`client.usageScanInterval`，默认 `15m`)。
- **查询额度的服务**: Claude Code, Codex, Antigravity, each a switch (`client.quotaProviders`) with a subtitle (**已登录 · <plan>**, or **不查询** when off).
