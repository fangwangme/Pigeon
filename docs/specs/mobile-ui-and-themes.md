# Mobile UI and Theming Specification

## 1. Ergonomic Principles for Mobile Development

Pigeon is designed explicitly for single-handed mobile thumb usage on Chrome/Chromium mobile browsers, replacing raw SSH terminals with structured cards and native voice input.

### 1.1 Touch Targets and Hit Areas
- **Minimum Hit Target**: All interactive elements (buttons, tab pills, selection options, macro chips) must have an active clickable hit area of at least **44px × 44px**.
  - Elements with smaller visual footprints (e.g. 32px or 36px pills) must utilize negative margins, pseudo-elements (`::after`), or transparent padding to ensure the physical hit bounding box satisfies the 44px touch requirement.
- **Visual Feedback**: All interactable surfaces provide immediate active/pressed visual feedback (`--accents`, `--warns`).
- **Contrast Standard**: All text tokens must satisfy WCAG AA contrast (minimum 4.5:1 for regular text, 3:1 for graphical/decorative elements).

### 1.2 Viewport and Keyboard Adaptation (Chromium Standard)
- Viewport declaration:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
  ```
- Because Chromium mobile browsers natively honor `interactive-widget=resizes-content`, the layout viewport smoothly resizes above the software keyboard without requiring complex JavaScript visual-viewport listeners.
- The main card container uses `flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;`.
- The Macro Dock and Voice Input bar remain firmly pinned directly above the virtual keyboard.

### 1.3 Voice & Text Input Rules (IME Safety)
- **Input Component**: Pure native HTML `<textarea rows="1">` with auto-expanding height (max 120px).
- **IME Composition Guard**: Submissions are strictly prohibited between `compositionstart` and `compositionend`. Pressing Enter while an input method editor (IME) or voice-to-text dictation buffer is active will never submit the prompt.
- **Submission Trigger**: Prompts are sent solely by tapping the Send button or pressing Enter outside of active composition.
- **Draft Persistence**: Unsent input drafts are saved to `localStorage` per pane to prevent accidental loss if the tab reloads.

## 2. Navigation Architecture

### 2.1 Slide-Out Navigation Drawer
- **Trigger**: Swipe right from the left screen edge or tap the hamburger icon in the top header.
- **Top Half (Workspaces)**:
  - Vertical list of all active Herdr workspaces.
  - Displays workspace name, tab count, and status badges (`--accent` for working, `--warn` for blocked).
  - Tapping a workspace switches the active context and closes the drawer.
- **Bottom Half (Working Agents Radar)**:
  - Global list of all agents currently in `working` or `blocked` states across the entire machine.
  - Tapping any agent immediately navigates to its corresponding workspace and tab.
- **Footer**: Access to Settings (`快捷操作栏` Macros, `外观` Appearance, `连接与配对` Pairing).

### 2.2 Horizontal Tab Bar & Multi-Pane Split Support
- Pinned below the header, displaying active tabs in the current workspace.
- **Split Pane Chips**: In Herdr, a Tab may contain split panes (e.g. `pane_count > 1`).
  - Mobile view defaults to the primary agent pane.
  - If multiple panes exist within the tab, sub-pane pill chips (`[Claude c1] [Shell]`) are rendered directly beneath the tab bar, allowing one-tap switching between split panes without mutating desktop layout.
- Includes a dashed `[+]` button to launch a new Tab and select an agent.

## 3. Card Stream & Interactive Controls

### 3.1 Card Types, Turn-Based Flow, and Markdown
1. **Thought / Reasoning Block**: Displays agent internal thinking (`▸ Thought for Xs, Y tokens`). Collapsed by default via an accordion toggle with a subtle single-line preview beneath, expanding to show full reasoning text.
2. **Tool Execution Block & Display Density**:
   - **Compact Single-Line Mode (Antigravity-style, default)**: Condenses each command or file operation into a single-line item (e.g. `● Read(path)`, `● Edit(path)`, `● Bash(cmd)`), avoiding vertical screen waste. Tapping the line smoothly expands input parameters and terminal output logs.
   - **Aggregated Mode (OpenCode-style)**: Summarizes consecutive tool invocations into an ultra-compact summary line (e.g. `→ Explored: 4 reads, 1 search`), expandable on demand.
   - **Detailed Mode**: Full card presentation with discrete monospaced blocks.
3. **Full GFM Markdown Rendering**: Assistant responses and markdown cards render standard GitHub Flavored Markdown (headers, bullet/ordered lists, blockquotes, code blocks with syntax styling, inline code, and links) via `marked`.
4. **Table Anti-Wrap Standard**: To prevent Markdown tables from breaking on narrow 360–412px mobile screens, tables must use `display: block; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch;`. Table columns maintain natural widths and scroll smoothly horizontally without vertical character folding.
5. **Session Diff Drawer**: A top navigation badge `[ 📝 N files · +X -Y ]` opens a dedicated slide-out drawer showing per-file change statistics and unified line diffs with red/green syntax highlighting.
6. **Interactive Question Action Sheet**: When an agent transitions to `blocked` awaiting user input or permission, Pigeon elevates an Action Sheet highlighted with `--warn` borders, offering touch buttons (>= 44px) for each option plus fallback keys (`Enter`, `Esc`, `↑`, `↓`) and a "查看原始终端画面" (View Raw Terminal) sheet link.
7. **Skill Completion**: Typing `/` at the start of the composer lists the current pane's skills (`protocol.md` §5.7). Choosing one inserts its agent-specific invocation.

### 3.2 Scroll Anchoring, Floating Controls, and Jump to Bottom
- **Anchoring**: When new stream chunks arrive, the viewport auto-scrolls to the bottom **only if** the user is already within 40px of the bottom.
- **Auto Jump-to-Bottom Button**: If the user scrolls upward (> 60px from the bottom), a floating "回到底部 ⇣" (Jump to Bottom) pill button smoothly fades in centered above the bottom dock. Tapping it smoothly scrolls directly to the bottom.
- **Right Floating Quick-Scroll Bar**: Pinned vertically to the right-center edge of the screen, providing one-touch access to `⤒ Top` (回顶部), `↑ Page Up` (上一页), `↓ Page Down` (下一页), and `⤓ Bottom` (到底部). The strip displays a faint border and low opacity (`0.35`) by default so as not to obstruct reading, transitioning to full prominence (`0.95`) on hover or touch. Users can disable this control strip in Settings.

### 3.3 Contextual Safeguards for Destructive Actions
- **Interactive Approvals**: All authorization prompts are handled directly via elevated Interactive Question Cards and native Action Sheets with dedicated choice buttons. Redundant toolbar macro chips are eliminated to keep the bottom dock lean.
- **Terminating Action (`Ctrl+C`)**: **Double-tap protection**. A macro marked `confirm` (the default Ctrl+C macro) needs a second tap within 2 seconds; the first tap changes its label to a confirmation prompt. The setting `confirmCtrlC: false` turns this off.
- **Interrupt**: The interrupt button sends the current agent recipe's `interruptKeys` (Esc for agents, Ctrl+C for a plain terminal).
- **Unsent drafts**: When a prompt cannot be sent (offline), the composer keeps the text and an error toast explains why.

### 3.4 Mobile Shell Layout Invariants
- **Feed must scroll, never compress**: the card feed is a fixed-height flex column with `overflow-y: auto`. Its direct children are scroll content, so they must not participate in flex shrinking (`flex: 0 0 auto`). Cards with `overflow: hidden` otherwise collapse to a few pixels and overlap.
- **One status, one place**: agent status is shown once, in the session strip (workspace › tab › agent + status + model). The feed footer must not repeat it.
- **Top chrome budget**: header (52px) + tab bar (46px) + optional split-pane row (44px). Session strip stays under 92px so the feed keeps the majority of an 844px-tall viewport.
- **Terminal output**: rendered as a panel with a mobile header (title, line count, copy, expand). macOS traffic lights are not used. When structured cards exist, the raw screen collapses to a single-line "终端 · 最近一行 · N 行" row that opens the full-screen terminal sheet.
- **Tool cards**: header shows the tool name and exit status; the command renders on its own mono line; output is capped at five lines with an explicit expand control.
- **Bottom composer & Unified Input Area (D3, D7)**: Replaces persistent macro toolbars with an all-in-one input composer area to maximize the viewport available for agent cards. It incorporates:
  - An inline model and thinking level capsule indicator.
  - Native `/` local Skill completion popup with zero-latency fuzzy search.
  - An Options button (`[···]`) that elevates an on-demand Option Sheet housing interrupts (`[🛑 中断 / Esc]`, double-tap `[Ctrl+C]`), raw virtual keys (`Tab`, `Enter`, arrows), and user macros. The Options trigger can be toggled in Settings (`showMacroDock`).
  - Strict respect for `interactive-widget=resizes-content` and `env(safe-area-inset-bottom)`.
- **Tab Lifecycle Safeguard (D5)**: Closing an active Tab triggers a double-confirmation modal warning that the agent process and session will terminate, synchronizing real destruction to Herdr (`tab.close`).
- **Truncation**: workspace names, server host and long card titles use ellipsis, never hard clipping without an indication.

## 4. Theming and Color Tokens

All UI components reference semantic CSS variables exclusively. Hardcoded hex colors in components are forbidden.

### 4.1 Token Schema
- **Backgrounds**: `--bg`, `--surface`, `--sheet`, `--inset`, `--scrim`
- **Lines & Borders**: `--line`, `--border`, `--border2`
- **Typography**: `--fg`, `--muted`, `--faint`
- **Selections**: `--sel`, `--selb`
- **Accent (Working/Primary)**: `--accent`, `--onaccent`, `--accentt`, `--accentbg`, `--accents`, `--accentl`
- **Warning (Blocked/Prompt)**: `--warn`, `--onwarn`, `--warnt`, `--warnbg`, `--warnb`, `--warns`, `--warnl`, `--warnk`
- **Code & Diffs**: `--code`, `--codeb`, `--codefg`, `--addbg`, `--addfg`, `--delbg`, `--delfg`, `--badge`

### 4.2 Contrast Calibration
In the Pigeon Light theme variant, `--faint` is calibrated to `#5C6675` against `--bg` (`#F6F7F9`), producing a contrast ratio of **5.2:1**, strictly satisfying the WCAG AA 4.5:1 threshold.

### 4.3 Preset Theme Packs
The system supports 6 curated theme packs, each providing paired Light and Dark variants:
1. **Tokyo Night** (Tokyo Night / Tokyo Night Day)
2. **Claude** (Claude Slate Dark / Claude Ivory Light)
3. **GitHub** (GitHub Dark / GitHub Light)
4. **Gruvbox** (Gruvbox Dark / Gruvbox Light)
5. **Catppuccin** (Mocha Dark / Latte Light)
6. **Pigeon** (Default Slate Dark / Pigeon Light)

### 4.4 Prevent Theme Flash on Load
The HTML header embeds an inline render-blocking script that reads `localStorage.getItem('pigeon_theme')` and immediately sets CSS root attributes before body rendering:
```html
<script>
  (function(){
    const t = localStorage.getItem('pigeon_theme') || 'pigeon';
    const m = localStorage.getItem('pigeon_mode') || 'dark';
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.setAttribute('data-mode', m);
  })();
</script>
```

## 5. Internationalization (i18n)

- **Source Language**: English (`en`). All fallback strings and key schemas are authored in English.
- **Initial Translations**: Simplified Chinese (`zh-CN`).
- Location: `src/web/i18n/{en,zh-CN}.json`. Hardcoded UI strings in Solid components are forbidden.
