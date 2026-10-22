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

### 3.1 Card Types
1. **Thought Card**: Displays agent internal thinking (`+ Thought`). Collapsed by default.
2. **Tool Execution Card**: Displays Bash command invocations with exit codes and monospaced output.
3. **Diff Card**: Displays file modifications (e.g. `src/auth.ts +1 -1`). Collapsed by default. When expanded, renders unified line-by-line diffs with full-width coloring.
4. **Assistant Response**: Streamed Markdown with code syntax highlighting.
5. **Interactive Question Card**: Highlighted in warning borders (`--warn`), featuring large touch buttons for each option, supplemented by fallback physical keys (`Enter`, `Esc`, `↑`, `↓`) and a "查看原始终端画面" (View Raw Terminal) sheet link.
6. **Ghost Prediction Banner**: Renders predicted next commands with `[ ⇥ 填入 ]` (populate input textarea) and `[ ⚡ 执行 ]` (direct execute).

### 3.2 Scroll Anchoring
- When new stream chunks arrive, the viewport auto-scrolls to the bottom **only if** the user is already within 40px of the bottom.
- If the user has scrolled upward to read past output, auto-scroll is paused, and a floating "回到底部" (Jump to Bottom) pill button appears.

### 3.3 Contextual Safeguards for Destructive Actions
- **`Approve` / `Reject` Macros**: Automatically disabled and dimmed when no interaction prompt is currently pending.
- **Terminating Action (`Ctrl+C`)**: **Double-tap protection**. Tapping once displays a temporary confirmation tooltip: *"再次点击确认中断 (Ctrl+C)"*; only a second tap within 0.8 seconds dispatches the termination signal.

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
The system includes 6 curated theme packs, each providing paired Light and Dark variants:
1. **Pigeon** (Default modern slate/blue)
2. **GitHub** (GitHub Light / GitHub Dark)
3. **Tokyo Night** (Tokyo Night Day / Tokyo Night)
4. **Catppuccin** (Latte / Mocha)
5. **Claude** (Warm terracotta light / deep ember dark)
6. **Solarized** (Solarized Light / Solarized Dark)

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
