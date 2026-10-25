import { Component, For, Show, createSignal } from "solid-js";
import {
  state,
  closeSettingsModal,
  setSettingsTab,
  setPaletteTheme,
  setDisplayDensity,
  setShowScrollControls,
  setShowMacroDock,
  setState,
  type MacroItem,
} from "../state/store";
import { sendConfigPatch } from "../state/ws";
import { DEFAULT_MACROS } from "../../../shared/defaults";
import { PALETTES } from "../themes";

export const SettingsModal: Component = () => {
  // Appearance state
  const themesList = [
    { key: "gruvbox", name: "Gruvbox", subtitle: "默认 · 复古经典" },
    { key: "pigeon", name: "Pigeon", subtitle: "冷灰现代" },
    { key: "github", name: "GitHub", subtitle: "Light / Dark" },
    { key: "tokyo-night", name: "Tokyo Night", subtitle: "Day / Night" },
    { key: "catppuccin", name: "Catppuccin", subtitle: "Latte / Mocha" },
    { key: "claude", name: "Claude", subtitle: "Ivory / Slate" },
    { key: "solarized", name: "Solarized", subtitle: "Light / Dark" },
  ];

  // Macros state
  const [macroName, setMacroName] = createSignal("");
  const [macroType, setMacroType] = createSignal<"text" | "key">("text");
  const [macroPayload, setMacroPayload] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);

  // Pairing state

  const handleSelectTheme = (themeKey: string) => {
    setPaletteTheme(themeKey, state.themeMode);
    sendConfigPatch({ themeKey });
  };

  const handleSelectMode = (mode: "system" | "light" | "dark") => {
    setPaletteTheme(state.themeKey, mode);
    sendConfigPatch({ themeMode: mode });
  };

  const handleSelectDensity = (density: "compact" | "aggregated" | "detailed") => {
    setDisplayDensity(density);
    sendConfigPatch({ displayDensity: density });
  };

  const handleToggleScrollControls = () => {
    const next = !state.showScrollControls;
    setShowScrollControls(next);
    sendConfigPatch({ showScrollControls: next });
  };

  const handleToggleMacroDock = () => {
    const next = !state.showMacroDock;
    setShowMacroDock(next);
    sendConfigPatch({ showMacroDock: next });
  };

  const handleSaveMacro = (e: Event) => {
    e.preventDefault();
    const name = macroName().trim();
    const payload = macroPayload().trim();
    if (!name || !payload) return;

    let updated: MacroItem[];
    if (editingId()) {
      updated = state.macros.map((m) =>
        m.id === editingId()
          ? { ...m, name, type: macroType(), payload }
          : m
      );
    } else {
      const newMacro: MacroItem = {
        id: `custom_${Date.now()}`,
        name,
        type: macroType(),
        payload,
      };
      updated = [...state.macros, newMacro];
    }

    setState("macros", updated);
    sendConfigPatch({ macros: updated });
    setMacroName("");
    setMacroPayload("");
    setMacroType("text");
    setEditingId(null);
  };

  const handleDeleteMacro = (id: string) => {
    const updated = state.macros.filter((m) => m.id !== id);
    setState("macros", updated);
    sendConfigPatch({ macros: updated });
  };

  const handleResetMacros = () => {
    setState("macros", DEFAULT_MACROS);
    sendConfigPatch({ macros: DEFAULT_MACROS });
  };

  return (
    <Show when={state.settingsModalOpen}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          "z-index": 60,
          background: "var(--bg)",
          color: "var(--fg)",
          display: "flex",
          "flex-direction": "column",
          overflow: "hidden",
          "touch-action": "pan-y",
        }}
      >
        {/* Modal Header */}
        <header
          style={{
            height: "56px",
            "flex-shrink": 0,
            display: "flex",
            "align-items": "center",
            padding: "0 12px 0 6px",
            "border-bottom": "1px solid var(--line)",
            gap: "8px",
          }}
        >
          <button
            aria-label="返回"
            class="touch-target"
            onClick={closeSettingsModal}
            style={{
              width: "44px",
              height: "44px",
              border: 0,
              background: "transparent",
              color: "var(--fg)",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              "border-radius": "10px",
              cursor: "pointer",
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span style={{ "font-size": "17px", "font-weight": 700, flex: 1 }}>设置 (Settings)</span>
        </header>

        {/* Unified Segmented Tab Bar */}
        <nav
          aria-label="设置导航"
          style={{
            padding: "10px 12px",
            "border-bottom": "1px solid var(--line)",
            background: "var(--surface)",
            "flex-shrink": 0,
          }}
        >
          <div
            style={{
              display: "grid",
              "grid-template-columns": "repeat(3, minmax(0, 1fr))",
              gap: "4px",
              background: "var(--inset)",
              padding: "4px",
              "border-radius": "10px",
              border: "1px solid var(--border)",
            }}
          >
            <button
              class="touch-target"
              onClick={() => setSettingsTab("appearance")}
              style={{
                height: "36px",
                "border-radius": "8px",
                border: 0,
                background: state.settingsTab === "appearance" ? "var(--accent)" : "transparent",
                color: state.settingsTab === "appearance" ? "var(--onaccent)" : "var(--muted)",
                "font-size": "13px",
                "font-weight": state.settingsTab === "appearance" ? 600 : 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              外观
            </button>
            <button
              class="touch-target"
              onClick={() => setSettingsTab("macros")}
              style={{
                height: "36px",
                "border-radius": "8px",
                border: 0,
                background: state.settingsTab === "macros" ? "var(--accent)" : "transparent",
                color: state.settingsTab === "macros" ? "var(--onaccent)" : "var(--muted)",
                "font-size": "13px",
                "font-weight": state.settingsTab === "macros" ? 600 : 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              快捷操作栏
            </button>
            <button
              class="touch-target"
              onClick={() => setSettingsTab("pairing")}
              style={{
                height: "36px",
                "border-radius": "8px",
                border: 0,
                background: state.settingsTab === "pairing" ? "var(--accent)" : "transparent",
                color: state.settingsTab === "pairing" ? "var(--onaccent)" : "var(--muted)",
                "font-size": "13px",
                "font-weight": state.settingsTab === "pairing" ? 600 : 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              设备与配对
            </button>
            <button
              class="touch-target"
              onClick={() => setSettingsTab("pwa")}
              style={{
                height: "36px",
                "border-radius": "8px",
                border: 0,
                background: state.settingsTab === "pwa" ? "var(--accent)" : "transparent",
                color: state.settingsTab === "pwa" ? "var(--onaccent)" : "var(--muted)",
                "font-size": "13px",
                "font-weight": state.settingsTab === "pwa" ? 600 : 500,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              全屏应用
            </button>
          </div>
        </nav>

        {/* Tab Content Container */}
        <div
          style={{
            flex: 1,
            "min-height": 0,
            "overflow-y": "auto",
            "overflow-x": "hidden",
            "-webkit-overflow-scrolling": "touch",
            "touch-action": "pan-y",
            padding: "16px 14px 40px",
            display: "flex",
            "flex-direction": "column",
            gap: "24px",
            "max-width": "100%",
            "box-sizing": "border-box",
          }}
        >
          {/* TAB 1: 外观 (Appearance) */}
          <Show when={state.settingsTab === "appearance"}>
            <section style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
              <div>
                <h3 style={{ "font-size": "15px", "font-weight": 700, margin: "0 0 4px" }}>色彩模式</h3>
                <p style={{ "font-size": "12px", color: "var(--muted)", margin: 0 }}>
                  支持自动跟随系统切换深浅色模式，或手动锁定。
                </p>
              </div>

              <div style={{ display: "grid", "grid-template-columns": "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
                {(["system", "light", "dark"] as const).map((mode) => {
                  const isSelected = () => state.themeMode === mode;
                  const label = mode === "system" ? "跟随系统" : mode === "light" ? "浅色模式" : "深色模式";
                  return (
                    <button
                      class="touch-target"
                      onClick={() => handleSelectMode(mode)}
                      style={{
                        height: "44px",
                        "border-radius": "10px",
                        border: isSelected() ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                        background: isSelected() ? "var(--accentbg)" : "var(--surface)",
                        color: isSelected() ? "var(--accentt)" : "var(--fg)",
                        "font-size": "13px",
                        "font-weight": 600,
                        cursor: "pointer",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              <div style={{ "margin-top": "8px" }}>
                <h3 style={{ "font-size": "15px", "font-weight": 700, margin: "0 0 4px" }}>主题预设</h3>
                <p style={{ "font-size": "12px", color: "var(--muted)", margin: 0 }}>
                  精心调优的高对比度配色预设。
                </p>
              </div>

              <div style={{ display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", gap: "10px" }}>
                <For each={themesList}>
                  {(item) => {
                    const isSelected = () => state.themeKey === item.key;
                    const palette = PALETTES[item.key] || PALETTES["pigeon"];
                    const previewDark = palette.dark;
                    const previewLight = palette.light;

                    return (
                      <button
                        class="touch-target"
                        onClick={() => handleSelectTheme(item.key)}
                        style={{
                          display: "flex",
                          "flex-direction": "column",
                          gap: "8px",
                          padding: "12px",
                          "border-radius": "12px",
                          border: isSelected() ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                          background: isSelected() ? "var(--accentbg)" : "var(--surface)",
                          color: "var(--fg)",
                          cursor: "pointer",
                          "text-align": "left",
                        }}
                      >
                        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", width: "100%" }}>
                          <span style={{ "font-size": "14px", "font-weight": 600 }}>{item.name}</span>
                          <Show when={isSelected()}>
                            <span style={{ "font-size": "11px", color: "var(--accent)", "font-weight": 600 }}>当前</span>
                          </Show>
                        </div>

                        {/* Theme color swatch preview */}
                        <div style={{ display: "flex", gap: "6px", "margin-top": "4px" }}>
                          <span style={{ width: "16px", height: "16px", "border-radius": "4px", background: previewDark.bg, border: "1px solid var(--border)" }} />
                          <span style={{ width: "16px", height: "16px", "border-radius": "4px", background: previewDark.accent }} />
                          <span style={{ width: "16px", height: "16px", "border-radius": "4px", background: previewLight.bg, border: "1px solid var(--border)" }} />
                          <span style={{ width: "16px", height: "16px", "border-radius": "4px", background: previewLight.accent }} />
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>

              {/* Display Density Settings */}
              <div style={{ "margin-top": "12px" }}>
                <h3 style={{ "font-size": "15px", "font-weight": 700, margin: "0 0 4px" }}>内容展示密度</h3>
                <p style={{ "font-size": "12px", color: "var(--muted)", margin: 0 }}>
                  控制命令执行与思考过程的紧凑程度与聚合展示方式。
                </p>
              </div>

              <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                {[
                  {
                    key: "compact",
                    title: "紧凑单行 (Antigravity 风格)",
                    desc: "如 ● Read(file) 单行精简展示，点击随时展开命令与输出",
                  },
                  {
                    key: "aggregated",
                    title: "极简聚合 (OpenCode 风格)",
                    desc: "如 → 探索: 4 次读取，自动汇总连续文件与搜索操作",
                  },
                  {
                    key: "detailed",
                    title: "完整卡片 (传统卡片)",
                    desc: "每个工具调用与命令均以完整独立卡片呈现",
                  },
                ].map((item) => {
                  const isSelected = () => state.displayDensity === item.key;
                  return (
                    <button
                      class="touch-target"
                      onClick={() => handleSelectDensity(item.key as any)}
                      style={{
                        display: "flex",
                        "flex-direction": "column",
                        gap: "4px",
                        padding: "12px 14px",
                        "border-radius": "10px",
                        border: isSelected() ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                        background: isSelected() ? "var(--accentbg)" : "var(--surface)",
                        color: "var(--fg)",
                        cursor: "pointer",
                        "text-align": "left",
                      }}
                    >
                      <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", width: "100%" }}>
                        <span style={{ "font-size": "13.5px", "font-weight": 600 }}>{item.title}</span>
                        <Show when={isSelected()}>
                          <span style={{ "font-size": "11.5px", color: "var(--accent)", "font-weight": 650 }}>已启用 ✓</span>
                        </Show>
                      </div>
                      <span style={{ "font-size": "11.5px", color: "var(--muted)", "line-height": 1.4 }}>
                        {item.desc}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Floating Quick Scroll Controls Toggle */}
              <div style={{ "margin-top": "12px" }}>
                <h3 style={{ "font-size": "15px", "font-weight": 700, margin: "0 0 4px" }}>快捷悬浮滚动条</h3>
                <p style={{ "font-size": "12px", color: "var(--muted)", margin: 0 }}>
                  在屏幕右侧居中常驻悬浮控制条（置顶 ⤒、翻页 ↑/↓、到底 ⤓），默认微光淡隐不干扰阅读，触碰高亮。
                </p>
              </div>

              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "12px 14px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "10px",
                }}
              >
                <div>
                  <div style={{ "font-size": "13.5px", "font-weight": 600 }}>右侧悬浮滚动条</div>
                  <div style={{ "font-size": "11.5px", color: "var(--muted)" }}>
                    {state.showScrollControls ? "已开启悬浮条" : "已隐藏悬浮条（仅保留非底部跳到底部药丸）"}
                  </div>
                </div>
                <button
                  class="touch-target"
                  onClick={handleToggleScrollControls}
                  style={{
                    height: "36px",
                    padding: "0 14px",
                    "border-radius": "8px",
                    border: state.showScrollControls ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: state.showScrollControls ? "var(--accent)" : "transparent",
                    color: state.showScrollControls ? "var(--onaccent)" : "var(--muted)",
                    "font-size": "12.5px",
                    "font-weight": 600,
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  {state.showScrollControls ? "开启" : "关闭"}
                </button>
              </div>
            </section>
          </Show>

          {/* TAB 2: 快捷操作栏 (Macros) */}
          <Show when={state.settingsTab === "macros"}>
            <section style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
              {/* Show / Hide Macro Dock Switch */}
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "12px 14px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "10px",
                }}
              >
                <div>
                  <div style={{ "font-size": "13.5px", "font-weight": 600 }}>显示底部快捷操作栏</div>
                  <div style={{ "font-size": "11.5px", color: "var(--muted)", "margin-top": "2px" }}>
                    {state.showMacroDock ? "已显示快捷键栏（模型 / 继续 / 终止）" : "已隐藏快捷键栏（仅保留输入框，扩大阅读视野）"}
                  </div>
                </div>
                <button
                  class="touch-target"
                  onClick={handleToggleMacroDock}
                  style={{
                    height: "36px",
                    padding: "0 14px",
                    "border-radius": "8px",
                    border: state.showMacroDock ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: state.showMacroDock ? "var(--accent)" : "transparent",
                    color: state.showMacroDock ? "var(--onaccent)" : "var(--muted)",
                    "font-size": "12.5px",
                    "font-weight": 600,
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  {state.showMacroDock ? "显示" : "隐藏"}
                </button>
              </div>

              <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                <div>
                  <h3 style={{ "font-size": "15px", "font-weight": 700, margin: "0 0 4px" }}>快捷键与常用命令</h3>
                  <p style={{ "font-size": "12px", color: "var(--muted)", margin: 0 }}>
                    显示在底栏上方，随时点按一键输入或发送按键。
                  </p>
                </div>
                <button
                  class="touch-target"
                  onClick={handleResetMacros}
                  style={{
                    height: "32px",
                    padding: "0 10px",
                    "border-radius": "8px",
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--muted)",
                    "font-size": "12px",
                    cursor: "pointer",
                  }}
                >
                  重置默认
                </button>
              </div>

              {/* Macro items list */}
              <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                <For each={state.macros}>
                  {(macro) => (
                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "10px",
                        padding: "10px 14px",
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        "border-radius": "10px",
                      }}
                    >
                      <div style={{ flex: 1, "min-width": 0 }}>
                        <div style={{ "font-size": "14px", "font-weight": 600 }}>{macro.name}</div>
                        <div style={{ "font-size": "12px", color: "var(--muted)", "font-family": "'JetBrains Mono', monospace" }}>
                          [{macro.type === "key" ? "按键" : "文本"}] {macro.payload}
                        </div>
                      </div>
                      <button
                        class="touch-target"
                        onClick={() => handleDeleteMacro(macro.id)}
                        aria-label={`删除宏 ${macro.name}`}
                        style={{
                          width: "36px",
                          height: "36px",
                          border: 0,
                          background: "transparent",
                          color: "var(--delfg)",
                          cursor: "pointer",
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "center",
                        }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  )}
                </For>
              </div>

              {/* Add Custom Macro Form */}
              <form
                onSubmit={handleSaveMacro}
                style={{
                  background: "var(--inset)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  padding: "14px",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "12px",
                  "margin-top": "8px",
                }}
              >
                <div style={{ "font-size": "14px", "font-weight": 600 }}>添加新快捷键</div>

                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="text"
                    placeholder="按钮名称 (如: /help)"
                    value={macroName()}
                    onInput={(e) => setMacroName(e.currentTarget.value)}
                    style={{
                      flex: 1,
                      height: "40px",
                      padding: "0 10px",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      "border-radius": "8px",
                      color: "var(--fg)",
                      "font-size": "13px",
                    }}
                  />
                  <select
                    value={macroType()}
                    onChange={(e) => setMacroType(e.currentTarget.value as any)}
                    style={{
                      width: "80px",
                      height: "40px",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      "border-radius": "8px",
                      color: "var(--fg)",
                      "font-size": "13px",
                      padding: "0 6px",
                    }}
                  >
                    <option value="text">文本</option>
                    <option value="key">按键</option>
                  </select>
                </div>

                <input
                  type="text"
                  placeholder="发送内容或按键名 (如: enter, ctrl+c, /status)"
                  value={macroPayload()}
                  onInput={(e) => setMacroPayload(e.currentTarget.value)}
                  style={{
                    height: "40px",
                    padding: "0 10px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    "border-radius": "8px",
                    color: "var(--fg)",
                    "font-size": "13px",
                    "font-family": "'JetBrains Mono', monospace",
                  }}
                />

                <button
                  type="submit"
                  class="touch-target"
                  style={{
                    height: "44px",
                    background: "var(--accent)",
                    color: "var(--onaccent)",
                    border: 0,
                    "border-radius": "10px",
                    "font-size": "14px",
                    "font-weight": 600,
                    cursor: "pointer",
                  }}
                >
                  添加快捷项
                </button>
              </form>
            </section>
          </Show>

          {/* TAB 3: 设备与配对 (Pairing & Devices) */}
          <Show when={state.settingsTab === "pairing"}>
            <section style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
              <div>
                <h3 style={{ "font-size": "15px", "font-weight": 700, margin: "0 0 4px" }}>连接状态</h3>
                <p style={{ "font-size": "12px", color: "var(--muted)", margin: 0 }}>
                  当前主机：<code style={{ color: "var(--fg)" }}>{window.location.host}</code> · {state.connected ? "已连接" : "未连接"}
                </p>
              </div>

              {/* Pair new device form */}
              <div
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "14px",
                  padding: "16px",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "14px",
                }}
              >
                <div style={{ "font-size": "14px", "font-weight": 600 }}>{state.paired ? "重新配对本机" : "这台手机还没有配对"}</div>
                <div style={{ "font-size": "12px", color: "var(--muted)", "line-height": 1.5 }}>
                  在电脑上运行 <code>pigeon pair</code>，用手机相机扫终端里的二维码即可配对（security-and-pairing.md §2：只支持扫码）。
                </div>
              </div>

              {/* Instructions */}
              <div
                style={{
                  padding: "14px",
                  background: "var(--inset)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  "font-size": "12px",
                  "line-height": 1.6,
                  color: "var(--muted)",
                }}
              >
                <div style={{ "font-weight": 600, color: "var(--fg)", "margin-bottom": "4px" }}>如何在电脑上为新设备生成配对码？</div>
                在电脑终端运行：<code style={{ color: "var(--accent)", background: "var(--surface)", padding: "2px 6px", "border-radius": "4px" }}>./dist/pigeon pair</code> 即可生成新二维码与专属配对码。
              </div>
            </section>
          </Show>

          {/* TAB 4: 全屏应用 PWA (Standalone App & Auto Update) */}
          <Show when={state.settingsTab === "pwa"}>
            <section style={{ display: "flex", "flex-direction": "column", gap: "20px" }}>
              <div>
                <h3 style={{ "font-size": "15px", "font-weight": 700, margin: "0 0 4px" }}>
                  添加到主屏幕（全屏 App 模式）
                </h3>
                <p style={{ "font-size": "12.5px", color: "var(--muted)", margin: 0, "line-height": 1.5 }}>
                  普通网页模式下，浏览器顶部地址栏和底部操作栏会侵占手机屏幕空间。将 Pigeon 添加到手机主屏幕后，将以纯粹的全屏独立 App 运行，彻底移除浏览器工具栏！
                </p>
              </div>

              {/* Install button if browser triggers beforeinstallprompt */}
              <Show when={state.canInstallPWA}>
                <button
                  class="touch-target"
                  onClick={async () => {
                    const prompt = (window as any).__pigeonDeferredPrompt;
                    if (prompt) {
                      prompt.prompt();
                      const choice = await prompt.userChoice;
                      if (choice.outcome === "accepted") {
                        setState("canInstallPWA", false);
                      }
                    }
                  }}
                  style={{
                    width: "100%",
                    height: "46px",
                    background: "var(--accent)",
                    color: "var(--onaccent)",
                    border: 0,
                    "border-radius": "10px",
                    "font-size": "14px",
                    "font-weight": 650,
                    cursor: "pointer",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    gap: "8px",
                    "box-shadow": "0 2px 8px rgba(0, 0, 0, 0.2)",
                  }}
                >
                  <span>📥</span>
                  <span>立即安装 Pigeon 到手机桌面</span>
                </button>
              </Show>

              {/* Step by Step Guide Card */}
              <div
                style={{
                  background: "var(--inset)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  padding: "16px",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "14px",
                  "font-size": "13px",
                  "line-height": 1.6,
                }}
              >
                <div style={{ "font-weight": 650, color: "var(--fg)", "font-size": "14px" }}>
                  📱 手动添加方式（推荐）：
                </div>

                <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
                  <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "8px", border: "1px solid var(--border)" }}>
                    <div style={{ "font-weight": 600, color: "var(--accent)", "margin-bottom": "2px" }}>
                      🤖 Chrome / Android
                    </div>
                    <div style={{ color: "var(--muted)", "font-size": "12.5px" }}>
                      点击浏览器右上角菜单 <strong>⋮</strong> ➔ 选择<strong>「添加到主屏幕」</strong>或<strong>「安装应用」</strong>。
                    </div>
                  </div>

                  <div style={{ background: "var(--surface)", padding: "10px 12px", "border-radius": "8px", border: "1px solid var(--border)" }}>
                    <div style={{ "font-weight": 600, color: "var(--accent)", "margin-bottom": "2px" }}>
                      🍏 Safari / iOS
                    </div>
                    <div style={{ color: "var(--muted)", "font-size": "12.5px" }}>
                      点击 Safari 底部分享按钮 <strong>⎋</strong> ➔ 向下滑动并选择<strong>「添加到主屏幕」</strong>。
                    </div>
                  </div>
                </div>
              </div>

              {/* Automatic Update Mechanism explanation */}
              <div
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "12px",
                  padding: "14px",
                  display: "flex",
                  "flex-direction": "column",
                  gap: "6px",
                  "font-size": "12.5px",
                  color: "var(--muted)",
                  "line-height": 1.5,
                }}
              >
                <div style={{ "font-weight": 650, color: "var(--fg)", display: "flex", "align-items": "center", gap: "6px" }}>
                  <span>🔄</span>
                  <span>PWA 自动热更新机制</span>
                </div>
                <div>
                  Pigeon 采用 <strong>Network-First + 智能版本探测</strong>。当服务端更新或重启后，PWA 每次打开或切换回前台时会自动拉取最新版本并在后台无缝热替换，无需重新添加或清理缓存！
                </div>
              </div>
            </section>
          </Show>
        </div>
      </div>
    </Show>
  );
};
