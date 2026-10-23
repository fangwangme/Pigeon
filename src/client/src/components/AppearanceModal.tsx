import { Component, For, Show } from "solid-js";
import {
  state,
  closeAppearanceModal,
  setPaletteTheme,
} from "../state/store";
import { sendConfigPatch } from "../state/ws";
import { PALETTES } from "../themes";

export const AppearanceModal: Component = () => {
  const themesList = [
    { key: "pigeon", name: "Pigeon", subtitle: "默认" },
    { key: "github", name: "GitHub", subtitle: "Light / Dark" },
    { key: "tokyo-night", name: "Tokyo Night", subtitle: "Day / Night" },
    { key: "catppuccin", name: "Catppuccin", subtitle: "Latte / Mocha" },
    { key: "claude", name: "Claude", subtitle: "Ivory / Slate" },
    { key: "solarized", name: "Solarized", subtitle: "Light / Dark" },
  ];

  return (
    <Show when={state.appearanceModalOpen}>
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
        }}
      >
        {/* Header */}
        <header
          style={{
            height: "56px",
            "flex-shrink": 0,
            display: "flex",
            "align-items": "center",
            gap: "4px",
            padding: "0 8px 0 4px",
            "border-bottom": "1px solid var(--line)",
          }}
        >
          <button
            aria-label="返回"
            class="touch-target"
            onClick={closeAppearanceModal}
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
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <div style={{ flex: 1, "font-size": "16px", "font-weight": 600 }}>外观</div>
        </header>

        {/* Content body */}
        <div
          style={{
            flex: 1,
            "min-height": 0,
            "overflow-y": "auto",
            padding: "16px 16px 0",
            display: "flex",
            "flex-direction": "column",
            gap: "20px",
          }}
        >
          {/* Mode fieldset */}
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", "flex-direction": "column", gap: "8px" }}>
            <legend style={{ padding: 0, "margin-bottom": "8px", "font-size": "13px", "font-weight": 600, color: "var(--muted)" }}>
              深浅模式
            </legend>
            <div
              style={{
                display: "grid",
                "grid-template-columns": "repeat(3, minmax(0, 1fr))",
                gap: "4px",
                padding: "4px",
                "border-radius": "12px",
                background: "var(--inset)",
                border: "1px solid var(--codeb)",
              }}
            >
              {(["system", "light", "dark"] as const).map((mode) => {
                const isSelected = () => state.themeMode === mode;
                const label = mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色";
                return (
                  <button
                    aria-pressed={isSelected()}
                    class="touch-target"
                    onClick={() => {
                      setPaletteTheme(state.themeKey, mode);
                      sendConfigPatch({ themeMode: mode });
                    }}
                    style={{
                      height: "40px",
                      "border-radius": "8px",
                      border: 0,
                      background: isSelected() ? "var(--sel)" : "transparent",
                      color: isSelected() ? "var(--fg)" : "var(--muted)",
                      "font-size": "13px",
                      "font-weight": isSelected() ? 600 : 500,
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div style={{ "font-size": "12px", "line-height": 1.5, color: "var(--muted)" }}>
              手机开了自动深色模式时，白天用浅色、晚上用深色。
            </div>
          </fieldset>

          {/* Color Palettes fieldset */}
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend style={{ padding: 0, "margin-bottom": "8px", "font-size": "13px", "font-weight": 600, color: "var(--muted)" }}>
              配色
            </legend>
            <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
              <For each={themesList}>
                {(t) => {
                  const isSelected = () => state.themeKey === t.key;
                  const pal = PALETTES[t.key] || PALETTES.pigeon;

                  return (
                    <button
                      aria-pressed={isSelected()}
                      class="touch-target"
                      onClick={() => {
                        setPaletteTheme(t.key, state.themeMode);
                        sendConfigPatch({ themeKey: t.key, themeId: t.key });
                      }}
                      style={{
                        "min-height": "60px",
                        display: "flex",
                        "align-items": "center",
                        gap: "12px",
                        padding: "0 12px",
                        "border-radius": "12px",
                        border: isSelected()
                          ? "1.5px solid var(--accent)"
                          : "1px solid var(--line)",
                        background: isSelected() ? "var(--accentbg)" : "var(--sheet)",
                        color: "var(--fg)",
                        "text-align": "left",
                        cursor: "pointer",
                      }}
                    >
                      {/* Mini Preview Icons */}
                      <span style={{ display: "flex", gap: "4px" }}>
                        {/* Light preview card */}
                        <span
                          style={{
                            width: "40px",
                            height: "32px",
                            "box-sizing": "border-box",
                            "border-radius": "6px",
                            border: "1px solid rgba(127, 127, 127, 0.3)",
                            background: pal.light.bg,
                            display: "flex",
                            "flex-direction": "column",
                            "justify-content": "center",
                            gap: "4px",
                            padding: "0 6px",
                          }}
                        >
                          <span
                            style={{
                              height: "3px",
                              width: "22px",
                              "border-radius": "2px",
                              background: pal.light.fg,
                            }}
                          />
                          <span style={{ display: "flex", gap: "3px" }}>
                            <span
                              style={{
                                width: "6px",
                                height: "6px",
                                "border-radius": "3px",
                                background: pal.light.accent,
                              }}
                            />
                            <span
                              style={{
                                width: "6px",
                                height: "6px",
                                "border-radius": "3px",
                                background: pal.light.warn,
                              }}
                            />
                          </span>
                        </span>

                        {/* Dark preview card */}
                        <span
                          style={{
                            width: "40px",
                            height: "32px",
                            "box-sizing": "border-box",
                            "border-radius": "6px",
                            border: "1px solid rgba(127, 127, 127, 0.3)",
                            background: pal.dark.bg,
                            display: "flex",
                            "flex-direction": "column",
                            "justify-content": "center",
                            gap: "4px",
                            padding: "0 6px",
                          }}
                        >
                          <span
                            style={{
                              height: "3px",
                              width: "22px",
                              "border-radius": "2px",
                              background: pal.dark.fg,
                            }}
                          />
                          <span style={{ display: "flex", gap: "3px" }}>
                            <span
                              style={{
                                width: "6px",
                                height: "6px",
                                "border-radius": "3px",
                                background: pal.dark.accent,
                              }}
                            />
                            <span
                              style={{
                                width: "6px",
                                height: "6px",
                                "border-radius": "3px",
                                background: pal.dark.warn,
                              }}
                            />
                          </span>
                        </span>
                      </span>

                      <span style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column", gap: "2px" }}>
                        <span style={{ "font-size": "14px", "font-weight": 600 }}>{t.name}</span>
                        <span style={{ "font-size": "12px", color: "var(--muted)" }}>{t.subtitle}</span>
                      </span>

                      <Show when={isSelected()}>
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                          style={{ color: "var(--accent)" }}
                        >
                          <path d="M5 12l5 5 9-10" />
                        </svg>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </fieldset>
        </div>

        {/* Footer */}
        <div
          style={{
            "flex-shrink": 0,
            padding: "10px 16px 20px",
            "font-size": "11px",
            "line-height": 1.5,
            color: "var(--faint)",
            "text-align": "center",
          }}
        >
          配色每台设备单独保存
        </div>
      </div>
    </Show>
  );
};
